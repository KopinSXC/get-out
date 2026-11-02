import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorldHost } from 'cortico/core/types.ts';
import { LedgerReader, aggregate, costOf, evaluate, normalizeLevels, parseLine, parsePricing, priceFor } from '../src/budget.ts';
import { BudgetWorld, EVENT_TYPE, defaultConfig, type BudgetConfig } from '../src/world.ts';

const TZ = 'Asia/Shanghai';
const table = parsePricing({
  models: {
    'm-exact': { input: 2, cacheHit: 0.5, output: 8 },
    'm-*': { input: 1, cacheHit: 1, output: 1 },
    'm-long-*': { input: 3, cacheHit: 3, output: 3 },
  },
});

/** 一行账本;1 次调用 = 100 万 prompt(其中 cacheHit 万) + 100 万 completion。 */
function rec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2, recordId: crypto.randomUUID(), ts: '2026-11-02T10:00:00.000+08:00', model: 'm-exact',
    promptTokens: 1_000_000, cacheHitTokens: 0, completionTokens: 1_000_000, reasoningTokens: 200_000, ...over,
  });
}

const lines = (n: number) => Array.from({ length: n }, () => `${rec()}\n`).join('');

describe('单价', () => {
  it('精确名优先,其次最长前缀', () => {
    expect(priceFor(table, 'm-exact')?.input).toBe(2);
    expect(priceFor(table, 'm-long-x')?.input).toBe(3);
    expect(priceFor(table, 'm-other')?.input).toBe(1);
    expect(priceFor(table, 'zzz')).toBeNull();
  });

  it('命中缓存按 cacheHit 价,推理已含在输出里不重复计', () => {
    const r = parseLine(rec({ cacheHitTokens: 400_000 }));
    if (typeof r === 'string') throw new Error(r);
    // 60 万 * 2 + 40 万 * 0.5 + 100 万 * 8 = 1.2 + 0.2 + 8
    expect(costOf(r, table).yuan).toBeCloseTo(9.4, 6);
    expect(costOf(r, table).basis).toBe('pricing');
  });

  it('单价表校验', () => {
    expect(() => parsePricing({ models: { a: { input: -1, output: 1 } } })).toThrow();
    expect(() => parsePricing([])).toThrow();
    expect(parsePricing({ models: { a: { input: 1, output: 2 } } }).models.a.cacheHit).toBe(1);
  });
});

/** 一笔 charge,形状同 cortico 的 Charge。 */
const charge = (currency: string, knownAmount: number, amount: number | null = knownAmount) => ({
  quote: { id: 'q', currency, basis: 'marginal', source: 's', capturedAt: '2026-11-01T00:00:00Z' },
  amount, knownAmount, missing: [], lines: [],
});

describe('charges 优先于单价表', () => {
  const parse = (over: Record<string, unknown>) => {
    const r = parseLine(rec(over));
    if (typeof r === 'string') throw new Error(r);
    return r;
  };

  it('有美元 charges 就按汇率折算,不看单价表', () => {
    const r = parse({ attempt: { id: 'a1', charges: [charge('USD', 0.01)] } });
    const c = costOf(r, table, { USD: 7 });
    expect(c).toMatchObject({ basis: 'charges', partial: false });
    expect(c.yuan).toBeCloseTo(0.07, 9);
  });

  it('attempt.charges 优先于记录上的 charges', () => {
    const r = parse({ attempt: { id: 'a2', charges: [charge('CNY', 1)] }, charges: [charge('CNY', 99)] });
    expect(costOf(r, table).yuan).toBe(1);
  });

  it('没有汇率时算不出,也不回落到单价表', () => {
    const r = parse({ charges: [charge('USD', 0.01)] });
    expect(costOf(r, table)).toMatchObject({ yuan: null, basis: 'charges', reason: 'USD 没有设汇率' });
  });

  it('charges 为空数组时回落到单价表;amount 为 null 记为部分', () => {
    expect(costOf(parse({ charges: [] }), table).basis).toBe('pricing');
    const p = costOf(parse({ charges: [charge('CNY', 0.5, null)] }), table);
    expect(p).toMatchObject({ yuan: 0.5, partial: true });
  });

  it('charges 形状不对的行算坏行', () => {
    expect(parseLine(rec({ charges: [{ amount: 1 }] }))).toBe('bad');
    expect(parseLine(rec({ charges: 'x' }))).toBe('bad');
  });

  it('聚合里分开统计来源', () => {
    const recs = [
      parse({ charges: [charge('USD', 1)] }),
      parse({}),
      parse({ model: 'nope' }),
    ].map((r) => ({ ...r, hour: 10 }));
    const d = aggregate('2026-11-02', recs, table, { USD: 7 });
    expect(d.basis).toEqual({ charges: 1, pricing: 1, unpriced: 1, partial: 0 });
    expect(d.spent).toBeCloseTo(7 + 10, 4);
    expect(d.unpriced).toEqual(['nope']);
  });
});

