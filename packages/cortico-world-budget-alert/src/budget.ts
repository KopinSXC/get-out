/**
 * 预算的纯逻辑部分:单价表、增量读账本、按日聚合、告警线状态机。
 * 读文件只用 fs/promises;不联网。
 */
import { open, stat } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// 单价表
// ---------------------------------------------------------------------------

/** 人民币元 / 百万 token。 */
export interface ModelPrice {
  input: number;
  cacheHit: number;
  output: number;
}

export interface PricingTable {
  note?: string;
  models: Record<string, ModelPrice>;
}

/** 校验并规范化单价表;不合格抛错,错误信息给人看。 */
export function parsePricing(value: unknown): PricingTable {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('单价表要是一个 JSON 对象');
  const v = value as Record<string, unknown>;
  const models = v.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error('单价表缺 models 对象');
  const out: Record<string, ModelPrice> = {};
  for (const [name, raw] of Object.entries(models as Record<string, unknown>)) {
    if (!name.trim()) throw new Error('模型名不能为空');
    if (!raw || typeof raw !== 'object') throw new Error(`${name} 的单价要是对象`);
    const p = raw as Record<string, unknown>;
    const price: Partial<ModelPrice> = {};
    for (const k of ['input', 'cacheHit', 'output'] as const) {
      const n = p[k] ?? (k === 'cacheHit' ? p.input : undefined);
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`${name}.${k} 要是不小于 0 的数字`);
      price[k] = n;
    }
    out[name] = price as ModelPrice;
  }
  return { ...(typeof v.note === 'string' ? { note: v.note } : {}), models: out };
}

/** 精确名优先,其次是最长的 `前缀*`。找不到返回 null。 */
export function priceFor(table: PricingTable, model: string): ModelPrice | null {
  const exact = table.models[model];
  if (exact) return exact;
  let best: { len: number; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(table.models)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (model.startsWith(prefix) && (!best || prefix.length > best.len)) best = { len: prefix.length, price };
  }
  return best?.price ?? null;
}

// ---------------------------------------------------------------------------
// 账本记录
// ---------------------------------------------------------------------------

/** 一条记录里 provider 实扣的一笔费用(来自 attempt.charges 或 charges)。 */
export interface LineCharge {
  /** PriceSnapshot.currency,如 USD、CNY。 */
  currency: string;
  /** Charge.knownAmount:能算出来的部分。 */
  amount: number;
  /** Charge.amount 为 null:有计量项没有价,amount 只是下限。 */
  partial: boolean;
}

