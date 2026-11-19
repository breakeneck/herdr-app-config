// Branch picker behind the header's branch chip: local AND remote branches as a tree (sections Recent /
// Local / Remote; every `/` makes a nested folder, remotes sit under their remote's name), recently
// checked-out ones pinned on top, a filter box. A click runs `git checkout` — spaces, tabs and terminals
// never move. Picking a remote branch checks out the local one of that name, else creates it tracking
// the remote (`--track`). Smart checkout, as the IDE's: when local changes would be overwritten the
// picker shows a panel instead of git's "Aborting" with Smart Checkout (stash incl. untracked, checkout,
// stash pop), Force Checkout (discards, asks twice) and Don't Checkout. A pop that conflicts keeps the
// stash and points at Resolve. The dialog stays open after a switch, so Update (gitsync.js: fetch +
// fast-forward or rebase, conflicts via the Changes header's Resolve) is one click away; local branches
// show ↓ behind / ↑ ahead of their upstream. The remote list is local data only (Update fetches).
// Recent comes from git's reflog, so terminal checkouts count and deleted branches drop out by themselves.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { props, closeOverlay, theme, spaces, panes, exec, setShared } from "herdr";
import { updateRepo, lastSync, repoKey, announce } from "./gitsync.js";

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
    this.conflict = null; // { args, to, files }: the checkout git refused because of local changes
    this.armed = false;   // Force Checkout was clicked once: the next click discards
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
      const fmt = "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track,nobracket)";
      const local = await exec("git", [...READ, "for-each-ref", fmt, "refs/heads"], { cwd: this.folder, on: this.on });
      const list = local.stdout.split("\n").filter(Boolean)
        .map(l => {
          const [name, at, upstream = "", track = ""] = l.split("\t");
          return { name, at: Number(at) || 0, upstream, ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0), behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0), gone: track === "gone" };
        })
        .sort((a, b) => b.at - a.at);
      this.branches = list;
      this.upstream = list.find(b => b.name === this.current)?.upstream ?? "";
      // Remote branches: local data only (no fetch here). refname, not :short, so origin/HEAD can't turn into "origin".
      const rem = await exec("git", [...READ, "for-each-ref", "--format=%(refname)%09%(committerdate:unix)", "refs/remotes"], { cwd: this.folder, on: this.on });
      this.remotes = rem.stdout.split("\n").filter(Boolean).map(l => {
        const [ref, at] = l.split("\t");
        return { name: ref.replace(/^refs\/remotes\//, ""), at: Number(at) || 0, remote: true };
      }).filter(b => b.name.includes("/") && !b.name.endsWith("/HEAD")).sort((a, b) => b.at - a.at);
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

  // Rows to draw: the recent section (unfiltered), then Local and Remote as nested folders.
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
    // Every `/` is a folder level; folders first by name, then the branches (already newest first).
    const tree = (items, sect) => {
      const walk = (its, prefix, depth) => {
        const folders = {}, leaves = [];
        for (const it of its) {
          if (it.parts.length - prefix.length > 1) (folders[it.parts[prefix.length]] ??= []).push(it); else leaves.push(it);
        }
        for (const seg of Object.keys(folders).sort()) {
          const path = [...prefix, seg], key = `${sect}:${path.join("/")}`;
          const open = Boolean(f) || !this.collapsed.has(key);
          out.push({ kind: "group", key, label: seg, depth, count: folders[seg].length, open });
          if (open) walk(folders[seg], path, depth + 1);
        }
        for (const it of leaves) out.push({ kind: "row", b: it.b, depth, rest: it.parts[it.parts.length - 1] });
      };
      walk(items.map(b => ({ b, parts: b.name.split("/") })), [], 0);
    };
    const loc = all.filter(b => (f || !inRecents.has(b.name)) && match(b));
    if (loc.length) { out.push({ kind: "head", label: "Local" }); tree(loc, "local"); }
    const rem = (this.remotes ?? []).filter(match);
    if (rem.length) { out.push({ kind: "head", label: "Remote" }); tree(rem, "remote"); }
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

  // A remote branch checks out the local one of that name, else creates it tracking the remote.
  pick(b, cx) {
    if (!b || this.busy) return;
    let to = b.name, args = ["checkout", b.name];
    if (b.remote) {
      to = b.name.slice(b.name.indexOf("/") + 1);
      if (!(this.branches ?? []).some(x => x.name === to)) args = ["checkout", "--track", b.name];
      else args = ["checkout", to];
    }
    if (to === this.current) return;
    this.error = ""; this.note = ""; this.conflict = null; this.armed = false;
    this.go({ args, to }, "plain", cx);
  }

  // mode: plain (git's own checkout; local changes that don't clash come along), smart (stash incl. untracked,
  // checkout, pop) or force (discard). Only git's state moves, the window stays as it is.
  go(at, mode, cx) {
    const { args, to } = at;
    const from = this.current;
    this.busy = to; this.error = ""; this.note = ""; this.conflict = null; this.armed = false;
    cx.notify();
    const git = (a) => exec("git", a, { cwd: this.folder, on: this.on, timeout: 600_000 });
    const text = (r) => (r.stderr || r.stdout || "").trim().split("\n").map(l => l.trimEnd()).filter(l => l.trim()).join("\n");
    cx.spawn(async (cx) => {
      let stashed = false;
      try {
        if (mode === "smart") {
          const s = await git(["stash", "push", "--include-untracked", "-m", `wb smart checkout ${from ?? "HEAD"} → ${to}`]);
          if (s.code !== 0) { this.error = text(s) || "git stash failed."; return; }
          stashed = !/No local changes/.test(s.stdout + s.stderr); // else a pop would take someone else's stash
        }
        const r = await git(mode === "force" ? ["checkout", "--force", ...args.slice(1)] : args);
        if (r.code !== 0) {
          const err = text(r);
          if (stashed) await git(["stash", "pop"]); // back to how it was
          else if (mode === "plain" && /would be overwritten by checkout/.test(err)) {
            // The lines git indents with a tab are the files.
            const files = err.split("\n").filter(l => l.startsWith("\t")).map(l => l.trim());
            this.conflict = { args, to, files };
            return;
          }
          this.error = err || "git checkout failed.";
          return;
        }
        let popFailed = false;
        if (stashed) popFailed = (await git(["stash", "pop"])).code !== 0;
        // The branch left goes to the top of Recent; the new current one leaves it.
        if (from) this.recents = [from, ...this.recents.filter(n => n !== from && n !== to)].slice(0, RECENTS);
        setShared("wb.branch.switched", Date.now()); // the header chip and the log re-ask on this
        if (this.root) announce(this.on, this.root, "checkout"); // the Changes panel refreshes
        // Stay open: the new current branch is marked, and Update is one click away.
        this.current = to;
        if (popFailed) this.error = `Switched to ${to}; your changes conflict — resolve them from the Resolve button in the Changes header (the stash is kept)`;
        else this.note = `Switched to ${to}`;
        this.seenSync = lastSync()?.ts ?? 0; // our own announce: reload right here
        await this.load();
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = "";
        cx.notify();
      }
    });
  }

  // Update the current branch (gitsync.js, the same as the log's Update): fetch, then fast-forward or rebase.
  // A conflict says so; the Changes header shows Resolve, which opens the conflicts dialog.
  update(cx) {
    if (this.fetching || !this.root) return;
    this.fetching = true; this.error = ""; this.note = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await updateRepo(this.root, this.on);
        this.seenSync = lastSync()?.ts ?? 0; // our own announce: the list reloads right here
        await this.load();
        if (r.conflict) this.error = `${r.text} · Resolve them from the Resolve button in the Changes header`;
        else this.note = r.text;
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

  // The smart-checkout panel: git refused because local changes would be overwritten.
  panel(t) {
    const c = this.conflict, n = c.files.length;
    const btn = (id, label, onClick, primary, danger) => div().id(id).flex_none().h(26).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(primary, el => el.bg(t.solid).text_color(t.solid_foreground).hover(s => s.opacity(0.85)))
      .when(!primary, el => el.border(1).border_color(danger ? (t.error ?? "#d9649a") : t.border).text_color(danger ? (t.error ?? "#d9649a") : t.muted).hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => onClick(cx)).child(label);
    return v_flex().flex_none().p(10).gap(8).rounded(6).border(1).border_color(t.border).bg(t.surface)
      .child(div().text_size(12).text_color(t.foreground).child(n ? `Your local changes to ${n} file${n === 1 ? "" : "s"} would be overwritten by checkout` : "Your local changes would be overwritten by checkout"))
      .when(n > 0, el => el.child(v_flex().text_size(11.5).text_color(t.muted)
        .children(c.files.slice(0, 6).map(f => div().truncate().child(f)))
        .when(n > 6, el => el.child(div().text_color(t.dim).child(`+${n - 6} more`)))))
      .child(h_flex().gap(8)
        .child(btn("sc-smart", "Smart Checkout", (cx) => this.go(c, "smart", cx), true))
        .child(btn("sc-force", this.armed ? "Discard changes?" : "Force Checkout", (cx) => {
          if (!this.armed) { this.armed = true; return cx.notify(); }
          this.go(c, "force", cx);
        }, false, true))
        .child(btn("sc-no", "Don't Checkout", (cx) => { this.conflict = null; this.armed = false; cx.notify(); })));
  }

  render(cx) {
    this.follow(cx);
    const t = theme();
    const rows = this.rows();
    const total = (this.branches ?? []).length + (this.remotes ?? []).length;
    const cur = (this.branches ?? []).find(b => b.name === this.current);
    let rowNo = -1;
    const row = (r) => {
      if (r.kind === "head") {
        return h_flex().flex_none().h(24).px(10).items_center().child(div().text_size(11).text_color(t.dim).child(r.label.toUpperCase()));
      }
      if (r.kind === "group") {
        return h_flex().id(`bg-${r.key}`).flex_none().h(28).pl(10 + r.depth * 18).pr(10).gap(7).items_center().rounded(6).cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.toggle(r.key, cx))
          .child(div().w(16).text_size(11).text_color(t.dim).child(r.open ? "▾" : "▸"))
          .child(svg("mods/wb-branch-picker/icons/folder.svg").size(13).text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.label))
          .child(div().text_size(11).text_color(t.dim).child(String(r.count)));
      }
      const i = ++rowNo;
      const on = i === this.at;
      const cur = r.b.name === this.current;
      const busy = Boolean(this.busy) && this.busy === (r.b.remote ? r.b.name.slice(r.b.name.indexOf("/") + 1) : r.b.name);
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
        .when(r.b.remote && r.b.name === this.upstream, el => el.child(div().flex_none().text_size(11).text_color(t.dim).tooltip(`${this.current} tracks this branch`).child("tracked")))
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
          .tooltip(`Update ${this.current ?? "the current branch"}: fetch, then bring its upstream's commits in (fast-forward, or rebase your commits on top). On conflicts, Resolve shows in the Changes header.`)
          .on_click((_e, cx) => this.update(cx))
          .when(this.fetching, el => el.child(svg("mods/wb-branch-picker/icons/spinner.svg").size(11).spin(900)))
          .child(this.fetching ? "Updating…" : `Update${cur?.behind ? ` ↓${cur.behind}` : ""}`))))
      .when(Boolean(this.note) && !this.error, el => el.child(div().text_size(11.5).text_color(t.dim).child(this.note)))
      .when(this.inSub, el => el.child(div().text_size(11).text_color(t.dim).child(`checked out inside ${this.folder.replace(this.root + "/", "")}`)))
      .when(this.branches === undefined, el => el.child(div().text_color(t.muted).child("…")))
      .when(this.branches && this.error && !this.branches.length, el => el.child(div().text_color(t.muted).child(this.error)))
      .when(this.branches && this.branches.length && this.error, el => el.child(v_flex().flex_none().text_size(11.5).text_color(t.error ?? "#d9649a").children(this.error.split("\n").map(l => div().child(l)))))
      .when(Boolean(this.conflict), el => el.child(this.panel(t)))
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