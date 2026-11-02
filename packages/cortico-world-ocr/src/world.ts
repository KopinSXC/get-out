/**
 * OCR World:ocr_screen / ocr_find 两个工具,一个开关配置组,一个「试一下」面板。
 * 配置每次调用时现读,不用重启。
 */
import type {
  ConfigGroup, ToolCallContext, ToolDef, ToolOutcome, ToolSpec, World, WorldHost, WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { findMatches, formatMatches, formatRows, mergeRows, toScreen, type RawResult, type Row } from './layout.ts';
import { runOcr, supported, type OcrRequest } from './ocr.ts';

export const WORLD_ID = 'ocr';
const CFG = `worlds.${WORLD_ID}`;

export interface OcrConfig {
  enabled: boolean;
  /** 总开关:关掉后两个工具都直接拒绝,不截屏。 */
  allow: boolean;
  /** 默认缩放倍数,工具参数 scale 不给时用。最终仍受长边 1600 限制。 */
  defaultScale: number;
  /** true = 只截前台窗口;false = 截前台窗口所在的整个显示器。 */
  foregroundOnly: boolean;
  /** OCR 语言标签,如 zh-Hans-CN、en-US;留空 = 跟随系统用户语言。 */
  language: string;
  timeoutSec: number;
}

export function defaultConfig(): OcrConfig {
  return { enabled: false, allow: true, defaultScale: 1, foregroundOnly: false, language: '', timeoutSec: 20 };
}

const REGION_SCHEMA = {
  type: 'object',
  description: '只识别这块屏幕区域,屏幕原始像素坐标(多显示器时可为负)。不给就按配置截前台窗口或其所在显示器。',
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
    w: { type: 'integer', minimum: 1 },
    h: { type: 'integer', minimum: 1 },
  },
  required: ['x', 'y', 'w', 'h'],
  additionalProperties: false,
};

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'ocr_screen',
    description: '用 Windows 自带 OCR 读屏幕上的文字,不发图片、不调视觉模型。返回按行合并的纯文本,每行前面是 x,y,w,h(屏幕原始像素)。只能读文字:图标、颜色、勾选状态、图片内容都读不到。超过 8000 字会截断并注明位置,可以用 region 缩小范围。',
    parameters: {
      type: 'object',
      properties: {
        region: REGION_SCHEMA,
        scale: { type: 'number', minimum: 0.25, maximum: 4, description: '识别前的缩放倍数,小字可以给 2;最终长边不超过 1600' },
      },
      additionalProperties: false,
    },
    tags: ['read'],
  },
  {
    name: 'ocr_find',
    description: '在屏幕文字里找某段字,返回每处匹配的 x,y,w,h 和中心点(屏幕原始像素),用来定位按钮、菜单项、输入框标签。pattern 按不区分大小写的正则匹配,不是合法正则就当普通文字。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1, description: '要找的文字或正则,如「确定」「保存|Save」' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    tags: ['read'],
  },
];

export const TOOL_SUMMARIES: Record<string, string> = {
  ocr_screen: '用本机 OCR 把屏幕文字读成带坐标的纯文本',
  ocr_find: '在屏幕上找一段文字的位置',
};

export interface OcrWorldOptions {
  cfg: OcrConfig;
  timezone: string;
  dataDir: string;
}

const fail = (reason: string): ToolOutcome => ({ text: JSON.stringify({ ok: false, reason }), failed: true });

function parseRegion(v: unknown): OcrRequest['region'] | string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') return 'region 要是 {x,y,w,h}';
  const r = v as Record<string, unknown>;
  const nums = ['x', 'y', 'w', 'h'].map((k) => r[k]);
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return 'region 的 x,y,w,h 都要是数字';
  const [x, y, w, h] = (nums as number[]).map(Math.round);
  if (w < 1 || h < 1) return 'region 的 w,h 要大于 0';
  if (w > 32768 || h > 32768) return 'region 太大';
  return { x, y, w, h };
}

