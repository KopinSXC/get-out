/**
 * 「试一下」面板:识别一次当前屏幕(可选带查找文字),原样显示模型会收到的回执。
 * 开关本身在配置组里,这里只读当前状态。只 import 类型。
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface Status {
  platform: string;
  supported: boolean;
  allow: boolean;
  foregroundOnly: boolean;
  defaultScale: number;
}

type RunResult = { ok: true; text: string; chars: number } | { ok: false; reason: string };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function mount(ctx: WebUiPanelContext): Promise<void> {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: '试一下', desc: '点「识别」会截一次屏并在本机识别;截图不落盘,这里只显示文字结果。' });
  sheet.el.classList.add('ocrwl');
  ctx.root.append(sheet.el);

  const state = ui.h('div', 'ocrwl-state');
  const pattern = ui.input({ placeholder: '要找的文字(留空 = 全屏文字)', cls: 'ocrwl-pattern' });
  const runBtn = ui.button('识别', { variant: 'primary', size: 'sm' });
  const bar = ui.rowbar();
  bar.append(pattern, runBtn);
  const msg = ui.msgline('');
  const pre = ui.h('pre', 'mono ocrwl-out');
  sheet.body.append(state, bar, msg, pre);

  async function loadStatus(): Promise<void> {
    try {
      const s = await ctx.invoke<Status>('status');
      state.replaceChildren(
        ui.pill(s.supported ? 'Windows OCR 可用' : `不支持当前平台 ${s.platform}`, s.supported ? 'on' : 'off'),
        ui.pill(s.allow ? '已允许' : '已关闭', s.allow ? 'on' : 'off'),
        ui.chip(s.foregroundOnly ? '只截前台窗口' : '截整块显示器'),
        ui.chip(`默认缩放 ${s.defaultScale}`),
      );
      runBtn.disabled = !s.supported || !s.allow;
    } catch (err) {
      state.replaceChildren(ui.msgline(errText(err), true));
    }
  }

  async function run(): Promise<void> {
    const lock = ui.disable(runBtn);
    msg.textContent = '识别中…';
    msg.classList.remove('bad');
    try {
      const r = await ctx.invoke<RunResult>('run', [pattern.value]);
      if (r.ok) {
        msg.textContent = `${r.chars} 字`;
        pre.textContent = r.text;
      } else {
        msg.textContent = r.reason;
        msg.classList.add('bad');
        pre.textContent = '';
      }
    } catch (err) {
      msg.textContent = errText(err);
      msg.classList.add('bad');
    } finally {
      lock.dispose();
    }
  }

  runBtn.addEventListener('click', () => void run(), { signal: ctx.signal });
  pattern.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) void run(); }, { signal: ctx.signal });
  await loadStatus();
}

const bundle: WebUiClientBundle = { panels: { try: { mount } } };
export default bundle;
