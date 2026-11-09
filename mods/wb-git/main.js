// Git panel (like JetBrains' Git log): the commits of the focused project — its branch together with
// the upstream, so commits not pulled yet (↓ incoming) and not pushed yet (↑ outgoing) show — or all
// branches. Fetch, Pull (fast-forward, or rebase when that can't) and Push. Click a commit: its full
// message and changed files; click a file: that commit's diff in the main area (wb-diff).
// Runs git on the project's machine; each repo's last log is cached so a project switch shows at once.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, theme, notify, run, setShared } from "herdr";
import * as S from "./section.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
// Reads write nothing under .git (no index refresh, no lock): the Changes panel watches it.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const SEP = "\x1f", LIMIT = 400, STALE = 30000, FETCH_EVERY = 5 * 60 * 1000;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 30 ? `${Math.round(d / 86400)}d`
    : new Date(s * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });
};
const STATUS_COLOR = { A: "ansi2", D: "ansi1", M: "blocked", R: "ansi4" };

export default class GitLog extends View {
  init(_props, cx) {
    S.migrateKeys(["sections.collapsed"]);
    this.repos = {}; // `${on}|${root}` -> { root, on, branch, upstream, ahead, behind, commits, incoming, outgoing, at, error }
    this.places = new Map(store.get("places", [])); // `${on}|${cwd}` -> `${on}|${root}` (or "" : not a repo)
    this.loc = null; this.cur = null; this.loading = new Set(); this.busy = null; this.note = null;
    this.all = store.get("all", false); this.open = null; this.details = {}; this.query = "";
    this.lastFetch = {};
    this.search = InputState.new({ placeholder: "Search commits: message, author, hash" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.follow(cx);
    cx.timer.every(2000, (cx) => this.follow(cx)); // a `cd` in a terminal; render catches space switches
    cx.timer.every(60 * 1000, (cx) => { if (this.cur) this.load(this.cur, cx); });
  }

  // The focused place moved: its repo's cached log at once, then a fresh one (and a quiet fetch now and then).
  follow(cx) {
    const loc = location(), lk = `${loc.on}|${loc.cwd}`;
    if (lk === this.loc) return;
    this.loc = lk; this.open = null; this.note = null;
    const show = (rk) => {
      this.cur = rk || null;
      if (rk && !this.repos[rk]) { const c = store.get(`log:${rk}`, null); if (c) this.repos[rk] = c; }
      if (rk && (!this.repos[rk] || Date.now() - (this.repos[rk].at ?? 0) > STALE)) this.load(rk, cx);
      if (rk && Date.now() - (this.lastFetch[rk] ?? 0) > FETCH_EVERY) this.fetch(rk, cx, true);
      cx.notify();
    };
    if (this.places.has(lk)) return show(this.places.get(lk));
    if (!loc.cwd) return show(null);
    cx.spawn(async (cx) => {
      const r = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd: loc.cwd, on: loc.on }).catch(() => null);
      const rk = r?.code === 0 ? `${loc.on}|${r.stdout.trim()}` : "";
      this.places.set(lk, rk); store.set("places", [...this.places]);
      if (this.loc === lk) show(rk);
    });
  }

  where(rk) { const i = rk.indexOf("|"), on = rk.slice(0, i); return { on: on === "null" ? null : on, root: rk.slice(i + 1) }; }
  git(rk, args, opts = {}) { const { on, root } = this.where(rk); return exec("git", args, { cwd: root, on, ...opts }); }

