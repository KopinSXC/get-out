/**
 * 全部在系统临时目录里的假工作区上跑;不碰任何真实部署。
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, truncate, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnapshotStore, safeJoin, isInside } from '../src/snapshot.ts';

let root: string;
let clock: Date;
let max: number;
const tick = (s = 1) => { clock = new Date(clock.getTime() + s * 1000); };

async function put(rel: string, body: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true });
  await writeFile(join(root, rel), body);
}

function store(): SnapshotStore {
  return new SnapshotStore({ root, timezone: 'Asia/Shanghai', maxSnapshots: () => max, now: () => clock });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'snapws-'));
  clock = new Date('2026-11-02T01:00:00Z');
  max = 30;
  await put('notes/a.md', 'A');
  await put('memory/m.json', '{}');
  await put('blobs/x.bin', 'xx');
  await put('node_modules/dep/index.js', 'no');
  await put('tmp-cache/t', 'no');
  await put('deep/snapshots/keep.txt', '别处的 snapshots 照常拷');
  await put('.env', 'SECRET=1');
  await put('data/.env.local', 'SECRET=2');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('路径校验', () => {
  it('拒绝 .. 与绝对路径', () => {
    expect(() => safeJoin(root, '../etc/passwd')).toThrow();
    expect(() => safeJoin(root, 'a/../../b')).toThrow();
    expect(() => safeJoin(root, '/etc/passwd')).toThrow();
    expect(() => safeJoin(root, 'C:/x')).toThrow();
    expect(safeJoin(root, 'notes/a.md')).toBe(join(root, 'notes/a.md'));
    expect(isInside(root, `${root}-sibling`)).toBe(false);
  });
});

describe('create', () => {
  it('拷贝工作区、跳过规则内目录、排除 snapshots/ 本身', async () => {
    const s = store();
    const r1 = await s.create('first');
    expect(r1.id).toBe('20261102-090000');
    const m1 = JSON.parse(await readFile(join(root, 'snapshots', r1.id, 'manifest.json'), 'utf8'));
    const paths = m1.files.map((f: { path: string }) => f.path);
    expect(paths).toEqual(['blobs/x.bin', 'deep/snapshots/keep.txt', 'memory/m.json', 'notes/a.md']);
    expect(m1.complete).toBe(true);
    expect(m1.sourceRoot).toBe(root);
    expect(m1.skipped.map((x: { path: string }) => x.path).sort()).toEqual(['.env', 'data/.env.local', 'node_modules', 'tmp-cache']);

    // 第二份不应包含第一份
    tick();
    const r2 = await s.create();
    const m2 = JSON.parse(await readFile(join(root, 'snapshots', r2.id, 'manifest.json'), 'utf8'));
    expect(m2.files.some((f: { path: string }) => f.path.startsWith('snapshots/'))).toBe(false);
    expect(m2.fileCount).toBe(4);
  });

  it('同一秒重复加序号', async () => {
    const s = store();
    const a = await s.create();
    const b = await s.create();
    const c = await s.create();
    expect([a.id, b.id, c.id]).toEqual(['20261102-090000', '20261102-090000-2', '20261102-090000-3']);
  });

  it('超限文件跳过并记录', async () => {
    await mkdir(join(root, 'archive'), { recursive: true });
    await writeFile(join(root, 'archive/big.zip'), '');
    await truncate(join(root, 'archive/big.zip'), 51 * 1024 * 1024);
    await writeFile(join(root, 'huge.bin'), '');
    await truncate(join(root, 'huge.bin'), 101 * 1024 * 1024);
    const r = await store().create();
    const reasons = Object.fromEntries(r.skipped.map((x) => [x.path, x.reason]));
    expect(reasons['archive/big.zip']).toMatch(/50MB/);
    expect(reasons['huge.bin']).toMatch(/100MB/);
  });

  it('保留策略删最旧的普通快照,pre-restore-* 不动', async () => {
    max = 2;
    const s = store();
    const first = await s.create();
    tick();
    await s.restore(first.id); // 生成一个 pre-restore-*
    tick();
    await s.create();
    tick();
    const last = await s.create();
    expect(last.pruned).toEqual([first.id]);
    const ids = (await s.list()).map((x) => x.id);
    expect(ids.filter((i) => i.startsWith('pre-restore-'))).toHaveLength(1);
    expect(ids.filter((i) => !i.startsWith('pre-restore-'))).toHaveLength(2);
  });
});

describe('snapshots/ 里别人的目录', () => {
  it('不列出、不按保留策略删、不能删', async () => {
    max = 1;
    await put('snapshots/20200101-000000/files/x', '别的工具的');
    await put('snapshots/20200101-000001/manifest.json', JSON.stringify({ files: [], createdAt: '2020-01-01T00:00:00Z' }));
    const s = store();
    await s.create();
    tick();
    await s.create();
    const ids = (await s.list()).map((x) => x.id);
    expect(ids).toEqual(['20261102-090001']);
    const left = (await readdir(join(root, 'snapshots'))).sort();
    expect(left).toEqual(['20200101-000000', '20200101-000001', '20261102-090001']);
    await expect(s.delete('20200101-000001')).rejects.toThrow(/不是本扩展/);
    await expect(s.restore('20200101-000001')).rejects.toThrow(/不是本扩展/);
  });
});

describe('回滚不碰 .env', () => {
  it('.env 既不进快照,也不会被回滚删掉或覆盖', async () => {
    const s = store();
    const snap = await s.create();
    tick();
    await put('.env', 'SECRET=changed');
    const r = await s.restore(snap.id);
    expect(r.removed).not.toContain('.env');
    expect(await readFile(join(root, '.env'), 'utf8')).toBe('SECRET=changed');
  });
});

describe('工作区根', () => {
  it('不存在时拒绝拍快照,也不会顺手建出来', async () => {
    const s = new SnapshotStore({ root: join(root, 'nope'), timezone: 'Asia/Shanghai', maxSnapshots: () => 30 });
    await expect(s.create()).rejects.toThrow(/不存在/);
    await expect(stat(join(root, 'nope'))).rejects.toThrow();
  });
});

describe('list / delete', () => {
  it('时间倒序,最多 20 条', async () => {
    const s = store();
    for (let i = 0; i < 22; i++) { await s.create(`n${i}`); tick(); }
    const l = await s.list();
    expect(l).toHaveLength(20);
    expect(l[0].note).toBe('n21');
    expect(l[19].note).toBe('n2');
  });

  it('删除整个快照目录,拒绝非法 id', async () => {
    const s = store();
    const r = await s.create();
    await s.delete(r.id);
    expect(await readdir(join(root, 'snapshots'))).toEqual([]);
    await expect(s.delete('../notes')).rejects.toThrow();
    await expect(s.delete('20990101-000000')).rejects.toThrow(/没有这个快照/);
  });
});

describe('restore', () => {
  it('先备份,再逐文件补/改/删,快照跳过的不碰', async () => {
    const s = store();
    const snap = await s.create();
    tick();
    await put('notes/a.md', 'A changed');
    await rm(join(root, 'memory/m.json'));
    await put('notes/new.md', 'new');
    await put('node_modules/dep/index.js', 'still here');

    const r = await s.restore(snap.id);
    expect(r.backupId).toBe('pre-restore-20261102-090001');
    expect(r.changed).toEqual(['notes/a.md']);
    expect(r.added).toEqual(['memory/m.json']);
    expect(r.removed).toEqual(['notes/new.md']);
    expect(r.errors).toEqual([]);
    expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe('A');
    expect(await readFile(join(root, 'node_modules/dep/index.js'), 'utf8')).toBe('still here');
    // 备份里有回滚前的状态
    const bak = join(root, 'snapshots', r.backupId, 'files');
    expect(await readFile(join(bak, 'notes/a.md'), 'utf8')).toBe('A changed');
    expect(await readFile(join(bak, 'notes/new.md'), 'utf8')).toBe('new');
    // 删文件不删目录
    expect((await stat(join(root, 'notes'))).isDirectory()).toBe(true);
  });

  it('manifest 里有跳出工作区的路径时整体拒绝,且不动工作区', async () => {
    const s = store();
    const snap = await s.create();
    const mp = join(root, 'snapshots', snap.id, 'manifest.json');
    const m = JSON.parse(await readFile(mp, 'utf8'));
    m.files.push({ path: '../escape.txt', bytes: 1 });
    await writeFile(mp, JSON.stringify(m));
    await put('notes/a.md', 'changed');
    await expect(s.restore(snap.id)).rejects.toThrow(/\.\./);
    expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe('changed');
    expect((await readdir(join(root, 'snapshots'))).some((d) => d.startsWith('pre-restore-'))).toBe(false);
  });

  it('不经符号链接写到工作区外', async (t) => {
    const outside = await mkdtemp(join(tmpdir(), 'snapout-'));
    try {
      const s = store();
      await put('linked/f.txt', 'inside');
      const snap = await s.create();
      tick();
      await rm(join(root, 'linked'), { recursive: true });
      // Windows 上用 junction:普通用户不开开发者模式也能建;其他平台忽略这个参数
      try {
        await symlink(outside, join(root, 'linked'), 'junction');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') t.skip();
        throw err;
      }
      const r = await s.restore(snap.id);
      expect(r.errors.map((e) => e.path)).toContain('linked/f.txt');
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
