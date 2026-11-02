/**
 * 快照 World:把 SnapshotStore 包成四个工具、一个配置组和一个只读列表面板。
 * 配置每次调用时现读,改了工作区根或保留个数不用重启。
 */
import { isAbsolute, resolve } from 'node:path';
import type {
  ConfigGroup, ToolDef, ToolOutcome, ToolSpec, World, WorldHost, WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { SnapshotStore, isValidId } from './snapshot.ts';

export const WORLD_ID = 'snapshot';
const CFG = `worlds.${WORLD_ID}`;

export interface SnapshotConfig {
  enabled: boolean;
  /** 工作区根;相对路径按部署目录解析。缺省 workspace;留空 = 整个部署目录。 */
  root: string;
  /** 普通快照最多保留几个。 */
  maxSnapshots: number;
}

export const DEFAULT_MAX_SNAPSHOTS = 30;
/** 缺省只拍部署目录下的 workspace/,不碰 config.json、.env、data/ 和别家的 snapshots/。 */
export const DEFAULT_ROOT = 'workspace';

export function defaultConfig(): SnapshotConfig {
  return { enabled: false, root: DEFAULT_ROOT, maxSnapshots: DEFAULT_MAX_SNAPSHOTS };
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'snapshot_create',
    description: '给当前工作区拍一份时间点快照(完整拷贝,跳过 node_modules、.git、tmp-*、snapshots/ 本身、超过 100MB 的单文件和 archive/ 里超过 50MB 的文件)。返回快照 id 和统计。超出保留上限时会删掉最旧的普通快照。',
    parameters: {
      type: 'object',
      properties: { note: { type: 'string', description: '可选备注,说明为什么拍这份' } },
      additionalProperties: false,
    },
    tags: ['write'],
  },
  {
    name: 'snapshot_list',
    description: '列出最近 20 份快照,按时间倒序,每条含 id、createdAt、note、fileCount、totalBytes。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    tags: ['read', 'snapshot'],
  },
  {
    name: 'snapshot_restore',
    description: '把工作区回滚到指定快照。会先把当前状态自动备份为 pre-restore-<时间戳>,然后逐个文件补上、覆盖、删除;不会整目录删除,快照当时跳过的文件不碰。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '快照 id,来自 snapshot_list' } },
      required: ['id'],
      additionalProperties: false,
    },
    tags: ['act'],
  },
  {
    name: 'snapshot_delete',
    description: '删除一份快照的整个目录,不可恢复。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '快照 id,来自 snapshot_list' } },
      required: ['id'],
      additionalProperties: false,
    },
    tags: ['write'],
  },
];

export const TOOL_SUMMARIES: Record<string, string> = {
  snapshot_create: '拍一份工作区快照',
  snapshot_list: '列出最近的快照',
  snapshot_restore: '先备份当前状态,再回滚到某份快照',
  snapshot_delete: '删除一份快照',
};