  // Branch, upstream, ahead/behind and the log; incoming = in the upstream, not here; outgoing = the other way.
  load(rk, cx) {
    if (this.loading.has(rk)) return;
    this.loading.add(rk); cx.notify();
    const all = this.all;
    cx.spawn(async (cx) => {
      const prev = this.repos[rk] ?? {};
      try {
        const g = (args) => this.git(rk, [...READ, ...args]);
        const [head, up] = await Promise.all([g(["rev-parse", "--abbrev-ref", "HEAD"]), g(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]);
        const branch = head.stdout.trim(), upstream = up.code === 0 ? up.stdout.trim() : null;
        let ahead = 0, behind = 0, incoming = [], outgoing = [];
        if (upstream) {
          const [cnt, inc, out] = await Promise.all([g(["rev-list", "--left-right", "--count", "HEAD...@{u}"]), g(["rev-list", "HEAD..@{u}"]), g(["rev-list", "@{u}..HEAD"])]);
          [ahead, behind] = cnt.stdout.trim().split(/\s+/).map(Number);
          incoming = inc.stdout.split("\n").filter(Boolean); outgoing = out.stdout.split("\n").filter(Boolean);
        }
        const fmt = ["%H", "%h", "%an", "%at", "%s", "%D"].join(SEP);
        const refs = all ? ["--all"] : ["HEAD", ...(upstream ? ["@{u}"] : [])];
        const log = await g(["log", `--format=${fmt}`, "--date-order", "-n", String(LIMIT), ...refs]);
        if (log.code !== 0) throw new Error((log.stderr || "git log failed").trim().split("\n").pop());
        const commits = log.stdout.split("\n").filter(Boolean).map((l) => {
          const [hash, short, author, at, subject, decor] = l.split(SEP);
          return { hash, short, author, at: Number(at), subject, refs: decor ? decor.split(", ").filter((x) => x && x !== "HEAD") : [], head: /(^|, )HEAD( ->|$|,)/.test(decor) };
        });
        this.repos[rk] = { branch, upstream, ahead: ahead || 0, behind: behind || 0, commits, incoming, outgoing, all, at: Date.now(), error: null };
        store.set(`log:${rk}`, this.repos[rk]);
      } catch (e) { this.repos[rk] = { ...prev, error: String(e.message ?? e) }; }
      finally { this.loading.delete(rk); cx.notify(); }
    });
  }

  // One git action with its progress shown; the log reloads after it.
  action(rk, label, args, cx, { quiet = false, onFail } = {}) {
    if (this.busy) return;
    this.busy = label; if (!quiet) this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await this.git(rk, args, { timeout: 180000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${label} failed`).trim().split("\n").slice(-3).join(" "));
        if (!quiet) this.note = { ok: true, text: `${label}: ${(r.stdout || r.stderr || "done").trim().split("\n").pop()}` };
        // Something that moved HEAD: the Changes panel and the branch chip ask again.
        setShared("wb.branch.switched", Date.now());
      } catch (e) {
        if (onFail) { this.busy = null; onFail(String(e.message ?? e), cx); return; }
        if (!quiet) this.note = { ok: false, text: `${label} failed: ${e.message ?? e}` };
      } finally {
        if (this.busy === label) this.busy = null;
        this.load(rk, cx); cx.notify();
      }
    });
  }

  fetch(rk, cx, quiet = false) { this.lastFetch[rk] = Date.now(); this.action(rk, "Fetch", ["fetch", "--prune", "--quiet"], cx, { quiet }); }
  // Pull: fast-forward when it can; when the branches diverged, rebase the local commits on top (like
  // "Update Project → Rebase"); if that stops on a conflict, it is aborted and said so.
  pull(rk, cx) {
    this.action(rk, "Pull", ["pull", "--ff-only"], cx, {
      onFail: (msg, cx) => {
        if (!/not possible to fast-forward|diverg/i.test(msg)) { this.note = { ok: false, text: `Pull failed: ${msg}` }; cx.notify(); return; }
        this.action(rk, "Pull (rebase)", ["pull", "--rebase", "--autostash"], cx, {
          onFail: (m2, cx) => {
            this.note = { ok: false, text: `Pull (rebase) stopped: ${m2} · rebase aborted, nothing changed` };
            this.git(rk, ["rebase", "--abort"]).finally(() => { this.load(rk, cx); cx.notify(); });
          },
        });
      },
    });
  }
  push(rk, cx) {
    const r = this.repos[rk];
    this.action(rk, "Push", r?.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"], cx);
  }

  setAll(v, cx) { this.all = v; store.set("all", v); if (this.cur) this.load(this.cur, cx); cx.notify(); }

  toggle(c, cx) {
    this.open = this.open === c.hash ? null : c.hash;
    if (this.open && !this.details[c.hash]) {
      const rk = this.cur;
      cx.spawn(async (cx) => {
        const [body, files] = await Promise.all([
          this.git(rk, [...READ, "show", "-s", "--format=%B%n%x1f%an <%ae>%x1f%ad%x1f%cn", "--date=format:%Y-%m-%d %H:%M", c.hash]),
          this.git(rk, [...READ, "show", "--format=", "--name-status", "-M", c.hash]),
        ]);
        const [message, author, date, committer] = body.stdout.split(SEP);
        this.details[c.hash] = {
          message: (message ?? "").trim(), author: author?.trim(), date: date?.trim(), committer: committer?.trim(),
          files: files.stdout.split("\n").filter(Boolean).map((l) => { const [st, ...p] = l.split("\t"); return { status: st[0], path: p[p.length - 1], from: p.length > 1 ? p[0] : null }; }),
        };
        cx.notify();
      });
    }
    cx.notify();
  }

  // A file of a commit: that commit's change, in the main area's diff tab (one per space).
  openFile(c, f) {
    const { on, root } = this.where(this.cur);
    const space = spaces().find((s) => s.active);
    const req = { space: space?.id ?? null, root, on, path: f.path, commit: c.hash, status: f.status, fresh: false, ts: Date.now() };
    const ids = new Set((space?.tabs ?? []).map((t) => t.id));
    const existing = panes().find((p) => p.mod === "wb-diff" && ids.has(p.tab));
    setShared("wb.diff.request", req);
    const name = `${f.path.split("/").pop()} @ ${c.short}`;
    if (existing) { run("tab.select", { id: existing.tab }); run("tab.rename", { id: existing.tab, name }); }
    else run("tab.new", { name, mod: "wb-diff", props: req, space: space?.id ?? undefined });
  }

  row(c, r, t) {
    const inc = r.incoming?.includes(c.hash), out = r.outgoing?.includes(c.hash), open = this.open === c.hash, d = this.details[c.hash];
    const badge = (text, color) => div().flex_none().px(4).rounded(3).border_1().border_color(color).text_size(9.5).text_color(color).max_w(130).truncate().child(text);
    return v_flex().id(`c-${c.hash}`).flex_none().rounded(5).when(open, (e) => e.bg(t.raised))
      .child(h_flex().id(`cr-${c.hash}`).h(24).px(8).gap(6).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(`${c.short} · ${c.author}\n${c.subject}`)
        .on_click((_e, cx) => this.toggle(c, cx))
        .on_mouse_down("right", (_e, cx) => { cx.write_to_clipboard(c.hash); notify({ title: "Copied", body: c.hash, level: "info", timeout: 1500 }); })
        .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(inc ? t.ansi4 : out ? t.ansi2 : c.head ? t.accent : t.border)
          .child(inc ? "↓" : out ? "↑" : c.head ? "●" : "·"))
        .child(div().flex_1().min_w(0).truncate().text_color(inc ? t.muted : t.foreground).child(c.subject))
        .children(c.refs.slice(0, 2).map((ref) => badge(ref.replace(/^HEAD -> /, ""), ref.startsWith("tag: ") ? t.ansi3 : ref.includes("/") ? t.ansi4 : t.ansi2)))
        .child(div().flex_none().max_w(90).truncate().text_size(10.5).text_color(t.dim).child(c.author))
        .child(div().flex_none().w(34).text_right().text_size(10.5).text_color(t.dim).child(ago(c.at))))
      .when(open, (e) => e.child(v_flex().px(26).pb(8).pt(2).gap(6)
        .when(!d, (e) => e.child(div().text_size(11).text_color(t.dim).child("Loading…")))
        .when(Boolean(d), (e) => e
          .child(h_flex().gap(8).text_size(10.5).text_color(t.dim).child(div().font_family("JetBrains Mono").child(c.short)).child(div().child(`${d.author} · ${d.date}`)))
          .child(div().text_size(12).text_color(t.foreground).child(d.message))
          .child(v_flex().gap(1).children(d.files.map((f) => h_flex().id(`f-${c.hash}-${f.path}`).h(20).px(4).gap(6).items_center().rounded(4).cursor_pointer()
            .hover((s) => s.bg(t.hover)).tooltip(f.from ? `${f.from} → ${f.path}` : f.path).on_click(() => this.openFile(c, f))
            .child(div().w(10).flex_none().text_size(10.5).text_color(t[STATUS_COLOR[f.status]] ?? t.muted).child(f.status))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(f.path))))))));
  }

  render(cx) {
    const t = theme();
    // A space switch: follow it right after this frame (render itself mustn't notify).
    const loc = location();
    if (`${loc.on}|${loc.cwd}` !== this.loc && !this.followSoon) { this.followSoon = true; cx.spawn(async (cx) => { this.followSoon = false; this.follow(cx); }); }
    const rk = this.cur, r = rk ? this.repos[rk] : null, q = this.query;
    const busyLoad = rk && this.loading.has(rk);
    const commits = (r?.commits ?? []).filter((c) => !q || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q));
    const sec = S.sectionOf("wb-git"), ov = S.overlay(sec);
    const tool = (id, label, tip, act, accent = false, spin = false) => h_flex().id(id).h(24).px(7).gap(4).flex_none().items_center().rounded(6).cursor_pointer()
      .border_1().border_color(accent ? t.accent : t.border).text_size(11).text_color(accent ? t.accent : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click((e, cx) => { cx.stop_propagation(); act(e, cx); })
      .when(spin, (e) => e.child(svg("mods/wb-git/icons/spinner.svg").size(11).spin(900))).child(label);
    const root = rk ? this.where(rk).root : null;
    return v_flex().id("git-log").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(S.header(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border), sec, 44)
        .child(S.mark(sec))
        .child(div().font_semibold().text_size(13).child("Git"))
        .when(Boolean(r?.branch), (e) => e.child(h_flex().min_w(0).gap(4).items_center().text_size(11).text_color(t.muted)
          .child(svg("mods/wb-git/icons/git-branch.svg").size(12)).child(div().min_w(0).truncate().child(r.branch))
          .when(Boolean(r.upstream), (e) => e.child(div().flex_none().text_color(t.dim).child(`→ ${r.upstream}`)))))
        .child(div().flex_1())
        .child(h_flex().id("scope").flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().text_size(10)
          .children([["branch", "Branch", false], ["all", "All", true]].map(([id, label, v]) => div().id(`scope-${id}`).h(20).px(6).flex().items_center().cursor_pointer()
            .bg(this.all === v ? t.selected : t.background).text_color(this.all === v ? t.foreground : t.muted)
            .tooltip(v ? "Every branch" : "This branch and its upstream")
            .on_click((_e, cx) => { cx.stop_propagation(); if (this.all !== v) this.setAll(v, cx); }).child(label))))
        .child(div().id("refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover)).tooltip("Reload the log").on_click((_e, cx) => { cx.stop_propagation(); if (rk) this.load(rk, cx); })
          .child(svg("mods/wb-git/refresh.svg").size(14).when(Boolean(busyLoad), (s) => s.spin(900)))))
      // Fetch / Pull / Push, with what's waiting each way.
      .when(Boolean(r && !r.error && rk), (e) => e.child(h_flex().flex_none().px(8).pt(8).gap(6).items_center()
        .child(tool("fetch", "Fetch", "git fetch --prune: see what's new upstream", (_e, cx) => this.fetch(rk, cx), false, this.busy === "Fetch"))
        .child(tool("pull", `Pull${r.behind ? ` ↓${r.behind}` : ""}`, "Fast-forward, or rebase my commits on top when the branches diverged", (_e, cx) => this.pull(rk, cx), r.behind > 0, Boolean(this.busy?.startsWith("Pull"))))
        .child(tool("push", `Push${r.ahead ? ` ↑${r.ahead}` : ""}`, r.upstream ? `git push to ${r.upstream}` : "No upstream yet: git push -u origin HEAD", (_e, cx) => this.push(rk, cx), r.ahead > 0, this.busy === "Push"))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(r.upstream ? (r.behind || r.ahead ? `${r.behind} incoming · ${r.ahead} outgoing` : "up to date") : "no upstream"))))
      .when(Boolean(this.note), (e) => e.child(div().flex_none().px(10).pt(6).text_size(11).text_color(this.note.ok ? t.dim : t.ansi1).child(this.note.text)))
      .when(Boolean(r && !r.error), (e) => e.child(div().flex_none().px(8).pt(8)
        .child(div().id("search").h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().w_full().text_size(12).text_color(t.foreground)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("git-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(!rk, (e) => e.child(div().p(8).text_color(t.dim).child(this.places.get(this.loc) === "" ? "Not a git repository" : "Open a project folder")))
          .when(Boolean(rk && !r), (e) => e.child(div().p(8).text_color(t.dim).child(`Loading ${root?.split("/").pop() ?? ""}…`)))
          .when(Boolean(r?.error), (e) => e.child(div().p(8).text_color(t.ansi1).child(r.error)))
          .when(Boolean(r && !r.error && !commits.length), (e) => e.child(div().p(8).text_color(t.dim).child(q ? "No matches" : "No commits")))
          .children(r && !r.error ? commits.map((c) => this.row(c, r, t)) : []))
        .child(Scrollbar.vertical("git-list").absolute().inset_0()))
      .when(Boolean(ov), (e) => e.child(ov));
  }
}
