// The Log section of the Changes panel (like JetBrains' Git log): the commits of the focused project — its branch
// together with the upstream, so commits not pulled yet (↓ incoming) and not pushed yet (↑ outgoing) show — or all
// branches. Update (fetch + fast-forward or rebase; conflicts open wb-conflicts); no auto refresh, only a
// "New · Reload" hint (pushing is the Commit and Push button above). Click a commit: its full message and
// changed files; click a file: that commit's diff in the main area (wb-diff).
// Runs git on the project's machine; each repo's last log is cached so a project switch shows at once.
// The main View drives this helper: init(cx), sync(cx) on render, view(t, opts) for the section.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, appHome, readTextFile, theme, settings, notify, run, shared, setShared, openOverlay } from "herdr";
import { updateRepo, openConflicts, lastSync } from "./gitsync.js";

// Soft dependency: is mods/<name>/ installed? Cached per name, re-read at most once a minute (assumed present until the first read answers).
const _soft = {};
export function installed(name, fresh) {
  const c = (_soft[name] ??= { ok: true, at: 0 });
  if (!fresh && Date.now() - c.at < 60000) return c.ok;
  c.at = Date.now();
  const p = readTextFile(`${appHome()}/mods/${name}/main.js`).then((r) => (c.ok = r != null), () => (c.ok = false));
  return fresh ? p : c.ok; // stale: answer from the cache now, the next call sees the re-read
}

export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd
    // A mod pane (a file or diff tab) has no folder: the space's terminal one (shown tab first), so panels stay on the project.
    || panes().find((p) => p.cwd && p.tab === space?.tabs?.find((t) => t.active)?.id)?.cwd
    || panes().find((p) => p.cwd && space?.tabs?.some((t) => t.id === p.tab))?.cwd || space?.folder, on };
}
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie): the folder watch would see it.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// Display prefs shared by the panel and its ⋯ popup (a separate copy): shared "wb.changes.prefs".
const PREFS = "wb.changes.prefs", AUTHOR = "wb.changes.author";
export const getPrefs = () => ({ view: "list", scope: "head", logAll: false, logOpen: true, ...(shared(PREFS) ?? {}) });
export const setPrefs = (patch) => setShared(PREFS, { ...getPrefs(), ...patch });
export const getAuthor = () => shared(AUTHOR) ?? null;
export const setAuthor = (name) => setShared(AUTHOR, name);

// File names are colored by status, like JetBrains: kind M modified, A added, U unversioned, D deleted, X conflict.
const NAME_COLORS = { M: ["#0032A0", "#6897BB"], A: ["#0A7700", "#629755"], U: ["#993300", "#D1675A"], D: ["#6C6C6C", "#6C6C6C"], X: ["#FF0000", "#D5756C"] };
export const nameColor = (kind) => (NAME_COLORS[kind] ?? NAME_COLORS.M)[settings().dark ? 1 : 0];
const logKind = (s) => ({ R: "M", C: "M", T: "M", U: "X" })[s] ?? s;

