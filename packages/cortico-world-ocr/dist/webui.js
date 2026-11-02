// src/webui.ts
var errText = (err) => err instanceof Error ? err.message : String(err);
async function mount(ctx) {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: "\u8BD5\u4E00\u4E0B", desc: "\u70B9\u300C\u8BC6\u522B\u300D\u4F1A\u622A\u4E00\u6B21\u5C4F\u5E76\u5728\u672C\u673A\u8BC6\u522B;\u622A\u56FE\u4E0D\u843D\u76D8,\u8FD9\u91CC\u53EA\u663E\u793A\u6587\u5B57\u7ED3\u679C\u3002" });
  sheet.el.classList.add("ocrwl");
  ctx.root.append(sheet.el);
  const state = ui.h("div", "ocrwl-state");
  const pattern = ui.input({ placeholder: "\u8981\u627E\u7684\u6587\u5B57(\u7559\u7A7A = \u5168\u5C4F\u6587\u5B57)", cls: "ocrwl-pattern" });
  const runBtn = ui.button("\u8BC6\u522B", { variant: "primary", size: "sm" });
  const bar = ui.rowbar();
  bar.append(pattern, runBtn);
  const msg = ui.msgline("");
  const pre = ui.h("pre", "mono ocrwl-out");
  sheet.body.append(state, bar, msg, pre);
  async function loadStatus() {
    try {
      const s = await ctx.invoke("status");
      state.replaceChildren(
        ui.pill(s.supported ? "Windows OCR \u53EF\u7528" : `\u4E0D\u652F\u6301\u5F53\u524D\u5E73\u53F0 ${s.platform}`, s.supported ? "on" : "off"),
        ui.pill(s.allow ? "\u5DF2\u5141\u8BB8" : "\u5DF2\u5173\u95ED", s.allow ? "on" : "off"),
        ui.chip(s.foregroundOnly ? "\u53EA\u622A\u524D\u53F0\u7A97\u53E3" : "\u622A\u6574\u5757\u663E\u793A\u5668"),
        ui.chip(`\u9ED8\u8BA4\u7F29\u653E ${s.defaultScale}`)
      );
      runBtn.disabled = !s.supported || !s.allow;
    } catch (err) {
      state.replaceChildren(ui.msgline(errText(err), true));
    }
  }
  async function run() {
    const lock = ui.disable(runBtn);
    msg.textContent = "\u8BC6\u522B\u4E2D\u2026";
    msg.classList.remove("bad");
    try {
      const r = await ctx.invoke("run", [pattern.value]);
      if (r.ok) {
        msg.textContent = `${r.chars} \u5B57`;
        pre.textContent = r.text;
      } else {
        msg.textContent = r.reason;
        msg.classList.add("bad");
        pre.textContent = "";
      }
    } catch (err) {
      msg.textContent = errText(err);
      msg.classList.add("bad");
    } finally {
      lock.dispose();
    }
  }
  runBtn.addEventListener("click", () => void run(), { signal: ctx.signal });
  pattern.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing) void run();
  }, { signal: ctx.signal });
  await loadStatus();
}
var bundle = { panels: { try: { mount } } };
var webui_default = bundle;
export {
  webui_default as default
};