export class OcrWorld implements World {
  readonly id = WORLD_ID;
  private readonly cfg: OcrConfig;
  private host: WorldHost | null = null;
  /** 同一时刻只跑一个 PowerShell。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: OcrWorldOptions) {
    this.cfg = opts.cfg;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** 截屏并识别;返回合并好的行,或拒绝原因。 */
  async recognize(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ raw: RawResult; rows: Row[] } | { reason: string }> {
    if (!this.cfg.allow) return { reason: 'OCR 已在面板里关闭' };
    if (!supported()) return { reason: `只支持 Windows 10/11,当前平台是 ${process.platform}` };
    const region = parseRegion(args.region);
    if (typeof region === 'string') return { reason: region };
    let scale = typeof args.scale === 'number' && Number.isFinite(args.scale) ? args.scale : Number(this.cfg.defaultScale);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    scale = Math.min(4, Math.max(0.25, scale));
    const timeoutSec = Number(this.cfg.timeoutSec);
    const timeoutMs = Math.min(120, Math.max(5, Number.isFinite(timeoutSec) ? timeoutSec : 20)) * 1000;
    const language = (this.cfg.language ?? '').trim();

    if (signal?.aborted) return { reason: '已取消' };
    const res = await this.serial(() => runOcr({
      ...(region ? { region } : {}),
      scale,
      foregroundOnly: !!this.cfg.foregroundOnly,
      ...(language ? { language } : {}),
    }, { timeoutMs, signal }));
    if (!res.ok) {
      this.host?.log.warn(`OCR 失败: ${res.reason}`);
      return { reason: res.reason };
    }
    return { raw: res, rows: mergeRows(toScreen(res)) };
  }

  tools(): ToolDef[] {
    const handlers: Record<string, ToolDef['handler']> = {
      ocr_screen: async (args, ctx: ToolCallContext) => {
        const r = await this.recognize(args, ctx.signal);
        if ('reason' in r) return fail(r.reason);
        return formatRows(r.raw, r.rows);
      },
      ocr_find: async (args, ctx: ToolCallContext) => {
        const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
        if (!pattern) return fail('pattern 不能为空');
        if (pattern.length > 200) return fail('pattern 太长');
        const r = await this.recognize({}, ctx.signal);
        if ('reason' in r) return fail(r.reason);
        return formatMatches(r.raw, r.rows, pattern, findMatches(r.rows, pattern));
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
        title: '屏幕 OCR',
        description: '用 Windows 自带的 Windows.Media.Ocr 读屏幕文字;截图只在内存里,不落盘,不发图片。',
        properties: {
          [`${CFG}.allow`]: {
            type: 'boolean',
            title: '允许 OCR',
            description: '关掉后 ocr_screen 和 ocr_find 直接拒绝,不会截屏。',
            'x-hot': true,
          },
          [`${CFG}.defaultScale`]: {
            type: 'number',
            title: '默认缩放',
            description: '工具没给 scale 时用。小字多可以调到 1.5 或 2;最终长边仍不超过 1600 像素。',
            minimum: 0.25,
            maximum: 4,
            multipleOf: 0.05,
            'x-suffix': '倍',
            'x-hot': true,
          },
          [`${CFG}.foregroundOnly`]: {
            type: 'boolean',
            title: '只截前台窗口',
            description: '打开:只截当前前台窗口。关闭:截前台窗口所在的整块显示器。',
            'x-hot': true,
          },
          [`${CFG}.language`]: {
            type: 'string',
            title: '识别语言',
            description: '如 zh-Hans-CN、en-US,需要系统装了对应语言的 OCR 组件。留空跟随系统。',
            'x-hot': true,
          },
          [`${CFG}.timeoutSec`]: {
            type: 'integer',
            title: '超时',
            minimum: 5,
            maximum: 120,
            'x-suffix': '秒',
            'x-hot': true,
          },
        },
      },
    };
  }

  webUi(): WorldWebUiDecl {
    const ok = supported();
    return {
      config: [this.configGroup()],
      lamps: [{
        label: 'Windows OCR',
        state: !ok ? 'offline' : this.cfg.allow ? 'online' : 'offline',
        hint: !ok ? `当前平台 ${process.platform} 不支持` : this.cfg.allow ? '可用' : '已关闭',
      }],
      panels: [{ id: 'try', title: '试一下', description: '识别一次当前屏幕,看看模型会收到什么' }],
      invoke: async (panel, method, args) => {
        if (panel !== 'try') throw new Error(`未知面板: ${panel}`);
        if (method === 'status') {
          return { platform: process.platform, supported: ok, allow: this.cfg.allow, foregroundOnly: this.cfg.foregroundOnly, defaultScale: this.cfg.defaultScale };
        }
        if (method === 'run') {
          const pattern = typeof args[0] === 'string' ? args[0].trim() : '';
          const r = await this.recognize({});
          if ('reason' in r) return { ok: false, reason: r.reason };
          const text = pattern
            ? formatMatches(r.raw, r.rows, pattern, findMatches(r.rows, pattern))
            : formatRows(r.raw, r.rows);
          return { ok: true, text, chars: text.length };
        }
        throw new Error(`未知方法: ${method}`);
      },
    };
  }

  envPromptVars(): null {
    return null;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
  }

  async stop(): Promise<void> {
    this.host = null;
  }
}
