/**
 * 预算告警 World:每 60 秒增量读一次 <dataDir>/usage.jsonl,按单价表折算今天的人民币花费,
 * 越过百分比线时推一条 cortico-world.budget-alert 事件。不联网、不用 API Key。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConfigGroup, EventDescribe, ToolDef, ToolOutcome, ToolSpec, World, WorldHost, WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { DeepPartial } from 'cortico/world.ts';
import { nowIso } from 'cortico/core/util.ts';
import {
  LedgerReader, aggregate, evaluate, normalizeLevels, parsePricing, problemText,
  type DaySpend, type PricingTable, type Rates,
} from './budget.ts';

export const WORLD_ID = 'budget-alert';
const CFG = `worlds.${WORLD_ID}`;
export const EVENT_TYPE = 'cortico-world.budget-alert';
export const CHECK_INTERVAL_MS = 60_000;
export const DEFAULT_LEVELS = [0.8, 1.0];

export interface BudgetConfig {
  enabled: boolean;
  /** 日预算,人民币元;0 = 未设置,不告警。 */
  dailyYuan: number;
  /** 占预算的比例,1.0 = 100%。 */
  alertAt: number[];
  /** 1 美元折合多少人民币,用来折算账本里的美元 charges;0 = 没设,美元 charges 算不出、不计入 spent。 */
  usdToCny: number;
}

export function defaultConfig(): BudgetConfig {
  return { enabled: false, dailyYuan: 0, alertAt: [...DEFAULT_LEVELS], usdToCny: 0 };
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'budget_status',
    description: '查今天(部署时区)的模型花费:spent 已花、budget 日预算、remaining 剩余(人民币元),byModel 按模型拆分,byHour 是 24 小时每小时花费。数据来自本机 usage 账本:记录里有 provider 实扣的 charges 就按它(美元按配置的汇率折算),没有才按单价表折算;算不出的模型列在 unpriced 里,不计入 spent。basis 给出各种计费方式的调用数。账本不存在或格式坏了时返回 ok:false 和原因。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    tags: ['read', 'snapshot'],
  },
  {
    name: 'budget_set',
    description: '设置日预算和告警线。alertAt 是占预算的比例数组,1.0 = 100%,不给就保留现在的(缺省 [0.8, 1.0])。每条线只在花费越过时提醒一次,回落到线下再越过才会再提醒。',
    parameters: {
      type: 'object',
      properties: {
        dailyYuan: { type: 'number', exclusiveMinimum: 0, maximum: 1000000, description: '日预算,人民币元' },
        alertAt: {
          type: 'array',
          items: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
          minItems: 1,
          maxItems: 10,
          description: '告警线,占预算的比例,如 [0.5, 0.8, 1.0]',
        },
      },
      required: ['dailyYuan'],
      additionalProperties: false,
    },
    tags: ['write'],
  },
];

export const TOOL_SUMMARIES: Record<string, string> = {
  budget_status: '看今天花了多少钱、还剩多少、按模型拆分',
  budget_set: '设置日预算和告警线',
};

export const EVENTS: readonly EventDescribe[] = [
  {
    type: EVENT_TYPE,
    description: '今天的花费越过某条告警线时推一次,meta 带 {level, spent, budget, ts};同一条线回落后再越过才会再推',
    trigger: 'flush',
  },
];

export interface BudgetWorldOptions {
  cfg: BudgetConfig;
  timezone: string;
  dataDir: string;
  /** 写回 worlds.budget-alert 段;缺省时只改内存里的 cfg。 */
  persist?: (patch: DeepPartial<BudgetConfig>) => void;
  /** 测试用。 */
  now?: () => Date;
  defaultPricingPath?: string;
}

interface AlertState {
  date: string;
  fired: number[];
}

export type StatusPayload =
  | ({ ok: true; budget: number | null; remaining: number | null; ratio: number | null; alertAt: number[]; fired: number[]; badLines: number; checkedAt: string } & DaySpend)
  | { ok: false; reason: string };

