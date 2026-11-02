/**
 * 两个面板:「今天」读数页,「设置」页(日预算、告警线、单价表)。只 import 类型。
 */
import type { WebUiClientBundle, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface ModelSpend {
  calls: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  yuan: number | null;
}

type Status =
  | {
    ok: true; date: string; spent: number; budget: number | null; remaining: number | null; ratio: number | null;
    alertAt: number[]; fired: number[]; byModel: Record<string, ModelSpend>; byHour: number[]; unpriced: string[];
    badLines: number; checkedAt: string;
  }
  | { ok: false; reason: string };

interface Settings {
  dailyYuan: number;
  alertAt: number[];
  pricingText: string;
  source: 'override' | 'default' | 'broken';
  pricingError?: string;
  ledgerPath: string;
  overridePath: string;
}

const yuan = (n: number | null) => (n === null ? '—' : `¥${n.toFixed(2)}`);
const pct = (r: number) => `${Math.round(r * 100)}%`;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function mountToday(ctx: WebUiPanelContext): Promise<void> {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: '今天', desc: '按本机 usage 账本和单价表折算,每 60 秒刷新。' });
  sheet.el.classList.add('budgetwl');
  ctx.root.append(sheet.el);
  const body = ui.h('div');
  sheet.body.append(body);

  async function load(): Promise<void> {
    let s: Status;
    try {
      s = await ctx.invoke<Status>('status');
    } catch (err) {
      body.replaceChildren(ui.msgline(errText(err), true));
      return;
    }
    if (!s.ok) {
      body.replaceChildren(ui.msgline(s.reason, true));
      return;
    }
    const over = s.ratio !== null && s.ratio >= 1;
    const grid = ui.statgrid([
      { k: '今天已花', v: yuan(s.spent), accent: true },
      { k: '日预算', v: s.budget === null ? '未设置' : yuan(s.budget) },
      { k: over ? '超出' : '还剩', v: s.remaining === null ? '—' : yuan(Math.abs(s.remaining)) },
    ]);
    const nodes: HTMLElement[] = [grid];
    if (s.budget !== null && s.ratio !== null) {
      const bar = ui.progress({
        label: `告警线 ${s.alertAt.map(pct).join(' / ')}`,
        max: 1,
        value: Math.min(1, s.ratio),
        tone: over ? 'warn' : s.fired.length ? 'accent' : 'plain',
        format: () => pct(s.ratio ?? 0),
      });
      nodes.push(bar.el);
    }
    if (s.unpriced.length) {
      nodes.push(ui.msgline(`这些模型在单价表里没有价格,没算进去,实际花费更高:${s.unpriced.join('、')}`, true));
    }
    if (s.badLines) nodes.push(ui.msgline(`账本里有 ${s.badLines} 行解析不了,已跳过`));

    const models = Object.entries(s.byModel).sort((a, b) => (b[1].yuan ?? Infinity) - (a[1].yuan ?? Infinity));
    nodes.push(ui.section('按模型'));
    const t = ui.table({ head: ['模型', '调用', '输入', '其中命中缓存', '输出', '花费'] });
    if (!models.length) t.clear('今天还没有模型调用');
    for (const [name, m] of models) {
      t.addRow([
        { text: name, cls: 'mono' },
        { text: m.calls, cls: 'mono' },
        { text: ui.fmt.count(m.promptTokens), cls: 'mono' },
        { text: ui.fmt.count(m.cacheHitTokens), cls: 'mono' },
        { text: ui.fmt.count(m.completionTokens), cls: 'mono' },
        { text: m.yuan === null ? '无单价' : yuan(m.yuan), cls: 'mono' },
      ]);
    }
    nodes.push(t.el);

    const hours = s.byHour.map((v, h) => ({ h, v })).filter((x) => x.v > 0);
    if (hours.length) {
      nodes.push(ui.section('按小时'));
      const ht = ui.table({ head: ['时段', '花费'] });
      for (const { h, v } of hours) {
        ht.addRow([{ text: `${String(h).padStart(2, '0')}:00`, cls: 'mono' }, { text: yuan(v), cls: 'mono' }]);
      }
      nodes.push(ht.el);
    }
    const foot = ui.msgline(`${s.date},更新于 ${ui.fmt.clock(s.checkedAt)}`);
    foot.classList.add('budgetwl-foot');
    nodes.push(foot);
    body.replaceChildren(...nodes);
  }

  await load();
  ctx.interval(() => void load(), 60_000);
}

function parseLevels(text: string): number[] | string {
  const parts = text.split(/[,\uff0c\u3001\s]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '至少要一条线';
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p.replace(/%$/, ''));
    if (!Number.isFinite(n) || n <= 0 || n > 1000) return `看不懂「${p}」,写成 80 或 80% 这样的百分数`;
    out.push(n / 100);
  }
  return out;
}

