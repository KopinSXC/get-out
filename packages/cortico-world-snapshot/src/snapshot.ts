/**
 * 快照引擎:扫描工作区、拷贝、列出、回滚、删除、保留策略。
 *
 * 布局:<root>/snapshots/<id>/manifest.json 与 <root>/snapshots/<id>/files/<工作区相对路径>。
 * 只用 fs/promises。凡是要读写的路径都先 path.resolve,再校验仍在允许的根下;
 * 写入与删除前还按 realpath 核对父目录,防止工作区里的符号链接把操作带到根外。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, unlink, utimes, writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const MB = 1024 * 1024;
/** 单文件上限,超过的跳过并记进 skipped。 */
export const MAX_FILE_BYTES = 100 * MB;
/** archive/ 下的单文件上限。 */
export const MAX_ARCHIVE_FILE_BYTES = 50 * MB;
/** 快照目录名,位于工作区根下。 */
export const SNAPSHOTS_DIRNAME = 'snapshots';
/** 按名字跳过的目录或文件。 */
const SKIP_NAMES = new Set(['node_modules', '.git']);
const SKIP_PREFIX = 'tmp-';
/** 含密钥的环境文件:.env 与 .env.*,任何层级都不拷。 */
const isEnvFile = (name: string) => name === '.env' || name.startsWith('.env.');
/** 写进 manifest 的归属标记;不带它的目录不是本扩展拍的,列表、保留策略、删除一律不碰。 */
export const MANIFEST_TOOL = 'cortico-world-snapshot';
export const PRE_RESTORE_PREFIX = 'pre-restore-';
const ID_SHAPE = /^(pre-restore-)?\d{8}-\d{6}(-\d+)?$/;
const MANIFEST = 'manifest.json';
const FILES_DIR = 'files';
/** snapshot_list 返回的条数。 */
export const LIST_LIMIT = 20;

export interface SkippedEntry {
  path: string;
  reason: string;
  bytes?: number;
}

export interface FileEntry {
  path: string;
  bytes: number;
}

export interface Manifest {
  id: string;
  createdAt: string;
  note?: string;
  fileCount: number;
  totalBytes: number;
  sourceRoot: string;
  /** 归属标记,恒为 MANIFEST_TOOL。 */
  tool: typeof MANIFEST_TOOL;
  skipped: SkippedEntry[];
  /** 拷贝完成前为 false;回滚拒绝未完成的快照。 */
  complete: boolean;
  files: FileEntry[];
}

export interface SnapshotSummary {
  id: string;
  createdAt: string;
  note?: string;
  fileCount: number;
  totalBytes: number;
  preRestore: boolean;
  complete: boolean;
}

export interface CreateReport {
  id: string;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
  skippedCount: number;
  skipped: SkippedEntry[];
  /** 按保留策略删掉的旧快照。 */
  pruned: string[];
}

export interface RestoreReport {
  id: string;
  /** 回滚前给当时状态做的备份。 */
  backupId: string;
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
  errors: Array<{ path: string; reason: string }>;
}

/** child 解析后仍在 root 之内(含 root 本身)。 */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 把相对路径落到 root 下;绝对路径、含 .. 段、解析后跳出 root 或等于 root 的一律抛错。 */
export function safeJoin(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel === '') throw new Error('路径为空');
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error(`拒绝绝对路径: ${rel}`);
  if (rel.split(/[\\/]/).some((seg) => seg === '..')) throw new Error(`拒绝含 .. 的路径: ${rel}`);
  const full = resolve(root, rel);
  if (!isInside(root, full) || full === resolve(root)) throw new Error(`路径跳出了允许的目录: ${rel}`);
  return full;
}

/** 部署时区下的 YYYYMMDD-HHmmss。 */
export function stamp(timezone: string, d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_SHAPE.test(id);
}

const toPosix = (p: string) => p.split(sep).join('/');
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** 两个文件内容相同:先比大小,再比哈希。 */
async function sameContent(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return ha === hb;
}

/** 文件类型:不存在为 null,符号链接不跟随。 */
async function kindOf(p: string): Promise<'file' | 'dir' | 'link' | 'other' | null> {
  try {
    const s = await lstat(p);
    if (s.isSymbolicLink()) return 'link';
    if (s.isFile()) return 'file';
    if (s.isDirectory()) return 'dir';
    return 'other';
  } catch {
    return null;
  }
}

