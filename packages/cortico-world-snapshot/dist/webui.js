// src/webui.ts
function when(iso) {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
var errText = (err) => err instanceof Error ? err.message : String(err);
async function mount(ctx) {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: "\u5FEB\u7167\u5217\u8868", desc: "\u6700\u8FD1 20 \u4EFD,\u65B0\u7684\u5728\u4E0A\u3002\u56DE\u6EDA\u524D\u4F1A\u81EA\u52A8\u5907\u4EFD\u5F53\u524D\u72B6\u6001\u3002" });
  sheet.el.classList.add("snapwl");
  ctx.root.append(sheet.el);
  const where = ui.msgline("");
  where.classList.add("snapwl-root");
  const bar = ui.rowbar();
  const reload = ui.button("\u5237\u65B0", { size: "sm", onClick: () => void load() });
  bar.append(reload);
  const table = ui.table({ head: ["\u5FEB\u7167", "\u65F6\u95F4", "\u5927\u5C0F", "\u6587\u4EF6", ""] });
  sheet.body.append(where, bar, table.el);
  async function act(row, kind, btns) {
    const ok = await ui.confirm(kind === "delete" ? { title: `\u5220\u9664\u5FEB\u7167 ${row.id}?`, body: "\u6574\u4E2A\u5FEB\u7167\u76EE\u5F55\u4F1A\u88AB\u5220\u6389,\u4E0D\u80FD\u6062\u590D\u3002", danger: true } : {
      title: `\u56DE\u6EDA\u5230 ${row.id}?`,
      body: "\u4F1A\u5148\u628A\u5F53\u524D\u5DE5\u4F5C\u533A\u5907\u4EFD\u6210 pre-restore-<\u65F6\u95F4\u6233>,\u518D\u6309\u5FEB\u7167\u9010\u4E2A\u6587\u4EF6\u8865\u4E0A\u3001\u8986\u76D6\u3001\u5220\u9664\u3002\u56DE\u6EDA\u540E\u5EFA\u8BAE\u91CD\u542F bot\u3002",
      danger: true
    });
    if (!ok) return;
    const lock = ui.disable(...btns, reload);
    const busy = ui.busy(kind === "delete" ? "\u6B63\u5728\u5220\u9664" : "\u6B63\u5728\u56DE\u6EDA", row.id);
    try {
      if (kind === "delete") {
        await ctx.invoke("delete", [row.id]);
        ui.toast(`\u5DF2\u5220\u9664 ${row.id}`);
      } else {
        const r = await ctx.invoke("restore", [row.id]);
        const line = `\u8865 ${r.added.length},\u6539 ${r.changed.length},\u5220 ${r.removed.length},\u672A\u53D8 ${r.unchanged}`;
        if (r.errors.length) {
          ui.drawer(`\u56DE\u6EDA\u6709 ${r.errors.length} \u5904\u6CA1\u5904\u7406`, r.errors.map((e) => `${e.path}
  ${e.reason}`).join("\n"));
        }
        ui.toast(`\u5DF2\u56DE\u6EDA\u5230 ${row.id}(${line}),\u5907\u4EFD\u5728 ${r.backupId}`, r.errors.length ? "bad" : "ok");
      }
    } catch (err) {
      ui.toast(errText(err), "bad");
    } finally {
      busy.dispose();
      lock.dispose();
    }
    await load();
  }
  async function load() {
    let data;
    try {
      data = await ctx.invoke("list");
    } catch (err) {
      table.clear(`\u8BFB\u53D6\u5931\u8D25:${errText(err)}`);
      return;
    }
    where.textContent = `\u5DE5\u4F5C\u533A\u6839:${data.root}`;
    table.clear(data.snapshots.length ? void 0 : "\u8FD8\u6CA1\u6709\u5FEB\u7167");
    for (const row of data.snapshots) {
      const idCell = ui.h("div", "snapwl-id");
      idCell.append(ui.h("span", "mono", row.id));
      if (row.preRestore) idCell.append(ui.pill("\u56DE\u6EDA\u524D\u5907\u4EFD", "plain"));
      if (!row.complete) idCell.append(ui.chip("\u4E0D\u5B8C\u6574", "warn"));
      if (row.note) idCell.append(ui.h("div", "snapwl-note", row.note));
      const ops = ui.h("div", "snapwl-ops");
      const restoreBtn = ui.button("\u56DE\u6EDA", { size: "sm" });
      const deleteBtn = ui.button("\u5220\u9664", { size: "sm", variant: "danger" });
      restoreBtn.disabled = !row.complete;
      const btns = [restoreBtn, deleteBtn];
      restoreBtn.addEventListener("click", () => void act(row, "restore", btns), { signal: ctx.signal });
      deleteBtn.addEventListener("click", () => void act(row, "delete", btns), { signal: ctx.signal });
      ops.append(restoreBtn, deleteBtn);
      table.addRow([
        { el: idCell },
        { text: when(row.createdAt), cls: "mono" },
        { text: ui.fmt.bytes(row.totalBytes), cls: "mono" },
        { text: row.fileCount, cls: "mono" },
        { el: ops }
      ]);
    }
  }
  await load();
}
var bundle = { panels: { list: { mount } } };
var webui_default = bundle;
export {
  webui_default as default
};
