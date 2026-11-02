/**
 * 浏览器端面板:只读快照列表,每行带「回滚」「删除」。两种操作都要二次确认。
 * 只 import 类型;打包成 dist/webui.js。
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface Row {
  id: string;
  createdAt: string;
  note?: string;
  fileCount: number;
  totalBytes: number;
  preRestore: boolean;
  complete: boolean;
}

interface ListResult {
  root: string;
  snapshots: Row[];
}

interface RestoreResult {
  backupId: string;
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
  errors: Array<{ path: string; reason: string }>;
}

function when(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function mount(ctx: WebUiPanelContext): Promise<void> {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: '快照列表', desc: '最近 20 份,新的在上。回滚前会自动备份当前状态。' });
  sheet.el.classList.add('snapwl');
  ctx.root.append(sheet.el);

  const where = ui.msgline('');
  where.classList.add('snapwl-root');
  const bar = ui.rowbar();
  const reload = ui.button('刷新', { size: 'sm', onClick: () => void load() });
  bar.append(reload);
  const table = ui.table({ head: ['快照', '时间', '大小', '文件', ''] });
  sheet.body.append(where, bar, table.el);

  async function act(row: Row, kind: 'restore' | 'delete', btns: HTMLButtonElement[]): Promise<void> {
    const ok = await ui.confirm(kind === 'delete'
      ? { title: `删除快照 ${row.id}?`, body: '整个快照目录会被删掉,不能恢复。', danger: true }
      : {
        title: `回滚到 ${row.id}?`,
        body: '会先把当前工作区备份成 pre-restore-<时间戳>,再按快照逐个文件补上、覆盖、删除。回滚后建议重启 bot。',
        danger: true,
      });
    if (!ok) return;
    const lock = ui.disable(...btns, reload);
    const busy = ui.busy(kind === 'delete' ? '正在删除' : '正在回滚', row.id);
    try {
      if (kind === 'delete') {
        await ctx.invoke('delete', [row.id]);
        ui.toast(`已删除 ${row.id}`);
      } else {
        const r = await ctx.invoke<RestoreResult>('restore', [row.id]);
        const line = `补 ${r.added.length},改 ${r.changed.length},删 ${r.removed.length},未变 ${r.unchanged}`;
        if (r.errors.length) {
          ui.drawer(`回滚有 ${r.errors.length} 处没处理`, r.errors.map((e) => `${e.path}\n  ${e.reason}`).join('\n'));
        }
        ui.toast(`已回滚到 ${row.id}(${line}),备份在 ${r.backupId}`, r.errors.length ? 'bad' : 'ok');
      }
    } catch (err) {
      ui.toast(errText(err), 'bad');
    } finally {
      busy.dispose();
      lock.dispose();
    }
    await load();
  }

  async function load(): Promise<void> {
    let data: ListResult;
    try {
      data = await ctx.invoke<ListResult>('list');
    } catch (err) {
      table.clear(`读取失败:${errText(err)}`);
      return;
    }
    where.textContent = `工作区根:${data.root}`;
    table.clear(data.snapshots.length ? undefined : '还没有快照');
    for (const row of data.snapshots) {
      const idCell = ui.h('div', 'snapwl-id');
      idCell.append(ui.h('span', 'mono', row.id));
      if (row.preRestore) idCell.append(ui.pill('回滚前备份', 'plain'));
      if (!row.complete) idCell.append(ui.chip('不完整', 'warn'));
      if (row.note) idCell.append(ui.h('div', 'snapwl-note', row.note));

      const ops = ui.h('div', 'snapwl-ops');
      const restoreBtn = ui.button('回滚', { size: 'sm' });
      const deleteBtn = ui.button('删除', { size: 'sm', variant: 'danger' });
      restoreBtn.disabled = !row.complete;
      const btns = [restoreBtn, deleteBtn];
      restoreBtn.addEventListener('click', () => void act(row, 'restore', btns), { signal: ctx.signal });
      deleteBtn.addEventListener('click', () => void act(row, 'delete', btns), { signal: ctx.signal });
      ops.append(restoreBtn, deleteBtn);

      table.addRow([
        { el: idCell },
        { text: when(row.createdAt), cls: 'mono' },
        { text: ui.fmt.bytes(row.totalBytes), cls: 'mono' },
        { text: row.fileCount, cls: 'mono' },
        { el: ops },
      ]);
    }
  }

  await load();
}

const bundle: WebUiClientBundle = { panels: { list: { mount } } };
export default bundle;