describe('告警线状态机', () => {
  it('同一条线只触发一次,回落再越过才再触发', () => {
    const levels = [0.8, 1];
    let fired = new Set<number>();
    const step = (ratio: number) => {
      const r = evaluate(levels, fired, ratio);
      fired = r.fired;
      return r.fire;
    };
    expect(step(0.5)).toBeNull();
    expect(step(0.85)).toBe(0.8);
    expect(step(0.9)).toBeNull();
    expect(step(0.95)).toBeNull();
    expect(step(0.7)).toBeNull(); // 回落,0.8 复位
    expect(step(0.81)).toBe(0.8); // 再越过
    expect(step(1.2)).toBe(1);
    expect(step(1.5)).toBeNull();
  });

  it('一次越过多条只报最高的', () => {
    const r = evaluate([0.5, 0.8, 1], new Set(), 0.9);
    expect(r.fire).toBe(0.8);
    expect([...r.fired]).toEqual([0.5, 0.8]);
  });

  it('规范化告警线', () => {
    expect(normalizeLevels([1, 0.8, 0.8])).toEqual([0.8, 1]);
    expect(typeof normalizeLevels([])).toBe('string');
    expect(typeof normalizeLevels([0])).toBe('string');
  });
});

let dir: string;
let file: string;
let now: Date;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'budget-'));
  file = join(dir, 'usage.jsonl');
  now = new Date('2026-11-02T12:00:00+08:00');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('增量读账本', () => {
  it('账本不存在时报 missing,不当作 0', async () => {
    const r = await new LedgerReader(file, () => TZ, () => now).read();
    expect(r.ok).toBe(false);
    expect(r.problem?.kind).toBe('missing');
  });

  it('只读新增部分;半行等补全;按 recordId 去重;只留今天', async () => {
    const reader = new LedgerReader(file, () => TZ, () => now);
    const dup = rec({ recordId: 'same' });
    await writeFile(file, `\n${rec()}\n\n${rec({ ts: '2026-11-01T23:59:00+08:00' })}\n${dup}\n`);
    let s = await reader.read();
    expect(s.ok).toBe(true);
    expect(s.records).toHaveLength(2);
    const firstBytes = s.bytesRead;

    const half = rec();
    await appendFile(file, `\n${dup}\n${half.slice(0, 20)}`);
    s = await reader.read();
    expect(s.records).toHaveLength(2);
    expect(s.bytesRead).toBeLessThan(firstBytes);

    await appendFile(file, `${half.slice(20)}\n`);
    s = await reader.read();
    expect(s.records).toHaveLength(3);
  });

  it('文件被清空后从头读', async () => {
    const reader = new LedgerReader(file, () => TZ, () => now);
    await writeFile(file, `${rec()}\n${rec()}\n`);
    expect((await reader.read()).records).toHaveLength(2);
    await truncate(file, 0);
    await writeFile(file, `${rec()}\n`);
    expect((await reader.read()).records).toHaveLength(1);
  });

  it('坏行多了报 malformed;偶尔一行撕裂的照常算', async () => {
    await writeFile(file, `${rec()}\n{"torn\n${rec()}\n`);
    const ok = await new LedgerReader(file, () => TZ, () => now).read();
    expect(ok.ok).toBe(true);
    expect(ok.badLines).toBe(1);

    await writeFile(file, 'not json\nnope\n{}\n');
    const bad = await new LedgerReader(file, () => TZ, () => now).read();
    expect(bad.ok).toBe(false);
    expect(bad.problem?.kind).toBe('malformed');
  });

  it('跨天后昨天的不算', async () => {
    const reader = new LedgerReader(file, () => TZ, () => now);
    await writeFile(file, `${rec()}\n`);
    expect((await reader.read()).records).toHaveLength(1);
    now = new Date('2026-11-03T00:10:00+08:00');
    expect((await reader.read()).records).toHaveLength(0);
  });
});