const json = (v: unknown) => JSON.stringify(v, null, 2);
const fail = (reason: string): ToolOutcome => ({ text: json({ ok: false, reason }), failed: true });
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (r: number) => `${Math.round(r * 100)}%`;
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class BudgetWorld implements World {
  readonly id = WORLD_ID;
  private readonly cfg: BudgetConfig;
  private readonly timezone: string;
  private readonly dataDir: string;
  private readonly persist: (patch: DeepPartial<BudgetConfig>) => void;
  private readonly now: () => Date;
  readonly ledgerPath: string;
  readonly stateDir: string;
  private readonly defaultPricingPath: string;
  private readonly reader: LedgerReader;
  private host: WorldHost | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private state: AlertState | null = null;

  constructor(opts: BudgetWorldOptions) {
    this.cfg = opts.cfg;
    this.timezone = opts.timezone;
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? (() => new Date());
    this.persist = opts.persist ?? ((patch) => { Object.assign(this.cfg, patch); });
    this.ledgerPath = join(this.dataDir, 'usage.jsonl');
    this.stateDir = join(this.dataDir, 'budget-alert');
    this.defaultPricingPath = opts.defaultPricingPath ?? fileURLToPath(new URL('./pricing.json', import.meta.url));
    this.reader = new LedgerReader(this.ledgerPath, () => this.timezone, this.now);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ---- 单价表:部署里的覆盖文件优先,没有就用包里的 src/pricing.json ----

  get pricingOverridePath(): string {
    return join(this.stateDir, 'pricing.json');
  }

  async loadPricing(): Promise<{ table: PricingTable; source: 'override' | 'default' }> {
    try {
      const raw = await readFile(this.pricingOverridePath, 'utf8');
      return { table: parsePricing(JSON.parse(raw)), source: 'override' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`单价表 ${this.pricingOverridePath} 有问题:${errMsg(err)}`);
      }
    }
    return { table: parsePricing(JSON.parse(await readFile(this.defaultPricingPath, 'utf8'))), source: 'default' };
  }

  async savePricing(text: string): Promise<PricingTable> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`不是合法的 JSON:${errMsg(err)}`);
    }
    const table = parsePricing(parsed);
    await this.writeAtomic(this.pricingOverridePath, `${JSON.stringify(table, null, 2)}\n`);
    return table;
  }

  async resetPricing(): Promise<void> {
    await rm(this.pricingOverridePath, { force: true });
  }

  // ---- 告警状态,落盘,重启后不重复提醒 ----

  private get statePath(): string {
    return join(this.stateDir, 'alerts.json');
  }

  private async writeAtomic(file: string, body: string): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, file);
  }

  private async loadState(): Promise<AlertState> {
    if (this.state) return this.state;
    try {
      const s = JSON.parse(await readFile(this.statePath, 'utf8')) as AlertState;
      if (typeof s?.date === 'string' && Array.isArray(s.fired)) this.state = { date: s.date, fired: s.fired.filter((n) => typeof n === 'number') };
    } catch {
      // 没有或坏了都当作从未提醒过
    }
    this.state ??= { date: '', fired: [] };
    return this.state;
  }

  private async saveState(s: AlertState): Promise<void> {
    this.state = s;
    try {
      await this.writeAtomic(this.statePath, `${JSON.stringify(s)}\n`);
    } catch (err) {
      this.host?.log.warn(`告警状态写不进 ${this.statePath}: ${errMsg(err)}`);
    }
  }

  levels(): number[] {
    const v = normalizeLevels(this.cfg.alertAt);
    return typeof v === 'string' ? [...DEFAULT_LEVELS] : v;
  }

  rates(): Rates {
    const usd = Number(this.cfg.usdToCny);
    return Number.isFinite(usd) && usd > 0 ? { USD: usd } : {};
  }

  budget(): number | null {
    const b = Number(this.cfg.dailyYuan);
    return Number.isFinite(b) && b > 0 ? b : null;
  }

  /** 读账本、算今天、按需推事件;返回给工具和面板的读数。 */
  check(): Promise<StatusPayload> {
    return this.serial(async () => {
      const snap = await this.reader.read();
      if (!snap.ok && snap.problem) return { ok: false as const, reason: problemText(snap.problem, this.ledgerPath) };
      let pricing: PricingTable;
      try {
        pricing = (await this.loadPricing()).table;
      } catch (err) {
        return { ok: false as const, reason: errMsg(err) };
      }
      const day = aggregate(snap.date, snap.records, pricing, this.rates());
      const budget = this.budget();
      const levels = this.levels();
      const prev = await this.loadState();
      const prevFired = new Set(prev.date === day.date ? prev.fired : []);
      let fired = [...prevFired].sort((a, b) => a - b);

      if (budget !== null) {
        const ratio = day.spent / budget;
        const r = evaluate(levels, prevFired, ratio);
        fired = [...r.fired].sort((a, b) => a - b);
        if (r.fire !== null) this.emit(r.fire, day.spent, budget);
        const changed = prev.date !== day.date || fired.length !== prev.fired.length || fired.some((x, i) => x !== prev.fired[i]);
        if (changed) await this.saveState({ date: day.date, fired });
      }

      return {
        ok: true as const,
        ...day,
        budget,
        remaining: budget === null ? null : round2(budget - day.spent),
        ratio: budget === null ? null : Math.round((day.spent / budget) * 1e4) / 1e4,
        alertAt: levels,
        fired,
        badLines: snap.badLines,
        checkedAt: nowIso(this.timezone, this.now()),
      };
    });
  }

  private emit(level: number, spent: number, budget: number): void {
    const host = this.host;
    if (!host) return;
    const ts = nowIso(this.timezone, this.now());
    const text = `[预算提醒] 今天的模型花费 ¥${spent.toFixed(2)},已到日预算 ¥${budget.toFixed(2)} 的 ${pct(spent / budget)}(越过 ${pct(level)} 线)。`;
    host.pushEvent(
      { type: EVENT_TYPE, ts, source: this.id, origin: 'internal', text, meta: { level, spent, budget, ts } },
      { trigger: 'flush' },
    ).catch((err: unknown) => host.log.error(`预算提醒事件推送失败: ${errMsg(err)}`));
  }

  /** 改预算与告警线;写回配置后立即重新检查一次。 */
  async setBudget(dailyYuan: unknown, alertAt?: unknown): Promise<StatusPayload | { ok: false; reason: string }> {
    if (typeof dailyYuan !== 'number' || !Number.isFinite(dailyYuan) || dailyYuan <= 0 || dailyYuan > 1_000_000) {
      return { ok: false, reason: 'dailyYuan 要是大于 0 的数字(人民币元)' };
    }
    const patch: DeepPartial<BudgetConfig> = { dailyYuan: Math.round(dailyYuan * 100) / 100 };
    if (alertAt !== undefined) {
      const levels = normalizeLevels(alertAt);
      if (typeof levels === 'string') return { ok: false, reason: levels };
      patch.alertAt = levels;
    }
    this.persist(patch);
    return this.check();
  }

  tools(): ToolDef[] {
    const handlers: Record<string, ToolDef['handler']> = {
      budget_status: async () => {
        const s = await this.check();
        return s.ok ? json(s) : fail(s.reason);
      },
      budget_set: async (args) => {
        const s = await this.setBudget(args.dailyYuan, args.alertAt);
        return s.ok ? json(s) : fail(s.reason);
      },
    };
    return TOOL_SPECS.map((spec) => ({ ...spec, handler: handlers[spec.name] }));
  }

  configGroup(): ConfigGroup {
    return {
      id: `world:${WORLD_ID}`,
      owner: `world:${WORLD_ID}`,
      schema: {
        type: 'object',
        title: '预算告警',
        description: '告警线、单价表在「设置」面板里改。',
        properties: {
          [`${CFG}.dailyYuan`]: {
            type: 'number',
            title: '日预算',
            description: '人民币元,按部署时区的自然日算。0 = 不设预算、不告警。',
            minimum: 0,
            maximum: 1000000,
            multipleOf: 0.01,
            'x-suffix': '元',
            'x-hot': true,
          },
          [`${CFG}.usdToCny`]: {
            type: 'number',
            title: '美元汇率',
            description: '1 美元折合多少人民币,用来折算账本里 provider 按美元实扣的 charges。0 = 没设:美元 charges 算不出,不计入花费,并列进 unpriced。本扩展不联网,汇率要你自己填。',
            minimum: 0,
            maximum: 100,
            multipleOf: 0.0001,
            'x-suffix': '元/美元',
            'x-hot': true,
          },
        },
      },
    };
  }

  webUi(): WorldWebUiDecl {
    return {
      config: [this.configGroup()],
      panels: [
        { id: 'today', title: '今天', description: '今天花了多少、还剩多少、按模型拆', getMethods: ['status'] },
        { id: 'settings', title: '设置', description: '日预算、告警线、单价表', getMethods: ['get'] },
      ],
      invoke: async (panel, method, args) => {
        if (panel === 'today' && method === 'status') return this.check();
        if (panel === 'settings') {
          if (method === 'get') {
            let pricingText = '';
            let source: 'override' | 'default' | 'broken' = 'default';
            let pricingError: string | undefined;
            try {
              const p = await this.loadPricing();
              pricingText = JSON.stringify(p.table, null, 2);
              source = p.source;
            } catch (err) {
              source = 'broken';
              pricingError = errMsg(err);
              pricingText = await readFile(this.pricingOverridePath, 'utf8').catch(() => '');
            }
            return {
              dailyYuan: this.cfg.dailyYuan, alertAt: this.levels(), usdToCny: this.cfg.usdToCny, pricingText, source,
              ...(pricingError ? { pricingError } : {}), ledgerPath: this.ledgerPath, overridePath: this.pricingOverridePath,
            };
          }
          if (method === 'saveBudget') {
            const r = await this.setBudget(args[0], args[1]);
            if (!r.ok) throw new Error(r.reason);
            return { ok: true };
          }
          if (method === 'savePricing') {
            await this.savePricing(String(args[0] ?? ''));
            return { ok: true };
          }
          if (method === 'resetPricing') {
            await this.resetPricing();
            return { ok: true };
          }
        }
        throw new Error(`未知调用: ${panel}.${method}`);
      },
    };
  }

  envPromptVars(): null {
    return null;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const tick = () => {
      this.check().then((s) => {
        if (!s.ok) host.log.debug(`预算检查跳过: ${s.reason}`);
      }, (err: unknown) => host.log.warn(`预算检查失败: ${errMsg(err)}`));
    };
    tick();
    this.timer = setInterval(tick, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.host = null;
    await this.chain.catch(() => undefined);
  }
}