/** 账本一行里用得到的字段。 */
export interface UsageLine {
  id?: string;
  /** 有就按它计费;空数组或缺省才回落到单价表。 */
  charges?: LineCharge[];
  ts: string;
  model: string;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** 与 cortico 的 recordCharges 同一取法:attempt.charges 优先,其次记录上的 charges。 */
function chargesOf(r: Record<string, unknown>): LineCharge[] | 'bad' | undefined {
  const attempt = r.attempt as { charges?: unknown } | undefined;
  const raw = attempt?.charges ?? r.charges;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return 'bad';
  const out: LineCharge[] = [];
  for (const c of raw as Array<Record<string, unknown>>) {
    const quote = c?.quote as { currency?: unknown } | undefined;
    const known = num(c?.knownAmount);
    if (typeof quote?.currency !== 'string' || known === null) return 'bad';
    out.push({ currency: quote.currency.toUpperCase(), amount: known, partial: c.amount === null });
  }
  return out;
}

/** 一行 → 记录;空行返回 'blank',解析不了或缺字段返回 'bad'。 */
export function parseLine(line: string): UsageLine | 'blank' | 'bad' {
  const s = line.trim();
  if (!s) return 'blank';
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return 'bad';
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'bad';
  const prompt = num(r.promptTokens);
  const completion = num(r.completionTokens);
  if (typeof r.ts !== 'string' || typeof r.model !== 'string' || prompt === null || completion === null) return 'bad';
  if (Number.isNaN(Date.parse(r.ts))) return 'bad';
  const attempt = r.attempt as { id?: unknown } | undefined;
  const id = typeof r.recordId === 'string' ? r.recordId : typeof attempt?.id === 'string' ? attempt.id : undefined;
  const charges = chargesOf(r);
  if (charges === 'bad') return 'bad';
  return {
    ...(id ? { id } : {}),
    ...(charges && charges.length ? { charges } : {}),
    ts: r.ts,
    model: r.model,
    promptTokens: prompt,
    cacheHitTokens: Math.min(num(r.cacheHitTokens) ?? 0, prompt),
    completionTokens: completion,
    reasoningTokens: num(r.reasoningTokens) ?? 0,
  };
}

/** 币种 → 1 单位折合多少人民币。CNY 恒为 1。 */
export type Rates = Readonly<Record<string, number>>;

export interface Cost {
  /** 人民币元;null = 算不出来(没有单价,或币种没有汇率),不计入 spent。 */
  yuan: number | null;
  basis: 'charges' | 'pricing';
  /** 按 charges 算,但有计量项没有价:yuan 只是下限。 */
  partial: boolean;
  /** yuan 为 null 时的原因。 */
  reason?: string;
}

/**
 * 一条记录的费用。有 charges 就用 charges(provider 实扣,按汇率折成人民币);
 * 没有才按单价表和 token 数算。reasoningTokens 已含在 completionTokens 里,不重复计。
 */
export function costOf(rec: UsageLine, table: PricingTable, rates: Rates = {}): Cost {
  if (rec.charges?.length) {
    let yuan = 0;
    let partial = false;
    for (const c of rec.charges) {
      const rate = c.currency === 'CNY' ? 1 : rates[c.currency];
      if (!(typeof rate === 'number' && rate > 0)) {
        return { yuan: null, basis: 'charges', partial: false, reason: `${c.currency} 没有设汇率` };
      }
      yuan += c.amount * rate;
      partial ||= c.partial;
    }
    return { yuan, basis: 'charges', partial };
  }
  const p = priceFor(table, rec.model);
  if (!p) return { yuan: null, basis: 'pricing', partial: false, reason: '单价表里没有这个模型' };
  const miss = Math.max(0, rec.promptTokens - rec.cacheHitTokens);
  return { yuan: (miss * p.input + rec.cacheHitTokens * p.cacheHit + rec.completionTokens * p.output) / 1e6, basis: 'pricing', partial: false };
}

// ---------------------------------------------------------------------------
// 时区
// ---------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timezone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    });
    fmtCache.set(timezone, f);
  }
  return f;
}