describe('World', () => {
  function fakeHost(events: Array<{ type: string; meta?: Record<string, unknown> }>): WorldHost {
    const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, emit() {}, child() { return log; } };
    return {
      pushEvent: async (e: { type: string; meta?: Record<string, unknown> }) => { events.push(e); return e; },
      log,
    } as unknown as WorldHost;
  }

  async function world(cfg: Partial<BudgetConfig> = {}) {
    const pricing = join(dir, 'default-pricing.json');
    await writeFile(pricing, JSON.stringify({ models: { 'm-exact': { input: 1, cacheHit: 1, output: 0 } } }));
    return new BudgetWorld({ cfg: { ...defaultConfig(), ...cfg }, timezone: TZ, dataDir: dir, now: () => now, defaultPricingPath: pricing });
  }

  it('账本不存在时工具返回 ok:false', async () => {
    const w = await world({ dailyYuan: 10 });
    const out = await w.tools().find((t) => t.name === 'budget_status')!.handler({}, { role: 'x', log: console as never });
    expect(typeof out === 'string' ? out : out.text).toContain('"ok": false');
  });

  it('每条线只推一次事件;重启不重复;预算调高回落后再越过才再推', async () => {
    const events: Array<{ type: string; meta?: Record<string, unknown> }> = [];
    const w = await world({ dailyYuan: 10 });
    await w.start(fakeHost(events));
    await writeFile(file, lines(8)); // 8 元
    await w.check();
    await w.check();
    expect(events.map((e) => e.meta?.level)).toEqual([0.8]);
    expect(events[0]).toMatchObject({ type: EVENT_TYPE, meta: { spent: 8, budget: 10 } });

    // 重启:状态落盘,不重复推
    await w.stop();
    const w2 = await world({ dailyYuan: 10 });
    await w2.start(fakeHost(events));
    await w2.check();
    expect(events).toHaveLength(1);

    // 调高预算,回落到 0.8 线以下;再加花费越过
    await w2.setBudget(20);
    await appendFile(file, lines(9)); // 17 元 / 20 = 0.85
    await w2.check();
    expect(events.map((e) => e.meta?.level)).toEqual([0.8, 0.8]);
    await w2.stop();
  });

  it('budget_status 形状', async () => {
    const w = await world({ dailyYuan: 10 });
    await writeFile(file, `${rec()}\n${rec({ model: 'unknown' })}\n`);
    const s = await w.check();
    if (!s.ok) throw new Error(s.reason);
    expect(s).toMatchObject({ spent: 1, budget: 10, remaining: 9, unpriced: ['unknown'] });
    expect(s.byHour).toHaveLength(24);
    expect(s.byHour[10]).toBe(1);
    expect(s.byModel.unknown.yuan).toBeNull();
  });
});
