import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, theme, notify, playSound } from "herdr";
import * as S from "./section.js";

// My open pull requests in the repo of the focused folder. Click opens it in the browser.
// GitHub: via the `gh` CLI. GitLab (any other host, e.g. a self-hosted git.allmylinks.com): merge requests
// via its REST API, with a personal access token (read_api) kept in the macOS Keychain
// (service herdr-gitlab, account = the host); the panel asks for it the first time.
// ponytail: only open PRs I authored (first 100); add `--search "review-requested:@me"` as a second list if wanted.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

// CI of the PR: "fail" if any check failed, "wait" if any is still running, else "ok" (or "" without checks).
function ci(rollup) {
  if (!rollup?.length) return "";
  const bad = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  if (rollup.some((c) => bad.includes(c.conclusion) || c.state === "FAILURE" || c.state === "ERROR")) return "fail";
  if (rollup.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "wait";
  return "ok";
}

// Copilot: "done" once it left a review, "asked" while its request is pending, else "".
// ponytail: matches the login by /copilot/i (its review login is copilot-pull-request-reviewer, the request's is Copilot).
const isCopilot = (x) => /copilot/i.test(x?.login ?? x?.name ?? "");
const copilot = (pr) => pr.reviews?.some((r) => isCopilot(r.author)) ? "done" : pr.reviewRequests?.some(isCopilot) ? "asked" : "";

const FIELDS = "number,title,headRefName,isDraft,reviewDecision,url,statusCheckRollup,reviewRequests,reviews,author";
// mine: only the ones I opened; else every open one in the repo.
async function list(cwd, on, mine) {
  const r = await exec("gh", ["pr", "list", ...(mine ? ["--author", "@me"] : []), "--state", "open", "--limit", "100", "--json", FIELDS], { cwd, on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || "gh failed");
  return JSON.parse(r.stdout);
}

// { host, path } from a git remote URL: https://host/a/b(.git), git@host:a/b(.git), ssh://git@host[:port]/a/b.
// The path keeps GitLab subgroups (group/sub/name). Null if it isn't one of those.
function remoteOf(url) {
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url) ?? /^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? { host: m[1].toLowerCase(), path: m[2] } : null;
}

// GitLab: the token for a host, from the Keychain (null: none saved).
const GL_SERVICE = "herdr-gitlab";
async function gitlabToken(host) {
  const r = await exec("security", ["find-generic-password", "-s", GL_SERVICE, "-a", host, "-w"]).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() || null : null;
}
async function gitlab(host, token, path) {
  const r = await fetch(`https://${host}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": token, Accept: "application/json" } });
  if (!r.ok) throw Object.assign(new Error(`GitLab ${r.status}: ${(await r.text()).slice(0, 160)}`), { status: r.status });
  return r.json();
}
// A pipeline status as the row's dot: "ok" / "fail" / "wait" / "" (no pipeline).
const pipelineState = (st) => !st ? "" : ["success", "skipped", "manual"].includes(st) ? "ok"
  : ["failed", "canceled"].includes(st) ? "fail" : "wait";
// detailed_merge_status → a short label and its theme color.
const MERGE_LABEL = { mergeable: ["ready", "done"], not_approved: ["review", "muted"], discussions_not_resolved: ["threads", "ansi1"],
  conflict: ["conflict", "ansi1"], need_rebase: ["rebase", "ansi1"], broken_status: ["broken", "ansi1"], blocked_status: ["blocked", "ansi1"] };

// My open merge requests in a GitLab project, shaped like gh's PRs (+ ci, badge, provider).
async function listGitlab(host, path, token, mine) {
  const project = `/projects/${encodeURIComponent(path)}`;
  const mrs = await gitlab(host, token, `${project}/merge_requests?state=opened&scope=${mine ? "created_by_me" : "all"}&per_page=100`);
  // The list has no pipeline: one detail call per MR (a handful).
  return Promise.all(mrs.map(async (mr) => {
    const d = await gitlab(host, token, `${project}/merge_requests/${mr.iid}`).catch(() => mr);
    return { provider: "gitlab", author: mr.author?.name ?? mr.author?.username ?? "", number: mr.iid, title: mr.title, headRefName: mr.source_branch, isDraft: Boolean(mr.draft ?? mr.work_in_progress),
      url: mr.web_url, ci: pipelineState(d.head_pipeline?.status ?? d.pipeline?.status), badge: MERGE_LABEL[d.detailed_merge_status] ?? null };
  }));
}

export default class Prs extends View {
  init(_props, cx) {
    this.prs = []; this.error = null; this.loading = false; this.key = key(); this.repo = "";
    this.byRepo = new Map(); // repo key -> { name, prs, error }: one gh call per repo, whatever folders point at it
    this.remotes = new Map(); // folder -> its repo, from the local git remote (no API call)
    this.focusRepo = null;
    // GitLab token form: shown while the focused repo's host has no (working) token.
    this.tokenInput = InputState.new({ placeholder: "GitLab personal access token (read_api)" });
    this.tokenInput.set_masked(true);
    this.tokenInput.on("submit", (_e, cx) => this.saveToken(cx));
    this.tokenError = null; this.savingToken = false;
    this.seen = null; // PR url -> copilot state at the last poll; null until the first one (no sound for what already was)
    // Auto-sync (the minute poll and its sound) can be switched off; remembered. Refresh still works by hand.
    // All open PRs/MRs of the repo, or only mine; remembered.
    this.mine = (() => { try { return localStorage.getItem("mine") === "1"; } catch { return false; } })();
    this.auto = (() => { try { return localStorage.getItem("auto") !== "0"; } catch { return true; } })();
    this.fetching = new Set(); // repo keys being fetched one by one (a project switch)
    // The last lists and folder→repo answers survive restarts: a switch shows them at once.
    this.loadCache();
    this.key = null; this.focus(cx);
    this.poll(cx);
    // The folder follows focus: render notices a switch at once; this catches a `cd` inside a terminal.
    cx.timer.every(2000, (cx) => this.follow(cx));
    cx.timer.every(60 * 1000, (cx) => { if (this.auto) this.poll(cx); });
  }

  // Cache: one list per mode (All / Mine) in localStorage, plus the folder → repo answers.
  cacheKey() { return `cache:${this.mine ? "mine" : "all"}`; }
  loadCache() {
    try {
      this.byRepo = new Map(JSON.parse(localStorage.getItem(this.cacheKey()) ?? "[]"));
      for (const [id, r] of JSON.parse(localStorage.getItem("remotes") ?? "[]")) this.remotes.set(id, r);
    } catch { this.byRepo = new Map(); }
  }
  saveCache() {
    try {
      // Only real lists: errors and token prompts are asked again.
      localStorage.setItem(this.cacheKey(), JSON.stringify([...this.byRepo].filter(([, e]) => !e.error && !e.needToken)));
      localStorage.setItem("remotes", JSON.stringify([...this.remotes]));
    } catch {}
  }

  follow(cx) {
    const k = key();
    if (k !== this.key) { this.key = k; this.focus(cx); }
  }

  toggleMine(cx) {
    this.mine = !this.mine;
    try { localStorage.setItem("mine", this.mine ? "1" : "0"); } catch {}
    this.seen = null; this.loadCache(); this.show(); cx.notify();
    this.poll(cx);
  }

  toggleAuto(cx) {
    this.auto = !this.auto;
    try { localStorage.setItem("auto", this.auto ? "1" : "0"); } catch {}
    if (this.auto) this.poll(cx); else cx.notify();
  }

  // The repo a place belongs to: `{ key, name, host, path }`. Folders (and worktrees) of one repo share the key.
  async repoOf({ cwd, on }) {
    const id = `${on}|${cwd}`;
    if (!this.remotes.has(id)) {
      const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on }).catch(() => null);
      const remote = r?.code === 0 ? remoteOf(r.stdout.trim()) : null;
      if (!remote) return { key: id, name: null };
      this.remotes.set(id, { key: `${remote.host}|${remote.path}`, name: remote.path, host: remote.host, path: remote.path });
    }
    return this.remotes.get(id);
  }

  // Open MRs/PRs of one repo: gh for github.com, the GitLab API for anything else.
  async fetchRepo(r) {
    if (!r.host) throw new Error("No git remote (origin) in this folder");
    if (r.host === "github.com") return list(r.cwd, r.on, this.mine);
    const token = await gitlabToken(r.host);
    if (!token) throw Object.assign(new Error(`No GitLab token for ${r.host}`), { needToken: r.host });
    try { return await listGitlab(r.host, r.path, token, this.mine); }
    catch (e) { if (e.status === 401) throw Object.assign(new Error(`${r.host} rejected the saved token`), { needToken: r.host }); throw e; }
  }

  // Checks a pasted token against the host, then keeps it in the Keychain and polls again.
  saveToken(cx) {
    const host = this.needToken, token = this.tokenInput.value().trim();
    if (!host || this.savingToken) return;
    if (!token || /\s/.test(token)) { this.tokenError = "Paste the token (Create token → copy)"; cx.notify(); return; }
    this.savingToken = true; this.tokenError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await gitlab(host, token, "/user");
        // ponytail: -w puts the token in `security`'s argv for a moment (local ps only).
        const r = await exec("security", ["add-generic-password", "-U", "-s", GL_SERVICE, "-a", host, "-w", token]);
        if (r.code !== 0) throw new Error(`Keychain: ${(r.stderr || r.stdout).trim()}`);
        this.tokenInput.set_value(""); this.needToken = null;
        for (const [k, e] of this.byRepo) if (e.needToken === host) this.byRepo.delete(k);
      } catch (e) { this.tokenError = e.status === 401 ? `${host} rejected this token (needs the read_api scope)` : String(e.message ?? e); }
      finally { this.savingToken = false; cx.notify(); }
      if (!this.needToken) this.poll(cx);
    });
  }

  show() {
    const e = this.byRepo.get(this.focusRepo);
    this.prs = e?.prs ?? []; this.repo = e?.name ?? ""; this.needToken = e?.needToken ?? null; this.provider = e?.provider ?? null;
    this.error = e?.error ?? (!location().cwd ? "No folder" : !e && !this.auto ? "Auto-sync is off · press refresh" : null);
  }

  // A project switch: show that repo's list from the cache right away, then (auto-sync on) refresh
  // just that repo in the background when its list is older than 30 s or missing.
  focus(cx) {
    const k = this.key, loc = location();
    cx.spawn(async (cx) => {
      const r = await this.repoOf(loc);
      if (key() !== k) return; // switched again meanwhile: that switch handles it
      this.focusRepo = r.key; this.show(); cx.notify();
      const e = this.byRepo.get(r.key);
      if (this.auto && r.host && loc.cwd && (!e || e.error || Date.now() - (e.at ?? 0) > 30000)) this.refreshOne({ ...r, ...loc }, cx);
    });
  }

  refreshOne(r, cx) {
    if (this.fetching.has(r.key)) return;
    this.fetching.add(r.key); cx.notify();
    cx.spawn(async (cx) => {
      const old = this.byRepo.get(r.key);
      try {
        const prs = await this.fetchRepo(r);
        this.byRepo.set(r.key, { name: r.name, prs, error: null, provider: r.host === "github.com" ? "github" : "gitlab", at: Date.now() });
        // Copilot news needs the poll's baseline; keep it current for what this fetch saw.
        if (this.seen) for (const pr of prs) if (!this.seen.has(pr.url)) this.seen.set(pr.url, copilot(pr));
      } catch (e) { this.byRepo.set(r.key, { name: r.name, prs: old?.prs ?? [], error: e.needToken ? null : String(e.message ?? e), needToken: e.needToken ?? null, provider: r.host === "github.com" ? "github" : "gitlab" }); }
      finally {
        this.fetching.delete(r.key); this.saveCache();
        if (this.focusRepo === r.key) this.show();
        cx.notify();
      }
    });
  }

  // Every minute (and on demand): the open PRs of every repo among all spaces' folders and the focused one,
  // one gh call per repo. A sound and a toast when Copilot's review shows up on a PR that was already there.
  // Runs even while the panel is hidden.
  // ponytail: in memory only (a reload re-baselines).
  poll(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true; cx.notify();
    const focus = location(), places = new Map();
    for (const p of [focus, ...spaces().map((s) => ({ cwd: s.folder, on: s.machine ?? null }))]) if (p.cwd) places.set(`${p.on}|${p.cwd}`, p);
    cx.spawn(async (cx) => {
      try {
        const repos = new Map();
        for (const p of places.values()) { const r = await this.repoOf(p); if (!repos.has(r.key)) repos.set(r.key, { ...r, ...p }); }
        const next = new Map(), done = [];
        await Promise.all([...repos].map(async ([k, r]) => {
          const old = this.byRepo.get(k);
          try {
            const prs = await this.fetchRepo(r);
            this.byRepo.set(k, { name: r.name, prs, error: null, provider: r.host === "github.com" ? "github" : "gitlab", at: Date.now() });
            for (const pr of prs) next.set(pr.url, { state: copilot(pr), pr });
          } catch (e) { this.byRepo.set(k, { name: r.name, prs: old?.prs ?? [], error: e.needToken ? null : String(e.message ?? e), needToken: e.needToken ?? null, provider: "gitlab" }); }
        }));
        for (const [url, { state, pr }] of next) if (this.seen?.get(url) !== undefined && this.seen.get(url) !== "done" && state === "done") done.push(pr);
        // A failed repo drops out of `next`; keep its old states so a later success isn't mistaken for news.
        this.seen = new Map([...(this.seen ?? []), ...[...next].map(([url, { state }]) => [url, state])]);
        // Where focus is now (it may have moved during the poll).
        this.focusRepo = (await this.repoOf(location())).key; this.show(); this.saveCache();
        for (const pr of done) notify({ title: "Copilot reviewed", body: `#${pr.number} ${pr.title}`, level: "info" });
        if (done.length) playSound("done");
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.poll(cx); }
      }
    });
  }

  row(pr, t) {
    const gl = pr.provider === "gitlab";
    const state = gl ? pr.ci : ci(pr.statusCheckRollup);
    const dot = { ok: t.done, fail: t.ansi1, wait: t.working }[state];
    const review = gl ? (pr.badge ? [pr.badge[0], t[pr.badge[1]]] : null)
      : { APPROVED: ["approved", t.done], CHANGES_REQUESTED: ["changes", t.ansi1], REVIEW_REQUIRED: ["review", t.muted] }[pr.reviewDecision];
    const cp = copilot(pr);
    return v_flex().id(`pr-${pr.number}`).flex_none().px(8).py(4).gap(2).rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(`#${pr.number} ${pr.title}\n${pr.headRefName}`)
      .on_click(() => exec("open", [pr.url]))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().size(7).rounded(4).bg(dot ?? t.border))
        // Copilot badge "C" (GitHub only): filled green = reviewed, yellow outline = requested, faint = not asked.
        .when(!gl, (e) => e.child(div().flex_none().size(15).flex().items_center().justify_center().rounded(4).border_1().text_size(10).font_semibold()
          .border_color(cp === "done" ? t.done : cp === "asked" ? t.working : t.border)
          .bg(cp === "done" ? t.done : t.background)
          .text_color(cp === "done" ? t.background : cp === "asked" ? t.working : t.dim)
          .tooltip(cp === "done" ? "Copilot reviewed" : cp === "asked" ? "Copilot review requested, no answer yet" : "Copilot not requested").child("C")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${gl ? "!" : "#"}${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().child(pr.title))
        .when(pr.isDraft,(e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("draft")))
        .when(Boolean(review), (e) => e.child(div().flex_none().text_size(10).text_color(review[1]).child(review[0]))))
      .child(h_flex().pl(13).gap(6).text_size(10).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(pr.headRefName))
        .when(!this.mine, (e) => e.child(div().flex_none().max_w(120).truncate().text_color(t.muted).child(pr.provider === "gitlab" ? pr.author : pr.author?.login ?? ""))));
  }

  tokenForm(t) {
    const host = this.needToken;
    const button = (id, label, primary, onClick) => div().id(id).h(28).px(12).flex().flex_1().items_center().justify_center().rounded(7).cursor_pointer().text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.9)).on_click(onClick).child(label);
    return v_flex().p(8).gap(8).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child(`Connect ${host}`))
      .child(div().text_size(11).child("A personal access token with the read_api scope lets this panel list your merge requests."))
      .child(div().id("gl-token").h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.tokenInput).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(6)
        .child(button("gl-open", "Create token", false, () => exec("open", [`https://${host}/-/user_settings/personal_access_tokens?name=Herdr&scopes=read_api`])))
        .child(button("gl-save", this.savingToken ? "Checking…" : "Save", true, (_e, cx) => this.saveToken(cx))))
      .when(Boolean(this.tokenError), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.tokenError)))
      .child(div().text_size(10).text_color(t.dim).child(`Checked against ${host} before saving; kept in the macOS Keychain (${GL_SERVICE}).`));
  }

  render(cx) {
    this.follow(cx);
    const t = theme(), busy = this.loading || this.fetching.has(this.focusRepo);
    const empty = this.error || (busy && !this.prs.length ? "Loading…" : !this.prs.length ? (this.mine ? "None of mine open · All shows everyone's" : "No open pull requests") : null);
    const refresh = div().id("refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Refresh").on_click((_e, cx) => { cx.stop_propagation(); this.poll(cx); })
      .child(svg("mods/prs/refresh.svg").size(14).when(busy, (s) => s.spin(900)));
    const sec = S.sectionOf("prs"), ov = S.overlay(sec);
    return v_flex().id("prs").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(S.header(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border), sec, 44)
        .child(S.mark(sec))
        .child(div().font_semibold().text_size(13).child(this.provider === "gitlab" ? "Merge requests" : "Pull requests"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(this.prs.length)))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(this.repo))
        .child(h_flex().id("scope").flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().text_size(10)
          .children([["all", "All", false], ["mine", "Mine", true]].map(([id, label, v]) => div().id(`scope-${id}`).h(20).px(6).flex().items_center().cursor_pointer()
            .bg(this.mine === v ? t.selected : t.background).text_color(this.mine === v ? t.foreground : t.muted)
            .tooltip(v ? "Only the ones I opened" : "Every open one in this repo")
            .on_click((_e, cx) => { cx.stop_propagation(); if (this.mine !== v) this.toggleMine(cx); }).child(label))))
        .child(h_flex().id("auto").h(24).px(5).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(this.auto ? "Auto-sync every minute (with Copilot sound): on" : "Auto-sync: off · refresh by hand").on_click((_e, cx) => { cx.stop_propagation(); this.toggleAuto(cx); })
          .child(div().size(13).flex().items_center().justify_center().rounded(3).border_1().text_size(10).font_semibold()
            .border_color(this.auto ? t.accent : t.border).bg(this.auto ? t.accent : t.background).text_color(t.accent_foreground).child(this.auto ? "✓" : ""))
          .child(div().text_size(10).text_color(t.muted).child("Auto")))
        .child(refresh))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("prs-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(Boolean(this.needToken), (e) => e.child(this.tokenForm(t)))
          .when(Boolean(empty) && !this.needToken, (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .children(this.prs.map((pr) => this.row(pr, t))))
        .child(Scrollbar.vertical("prs-list").absolute().inset_0()))
      .when(Boolean(ov), (e) => e.child(ov));
  }
}
