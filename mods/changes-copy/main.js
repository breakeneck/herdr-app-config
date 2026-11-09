import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, run, shared, setShared, props, openOverlay, closeOverlay } from "herdr";
import * as S from "./section.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const ITEM = 22, INDENT = 10; // ITEM: changed-file list row, INDENT: per tree level
// Same default as the commit-gen window"s Template field.
const DEFAULT_TEMPLATE = "A first line of up to 72 characters in imperative mood. Then, only when they add something, short bullet details (\"- ...\"), one per line, right under it. No blank lines anywhere.";
const COMMIT_MIN = 40, COMMIT_MAX = 420; // commit message box height, px
// Generation settings live in shared("commit.gen"), edited in the commit-gen window.
const openGenSettings = () => openOverlay({ mod: "commit-gen", kind: "window", key: "commit-gen", width: 460 });

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.view = "list"; this.scope = "head"; this.collapsed = new Set();
    try { if (localStorage.getItem("view") === "tree") this.view = "tree"; if (localStorage.getItem("scope") === "base") this.scope = "base"; } catch {}
    this.message = ""; this.handle = cx.focus_handle(); this.generating = false;
    this.input = TextareaState.new({ placeholder: "Commit message" });
    // The box height (px) is a splitter choice: drag the handle above it up to grow it, remembered per person.
    // The textarea is sized by this height, not by rows (a Textarea's layout height is its element's).
    this.commitH = Math.min(COMMIT_MAX, Math.max(COMMIT_MIN, Number(localStorage.getItem("commitH")) || 72));
    this.splitDrag = null;
    this.input.set_rows(16);
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (e, cx) => { if (!e.modifiers?.shift) this.commit(cx); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, gitDir, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    // A worktree's index and HEAD live outside it (the main repo's .git/worktrees/<name>), so commits
    // and staging there would only show on the 10 s timer: watch that folder too.
    for (const dir of gitDir.startsWith(root + "/") ? [root] : [root, gitDir]) cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(dir);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { if (dir === root) this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.collapsed = new Set(); this.root = null; this.files = []; this.open = null;
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    const scope = this.scope, stale = () => key() !== context || this.scope !== scope;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd, on });
        if (stale()) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.open = null; this.error = "Not a git repository"; return; }
        const [root, gitDir] = top.stdout.trim().split("\n"), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        let against = head.code === 0 ? "HEAD" : null, base = null;
        // Branch scope: everything since the branch left its base (like a PR), including uncommitted work.
        if (scope === "base" && against) {
          for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
            const r = await git(["rev-parse", "--abbrev-ref", ref]);
            if (r.code !== 0) continue;
            const mb = await git(["merge-base", "HEAD", ref]);
            if (mb.code === 0) { base = r.stdout.trim(); against = mb.stdout.trim(); break; }
          }
        }
        const stats = {};
        const results = against ? [await git(["diff", against, "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        let entries = status.stdout.split("\0").filter(Boolean);
        if (base) {
          // Tracked changes come from the diff against the merge-base; untracked files from status.
          const ns = await git(["diff", against, "--name-status", "-z", "--no-renames"]);
          if (ns.code !== 0) throw new Error(ns.stderr);
          const parts = ns.stdout.split("\0"), tracked = [];
          for (let i = 0; i + 1 < parts.length; i += 2) tracked.push(`${parts[i][0] === "U" ? "UU" : parts[i][0] + " "} ${parts[i + 1]}`);
          entries = [...tracked, ...entries.filter((e) => e.startsWith("??"))];
        }
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (stale()) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.against = against; this.base = base; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, gitDir, cx);
        if (this.open && !files.some((f) => f.path === this.open)) this.open = null;
        // The first changed file is highlighted; its diff itself opens in the main area on click.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
      } catch (e) { if (!stale()) this.error = String(e); }
      finally { this.loading = false; if (this.scope !== scope) this.refresh(cx); cx.notify(); }
    });
  }


  setView(view, cx) {
    if (this.view === view) return;
    this.view = view;
    try { localStorage.setItem("view", view); } catch {}
    cx.notify();
  }

  setScope(scope, cx) {
    if (this.scope === scope) return;
    this.scope = scope;
    try { localStorage.setItem("scope", scope); } catch {}
    this.files = []; this.open = null; this.closed = false; this.note = null;
    this.refresh(cx); cx.notify();
  }

  // Icon toggle group: options are [value, icon in ./icons, tooltip]; `warn` paints that option red.
  segment(name, current, options, pick, t, warn = null) {
    return h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
      .children(options.map(([v, icon, tip]) => div().id(`${name}-${v}`).w(26).h(20).flex().items_center().justify_center().cursor_pointer().tooltip(tip)
        .text_color(v === warn ? t.ansi1 : current === v ? t.foreground : t.muted)
        .when(current === v, (e) => e.bg(t.selected)).when(current !== v, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { cx.stop_propagation(); pick(v, cx); }).child(svg(`mods/changes-copy/icons/${icon}.svg`).size(13))));
  }

  toggleDir(path, cx) {
    if (!this.collapsed.delete(path)) this.collapsed.add(path);
    cx.notify();
  }

  // Flat file rows, or folders-first tree rows (single-child folder chains are merged: a/b/c).
  listRows() {
    if (this.view !== "tree") return this.files.map((f) => ({ file: f, depth: 0 }));
    const top = { dirs: new Map(), files: [] };
    for (const f of this.files) {
      const parts = f.path.split("/"), name = parts.pop();
      let node = top;
      for (const part of parts) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ file: f, name });
    }
    const count = (n) => n.files.length + [...n.dirs.values()].reduce((sum, d) => sum + count(d), 0);
    const rows = [];
    const walk = (node, prefix, depth) => {
      for (const [name, first] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        let label = name, dir = first, path = prefix + name;
        while (dir.files.length === 0 && dir.dirs.size === 1) {
          const [k, v] = [...dir.dirs][0];
          label += "/" + k; path += "/" + k; dir = v;
        }
        const open = !this.collapsed.has(path);
        rows.push({ dir: true, path, label, depth, open, count: count(dir) });
        if (open) walk(dir, path + "/", depth + 1);
      }
      for (const entry of node.files.sort((a, b) => a.name.localeCompare(b.name))) rows.push({ ...entry, depth });
    };
    walk(top, "", 0);
    return rows;
  }

  dirRow(r, t) {
    return h_flex().id(`dir-${r.path}`).h(ITEM).flex_none().pl(8 + r.depth * INDENT).pr(8).gap(6).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleDir(r.path, cx))
      .child(div().w(12).text_size(10).text_color(t.muted).child(r.open ? "▾" : "▸"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.label))
      .child(div().text_size(10).text_color(t.dim).child(String(r.count)));
  }

  // A click always opens that file's diff (and re-opens it, if its tab was closed).
  pick(path, cx) {
    this.open = path; this.note = null; this.closed = false;
    this.openMain(path);
    cx.notify();
  }

  // A clicked file opens its PhpStorm-style side-by-side diff wide in the main area, as a tab.
  // One diff tab per space: clicking another file sends it a new request through shared state.
  openMain(path) {
    if (!this.root) return;
    const file = this.files.find((f) => f.path === path);
    const space = spaces().find((s) => s.active);
    // `space`: each space's diff tab takes only its own space's requests.
    const req = { space: space?.id ?? null, root: this.root, on: this.on ?? null, path, against: this.against ?? null, status: file?.status ?? "M", fresh: Boolean(file?.fresh), ts: Date.now() };
    const ids = new Set((space?.tabs ?? []).map((t) => t.id));
    const existing = panes().find((p) => p.mod === "diff-view" && ids.has(p.tab));
    setShared("diff.request", req);
    // The tab is named after the file it shows.
    if (existing) { run("tab.select", { id: existing.tab }); run("tab.rename", { id: existing.tab, name: path.split("/").pop() }); }
    else run("tab.new", { name: path.split("/").pop(), mod: "diff-view", props: req, space: space?.id ?? undefined });
  }

  genConfig() { return { provider: "claude", command: "claude", args: "-p", model: "", url: "http://localhost:11434/v1", ...(shared("commit.gen") ?? {}) }; }
  // Ask the configured model for a commit message from the current diff, and drop it into the textarea.
  // Claude rides the person's subscription and starts inside the repo folder; local goes to the endpoint.
  generate(cx) {
    if (!this.root || this.generating || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, hasHead = this.hasHead, against = this.against;
    const cfg = this.genConfig();
    this.generating = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [st, df] = await Promise.all([
          git(["status", "--short"]),
          git(["diff", ...(hasHead ? [against ?? "HEAD"] : []), "--no-color"]),
        ]);
        const fresh = (st.stdout || "").split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3)).slice(0, 20);
        let text = `Git status:\n${st.stdout}\n\nDiff:\n${(df.stdout || "").slice(0, 60000)}`;
        if (fresh.length) text += `\n\nNew untracked files (contents not shown): ${fresh.join(", ")}`;
        // The template (commit-gen window) says how the message looks; blank lines are dropped unless allowed.
        const prompt = `Write one git commit message for these changes in this repository. Format: ${cfg.template || DEFAULT_TEMPLATE} Reply with the message only — no quotes, no code fences, no explanations.`;
        let msg;
        if (cfg.provider === "local") {
          const url = String(cfg.url || "").replace(/\/+$/, "");
          if (!url) throw new Error("set the local server URL in Settings first");
          if (!cfg.model) throw new Error("pick a model in Settings first");
          const r = await fetch(`${url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: `${prompt}\n\n${text}` }], stream: false }) });
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
          const j = await r.json();
          msg = String(j.choices?.[0]?.message?.content ?? "").trim();
        } else {
          const args = [...String(cfg.args || "").split(/\s+/).filter(Boolean), ...(cfg.model ? ["--model", cfg.model] : []), `${prompt}\n\n${text}`];
          const r = await exec(cfg.command || "claude", args, { cwd: root, on, timeout: 180000 });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout || "no output").trim().slice(0, 300));
          msg = r.stdout.trim();
        }
        msg = msg.replace(/^```[^\n]*\n/, "").replace(/\n?```$/, "").trim();
        if (cfg.noBlank !== false) msg = msg.split("\n").filter((l) => l.trim()).join("\n");
        if (!msg) throw new Error("the model returned nothing");
        if (key() === context) { this.input.set_value(msg); this.message = msg; }
      } catch (e) { if (key() === context) this.note = `Generate failed: ${e}`; }
      finally { this.generating = false; cx.notify(); }
    });
  }

  // The thin dropdown beside the Generate button.
  menuView() {
    const t = theme();
    const item = (id, label, action) => h_flex().id(id).h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .text_size(12.5).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { closeOverlay(props()?.overlay); action(); })
      .child(svg("mods/workspace-chrome/settings.svg").size(13).text_color(t.muted)).child(label);
    return v_flex().p(6).gap(2).w_full().bg(t.raised).text_color(t.foreground)
      .child(item("gen-settings", "Settings…", openGenSettings));
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  endSplit() {
    if (!this.splitDrag) return;
    this.splitDrag = null;
    try { localStorage.setItem("commitH", String(this.commitH)); } catch {}
  }

  render(cx) {
    if (props()?.menu) return this.menuView();
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const rows = this.listRows(), tree = this.view === "tree";
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const genEnabled = Boolean(this.root && !this.generating && !this.busy && !this.loading && this.context === key());
    const noBase = this.scope === "base" && Boolean(this.root) && !this.base && !this.loading;
    const sec = S.sectionOf("changes-copy"), ov = S.overlay(sec);
    return v_flex().id("changes").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
      })
      // The commit-box splitter: the handle grabs, the panel tracks the drag even outside it.
      .on_mouse_move((e, cx) => {
        if (!this.splitDrag) return;
        const z = settings().zoom || 1;
        // The handle sits above the box: dragging up grows it.
        const h = Math.round(Math.max(COMMIT_MIN, Math.min(COMMIT_MAX, this.splitDrag.h - (e.position.y - this.splitDrag.y) / z)));
        if (h !== this.commitH) { this.commitH = h; cx.notify(); }
      })
      .on_mouse_up("left", () => this.endSplit())
      .on_hover((hovered) => { if (!hovered) this.endSplit(); })
      .child(S.header(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border), sec, 44)
        .child(S.mark(sec))
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1())
        .child(this.segment("scope", this.scope, [["head", "uncommitted", "Uncommitted changes"],
          ["base", "branch", this.base ? `Branch changes vs ${this.base} (incl. uncommitted)` : noBase ? "No base branch (origin/HEAD, main, master) · showing uncommitted" : "Branch changes vs base"]],
          (v, cx) => this.setScope(v, cx), t, noBase ? "base" : null))
        .child(this.segment("view", this.view, [["list", "list", "List"], ["tree", "tree", "Tree"]], (v, cx) => this.setView(v, cx), t))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(rows.map((r) => {
        if (r.dir) return this.dirRow(r, t);
        const f = r.file, parts = tree ? [] : f.path.split("/"), name = tree ? r.name : parts.pop();
        return h_flex().id(`change-${f.path}`).h(ITEM).flex_none().px(8).pl(tree ? 8 + r.depth * INDENT + 18 : 8).gap(4).items_center().rounded(5).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(10).flex_none().text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (this.base ? `No changes since ${this.base}` : "No uncommitted changes") : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
            .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      // Explicit height: the layout under-measures the Textarea inside, which pushed the buttons off the bottom.
      // 10+10 padding, 8 handle, 8+8 gaps, 30 buttons, 1 border.
      .child(v_flex().flex_none().h(this.commitH + 75).overflow_hidden().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-split").h(12).flex_none().ml(-10).mr(-10).mt(-4).flex().items_center().justify_center().cursor_row_resize().tooltip("Drag to resize the message box").hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (e, cx) => { this.splitDrag = { y: e.position.y, h: this.commitH }; cx.stop_propagation(); })
          .child(div().w(36).h(4).rounded(2).bg(t.border)))
        .child(div().id("commit-message").w_full().h(this.commitH).flex_none().overflow_hidden().px(10).py(6).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.input).w_full().h(this.commitH - 14).text_size(12).text_color(t.foreground)))
        .child(h_flex().gap(8).items_center()
          .child(h_flex().id("generate").h(30).flex_none().rounded(8).overflow_hidden().border_1().border_color(genEnabled ? t.accent : t.border)
            .child(h_flex().id("generate-run").px(12).h_full().items_center().gap(6).text_size(12).text_color(this.generating ? t.accent : genEnabled ? t.accent : t.dim).when(genEnabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.generate(cx)).tooltip(`Ask ${this.genConfig().command || "claude"} to write the commit message from the diff`)
              .child(this.generating ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.accent).spin(900) : svg("mods/workspace-chrome/layers.svg").size(12))
              .child(this.generating ? "Generating…" : "Generate"))
            .child(div().id("generate-menu").w(26).h_full().flex().items_center().justify_center().border_l(1).border_color(t.border).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("More").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => openOverlay({ mod: "changes-copy", kind: "popup", width: 180, props: { menu: true } })).child(svg("mods/workspace-chrome/chevron-down.svg").size(12))))
          .child(div().flex_1())
          .child(div().id("commit").h(30).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))))
      .when(Boolean(ov), (e) => e.child(ov));
  }
}