/** 部署时区下的 { date: YYYY-MM-DD, hour: 0..23 }。 */
export function localDay(timezone: string, d: Date): { date: string; hour: number } {
  const parts = fmt(timezone).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

// ---------------------------------------------------------------------------
// 增量读账本
// ---------------------------------------------------------------------------

export type LedgerProblem = { kind: 'missing' } | { kind: 'unreadable'; message: string } | { kind: 'malformed'; bad: number; total: number };

export interface LedgerSnapshot {
  ok: boolean;
  problem?: LedgerProblem;
  /** 今天(部署时区)的记录。 */
  date: string;
  records: readonly (UsageLine & { hour: number })[];
  badLines: number;
  totalLines: number;
  bytesRead: number;
}

const CHUNK = 1024 * 1024;
/** 坏行超过这个比例(且至少 3 行)就认为账本格式坏了。 */
const BAD_RATIO = 0.05;

/**
 * 记住读到哪儿;文件变小(被清空或改写)或换了文件就从头读。
 * 只保留今天的记录,跨天自动丢掉昨天的。同一 recordId 只算一次。
 */
export class LedgerReader {
  private offset = 0;
  private ino = -1;
  private rest = '';
  private date = '';
  private today: Array<UsageLine & { hour: number }> = [];
  private seen = new Set<string>();
  private badLines = 0;
  private totalLines = 0;
  private bytesRead = 0;
  private reading: Promise<LedgerSnapshot> | null = null;
  private readonly file: string;
  private readonly timezone: () => string;
  private readonly now: () => Date;

  constructor(file: string, timezone: () => string, now: () => Date = () => new Date()) {
    this.file = file;
    this.timezone = timezone;
    this.now = now;
  }

  private reset(): void {
    this.offset = 0;
    this.rest = '';
    this.today = [];
    this.seen.clear();
    this.badLines = 0;
    this.totalLines = 0;
  }

  /** 读新增部分并返回今天的快照;并发调用共用同一次读取。 */
  read(): Promise<LedgerSnapshot> {
    this.reading ??= this.doRead().finally(() => { this.reading = null; });
    return this.reading;
  }

  private take(line: string): void {
    const r = parseLine(line);
    if (r === 'blank') return;
    this.totalLines++;
    if (r === 'bad') {
      this.badLines++;
      return;
    }
    const day = localDay(this.timezone(), new Date(r.ts));
    if (day.date !== this.date) return;
    if (r.id) {
      if (this.seen.has(r.id)) return;
      this.seen.add(r.id);
    }
    this.today.push({ ...r, hour: day.hour });
  }

  private async doRead(): Promise<LedgerSnapshot> {
    const { date } = localDay(this.timezone(), this.now());
    let s;
    try {
      s = await stat(this.file);
    } catch (err) {
      this.reset();
      this.date = date;
      const code = (err as NodeJS.ErrnoException).code;
      return this.snapshot(code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', message: (err as Error).message });
    }
    // 跨天:今天的记录可能就在已读过的位置之后,也可能早就写进来了(时间戳早于读取时刻),只能从头再扫一遍
    if (date !== this.date || s.size < this.offset || (this.ino !== -1 && s.ino !== this.ino)) {
      this.reset();
      this.date = date;
    }
    this.ino = s.ino;
    this.bytesRead = 0;
    if (s.size > this.offset) {
      let fh;
      try {
        fh = await open(this.file, 'r');
        const buf = Buffer.alloc(CHUNK);
        let pos = this.offset;
        let pending = Buffer.from(this.rest, 'utf8');
        while (pos < s.size) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, s.size - pos), pos);
          if (bytesRead === 0) break;
          pos += bytesRead;
          this.bytesRead += bytesRead;
          const data = pending.length ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
          let start = 0;
          for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
            this.take(data.toString('utf8', start, nl));
            start = nl + 1;
          }
          pending = Buffer.from(data.subarray(start));
        }
        this.offset = pos;
        // 末尾没有换行的半行先留着,等下次补全;它是正在写入的那一行
        this.rest = pending.toString('utf8');
      } catch (err) {
        return this.snapshot({ kind: 'unreadable', message: (err as Error).message });
      } finally {
        await fh?.close();
      }
    }
    const malformed = this.badLines > 0 && (this.badLines === this.totalLines
      || (this.badLines >= 3 && this.badLines / this.totalLines > BAD_RATIO));
    return this.snapshot(malformed ? { kind: 'malformed', bad: this.badLines, total: this.totalLines } : undefined);
  }

  private snapshot(problem?: LedgerProblem): LedgerSnapshot {
    return {
      ok: !problem, ...(problem ? { problem } : {}),
      date: this.date, records: this.today, badLines: this.badLines, totalLines: this.totalLines, bytesRead: this.bytesRead,
    };
  }
}

