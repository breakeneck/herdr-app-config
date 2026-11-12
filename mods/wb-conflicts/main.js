// Merge conflicts of one repo, like the IDE's Conflicts dialog: every unmerged file on its own row, its
// conflict blocks side by side (Yours | Theirs) on the right. Per file: Accept Yours, Accept Theirs,
// Resolve with AI (the AI models of wb-ai, use "conflict", picked per project), Open in the editor tab and
// Mark resolved. On top: Resolve all with AI. Then Continue (or Abort) the rebase / merge.
// props: { root, on }. Opened only from the Changes header's Resolve button, shown while files are unmerged.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { props, closeOverlay, theme, readTextFile, spaces, panes, run, setShared } from "herdr";
import { conflictState, takeSide, markResolved, continueOp, abortOp, conflictBlocks, hasMarkers, writeRepoFile } from "./gitsync.js";
import { models, settingsFor, setUse, projectKey, runModel, describe, migrate } from "./ai.js";

const MAX_AI = 120 * 1024; // bigger files go through the editor: a CLI argument is capped near 128 KB
const OP = { rebase: "Rebase", merge: "Merge", "cherry-pick": "Cherry-pick", revert: "Revert" };

// The file in the main area's editor tab (wb-files viewer), like a click in the Files panel.
function openInEditor(root, on, path) {
  const space = spaces().find((s) => s.active);
  const req = { view: true, space: space?.id ?? null, root, on: on ?? null, path, ts: Date.now() };
  const ids = new Set((space?.tabs ?? []).map((t) => t.id));
  const existing = panes().find((p) => p.mod === "wb-files" && ids.has(p.tab));
  setShared("wb.files.request", req);
  const name = path.split("/").pop();
  if (existing) { run("tab.select", { id: existing.tab }); run("tab.rename", { id: existing.tab, name }); }
  else run("tab.new", { name, mod: "wb-files", props: req, space: space?.id ?? undefined });
}

export default class Conflicts extends View {
  init(_props, cx) {
    migrate();
    const p = props() ?? {};
    this.root = p.root; this.on = p.on ?? null;
    this.st = null;          // conflictState()
    this.sel = null;         // selected path
    this.blocks = {};        // path -> conflictBlocks() | { error }
    this.done = new Map();   // path -> how it was resolved (shown greyed under the list)
    this.working = new Map(); // path -> "Yours…" | "AI…"
    this.busy = "";          // Continue / Abort / AI all
    this.error = ""; this.note = "";
    this.key = null; this.modelId = null; this.menu = false;
    cx.spawn(async (cx) => {
      this.key = await projectKey({ cwd: this.root, on: this.on }).catch(() => null);
      this.modelId = settingsFor("conflict", this.key).model?.id ?? null;
      cx.notify();
    });
    this.reload(cx);
    // Edits in the editor tab (manual merges) show up here: a cheap re-ask while it's open.
    cx.timer.every(4000, (cx) => { if (!this.busy && !this.working.size) this.reload(cx); });
  }

  close() { closeOverlay(props()?.overlay); }
  full(path) { return `${this.root}/${path}`; }
  model() { return models().find((m) => m.id === this.modelId) ?? settingsFor("conflict", this.key).model; }

