// Branch picker behind the header's branch chip: all local branches in a tree
// (groups by their `prefix/`), recently checked-out ones pinned on top, a filter
// box. A click runs `git checkout` and nothing else — spaces, tabs and terminals
// never move. The dialog stays open after it, so Update (gitsync.js: fetch + fast-forward or rebase,
// conflicts in wb-conflicts) is one click away; each branch shows ↓ behind / ↑ ahead of its upstream.
// Recent comes from git's reflog, so terminal checkouts count and deleted
// branches drop out by themselves.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { props, closeOverlay, theme, spaces, panes, exec, setShared } from "herdr";
import { updateRepo, openConflicts, lastSync, repoKey } from "./gitsync.js";

// Where a space works now: its focused terminal's folder, else the first known one.
function place(sp, ps) {
  const tabs = new Set((sp?.tabs ?? []).map(c => c.id));
  return ps.find(p => p.focused && tabs.has(p.tab))?.cwd
    ?? ps.find(p => tabs.has(p.tab) && p.cwd)?.cwd ?? sp?.folder ?? null;
}

const RECENTS = 8;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

export default class BranchPicker extends View {
  init(_props, cx) {
    const sp = spaces().find(s => s.id === props()?.space) ?? spaces().find(s => s.active);
    this.on = sp?.machine ?? null;
    this.folder = place(sp, panes());
    this.repoName = "";
    this.branches = undefined; // undefined: loading; then [{ name, at }]
    this.current = null;
    this.recents = [];
    this.error = "";
    this.busy = "";
    this.fetching = false;
    this.note = "";
    this.text = "";
    this.at = 0;
    this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
    this.input = InputState.new({ placeholder: "filter branches" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.pick(this.pickable()[this.at], cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => { await this.load(); cx.notify(); });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  async load() {
    if (!this.folder) { this.branches = []; this.error = "This space has no folder to ask."; return; }
    try {
      const top = await exec("git", [...READ, "rev-parse", "--show-toplevel", "--show-prefix"], { cwd: this.folder, on: this.on });
      if (top.code !== 0) { this.branches = []; this.error = `${this.folder} is not in a git repository.`; return; }
      const lines = top.stdout.split("\n");
      const rootRaw = (lines[0] ?? "").trim();
      const prefix = (lines[1] ?? "").trim();
      this.root = rootRaw;
      this.repoName = rootRaw.replace(/\/+$/, "").split("/").pop();
      this.inSub = Boolean(prefix.trim());
      const head = await exec("git", [...READ, "status", "--porcelain=v2", "--branch"], { cwd: this.folder, on: this.on });
      for (const line of head.stdout.split("\n")) if (line.startsWith("# branch.head ")) this.current = line.slice(14);
      const fmt = "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:track,nobracket)";
      const local = await exec("git", [...READ, "for-each-ref", fmt, "refs/heads"], { cwd: this.folder, on: this.on });
      const list = local.stdout.split("\n").filter(Boolean)
        .map(l => {
          const [name, at, track = ""] = l.split("\t");
          return { name, at: Number(at) || 0, ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0), behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0), gone: track === "gone" };
        })
        .sort((a, b) => b.at - a.at);
      this.branches = list;
      // Recents, like the IDE's: the branches HEAD last moved to, from git's own reflog — so checkouts made
      // in a terminal count too, and nothing is stored here. The current one and deleted ones are left out.
      const known = new Set(list.map(b => b.name));
      const log = await exec("git", [...READ, "reflog", "--format=%gs", "-n", "1000"], { cwd: this.folder, on: this.on });
      const seen = new Set([this.current]);
      this.recents = [];
      for (const l of log.stdout.split("\n")) {
        const m = l.match(/^checkout: moving from (.+) to (.+)$/);
        if (!m) continue;
        for (const n of [m[2], m[1]]) if (known.has(n) && !seen.has(n)) { seen.add(n); this.recents.push(n); }
        if (this.recents.length >= RECENTS) break;
      }
    } catch (e) {
      this.branches = [];
      this.error = String(e?.message ?? e);
    }
  }

  // Rows to draw: the recent section (unfiltered), then a tree of the rest.
  rows() {
    const f = this.text.trim().toLowerCase();
    const all = this.branches ?? [];
    const match = (b) => !f || b.name.toLowerCase().includes(f);
    const inRecents = new Set(this.recents);
    const out = [];
    if (!f && this.recents.length) {
      const rec = this.recents.map(n => all.find(b => b.name === n)).filter(Boolean);
      if (rec.length) {
        out.push({ kind: "head", label: "Recent" });
        for (const b of rec) out.push({ kind: "row", b, depth: 0 });
      }
    }
    const rest = all.filter(b => (f || !inRecents.has(b.name)) && match(b));
    const tops = rest.filter(b => !b.name.includes("/"));
    for (const b of tops) out.push({ kind: "row", b, depth: 0 });
    const groups = {};
    for (const b of rest) if (b.name.includes("/")) {
      const g = b.name.slice(0, b.name.indexOf("/"));
      (groups[g] ??= []).push(b);
    }
    for (const g of Object.keys(groups).sort()) {
      const open = Boolean(f) || !this.collapsed.has(g);
      out.push({ kind: "group", g, count: groups[g].length, open });
      if (open) for (const b of groups[g]) out.push({ kind: "row", b, depth: 1, rest: b.name.slice(g.length + 1) });
    }
    return out;
  }

  pickable() {
    return this.rows().filter(r => r.kind === "row").map(r => r.b);
  }

  toggle(g, cx) {
    if (this.collapsed.has(g)) this.collapsed.delete(g); else this.collapsed.add(g);
    localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
    cx.notify();
  }

  pick(b, cx) {
    if (!b || this.busy || b.name === this.current) return;
    this.busy = b.name;
    this.error = "";
    this.note = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // Plain checkout: only git's state moves, the window stays as it is.
        const r = await exec("git", ["checkout", b.name], { cwd: this.folder, on: this.on, timeout: 600_000 });
        if (r.code !== 0) {
          this.busy = "";
          this.error = (r.stderr || r.stdout).trim().split("\n").filter(Boolean).pop() || "git checkout failed.";
          cx.notify();
          return;
        }
        // The branch left goes to the top of Recent; the new current one leaves it.
        if (this.current) this.recents = [this.current, ...this.recents.filter(n => n !== this.current && n !== b.name)].slice(0, RECENTS);
        setShared("wb.branch.switched", Date.now()); // the header chip and the log re-ask on this
        // Stay open: the new current branch is marked, and Update is one click away.
        this.current = b.name;
        this.busy = "";
        this.note = `Switched to ${b.name}`;
        cx.notify();
      } catch (e) {
        this.busy = "";
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  // Update the current branch (gitsync.js, the same as the log's Update): fetch, then fast-forward or rebase.
  // A conflict closes this and opens the conflicts dialog.
  update(cx) {
    if (this.fetching || !this.root) return;
    this.fetching = true; this.error = ""; this.note = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await updateRepo(this.root, this.on);
        this.seenSync = lastSync()?.ts ?? 0; // our own announce: the list reloads right here
        if (r.conflict) { this.fetching = false; this.close(); openConflicts(this.root, this.on); return; }
        await this.load();
        this.note = r.text;
      } catch (e) { this.error = String(e?.message ?? e); await this.load().catch(() => {}); }
      this.fetching = false;
      cx.notify();
    });
  }

  // Someone else (the log, the conflicts dialog) moved this repo's refs: the list follows.
  follow(cx) {
    const sy = lastSync();
    if (!sy || !this.root || sy.ts === (this.seenSync ??= sy.ts)) return;
    this.seenSync = sy.ts;
    if (sy.rk !== repoKey(this.on, this.root)) return;
    cx.spawn(async (cx) => { await this.load(); cx.notify(); });
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    const n = this.pickable().length;
    if (e.key === "enter") { this.pick(this.pickable()[this.at], cx); cx.stop_propagation(); return cx.notify(); }
    if ((e.key === "down" || e.key === "up") && n) { this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n; cx.stop_propagation(); return cx.notify(); }
  }

  render(cx) {
    this.follow(cx);
    const t = theme();
    const rows = this.rows();
    const total = (this.branches ?? []).length;
    const cur = (this.branches ?? []).find(b => b.name === this.current);
    let rowNo = -1;
    const row = (r) => {
      if (r.kind === "head") {
        return h_flex().flex_none().h(24).px(10).items_center().child(div().text_size(11).text_color(t.dim).child(r.label.toUpperCase()));
      }
      if (r.kind === "group") {
        return h_flex().id(`bg-${r.g}`).flex_none().h(28).px(10).gap(7).items_center().rounded(6).cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.toggle(r.g, cx))
          .child(div().w(16).text_size(11).text_color(t.dim).child(r.open ? "▾" : "▸"))
          .child(svg("mods/wb-branch-picker/icons/folder.svg").size(13).text_color(t.dim))
          .child(div().text_color(t.muted).child(r.g))
          .child(div().text_size(11).text_color(t.dim).child(String(r.count)));
      }
      const i = ++rowNo;
      const on = i === this.at;
      const cur = r.b.name === this.current;
      const busy = this.busy === r.b.name;
      return h_flex()
        .id(`br-${i}`)
        .flex_none()
        .h(30)
        .pl(10 + r.depth * 18)
        .pr(10)
        .gap(8)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(on, el => el.bg(t.selected))
        .when(!on, el => el.hover(s => s.bg(t.hover)))
        .tooltip(r.b.name)
        .on_click((_e, cx) => this.pick(r.b, cx))
        .child(svg(`mods/wb-branch-picker/icons/${r.depth ? "branch" : "git-branch"}.svg`).size(13).text_color(cur ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(cur ? t.foreground : t.muted).child(r.rest ?? r.b.name))
        .when(r.b.behind > 0 || r.b.ahead > 0 || r.b.gone, el => el.child(h_flex().flex_none().gap(4).text_size(11)
          .when(r.b.behind > 0, el => el.child(div().text_color(t.ansi4).child(`↓${r.b.behind}`)))
          .when(r.b.ahead > 0, el => el.child(div().text_color(t.ansi2).child(`↑${r.b.ahead}`)))
          .when(r.b.gone, el => el.child(div().text_color(t.dim).tooltip("Its upstream branch was deleted").child("gone")))))
        .when(cur, el => el.child(div().flex_none().text_size(11).text_color(t.accent).child("current")))
        .when(busy, el => el.child(svg("mods/wb-branch-picker/icons/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(!cur && !busy && r.b.at > 0, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(r.b.at))));
    };
    return v_flex()
      .id("branch-picker")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(`Branches${this.repoName ? ` of ${this.repoName}` : ""}`))
        .when(this.branches, el => el.child(div().text_size(11).text_color(t.dim).child(this.text.trim() ? `${rows.filter(r => r.kind === "row").length}/${total}` : `${total}`)))
        .when(Boolean(this.root), el => el.child(h_flex().id("br-fetch").ml(10).h(24).px(8).gap(5).items_center().rounded(6).border(1).border_color(t.border)
          .text_size(11.5).text_color(this.fetching ? t.dim : t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`Update ${this.current ?? "the current branch"}: fetch, then bring its upstream's commits in (fast-forward, or rebase your commits on top). Conflicts open the conflicts dialog.`)
          .on_click((_e, cx) => this.update(cx))
          .when(this.fetching, el => el.child(svg("mods/wb-branch-picker/icons/spinner.svg").size(11).spin(900)))
          .child(this.fetching ? "Updating…" : `Update${cur?.behind ? ` ↓${cur.behind}` : ""}`))))
      .when(Boolean(this.note) && !this.error, el => el.child(div().text_size(11.5).text_color(t.dim).child(this.note)))
      .when(this.inSub, el => el.child(div().text_size(11).text_color(t.dim).child(`checked out inside ${this.folder.replace(this.root + "/", "")}`)))
      .when(this.branches === undefined, el => el.child(div().text_color(t.muted).child("…")))
      .when(this.branches && this.error && !this.branches.length, el => el.child(div().text_color(t.muted).child(this.error)))
      .when(this.branches && this.branches.length && this.error, el => el.child(div().text_size(11.5).text_color(t.error ?? "#d9649a").child(this.error)))
      .when(this.branches && this.branches.length, el => el
        .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
        .child(div().relative().h(400).min_h(0)
          .child(v_flex().id("br-list").absolute().inset_0().overflow_y_scroll().gap(1)
            .children(rows.map(row))
            .when(!rows.some(r => r.kind === "row"), el => el.child(div().p(10).text_color(t.dim).child("No matching branch."))))
          .child(Scrollbar.vertical("br-list").absolute().inset_0())))
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("↑↓ choose · ↵ checkout · esc close"));
  }
}