export function problemText(p: LedgerProblem, file: string): string {
  if (p.kind === 'missing') return `账本不存在:${file}(bot 还没产生过模型调用,或数据目录不对)`;
  if (p.kind === 'unreadable') return `账本读不了:${p.message}`;
  return `账本格式坏了:${p.total} 行里有 ${p.bad} 行解析不了`;
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

export interface ModelSpend {
  calls: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** null = 至少有一次调用算不出费用,这个模型的费用不完整;能算出的部分仍计入 spent。 */
  yuan: number | null;
  /** 能算出来的那部分,yuan 为 null 时也有。 */
  knownYuan: number;
  /** 按 charges 计费的调用数。 */
  byCharges: number;
  /** 按单价表计费的调用数。 */
  byPricing: number;
  /** charges 不完整(只是下限)的调用数。 */
  partial: number;
  /** 算不出费用的调用数与原因。 */
  unpricedCalls: number;
  reasons: string[];
}

export interface DaySpend {
  date: string;
  spent: number;
  byModel: Record<string, ModelSpend>;
  /** 24 个小时,每小时花了多少(部署时区)。 */
  byHour: number[];
  /** 有调用算不出费用的模型;spent 不含那些调用,所以实际花费更高。 */
  unpriced: string[];
  /** 按 charges / 单价表 / 算不出 的调用数。 */
  basis: { charges: number; pricing: number; unpriced: number; partial: number };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function aggregate(
  date: string, records: readonly (UsageLine & { hour: number })[], table: PricingTable, rates: Rates = {},
): DaySpend {
  const byModel: Record<string, ModelSpend> = {};
  const byHour = Array.from({ length: 24 }, () => 0);
  const basis = { charges: 0, pricing: 0, unpriced: 0, partial: 0 };
  let spent = 0;
  for (const r of records) {
    const m = (byModel[r.model] ??= {
      calls: 0, promptTokens: 0, cacheHitTokens: 0, completionTokens: 0, reasoningTokens: 0,
      yuan: 0, knownYuan: 0, byCharges: 0, byPricing: 0, partial: 0, unpricedCalls: 0, reasons: [],
    });
    m.calls++;
    m.promptTokens += r.promptTokens;
    m.cacheHitTokens += r.cacheHitTokens;
    m.completionTokens += r.completionTokens;
    m.reasoningTokens += r.reasoningTokens;
    const c = costOf(r, table, rates);
    if (c.yuan === null) {
      m.yuan = null;
      m.unpricedCalls++;
      basis.unpriced++;
      if (c.reason && !m.reasons.includes(c.reason)) m.reasons.push(c.reason);
      continue;
    }
    if (c.basis === 'charges') { m.byCharges++; basis.charges++; } else { m.byPricing++; basis.pricing++; }
    if (c.partial) { m.partial++; basis.partial++; }
    m.knownYuan += c.yuan;
    if (m.yuan !== null) m.yuan += c.yuan;
    spent += c.yuan;
    byHour[r.hour] += c.yuan;
  }
  for (const m of Object.values(byModel)) {
    m.knownYuan = round4(m.knownYuan);
    if (m.yuan !== null) m.yuan = round4(m.yuan);
  }
  return {
    date,
    spent: round4(spent),
    byModel,
    byHour: byHour.map(round4),
    unpriced: Object.entries(byModel).filter(([, m]) => m.yuan === null).map(([k]) => k).sort(),
    basis,
  };
}
// ---------------------------------------------------------------------------
// 告警线
// ---------------------------------------------------------------------------

/** 规范化百分比线:去重、升序、限定在 (0, 10]。 */
export function normalizeLevels(v: unknown): number[] | string {
  if (!Array.isArray(v) || v.length === 0) return 'alertAt 要是非空数组,如 [0.8, 1.0]';
  if (v.length > 10) return 'alertAt 最多 10 条线';
  const out = new Set<number>();
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0 || x > 10) return 'alertAt 每项要是 (0, 10] 之间的小数,1.0 = 100%';
    out.add(Math.round(x * 1e4) / 1e4);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 每条线是一个两态开关:未触发 → 花费越过这条线时触发一次,变成已触发;
 * 已触发 → 只有花费回落到线以下才复位,复位后再越过才会再次触发。
 * 一次越过多条线时只报最高的那条,其余一并记为已触发。
 */
export function evaluate(levels: readonly number[], fired: ReadonlySet<number>, ratio: number): { fire: number | null; fired: Set<number> } {
  const next = new Set<number>();
  let fire: number | null = null;
  for (const level of levels) {
    if (ratio >= level) {
      next.add(level);
      if (!fired.has(level)) fire = level;
    }
  }
  return { fire, fired: next };
}