async function mountSettings(ctx: WebUiPanelContext): Promise<void> {
  const { ui } = ctx;
  const budgetSheet = ui.sheet({ title: '日预算与告警线', desc: '每条线只在花费越过时提醒一次;回落到线下再越过才会再提醒。' });
  const priceSheet = ui.sheet({ title: '单价表', desc: '人民币元 / 百万 token。input 未命中缓存,cacheHit 命中缓存,output 含推理。模型名可以用 * 结尾做前缀匹配。' });
  budgetSheet.el.classList.add('budgetwl');
  priceSheet.el.classList.add('budgetwl');
  ctx.root.append(budgetSheet.el, priceSheet.el);

  const daily = ui.input({ type: 'number', cls: 'mono' });
  const levels = ui.input({ cls: 'mono', placeholder: '80, 100' });
  const budgetMsg = ui.msgline('');
  const saveBudget = ui.button('保存', { variant: 'primary', size: 'sm' });
  const budgetActs = ui.actions();
  budgetActs.append(saveBudget);
  budgetSheet.body.append(ui.field('日预算(元)', daily), ui.field('告警线(百分比,逗号分隔)', levels), budgetMsg, budgetActs);

  const where = ui.msgline('');
  where.classList.add('budgetwl-path');
  const pricing = ui.textarea({ rows: 14, cls: 'mono' });
  const priceMsg = ui.msgline('');
  const savePrice = ui.button('保存单价表', { variant: 'primary', size: 'sm' });
  const resetPrice = ui.button('恢复包里的默认表', { size: 'sm' });
  const priceActs = ui.actions();
  priceActs.append(savePrice, resetPrice);
  priceSheet.body.append(where, pricing, priceMsg, priceActs);

  let saved = { daily: '', levels: '', pricing: '' };
  const dirty = () => daily.value !== saved.daily || levels.value !== saved.levels || pricing.value !== saved.pricing;
  ctx.guardLeave(() => (dirty() ? '设置还没保存,确定离开?' : null));

  async function load(): Promise<void> {
    try {
      const s = await ctx.invoke<Settings>('get');
      daily.value = s.dailyYuan > 0 ? String(s.dailyYuan) : '';
      levels.value = s.alertAt.map((x) => String(Math.round(x * 10000) / 100)).join(', ');
      pricing.value = s.pricingText;
      saved = { daily: daily.value, levels: levels.value, pricing: pricing.value };
      where.textContent = s.source === 'override'
        ? `正在用本部署的单价表:${s.overridePath}`
        : s.source === 'broken'
          ? `本部署的单价表有问题:${s.pricingError ?? ''}`
          : '正在用包里自带的示例单价表;保存后会另存一份到本部署,升级扩展不会覆盖';
      where.classList.toggle('bad', s.source === 'broken');
      priceMsg.textContent = `账本:${s.ledgerPath}`;
    } catch (err) {
      budgetMsg.textContent = errText(err);
      budgetMsg.classList.add('bad');
    }
  }

  saveBudget.addEventListener('click', async () => {
    budgetMsg.classList.remove('bad');
    const d = Number(daily.value);
    if (!Number.isFinite(d) || d <= 0) {
      budgetMsg.textContent = '日预算要是大于 0 的数字';
      budgetMsg.classList.add('bad');
      return;
    }
    const lv = parseLevels(levels.value);
    if (typeof lv === 'string') {
      budgetMsg.textContent = lv;
      budgetMsg.classList.add('bad');
      return;
    }
    const lock = ui.disable(saveBudget);
    try {
      await ctx.invoke('saveBudget', [d, lv]);
      ui.toast('已保存');
      await load();
      budgetMsg.textContent = '';
    } catch (err) {
      budgetMsg.textContent = errText(err);
      budgetMsg.classList.add('bad');
    } finally {
      lock.dispose();
    }
  }, { signal: ctx.signal });

  savePrice.addEventListener('click', async () => {
    priceMsg.classList.remove('bad');
    const lock = ui.disable(savePrice, resetPrice);
    try {
      await ctx.invoke('savePricing', [pricing.value]);
      ui.toast('单价表已保存');
      await load();
    } catch (err) {
      priceMsg.textContent = errText(err);
      priceMsg.classList.add('bad');
    } finally {
      lock.dispose();
    }
  }, { signal: ctx.signal });

  resetPrice.addEventListener('click', async () => {
    const ok = await ui.confirm({ title: '恢复默认单价表?', body: '本部署里改过的单价表会被删掉,改用包里自带的示例价格。', danger: true });
    if (!ok) return;
    const lock = ui.disable(savePrice, resetPrice);
    try {
      await ctx.invoke('resetPricing');
      ui.toast('已恢复默认');
      await load();
    } catch (err) {
      priceMsg.textContent = errText(err);
      priceMsg.classList.add('bad');
    } finally {
      lock.dispose();
    }
  }, { signal: ctx.signal });

  await load();
}

const bundle: WebUiClientBundle = { panels: { today: { mount: mountToday }, settings: { mount: mountSettings } } };
export default bundle;