export interface SnapshotStoreOptions {
  /** 工作区根:要拍快照的目录;快照放在它下面的 snapshots/。 */
  root: string;
  timezone: string;
  /** 普通快照最多保留几个;pre-restore-* 不计入、永不自动删除。 */
  maxSnapshots: () => number;
  /** 当前时刻,测试用。 */
  now?: () => Date;
}

export class SnapshotStore {
  readonly root: string;
  readonly snapshotsDir: string;
  private readonly timezone: string;
  private readonly maxSnapshots: () => number;
  private readonly now: () => Date;
  /** 串行化所有操作,避免回滚和拍快照交错。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: SnapshotStoreOptions) {
    this.root = resolve(opts.root);
    this.snapshotsDir = resolve(this.root, SNAPSHOTS_DIRNAME);
    this.timezone = opts.timezone;
    this.maxSnapshots = opts.maxSnapshots;
    this.now = opts.now ?? (() => new Date());
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * 快照目录按绝对路径排除,不按名字匹配:工作区里别处叫 snapshots 的目录照常拷,
   * 而 <root>/snapshots 本身无论怎么走到都不进快照。
   */
  private excludedByPath(abs: string): boolean {
    return isInside(this.snapshotsDir, abs);
  }

  /** 写入或删除前核对:路径的实际父目录(跟随链接后)仍在工作区根内,且不在快照目录里。 */
  private async assertWritable(abs: string): Promise<void> {
    if (!isInside(this.root, abs) || abs === this.root) throw new Error('路径不在工作区根内');
    if (this.excludedByPath(abs)) throw new Error('路径落在快照目录里');
    const realRoot = await realpath(this.root);
    let dir = dirname(abs);
    // 找到最近一个已存在的祖先目录再取 realpath
    for (;;) {
      try {
        const real = await realpath(dir);
        if (!isInside(realRoot, real)) throw new Error('父目录经符号链接指到了工作区外');
        if (isInside(await realpath(this.snapshotsDir).catch(() => this.snapshotsDir), real)) {
          throw new Error('父目录经符号链接指到了快照目录');
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const up = dirname(dir);
        if (up === dir) throw err;
        dir = up;
      }
    }
  }

  /** 扫描工作区,给出要拷的文件与跳过清单。 */
  async scan(): Promise<{ files: FileEntry[]; skipped: SkippedEntry[] }> {
    const files: FileEntry[] = [];
    const skipped: SkippedEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        skipped.push({ path: toPosix(relative(this.root, dir)) || '.', reason: `无法读取目录: ${errMsg(err)}` });
        return;
      }
      for (const ent of entries) {
        const abs = resolve(dir, ent.name);
        if (!isInside(this.root, abs)) continue;
        if (this.excludedByPath(abs)) continue;
        const rel = toPosix(relative(this.root, abs));
        if (SKIP_NAMES.has(ent.name) || ent.name.startsWith(SKIP_PREFIX)) {
          skipped.push({ path: rel, reason: '按规则跳过(node_modules / .git / tmp-*)' });
          continue;
        }
        if (isEnvFile(ent.name)) {
          skipped.push({ path: rel, reason: '环境文件含密钥,不拷(.env / .env.*)' });
          continue;
        }
        if (ent.isSymbolicLink()) {
          skipped.push({ path: rel, reason: '符号链接不跟随' });
          continue;
        }
        if (ent.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!ent.isFile()) continue;
        let size: number;
        try {
          size = (await stat(abs)).size;
        } catch (err) {
          skipped.push({ path: rel, reason: `无法读取: ${errMsg(err)}` });
          continue;
        }
        const inArchive = rel.startsWith('archive/');
        if (size > MAX_FILE_BYTES) {
          skipped.push({ path: rel, reason: '单文件超过 100MB', bytes: size });
        } else if (inArchive && size > MAX_ARCHIVE_FILE_BYTES) {
          skipped.push({ path: rel, reason: 'archive/ 里超过 50MB', bytes: size });
        } else {
          files.push({ path: rel, bytes: size });
        }
      }
    };
    await walk(this.root);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, skipped };
  }

  /** 原子地占一个快照目录名:同一秒已有就加 -2、-3……,绝不覆盖。 */
  private async claimDir(base: string): Promise<{ id: string; dir: string }> {
    await mkdir(this.snapshotsDir, { recursive: true });
    for (let n = 1; n < 1000; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      const dir = safeJoin(this.snapshotsDir, id);
      try {
        await mkdir(dir);
        return { id, dir };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error(`同一秒内的快照太多: ${base}`);
  }

  private async writeManifest(dir: string, m: Manifest): Promise<void> {
    await writeFile(resolve(dir, MANIFEST), `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  }

  /** 拍一份快照:先写 manifest(complete=false),拷完再补全。 */
  private async capture(prefix: '' | typeof PRE_RESTORE_PREFIX, note?: string): Promise<Manifest> {
    const at = this.now();
    const { id, dir } = await this.claimDir(`${prefix}${stamp(this.timezone, at)}`);
    try {
      const { files, skipped } = await this.scan();
      const manifest: Manifest = {
        id,
        createdAt: at.toISOString(),
        ...(note ? { note } : {}),
        fileCount: files.length,
        totalBytes: files.reduce((s, f) => s + f.bytes, 0),
        sourceRoot: this.root,
        tool: MANIFEST_TOOL,
        skipped,
        complete: false,
        files,
      };
      await this.writeManifest(dir, manifest);

      const filesDir = resolve(dir, FILES_DIR);
      const copied: FileEntry[] = [];
      for (const f of files) {
        const src = safeJoin(this.root, f.path);
        const dst = safeJoin(filesDir, f.path);
        try {
          const s = await lstat(src);
          if (!s.isFile()) throw new Error('拷贝时已不是普通文件');
          if (s.size > MAX_FILE_BYTES) {
            skipped.push({ path: f.path, reason: '单文件超过 100MB', bytes: s.size });
            continue;
          }
          await mkdir(dirname(dst), { recursive: true });
          await copyFile(src, dst);
          await utimes(dst, s.atime, s.mtime);
          copied.push({ path: f.path, bytes: s.size });
        } catch (err) {
          skipped.push({ path: f.path, reason: `拷贝失败: ${errMsg(err)}` });
        }
      }
      manifest.files = copied;
      manifest.fileCount = copied.length;
      manifest.totalBytes = copied.reduce((s, f) => s + f.bytes, 0);
      manifest.complete = true;
      await this.writeManifest(dir, manifest);
      return manifest;
    } catch (err) {
      // 半成品留着会被当成快照列出来;拍失败就整份删掉
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  private async readManifest(id: string): Promise<Manifest> {
    const dir = safeJoin(this.snapshotsDir, id);
    const raw = await readFile(resolve(dir, MANIFEST), 'utf8');
    const m = JSON.parse(raw) as Manifest;
    if (!m || typeof m !== 'object' || !Array.isArray(m.files)) throw new Error(`manifest 格式不对: ${id}`);
    if (m.tool !== MANIFEST_TOOL) throw new Error(`${id} 不是本扩展拍的快照,不碰`);
    return { ...m, id };
  }

  /**
   * 本扩展拍的全部快照(含 pre-restore-*),按创建时间倒序。
   * snapshots/ 里可能有别的工具留下的目录:manifest 读不出或没有归属标记的一律跳过,
   * 所以也不会被保留策略删掉。拍到一半中断的快照 manifest 已带标记,会列出并标为不完整。
   */
  private async all(): Promise<SnapshotSummary[]> {
    let entries;
    try {
      entries = await readdir(this.snapshotsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: SnapshotSummary[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || !isValidId(ent.name)) continue;
      const preRestore = ent.name.startsWith(PRE_RESTORE_PREFIX);
      try {
        const m = await this.readManifest(ent.name);
        out.push({
          id: ent.name, createdAt: m.createdAt, ...(m.note ? { note: m.note } : {}),
          fileCount: m.fileCount, totalBytes: m.totalBytes, preRestore, complete: m.complete === true,
        });
      } catch {
        // 不是本扩展的,或 manifest 坏了:不列出,也不参与保留策略
      }
    }
    // createdAt 相同(或缺失)时按 id 排;id 里的时间与序号同样是递增的
    return out.sort((a, b) => (b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id, 'en', { numeric: true })));
  }

  /** 普通快照超过上限时删最旧的;pre-restore-* 永远保留。 */
  private async prune(): Promise<string[]> {
    const max = Math.max(1, Math.floor(this.maxSnapshots()));
    const regular = (await this.all()).filter((s) => !s.preRestore);
    const victims = regular.slice(max);
    for (const v of victims) await rm(safeJoin(this.snapshotsDir, v.id), { recursive: true, force: true });
    return victims.map((v) => v.id);
  }

  create(note?: string): Promise<CreateReport> {
    return this.serial(async () => {
      const m = await this.capture('', note);
      const pruned = await this.prune();
      return {
        id: m.id, createdAt: m.createdAt, fileCount: m.fileCount, totalBytes: m.totalBytes,
        skippedCount: m.skipped.length, skipped: m.skipped, pruned,
      };
    });
  }

  list(limit = LIST_LIMIT): Promise<SnapshotSummary[]> {
    return this.serial(async () => (await this.all()).slice(0, limit));
  }

  delete(id: string): Promise<{ id: string; deleted: true }> {
    return this.serial(async () => {
      if (!isValidId(id)) throw new Error(`快照 id 格式不对: ${String(id)}`);
      const dir = safeJoin(this.snapshotsDir, id);
      if ((await kindOf(dir)) !== 'dir') throw new Error(`没有这个快照: ${id}`);
      await this.readManifest(id);
      await rm(dir, { recursive: true, force: true });
      return { id, deleted: true as const };
    });
  }

  /**
   * 回滚:先把当前状态备份成 pre-restore-<时间戳>,备份失败就不动工作区。
   * 然后逐个文件处理——快照里有、工作区缺的补上;内容不同的覆盖;
   * 工作区里有、快照里没有的单个删掉。快照当时跳过的文件(超限、按规则跳过的目录)不碰,
   * 也从不整目录删除。
   */
  restore(id: string): Promise<RestoreReport> {
    return this.serial(async () => {
      if (!isValidId(id)) throw new Error(`快照 id 格式不对: ${String(id)}`);
      const m = await this.readManifest(id);
      if (!m.complete) throw new Error(`快照 ${id} 没有拍完整,拒绝回滚`);
      const filesDir = resolve(safeJoin(this.snapshotsDir, id), FILES_DIR);

      // 先校验快照里的每个路径,有一个不合法就整体拒绝,此时还没碰工作区
      const wanted = new Map<string, string>();
      for (const f of m.files) {
        const target = safeJoin(this.root, f.path);
        if (this.excludedByPath(target)) throw new Error(`快照里有指向快照目录的路径: ${f.path}`);
        wanted.set(f.path, safeJoin(filesDir, f.path));
      }

      const backup = await this.capture(PRE_RESTORE_PREFIX, `回滚到 ${id} 之前的自动备份`);
      const report: RestoreReport = {
        id, backupId: backup.id, added: [], changed: [], removed: [], unchanged: 0, errors: [],
      };

      for (const [rel, src] of wanted) {
        const dst = safeJoin(this.root, rel);
        try {
          if ((await kindOf(src)) !== 'file') throw new Error('快照里缺这个文件');
          await this.assertWritable(dst);
          const kind = await kindOf(dst);
          if (kind === 'file') {
            if (await sameContent(src, dst)) {
              report.unchanged++;
              continue;
            }
            await copyFile(src, dst);
            report.changed.push(rel);
          } else if (kind === null) {
            await mkdir(dirname(dst), { recursive: true });
            await copyFile(src, dst);
            report.added.push(rel);
          } else {
            throw new Error(`工作区里同名的是${kind === 'dir' ? '目录' : '符号链接或特殊文件'},不覆盖`);
          }
          const s = await stat(src);
          await utimes(dst, s.atime, s.mtime);
        } catch (err) {
          report.errors.push({ path: rel, reason: errMsg(err) });
        }
      }

      // 工作区里多出来的文件:只删快照当时也会拍进去、却不在快照里的
      const untouchable = m.skipped.map((s) => s.path);
      const coveredBySkip = (p: string) => untouchable.some((s) => p === s || p.startsWith(`${s}/`));
      const { files: current } = await this.scan();
      for (const f of current) {
        if (wanted.has(f.path) || coveredBySkip(f.path)) continue;
        const abs = safeJoin(this.root, f.path);
        try {
          await this.assertWritable(abs);
          await unlink(abs);
          report.removed.push(f.path);
        } catch (err) {
          report.errors.push({ path: f.path, reason: `删除失败: ${errMsg(err)}` });
        }
      }
      return report;
    });
  }
}