export interface SnapshotWorldOptions {
  cfg: SnapshotConfig;
  timezone: string;
  dataDir: string;
  /** 部署目录,工作区根的缺省值。 */
  botDir: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
const fail = (reason: string): ToolOutcome => ({ text: json({ ok: false, reason }), failed: true });
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class SnapshotWorld implements World {
  readonly id = WORLD_ID;
  private readonly cfg: SnapshotConfig;
  private readonly timezone: string;
  private readonly botDir: string;
  private host: WorldHost | null = null;
  private cached: { root: string; store: SnapshotStore } | null = null;

  constructor(opts: SnapshotWorldOptions) {
    this.cfg = opts.cfg;
    this.timezone = opts.timezone;
    this.botDir = opts.botDir;
  }

  /** 当前配置下的工作区根(绝对路径)。 */
  root(): string {
    const raw = (this.cfg.root ?? '').trim();
    if (!raw) return resolve(this.botDir);
    return isAbsolute(raw) ? resolve(raw) : resolve(this.botDir, raw);
  }

  /** 工作区根变了就换一个 store;同一个根上的操作共用一条串行链。 */
  store(): SnapshotStore {
    const root = this.root();
    if (this.cached?.root !== root) {
      this.cached = {
        root,
        store: new SnapshotStore({
          root,
          timezone: this.timezone,
          maxSnapshots: () => (Number.isFinite(this.cfg.maxSnapshots) && this.cfg.maxSnapshots > 0
            ? this.cfg.maxSnapshots : DEFAULT_MAX_SNAPSHOTS),
        }),
      };
    }
    return this.cached.store;
  }

  tools(): ToolDef[] {
    const handlers: Record<string, ToolDef['handler']> = {
      snapshot_create: async (args) => {
        const note = typeof args.note === 'string' ? args.note.trim().slice(0, 500) : undefined;
        try {
          const r = await this.store().create(note || undefined);
          return json({
            ok: true, id: r.id, createdAt: r.createdAt, fileCount: r.fileCount, totalBytes: r.totalBytes,
            skippedCount: r.skippedCount, skipped: r.skipped.slice(0, 20), pruned: r.pruned,
          });
        } catch (err) {
          this.host?.log.error(`snapshot_create 失败: ${errMsg(err)}`);
          return fail(errMsg(err));
        }
      },
      snapshot_list: async () => {
        try {
          const list = await this.store().list();
          return json({
            ok: true,
            snapshots: list.map(({ id, createdAt, note, fileCount, totalBytes, complete }) => ({
              id, createdAt, ...(note ? { note } : {}), fileCount, totalBytes, ...(complete ? {} : { incomplete: true }),
            })),
          });
        } catch (err) {
          return fail(errMsg(err));
        }
      },
      snapshot_restore: async (args) => {
        if (!isValidId(args.id)) return fail('id 格式不对,应来自 snapshot_list');
        try {
          const r = await this.store().restore(args.id);
          return json({
            ok: r.errors.length === 0, id: r.id, backupId: r.backupId,
            added: r.added.length, changed: r.changed.length, removed: r.removed.length, unchanged: r.unchanged,
            errors: r.errors.slice(0, 20),
          });
        } catch (err) {
          this.host?.log.error(`snapshot_restore 失败: ${errMsg(err)}`);
          return fail(errMsg(err));
        }
      },
      snapshot_delete: async (args) => {
        if (!isValidId(args.id)) return fail('id 格式不对,应来自 snapshot_list');
        try {
          return json({ ok: true, ...(await this.store().delete(args.id)) });
        } catch (err) {
          return fail(errMsg(err));
        }
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
        title: '工作区快照',
        properties: {
          [`${CFG}.root`]: {
            type: 'string',
            title: '工作区根',
            description: '要拍快照的目录,快照存在它下面的 snapshots/。相对路径按部署目录解析,缺省 workspace。留空 = 整个部署目录(会包含 config.json、data/,回滚会改到它们)。',
            'x-path': { kind: 'directory' },
            'x-hot': true,
          },
          [`${CFG}.maxSnapshots`]: {
            type: 'integer',
            title: '最多保留几份',
            description: '普通快照超出时删最旧的;回滚前的自动备份(pre-restore-*)不计入、永远保留。',
            minimum: 1,
            maximum: 1000,
            'x-suffix': '份',
            'x-hot': true,
          },
        },
      },
    };
  }

  webUi(): WorldWebUiDecl {
    return {
      config: [this.configGroup()],
      panels: [{ id: 'list', title: '快照列表', description: '最近 20 份快照,可回滚或删除', getMethods: ['list'] }],
      invoke: async (panel, method, args) => {
        if (panel !== 'list') throw new Error(`未知面板: ${panel}`);
        const store = this.store();
        if (method === 'list') return { root: store.root, snapshots: await store.list() };
        const id = args[0];
        if (!isValidId(id)) throw new Error('id 格式不对');
        if (method === 'restore') return store.restore(id);
        if (method === 'delete') return store.delete(id);
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