// Parsed exactly like wb-prs does, so the create dialog gets the same repo key.
export function remoteOf(url) {
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url) ?? /^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? { host: m[1].toLowerCase(), path: m[2] } : null;
}
// After pushing a branch that had no upstream: what the "Create pull request?" hint needs (null: no usable origin).
// How to push like the IDE does: to the same-named branch on the remote. A branch cut from another one
// (e.g. created from origin/staging, so its upstream is origin/staging) would make a plain `git push`
// fail (push.default=simple) or hit the wrong branch: push HEAD to <remote>/<branch> and track that.
// fresh: that remote branch didn't exist yet (a new branch: offer a PR).
export async function pushPlan(root, on) {
  const g = (args) => exec("git", [...READ, ...args], { cwd: root, on });
  const [head, up] = await Promise.all([g(["rev-parse", "--abbrev-ref", "HEAD"]), g(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]);
  const branch = head.stdout.trim();
  if (head.code !== 0 || branch === "HEAD") throw new Error("Not on a branch (detached HEAD): nothing to push");
  const remote = (await g(["config", `branch.${branch}.remote`])).stdout.trim() || "origin";
  if (up.code === 0 && up.stdout.trim() === `${remote}/${branch}`) return { args: ["push"], fresh: false };
  const exists = (await g(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`])).code === 0;
  return { args: ["push", "-u", remote, `HEAD:refs/heads/${branch}`], fresh: !exists };
}

export async function prHintFor(root, on) {
  const [b, u] = await Promise.all([exec("git", [...READ, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, on }), exec("git", [...READ, "remote", "get-url", "origin"], { cwd: root, on })]);
  const remote = u.code === 0 ? remoteOf(u.stdout.trim()) : null;
  if (!remote || b.code !== 0) return null;
  return { id: `${on ?? "local"}:${root}`, branch: b.stdout.trim(), repo: { key: `${remote.host}|${remote.path}`, name: remote.path, host: remote.host, path: remote.path, cwd: root, on: on ?? null } };
}

const SEP = "\x1f", LIMIT = 400, FETCH_EVERY = 5 * 60 * 1000;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 30 ? `${Math.round(d / 86400)}d`
    : new Date(s * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });
};

export class Log {
  // host: { pushed(root, on, cx) } called after a push that created the upstream.
  constructor(host) { this.host = host; }

  init(cx) {
    this.repos = {}; // `${on}|${root}` -> { root, on, branch, upstream, ahead, behind, commits, incoming, outgoing, me, at, error }
    this.places = new Map(store.get("places", [])); // `${on}|${cwd}` -> `${on}|${root}` (or "" : not a repo)
    this.loc = null; this.cur = null; this.loading = new Set(); this.spinning = new Set(); this.busy = null; this.note = null;
    this.open = null; this.details = {}; this.query = ""; this.lastFetch = {}; this.newer = new Set(); this.dirty = new Set(); this.lastAll = getPrefs().logAll;
    this.search = InputState.new({ placeholder: "Search: message, task, hash" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.follow(cx);
    cx.timer.every(2000, (cx) => this.follow(cx)); // a `cd` in a terminal; render catches space switches
    // No auto refresh: once a minute only a cheap look whether refs moved, shown as "New · Reload".
    cx.timer.every(60 * 1000, (cx) => { if (this.cur) this.check(this.cur, cx); });
  }

  current() { return this.cur ? this.repos[this.cur] ?? null : null; }

  // Render must not notify: a space switch or a changed pref is picked up right after this frame.
  sync(cx) {
    const loc = location(), all = getPrefs().logAll;
    // A checkout (branch picker, the chip) or a fetch elsewhere: the log reloads for the new HEAD.
    // A person's fetch/update/continue anywhere (gitsync.js: the branch picker, the conflicts dialog, this log):
    // that repo reloads now — one source of truth for every git mod.
    const switched = Number(shared("wb.branch.switched") ?? 0), sy = lastSync(), syTs = sy?.ts ?? 0;
    const moved = `${loc.on}|${loc.cwd}` !== this.loc, flipped = all !== this.lastAll;
    const headMoved = switched !== (this.lastSwitch ??= switched), synced = syTs !== (this.lastSyncTs ??= syTs);
    if ((moved || flipped || headMoved || synced) && !this.soon) {
      this.soon = true;
      cx.spawn(async (cx) => {
        this.soon = false;
        if (syTs !== this.lastSyncTs) {
          this.lastSyncTs = syTs;
          if (sy.rk === this.cur) this.load(this.cur, cx, true); else this.dirty.add(sy.rk);
        }
        if (switched !== this.lastSwitch) { this.lastSwitch = switched; this.open = null; if (this.cur) this.load(this.cur, cx, true); }
        if (all !== this.lastAll) { this.lastAll = all; if (this.cur) this.load(this.cur, cx); }
        this.follow(cx);
      });
    }
  }

  // The focused place moved: its repo's cached log at once; a fresh one only when there's none, it was
  // changed by an action elsewhere, or the scope differs — else just a look whether something is new.
  follow(cx) {
    const loc = location(), lk = `${loc.on}|${loc.cwd}`;
    if (lk === this.loc) return;
    this.loc = lk; this.open = null; this.note = null;
    const show = (rk) => {
      this.cur = rk || null;
      if (rk && !this.repos[rk]) { const c = store.get(`log:${rk}`, null); if (c) this.repos[rk] = c; }
      if (rk && (!this.repos[rk] || this.repos[rk].all !== getPrefs().logAll || this.dirty.has(rk))) this.load(rk, cx, Boolean(this.repos[rk]));
      else if (rk) this.check(rk, cx);
      if (rk && Date.now() - (this.lastFetch[rk] ?? 0) > FETCH_EVERY) this.bgFetch(rk, cx);
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
  // quiet: a background refresh (timer, a project switch with a cached log): no spinner.
  load(rk, cx, quiet = false) {
    if (!quiet) { this.spinning.add(rk); cx.notify(); }
    if (this.loading.has(rk)) { (this.again ??= new Set()).add(rk); return; } // asked mid-load: once more after it
    this.loading.add(rk);
    const all = getPrefs().logAll;
    cx.spawn(async (cx) => {
      const prev = this.repos[rk] ?? {};
      try {
        const g = (args) => this.git(rk, [...READ, ...args]);
        this.dirty.delete(rk);
        const [head, up, me, sig, unmerged] = await Promise.all([g(["rev-parse", "--abbrev-ref", "HEAD"]), g(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), g(["config", "user.name"]), this.sig(rk), g(["diff", "--name-only", "--diff-filter=U"])]);
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
        this.repos[rk] = { branch, upstream, ahead: ahead || 0, behind: behind || 0, commits, incoming, outgoing, all, me: me.code === 0 ? me.stdout.trim() : "", at: Date.now(), error: null,
          sig, conflicts: unmerged.stdout.split("\n").filter(Boolean).length };
        this.newer.delete(rk);
        store.set(`log:${rk}`, this.repos[rk]);
      } catch (e) { this.repos[rk] = { ...prev, error: String(e.message ?? e) }; }
      finally {
        this.loading.delete(rk);
        if (this.again?.delete(rk)) this.load(rk, cx, !this.spinning.has(rk)); else this.spinning.delete(rk);
        cx.notify();
      }
    });
  }

  // What the log was drawn from: HEAD and every branch tip. A change means something new to show.
  async sig(rk) {
    const r = await this.git(rk, [...READ, "for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"]).catch(() => null);
    const h = await this.git(rk, [...READ, "rev-parse", "HEAD"]).catch(() => null);
    return `${h?.stdout.trim() ?? ""}:${r?.stdout.replace(/\s+/g, " ").trim() ?? ""}`;
  }
  check(rk, cx) {
    const r = this.repos[rk];
    if (!r?.sig || this.loading.has(rk)) return;
    cx.spawn(async (cx) => {
      const now = await this.sig(rk);
      if (now && now !== this.repos[rk]?.sig && !this.newer.has(rk)) { this.newer.add(rk); cx.notify(); }
    });
  }
  // A quiet fetch now and then, so "New" can also mean new upstream commits; it never redraws the log.
  bgFetch(rk, cx) {
    this.lastFetch[rk] = Date.now();
    cx.spawn(async (cx) => {
      await this.git(rk, ["fetch", "--prune", "--quiet"], { timeout: 180000 }).catch(() => null);
      this.check(rk, cx);
    });
  }

  // Update (gitsync.js): fetch, then fast-forward or rebase onto the upstream; a conflict opens the dialog.
  update(rk, cx) {
    if (this.busy) return;
    const { on, root } = this.where(rk);
    this.busy = "Update"; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await updateRepo(root, on);
        this.note = { ok: !r.conflict, text: r.text };
        if (r.conflict) openConflicts(root, on);
      } catch (e) { this.note = { ok: false, text: `Update failed: ${e.message ?? e}` }; }
      this.busy = null; this.lastFetch[rk] = Date.now();
      this.load(rk, cx, true); cx.notify();
    });
  }

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
  async openFile(c, f) {
    const { on, root } = this.where(this.cur);
    if (!installed("wb-diff") && !(await installed("wb-diff", true))) { this.openCommitWeb(c, on, root); return; }
    const space = spaces().find((s) => s.active);
    const req = { space: space?.id ?? null, root, on, path: f.path, commit: c.hash, status: f.status, fresh: false, ts: Date.now() };
    const ids = new Set((space?.tabs ?? []).map((t) => t.id));
    const existing = panes().find((p) => p.mod === "wb-diff" && ids.has(p.tab));
    setShared("wb.diff.request", req);
    const name = `${f.path.split("/").pop()} @ ${c.short}`;
    if (existing) { run("tab.select", { id: existing.tab }); run("tab.rename", { id: existing.tab, name }); }
    else run("tab.new", { name, mod: "wb-diff", props: req, space: space?.id ?? undefined });
  }

  // Without wb-diff: the commit on GitHub/GitLab in the browser (from origin's https or ssh url), else a toast.
  async openCommitWeb(c, on, root) {
    let url = null;
    try {
      const o = (await exec("git", ["remote", "get-url", "origin"], { cwd: root, on })).stdout.trim();
      const m = o.match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/);
      if (m && /github|gitlab/i.test(m[1])) url = `https://${m[1]}/${m[2]}${/gitlab/i.test(m[1]) ? "/-" : ""}/commit/${c.hash}`;
    } catch {}
    if (url) exec("open", [url]);
    else notify({ title: "Install wb-diff to see diffs", body: `${c.short} ${c.subject ?? ""}`.trim(), level: "info" });
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
          .child(v_flex().gap(1).children(d.files.map((f) => {
            const kind = logKind(f.status), parts = f.path.split("/"), name = parts.pop();
            return h_flex().id(`f-${c.hash}-${f.path}`).h(20).px(4).gap(6).items_center().rounded(4).cursor_pointer()
              .hover((s) => s.bg(t.hover)).tooltip(f.from ? `${f.from} → ${f.path}` : f.path).on_click(() => this.openFile(c, f))
              .child(h_flex().flex_1().min_w(0).text_size(11.5)
                .child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? parts.join("/") + "/" : ""))
                .child(div().flex_none().text_color(nameColor(kind)).when(kind === "D", (s) => s.line_through()).child(name)));
          }))))));
  }

  // o: { open, h (body px), startDrag(e, cx), toggle(cx) }. Collapsed: only the header row.
  view(t, o) {
    const rk = this.cur, r = this.current(), q = this.query, sel = getAuthor();
    const busyLoad = rk && this.spinning.has(rk);
    const commits = (r?.commits ?? []).filter((c) => (!q || c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q)) && (!sel || c.author === sel));
    const tool = (id, label, tip, act, accent = false, spin = false) => h_flex().id(id).h(22).px(7).gap(4).flex_none().items_center().rounded(6).cursor_pointer()
      .border_1().border_color(accent ? t.accent : t.border).text_size(11).text_color(accent ? t.accent : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((e, cx) => { cx.stop_propagation(); act(e, cx); })
      .when(spin, (e) => e.child(svg("mods/wb-changes/icons/spinner.svg").size(11).spin(900))).child(label);
    const root = rk ? this.where(rk).root : null;
    const authors = (() => { const n = new Map(); for (const c of r?.commits ?? []) n.set(c.author, (n.get(c.author) ?? 0) + 1); return [...n].sort((a, b) => b[1] - a[1]).map((a) => a[0]); })();
    return v_flex().flex_none().border_t(1).border_color(t.border)
      .when(o.open, (e) => e.child(div().id("log-split").h(8).flex_none().mt(-4).flex().items_center().justify_center().cursor_row_resize().tooltip("Drag to resize the log").hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { o.startDrag(e, cx); cx.stop_propagation(); }).child(div().w(36).h(3).rounded(2).bg(t.border))))
      .child(h_flex().id("log-head").h(30).flex_none().px(10).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(o.open ? "Hide the log" : "Show the log").on_click((_e, cx) => o.toggle(cx))
        .child(div().w(10).flex_none().text_size(10).text_color(t.muted).child(o.open ? "▾" : "▸"))
        .child(div().flex_none().font_semibold().text_size(12).child("Log"))
        .child(h_flex().flex_1().min_w(0).gap(4).items_center().text_size(11).text_color(t.muted)
          .when(Boolean(r?.branch), (e) => e.child(svg("mods/wb-changes/icons/git-branch.svg").size(12).flex_none()).child(div().min_w(0).truncate().child(r.branch))
            .when(Boolean(r.upstream), (e) => e.child(div().min_w(0).truncate().text_color(t.dim).child(`→ ${r.upstream}`)))
            .when(!r.upstream, (e) => e.child(div().flex_none().text_color(t.dim).child("no upstream")))))
        .when(Boolean(r && !r.error && rk), (e) => e
          .when(Boolean(this.newer.has(rk)), (e) => e.child(tool("newer", "● New · Reload", "Commits or branches moved since this log was drawn", (_e, cx) => this.load(rk, cx), true)))
          .when(r.conflicts > 0, (e) => e.child(h_flex().id("conflicts").h(22).px(7).flex_none().items_center().rounded(6).cursor_pointer().border_1().border_color(t.blocked)
            .text_size(11).text_color(t.blocked).hover((s) => s.bg(t.hover)).tooltip("Resolve the merge conflicts").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); const w = this.where(rk); openConflicts(w.root, w.on); })
            .child(`${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"}`)))
          .child(tool("update", `Update${r.behind ? ` ↓${r.behind}` : ""}`, "Fetch, then bring the upstream's commits in: fast-forward, or rebase your commits on top (uncommitted changes are kept). Conflicts open the conflicts dialog.", (_e, cx) => this.update(rk, cx), r.behind > 0, this.busy === "Update")))
        .child(div().id("log-reload").size(22).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
          .hover((s) => s.bg(t.raised)).tooltip("Reload the log").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); if (rk) this.load(rk, cx); })
          .child(svg("mods/wb-changes/icons/refresh.svg").size(12).when(Boolean(busyLoad), (s) => s.spin(900)))))
      .when(o.open, (e) => e.child(v_flex().h(o.h).flex_none().min_h(0)
        .when(Boolean(this.note), (e) => e.child(div().flex_none().px(10).pb(4).text_size(11).text_color(this.note.ok ? t.dim : t.ansi1).child(this.note.text)))
        .when(Boolean(r && !r.error), (e) => e.child(h_flex().flex_none().px(8).pb(6).gap(6).items_center()
          .child(div().id("log-search").flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().w_full().text_size(12).text_color(t.foreground)))
          .child(h_flex().id("log-author").h(26).max_w(130).flex_none().px(8).gap(4).items_center().rounded(7).border_1().border_color(sel ? t.accent : t.border).cursor_pointer()
            .text_size(11).text_color(sel ? t.accent : t.muted).hover((s) => s.bg(t.hover)).tooltip("Filter by author")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click(() => openOverlay({ mod: "wb-changes", kind: "popup", width: 230, height: Math.min(320, 26 * (authors.length + 2) + 16), props: { authorMenu: true, authors, me: r?.me ?? "" } }))
            .child(div().min_w(0).truncate().child(sel ?? "All authors")).child(div().flex_none().text_size(9).child("▾")))))
        .child(div().flex_1().min_h(0).relative()
          .child(v_flex().id("log-list").absolute().inset_0().overflow_y_scroll().px(6).pb(6).gap(1)
            .when(!rk, (e) => e.child(div().p(8).text_color(t.dim).child(this.places.get(this.loc) === "" ? "Not a git repository" : "Open a project folder")))
            .when(Boolean(rk && !r), (e) => e.child(div().p(8).text_color(t.dim).child(`Loading ${root?.split("/").pop() ?? ""}…`)))
            .when(Boolean(r?.error), (e) => e.child(div().p(8).text_color(t.ansi1).child(r.error)))
            .when(Boolean(r && !r.error && !commits.length), (e) => e.child(div().p(8).text_color(t.dim).child(q || sel ? "No matches" : "No commits")))
            .children(r && !r.error ? commits.map((c) => this.row(c, r, t)) : []))
          .child(Scrollbar.vertical("log-list").absolute().inset_0()))));
  }
}