  reload(cx) {
    cx.spawn(async (cx) => {
      try {
        const st = await conflictState(this.root, this.on);
        this.st = st;
        if (!st.files.some((f) => f.path === this.sel)) this.sel = st.files[0]?.path ?? null;
        await Promise.all(st.files.map((f) => this.loadBlocks(f)));
      } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  async loadBlocks(f) {
    if (!f.ours || !f.theirs) { this.blocks[f.path] = { deleted: true }; return; }
    const text = await readTextFile(this.full(f.path), { on: this.on });
    this.blocks[f.path] = text == null ? { error: "Can't read it" } : { list: conflictBlocks(text), text };
  }

  // One file action with its spinner; the list reloads after.
  act(f, label, fn, cx) {
    if (this.working.has(f.path)) return;
    this.working.set(f.path, label); this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try { const how = await fn(); if (how) this.done.set(f.path, how); }
      catch (e) { this.error = `${f.path}: ${e?.message ?? e}`; }
      this.working.delete(f.path);
      this.reload(cx); cx.notify();
    });
  }

  side(f, who, cx) {
    const git = who === "yours" ? this.st.yours : (this.st.yours === "ours" ? "theirs" : "ours");
    this.act(f, who === "yours" ? "Yours…" : "Theirs…", async () => { await takeSide(this.root, this.on, f, git); return who === "yours" ? "kept yours" : "took theirs"; }, cx);
  }

  async aiResolve(f) {
    if (!f.ours || !f.theirs) throw new Error("deleted on one side: take Yours or Theirs");
    const full = this.full(f.path);
    const text = await readTextFile(full, { on: this.on });
    if (text == null) throw new Error("can't read it");
    if (!hasMarkers(text)) { await markResolved(this.root, this.on, f.path); return "no markers left"; }
    if (text.length > MAX_AI) throw new Error("too big for the AI: open it in the editor");
    const st = this.st, rebase = st.op === "rebase";
    const yoursIsOurs = st.yours === "ours";
    const mineLabel = rebase ? `your local commit${st.subject ? ` "${st.subject}"` : ""}` : "the local branch (HEAD)";
    const otherLabel = rebase ? `the upstream ${st.onto || "branch"} you are rebasing onto` : st.op === "merge" ? `the branch being merged${st.subject ? ` ("${st.subject}")` : ""}` : "the incoming change";
    const s = settingsFor("conflict", this.key);
    const prompt = [
      `You are resolving a git ${st.op ?? "merge"} conflict in the file ${f.path}.`,
      `Between "<<<<<<<" and "=======" (or "|||||||", the common base) is ${yoursIsOurs ? mineLabel : otherLabel}; between "=======" and ">>>>>>>" is ${yoursIsOurs ? otherLabel : mineLabel}.`,
      s.template,
      "Reply with the complete resolved file content only: every line of the file, no conflict markers, no explanations, no code fences.",
      "", "File:", text,
    ].join("\n");
    let out = await runModel(this.model(), prompt, { cwd: this.root, on: this.on });
    if (!out.trim()) throw new Error("the model answered nothing");
    if (hasMarkers(out)) throw new Error("the model left conflict markers: resolve it by hand");
    if (text.endsWith("\n") && !out.endsWith("\n")) out += "\n";
    await writeRepoFile(full, this.on, out, text);
    await markResolved(this.root, this.on, f.path);
    return `AI · ${this.model()?.name ?? "model"}`;
  }

  aiAll(cx) {
    if (this.busy || !this.st?.files.length) return;
    this.busy = "AI"; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      const errors = [];
      for (const f of this.st.files.filter((f) => f.ours && f.theirs)) {
        this.working.set(f.path, "AI…"); this.sel = f.path; cx.notify();
        try { this.done.set(f.path, await this.aiResolve(f)); } catch (e) { errors.push(`${f.path}: ${e?.message ?? e}`); }
        this.working.delete(f.path); cx.notify();
      }
      this.busy = "";
      this.error = errors.join(" · ");
      this.reload(cx); cx.notify();
    });
  }

  finish(kind, cx) {
    if (this.busy || !this.st) return;
    const op = this.st.op;
    this.busy = kind; this.error = ""; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (kind === "abort") await abortOp(this.root, this.on, op);
        else await continueOp(this.root, this.on, op);
        const st = await conflictState(this.root, this.on);
        if (!st.op && !st.files.length) { this.busy = ""; this.close(); return; }
        this.st = st; this.done.clear(); this.note = st.files.length ? `Next commit stopped too: ${st.subject}` : "";
        await Promise.all(st.files.map((f) => this.loadBlocks(f)));
        this.sel = st.files[0]?.path ?? null;
      } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = "";
      cx.notify();
    });
  }

  render(cx) {
    const t = theme(), st = this.st, files = st?.files ?? [], op = st?.op ?? null;
    const sel = files.find((f) => f.path === this.sel) ?? null, m = this.model();
    const btn = (id, label, on, opts = {}) => h_flex().id(id).h(26).px(10).gap(6).flex_none().items_center().rounded(6).text_size(12)
      .when(opts.primary, (e) => e.bg(opts.enabled === false ? t.raised : t.solid).text_color(opts.enabled === false ? t.dim : t.solid_foreground))
      .when(!opts.primary, (e) => e.border_1().border_color(opts.accent ? t.accent : t.border).text_color(opts.enabled === false ? t.dim : opts.accent ? t.accent : t.muted))
      .when(opts.enabled !== false, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => on(cx)))
      .when(Boolean(opts.tip), (e) => e.tooltip(opts.tip))
      .when(Boolean(opts.spin), (e) => e.child(svg("mods/wb-conflicts/icons/spinner.svg").size(11).spin(900)))
      .child(label);
    const yoursLabel = op === "rebase" ? "Yours (your commit)" : "Yours (HEAD)";
    const theirsLabel = op === "rebase" ? `Theirs (${st?.onto || "upstream"})` : `Theirs${st?.subject ? ` (${st.subject})` : ""}`;
    const title = !st ? "Conflicts…" : op === "rebase" ? `Rebasing${st.subject ? ` “${st.subject}”` : ""} onto ${st.onto || "upstream"}`
      : op ? `${OP[op]}${st.subject ? ` “${st.subject}”` : ""}` : "Conflicts after putting your uncommitted changes back";

    const fileRow = (f) => {
      const on = f.path === this.sel, w = this.working.get(f.path), parts = f.path.split("/"), name = parts.pop();
      const n = this.blocks[f.path]?.list?.length;
      return h_flex().id(`cf-${f.path}`).flex_none().h(30).px(8).gap(7).items_center().rounded(6).cursor_pointer()
        .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .tooltip(f.path).on_click((_e, cx) => { this.sel = f.path; cx.notify(); })
        .child(div().flex_none().w(8).h(8).rounded(4).bg(t.blocked))
        .child(h_flex().flex_1().min_w(0).text_size(12.5)
          .child(div().flex_none().text_color(t.foreground).child(name))
          .child(div().min_w(0).ml(6).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
        .when(Boolean(w), (e) => e.child(svg("mods/wb-conflicts/icons/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
        .when(!w, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim)
          .child(!f.ours ? "deleted by us" : !f.theirs ? "deleted by them" : n != null ? `${n} block${n === 1 ? "" : "s"}` : "")));
    };
    const doneRow = ([path, how]) => h_flex().flex_none().h(24).px(8).gap(7).items_center().text_size(12).text_color(t.dim)
      .child(div().flex_none().w(8).text_color(t.done).child("✓"))
      .child(div().flex_1().min_w(0).truncate().child(path.split("/").pop()))
      .child(div().flex_none().text_size(11).child(how));

    const code = (lines, color) => v_flex().flex_1().min_w(0).p(6).rounded(5).bg(t.background).border_1().border_color(color)
      .font_family("JetBrains Mono").text_size(11.5).text_color(t.foreground)
      .children(lines.length ? lines.map((l, i) => div().id(`l${i}`).whitespace_nowrap().overflow_x_hidden().child(l || " ")) : [div().text_color(t.dim).child("(nothing)")]);
    const detail = () => {
      if (!sel) return v_flex().flex_1().items_center().justify_center().text_color(t.dim)
        .child(!st ? "…" : files.length ? "Pick a file" : op ? `All conflicts resolved · Continue the ${op}` : "No conflicts left");
      const b = this.blocks[sel.path], w = this.working.has(sel.path), canAi = sel.ours && sel.theirs;
      return v_flex().flex_1().min_w(0).min_h(0).gap(8)
        .child(h_flex().flex_none().gap(6).flex_wrap()
          .child(btn("take-yours", "Accept Yours", (cx) => this.side(sel, "yours", cx), { enabled: !w, tip: `Keep ${yoursLabel.toLowerCase()} for the whole file` }))
          .child(btn("take-theirs", "Accept Theirs", (cx) => this.side(sel, "theirs", cx), { enabled: !w, tip: `Take ${theirsLabel} for the whole file` }))
          .child(btn("ai-one", "Resolve with AI", (cx) => this.act(sel, "AI…", () => this.aiResolve(sel), cx), { enabled: !w && canAi && Boolean(m), accent: true, tip: `${describe(m)} merges both sides and stages the file` }))
          .child(div().flex_1())
          .child(btn("open", "Open in editor", () => { openInEditor(this.root, this.on, sel.path); this.close(); }, { enabled: canAi, tip: "Merge it by hand in the editor tab; then reopen this dialog and Mark resolved" }))
          .child(btn("mark", "Mark resolved", (cx) => this.act(sel, "…", async () => { const txt = await readTextFile(this.full(sel.path), { on: this.on }); if (hasMarkers(txt)) throw new Error("still has conflict markers"); await markResolved(this.root, this.on, sel.path); return "by hand"; }, cx), { enabled: !w, tip: "git add: the file has no conflict markers left" })))
        .child(h_flex().flex_none().gap(8).text_size(11).text_color(t.dim)
          .child(div().flex_1().text_color(t.ansi2).child(yoursLabel))
          .child(div().flex_1().text_color(t.ansi4).child(theirsLabel)))
        .child(div().flex_1().min_h(0).relative()
          .child(v_flex().id("cf-blocks").absolute().inset_0().overflow_y_scroll().gap(10).pr(8)
            .when(!b, (e) => e.child(div().text_color(t.dim).child("Loading…")))
            .when(Boolean(b?.deleted), (e) => e.child(div().text_color(t.muted)
              .child(`${(st.yours === "ours" ? sel.ours : sel.theirs) ? "Changed on your side, deleted on theirs." : "Deleted on your side, changed on theirs."} Accept Yours or Theirs.`)))
            .when(Boolean(b?.error), (e) => e.child(div().text_color(t.ansi1).child(b.error)))
            .when(Boolean(b?.list && !b.list.length), (e) => e.child(div().text_color(t.muted).child("No conflict markers left: Mark resolved.")))
            .children((b?.list ?? []).map((blk, i) => {
              const mine = st.yours === "ours" ? blk.ours : blk.theirs, other = st.yours === "ours" ? blk.theirs : blk.ours;
              return v_flex().id(`blk-${i}`).flex_none().gap(4)
                .child(div().text_size(10.5).text_color(t.dim).child(`Block ${i + 1}`))
                .child(h_flex().gap(8).items_start().child(code(mine, t.ansi2)).child(code(other, t.ansi4)));
            })))
          .child(Scrollbar.vertical("cf-blocks").absolute().inset_0()));
    };

    const left = files.length;
    return v_flex().id("conflicts").size_full().p(16).gap(12).bg(t.popover).text_size(13)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_semibold().text_color(t.foreground).child(left ? `${left} conflict${left === 1 ? "" : "s"}` : "Conflicts"))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(title)))
        .child(div().relative()
          .child(h_flex().id("model").h(26).px(8).gap(5).items_center().rounded(6).border_1().border_color(t.border).cursor_pointer()
            .text_size(11.5).text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("The AI model for conflicts in this project")
            .on_click((_e, cx) => { this.menu = !this.menu; cx.notify(); })
            .child(div().max_w(180).truncate().child(m ? `${m.name} · ${m.model || "default"}` : "No AI model")).child(div().text_size(9).child("▾")))
          .when(this.menu, (e) => e.child(v_flex().absolute().top(30).right_0().w(240).p(4).gap(1).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg()
            .children(models().map((x) => h_flex().id(`m-${x.id}`).h(28).px(8).gap(6).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { this.modelId = x.id; this.menu = false; setUse("conflict", x.id, this.key); cx.notify(); })
              .child(div().w(12).text_color(t.accent).child(x.id === m?.id ? "✓" : ""))
              .child(v_flex().min_w(0).child(div().truncate().text_color(t.foreground).child(x.name)).child(div().truncate().text_size(10.5).text_color(t.dim).child(describe(x)))))))))
        .child(btn("ai-all", this.busy === "AI" ? "Resolving…" : "Resolve all with AI", (cx) => this.aiAll(cx),
          { primary: true, enabled: !this.busy && files.some((f) => f.ours && f.theirs) && Boolean(m), spin: this.busy === "AI", tip: "Each conflicted file through the model, one by one; resolved files are staged" })))
      .when(Boolean(this.error), (e) => e.child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.note && !this.error), (e) => e.child(div().flex_none().text_size(11.5).text_color(t.dim).child(this.note)))
      .child(h_flex().flex_1().min_h(0).gap(12).items_start()
        .child(v_flex().w(280).flex_none().h_full().gap(1).child(div().relative().flex_1().min_h(0)
          .child(v_flex().id("cf-files").absolute().inset_0().overflow_y_scroll().gap(1)
            .children(files.map(fileRow))
            .when(this.done.size > 0, (e) => e.child(div().mt(8).mb(2).px(8).text_size(10.5).text_color(t.dim).child("RESOLVED")).children([...this.done].map(doneRow))))
          .child(Scrollbar.vertical("cf-files").absolute().inset_0())))
        .child(div().w(1).h_full().bg(t.border))
        .child(detail()))
      .child(h_flex().flex_none().gap(8).items_center()
        .when(Boolean(op), (e) => e.child(btn("abort", `Abort ${op}`, (cx) => this.finish("abort", cx), { enabled: !this.busy, spin: this.busy === "abort", tip: `git ${op} --abort: back to how it was before` })))
        .child(div().flex_1())
        .child(btn("later", "Close", () => this.close(), { tip: `Leave it for now: the ${op ?? "conflict"} stays in progress` }))
        .when(Boolean(op), (e) => e.child(btn("continue", `Continue ${op}`, (cx) => this.finish("continue", cx),
          { primary: true, enabled: !this.busy && !left, spin: this.busy === "continue", tip: left ? "Resolve every file first" : `git ${op} --continue` }))));
  }
}
