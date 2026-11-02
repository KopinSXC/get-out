// src/webui.ts
var yuan = (n) => n === null ? "\u2014" : `\xA5${n.toFixed(2)}`;
var pct = (r) => `${Math.round(r * 100)}%`;
var errText = (err) => err instanceof Error ? err.message : String(err);
async function mountToday(ctx) {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: "\u4ECA\u5929", desc: "\u6309\u672C\u673A usage \u8D26\u672C\u548C\u5355\u4EF7\u8868\u6298\u7B97,\u6BCF 60 \u79D2\u5237\u65B0\u3002" });
  sheet.el.classList.add("budgetwl");
  ctx.root.append(sheet.el);
  const body = ui.h("div");
  sheet.body.append(body);
  async function load() {
    let s;
    try {
      s = await ctx.invoke("status");
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
      { k: "\u4ECA\u5929\u5DF2\u82B1", v: yuan(s.spent), accent: true },
      { k: "\u65E5\u9884\u7B97", v: s.budget === null ? "\u672A\u8BBE\u7F6E" : yuan(s.budget) },
      { k: over ? "\u8D85\u51FA" : "\u8FD8\u5269", v: s.remaining === null ? "\u2014" : yuan(Math.abs(s.remaining)) }
    ]);
    const nodes = [grid];
    if (s.budget !== null && s.ratio !== null) {
      const bar = ui.progress({
        label: `\u544A\u8B66\u7EBF ${s.alertAt.map(pct).join(" / ")}`,
        max: 1,
        value: Math.min(1, s.ratio),
        tone: over ? "warn" : s.fired.length ? "accent" : "plain",
        format: () => pct(s.ratio ?? 0)
      });
      nodes.push(bar.el);
    }
    if (s.unpriced.length) {
      nodes.push(ui.msgline(`\u8FD9\u4E9B\u6A21\u578B\u5728\u5355\u4EF7\u8868\u91CC\u6CA1\u6709\u4EF7\u683C,\u6CA1\u7B97\u8FDB\u53BB,\u5B9E\u9645\u82B1\u8D39\u66F4\u9AD8:${s.unpriced.join("\u3001")}`, true));
    }
    if (s.badLines) nodes.push(ui.msgline(`\u8D26\u672C\u91CC\u6709 ${s.badLines} \u884C\u89E3\u6790\u4E0D\u4E86,\u5DF2\u8DF3\u8FC7`));
    const models = Object.entries(s.byModel).sort((a, b) => (b[1].yuan ?? Infinity) - (a[1].yuan ?? Infinity));
    nodes.push(ui.section("\u6309\u6A21\u578B"));
    const t = ui.table({ head: ["\u6A21\u578B", "\u8C03\u7528", "\u8F93\u5165", "\u5176\u4E2D\u547D\u4E2D\u7F13\u5B58", "\u8F93\u51FA", "\u82B1\u8D39"] });
    if (!models.length) t.clear("\u4ECA\u5929\u8FD8\u6CA1\u6709\u6A21\u578B\u8C03\u7528");
    for (const [name, m] of models) {
      t.addRow([
        { text: name, cls: "mono" },
        { text: m.calls, cls: "mono" },
        { text: ui.fmt.count(m.promptTokens), cls: "mono" },
        { text: ui.fmt.count(m.cacheHitTokens), cls: "mono" },
        { text: ui.fmt.count(m.completionTokens), cls: "mono" },
        { text: m.yuan === null ? "\u65E0\u5355\u4EF7" : yuan(m.yuan), cls: "mono" }
      ]);
    }
    nodes.push(t.el);
    const hours = s.byHour.map((v, h) => ({ h, v })).filter((x) => x.v > 0);
    if (hours.length) {
      nodes.push(ui.section("\u6309\u5C0F\u65F6"));
      const ht = ui.table({ head: ["\u65F6\u6BB5", "\u82B1\u8D39"] });
      for (const { h, v } of hours) {
        ht.addRow([{ text: `${String(h).padStart(2, "0")}:00`, cls: "mono" }, { text: yuan(v), cls: "mono" }]);
      }
      nodes.push(ht.el);
    }
    const foot = ui.msgline(`${s.date},\u66F4\u65B0\u4E8E ${ui.fmt.clock(s.checkedAt)}`);
    foot.classList.add("budgetwl-foot");
    nodes.push(foot);
    body.replaceChildren(...nodes);
  }
  await load();
  ctx.interval(() => void load(), 6e4);
}
function parseLevels(text) {
  const parts = text.split(/[,\uff0c\u3001\s]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "\u81F3\u5C11\u8981\u4E00\u6761\u7EBF";
  const out = [];
  for (const p of parts) {
    const n = Number(p.replace(/%$/, ""));
    if (!Number.isFinite(n) || n <= 0 || n > 1e3) return `\u770B\u4E0D\u61C2\u300C${p}\u300D,\u5199\u6210 80 \u6216 80% \u8FD9\u6837\u7684\u767E\u5206\u6570`;
    out.push(n / 100);
  }
  return out;
}
async function mountSettings(ctx) {
  const { ui } = ctx;
  const budgetSheet = ui.sheet({ title: "\u65E5\u9884\u7B97\u4E0E\u544A\u8B66\u7EBF", desc: "\u6BCF\u6761\u7EBF\u53EA\u5728\u82B1\u8D39\u8D8A\u8FC7\u65F6\u63D0\u9192\u4E00\u6B21;\u56DE\u843D\u5230\u7EBF\u4E0B\u518D\u8D8A\u8FC7\u624D\u4F1A\u518D\u63D0\u9192\u3002" });
  const priceSheet = ui.sheet({ title: "\u5355\u4EF7\u8868", desc: "\u4EBA\u6C11\u5E01\u5143 / \u767E\u4E07 token\u3002input \u672A\u547D\u4E2D\u7F13\u5B58,cacheHit \u547D\u4E2D\u7F13\u5B58,output \u542B\u63A8\u7406\u3002\u6A21\u578B\u540D\u53EF\u4EE5\u7528 * \u7ED3\u5C3E\u505A\u524D\u7F00\u5339\u914D\u3002" });
  budgetSheet.el.classList.add("budgetwl");
  priceSheet.el.classList.add("budgetwl");
  ctx.root.append(budgetSheet.el, priceSheet.el);
  const daily = ui.input({ type: "number", cls: "mono" });
  const levels = ui.input({ cls: "mono", placeholder: "80, 100" });
  const budgetMsg = ui.msgline("");
  const saveBudget = ui.button("\u4FDD\u5B58", { variant: "primary", size: "sm" });
  const budgetActs = ui.actions();
  budgetActs.append(saveBudget);
  budgetSheet.body.append(ui.field("\u65E5\u9884\u7B97(\u5143)", daily), ui.field("\u544A\u8B66\u7EBF(\u767E\u5206\u6BD4,\u9017\u53F7\u5206\u9694)", levels), budgetMsg, budgetActs);
  const where = ui.msgline("");
  where.classList.add("budgetwl-path");
  const pricing = ui.textarea({ rows: 14, cls: "mono" });
  const priceMsg = ui.msgline("");
  const savePrice = ui.button("\u4FDD\u5B58\u5355\u4EF7\u8868", { variant: "primary", size: "sm" });
  const resetPrice = ui.button("\u6062\u590D\u5305\u91CC\u7684\u9ED8\u8BA4\u8868", { size: "sm" });
  const priceActs = ui.actions();
  priceActs.append(savePrice, resetPrice);
  priceSheet.body.append(where, pricing, priceMsg, priceActs);
  let saved = { daily: "", levels: "", pricing: "" };
  const dirty = () => daily.value !== saved.daily || levels.value !== saved.levels || pricing.value !== saved.pricing;
  ctx.guardLeave(() => dirty() ? "\u8BBE\u7F6E\u8FD8\u6CA1\u4FDD\u5B58,\u786E\u5B9A\u79BB\u5F00?" : null);
  async function load() {
    try {
      const s = await ctx.invoke("get");
      daily.value = s.dailyYuan > 0 ? String(s.dailyYuan) : "";
      levels.value = s.alertAt.map((x) => String(Math.round(x * 1e4) / 100)).join(", ");
      pricing.value = s.pricingText;
      saved = { daily: daily.value, levels: levels.value, pricing: pricing.value };
      where.textContent = s.source === "override" ? `\u6B63\u5728\u7528\u672C\u90E8\u7F72\u7684\u5355\u4EF7\u8868:${s.overridePath}` : s.source === "broken" ? `\u672C\u90E8\u7F72\u7684\u5355\u4EF7\u8868\u6709\u95EE\u9898:${s.pricingError ?? ""}` : "\u6B63\u5728\u7528\u5305\u91CC\u81EA\u5E26\u7684\u793A\u4F8B\u5355\u4EF7\u8868;\u4FDD\u5B58\u540E\u4F1A\u53E6\u5B58\u4E00\u4EFD\u5230\u672C\u90E8\u7F72,\u5347\u7EA7\u6269\u5C55\u4E0D\u4F1A\u8986\u76D6";
      where.classList.toggle("bad", s.source === "broken");
      priceMsg.textContent = `\u8D26\u672C:${s.ledgerPath}`;
    } catch (err) {
      budgetMsg.textContent = errText(err);
      budgetMsg.classList.add("bad");
    }
  }
  saveBudget.addEventListener("click", async () => {
    budgetMsg.classList.remove("bad");
    const d = Number(daily.value);
    if (!Number.isFinite(d) || d <= 0) {
      budgetMsg.textContent = "\u65E5\u9884\u7B97\u8981\u662F\u5927\u4E8E 0 \u7684\u6570\u5B57";
      budgetMsg.classList.add("bad");
      return;
    }
    const lv = parseLevels(levels.value);
    if (typeof lv === "string") {
      budgetMsg.textContent = lv;
      budgetMsg.classList.add("bad");
      return;
    }
    const lock = ui.disable(saveBudget);
    try {
      await ctx.invoke("saveBudget", [d, lv]);
      ui.toast("\u5DF2\u4FDD\u5B58");
      await load();
      budgetMsg.textContent = "";
    } catch (err) {
      budgetMsg.textContent = errText(err);
      budgetMsg.classList.add("bad");
    } finally {
      lock.dispose();
    }
  }, { signal: ctx.signal });
  savePrice.addEventListener("click", async () => {
    priceMsg.classList.remove("bad");
    const lock = ui.disable(savePrice, resetPrice);
    try {
      await ctx.invoke("savePricing", [pricing.value]);
      ui.toast("\u5355\u4EF7\u8868\u5DF2\u4FDD\u5B58");
      await load();
    } catch (err) {
      priceMsg.textContent = errText(err);
      priceMsg.classList.add("bad");
    } finally {
      lock.dispose();
    }
  }, { signal: ctx.signal });
  resetPrice.addEventListener("click", async () => {
    const ok = await ui.confirm({ title: "\u6062\u590D\u9ED8\u8BA4\u5355\u4EF7\u8868?", body: "\u672C\u90E8\u7F72\u91CC\u6539\u8FC7\u7684\u5355\u4EF7\u8868\u4F1A\u88AB\u5220\u6389,\u6539\u7528\u5305\u91CC\u81EA\u5E26\u7684\u793A\u4F8B\u4EF7\u683C\u3002", danger: true });
    if (!ok) return;
    const lock = ui.disable(savePrice, resetPrice);
    try {
      await ctx.invoke("resetPricing");
      ui.toast("\u5DF2\u6062\u590D\u9ED8\u8BA4");
      await load();
    } catch (err) {
      priceMsg.textContent = errText(err);
      priceMsg.classList.add("bad");
    } finally {
      lock.dispose();
    }
  }, { signal: ctx.signal });
  await load();
}
var bundle = { panels: { today: { mount: mountToday }, settings: { mount: mountSettings } } };
var webui_default = bundle;
export {
  webui_default as default
};
