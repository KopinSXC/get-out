/**
 * 快照引擎:扫描工作区、拷贝、列出、回滚、删除、保留策略。
 * 只用 fs/promises;所有落到磁盘的路径都先 path.resolve,再校验仍在允许的根下。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MB = 1024 * 1024;
/** 单文件上限,超过的跳过并记进 skipped。 */
export const MAX_FILE_BYTES = 100 * MB;
/** archive/ 下的单文件上限。 */
export const MAX_ARCHIVE_FILE_BYTES = 50 * MB;
/** 按名字跳过的目录或文件。 */
const SKIP_NAMES = new Set(['node_modules', '.git']);
const SKIP_PREFIX = 'tmp-';
const PRE_RESTORE_PREFIX = 'pre-restore-';
const ID_SHAPE = /^(pre-restore-)?\d{8}-\d{6}(-\d+)?$/;
const MANIFEST = 'manifest.json';
const FILES_DIR = 'files';

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
  skipped: SkippedEntry[];
  files: FileEntry[];
}

export interface SnapshotSummary {
  id: string;
  createdAt: string;
  note?: string;
  fileCount: number;
  totalBytes: number;
  preRestore: boolean;
}

export interface RestoreReport {
  id: string;
  backupId: string;
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
}

/** child 解析后仍在 root 之内(含 root 本身)。 */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 把相对路径落到 root 下;任何跳出 root 的路径都抛错。 */
export function safeJoin(root: string, rel: string): string {
  if (isAbsolute(rel)) throw new Error(`拒绝绝对路径: ${rel}`);
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

const toPosix = (p: string) => p.split(sep).join('/');

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface SnapshotStoreOptions {
  /** 工作区根:要拍快照的目录。 */
  root: string;
  /** 快照目录,通常是 <dataDir>/snapshots。 */
  snapshotsDir: string;
  timezone: string;
  /** 普通快照最多保留几个;pre-restore-* 不计入、永不删除。 */
  maxSnapshots: () => number;
}

export class SnapshotStore {
  readonly root: string;
  readonly snapshotsDir: string;
  private readonly timezone: string;
  private readonly maxSnapshots: () => number;
  /** 串行化所有操作,避免回滚和拍快照交错。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: SnapshotStoreOptions) {
    this.root = resolve(opts.root);
    this.snapshotsDir = resolve(opts.snapshotsDir);
    this.timezone = opts.timezone;
    this.maxSnapshots = opts.maxSnapshots;
    if (isInside(this.snapshotsDir, this.root)) {
      throw new Error(`工作区根 ${this.root} 位于快照目录 ${this.snapshotsDir} 之内,拒绝工作`);
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * 按绝对路径判断该不该跳过一个目录项。快照目录如果在工作区里面,
   * 用它的绝对路径排除,不按名字匹配:工作区里别处叫 snapshots 的目录照常拷。
   */
  private excludedByPath(abs: string): boolean {
    return isInside(this.snapshotsDir, abs);
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
        skipped.push({ path: toPosix(relative(this.root, dir)) || '.', reason: `无法读取目录: ${(err as Error).message}` });
        return;
      }
      for (const ent of entries) {
        const abs = resolve(dir, ent.name);
        const rel = toPosix(relative(this.root, abs));
        if (!isInside(this.root, abs)) continue;
        if (this.excludedByPath(abs)) continue;
        if (SKIP_NAMES.has(ent.name) || ent.name.startsWith(SKIP_PREFIX)) {
          skipped.push({ path: rel, reason: '按规则跳过(node_modules / .git / tmp-*)' });
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
          skipped.push({ path: rel, reason: `无法读取: ${(err as Error).message}` });
          continue;
        }
        const inArchive = rel === 'archive' || rel.startsWith('archive/');
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
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, skipped };
  }

  private async freeId(base: string): Promise<string> {
    await mkdir(this.snapshotsDir, { recursive: true });
    let id = base;
    for (let n = 2; await exists(safeJoin(this.snapshotsDir, id)); n++) id = `${base}-${n}`;
    return id;
  }

  private async capture(idBase: string, note?: string): Promise