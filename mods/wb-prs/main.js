import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, TextView, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, appHome, readTextFile, theme, notify, props, openOverlay, closeOverlay, shared, setShared } from "herdr";
import * as S from "./section.js";
import { CreateDialog, GEN as MR_GEN, DRAFTS as MR_DRAFTS, liveJob, patchShared, generateMr } from "./create.js";
import { migrate, models, modelFor, settingsFor, setUse, languageLine, runModel, describe } from "./ai.js";
import { getSecret, setSecret, supported as secretsSupported, UNSUPPORTED } from "./secrets.js";
// Soft dependency: is mods/<name>/ installed? Cached per name, re-read at most once a minute (assumed present until the first read answers).
const _soft = {};
function installed(name, fresh) {
  const c = (_soft[name] ??= { ok: true, at: 0 });
  if (!fresh && Date.now() - c.at < 60000) return c.ok;
  c.at = Date.now();
  const p = readTextFile(`${appHome()}/mods/${name}/main.js`).then((r) => (c.ok = r != null), () => (c.ok = false));
  return fresh ? p : c.ok; // stale: answer from the cache now, the next call sees the re-read
}


// AI review drafts, per PR/MR url, until posted or discarded: shared "wb.ai.reviewDrafts" = { url: { text, model, at } }.
const DRAFTS = "wb.ai.reviewDrafts";
// A review runs in the panel copy, not the popup (an overlay's tasks are cancelled when it closes): the popup queues
// shared "wb.ai.reviewGen" = { [pr url]: { id, state: "queued" | "running" | "error", pr, detail, at, error? } }
// and the panel copy writes the text into DRAFTS[url] = { text, model, at, gen }.
const REVIEW_GEN = "wb.ai.reviewGen";
const openAiModels = () => openOverlay({ mod: "wb-ai", kind: "window", key: "wb-ai", width: 580 });
const openReviewSettings = (repo) => openOverlay({ mod: "wb-ai", kind: "dialog", width: 560, props: { use: "review", project: repo.key, projectName: repo.name } });

// My open pull requests in the repo of the focused folder. Click opens it in the browser.
// GitHub: via the `gh` CLI. GitLab (any other host, e.g. a self-hosted git.example.com): merge requests
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
const gitlabToken = (host) => getSecret(GL_SERVICE, host);
async function gitlab(host, token, path, method = "GET", body) {
  const r = await fetch(`https://${host}/api/v4${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { "PRIVATE-TOKEN": token, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) } });
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
    const [d, a] = await Promise.all([
      gitlab(host, token, `${project}/merge_requests/${mr.iid}`).catch(() => mr),
      gitlab(host, token, `${project}/merge_requests/${mr.iid}/approvals`).catch(() => null),
    ]);
    return { approvedBy: (a?.approved_by ?? []).map((x) => x.user?.name ?? x.user?.username).filter(Boolean), mineApproved: Boolean(a?.user_has_approved),
      provider: "gitlab", author: mr.author?.name ?? mr.author?.username ?? "", number: mr.iid, title: mr.title, headRefName: mr.source_branch, isDraft: Boolean(mr.draft ?? mr.work_in_progress),
      url: mr.web_url, ci: pipelineState(d.head_pipeline?.status ?? d.pipeline?.status), badge: MERGE_LABEL[d.detailed_merge_status] ?? null };
  }));
}

// GitHub: who approved (each reviewer's latest decisive review), from gh's `reviews`.
function ghApprovals(pr, me) {
  const last = new Map();
  for (const r of pr.reviews ?? []) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) last.set(r.author?.login, r.state);
  const by = [...last].filter(([, st]) => st === "APPROVED").map(([login]) => login).filter(Boolean);
  return { approvedBy: by, mineApproved: Boolean(me && by.includes(me)) };
}
const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

export default class Prs extends View {
  init(_props, cx) {
    S.migrateKeys(["sections.collapsed"]);
    migrate();
    // Opened as a popup for one PR/MR (click on a row): its description, comments and approvals.
    if (props()?.create) {
      this.creating = new CreateDialog(props().create.repo, { gitlab, gitlabToken, installed });
      this.creating.init(cx); return;
    }
    if (props()?.pr) {
      this.detailPr = props().pr; this.aiMenu = false; this.posting = false; this.seenGen = null; this.seenError = null;
      // The review draft: editable, kept (shared) until posted or discarded.
      this.draft = TextareaState.new({ placeholder: "AI review draft", rows: 12 });
      const saved = (shared(DRAFTS) ?? {})[this.detailPr.url];
      if (saved) { this.draft.set_value(saved.text); this.seenGen = saved.gen ?? null; }
      this.draft.on("blur", () => this.keepDraft());
      this.draft.on("change", () => this.keepDraft());
      // The review finishes in the panel copy: its text arrives through the shared draft.
      cx.timer.every(500, (cx) => { if (this.takeReview()) cx.notify(); });
      this.loadDetail(cx); return;
    }
    // Long-lived jobs queued by this panel's dialogs (MR descriptions, PR reviews): run here, since a closed overlay's tasks are cancelled.
    cx.timer.every(1000, (cx) => this.runQueued(cx));
    this.prs = []; this.error = null; this.loading = false; this.key = key(); this.repo = ""; this.started = Date.now();
    this.byRepo = new Map(); // repo key -> { name, prs, error }: one gh call per repo, whatever folders point at it
    this.remotes = new Map(); // folder -> its repo, from the local git remote (no API call)
    this.focusRepo = null;
    // GitLab token form: shown while the focused repo's host has no (working) token.
    this.tokenInput = InputState.new({ placeholder: "GitLab personal access token (read_api)" });
    this.tokenInput.set_masked(true);
    this.tokenInput.on("submit", (_e, cx) => this.saveToken(cx));
    this.tokenError = null; this.savingToken = false;
    // All open PRs/MRs of the repo, or only mine; remembered.
    this.mine = (() => { try { return (localStorage.getItem("prs:mine") ?? localStorage.getItem("mine")) === "1"; } catch { return false; } })();
    this.fetching = new Set(); // repo keys being fetched one by one (a project switch)
    // The last lists and folder→repo answers survive restarts: a switch shows them at once.
    this.loadCache();
    this.key = null; this.focus(cx);
    this.poll(cx);
    // The folder follows focus: render notices a switch at once; this catches a `cd` inside a terminal.
    cx.timer.every(2000, (cx) => this.follow(cx));
  }

  // Cache: one list per mode (All / Mine) in localStorage, plus the folder → repo answers.
  // Keys carry a "prs:" prefix: another mod's store once got these written into it (and this one
  // theirs), so each key is ours alone and every entry is type-checked; unprefixed keys are read once.
  cacheKey() { return `prs:cache:${this.mine ? "mine" : "all"}`; }
  loadCache() {
    try {
      // Lists cached before PRs carried their repo can't drive the menu or popup: dropped (re-fetched).
      const old = (k) => localStorage.getItem(k) ?? localStorage.getItem(k.slice(4)) ?? "[]";
      this.byRepo = new Map(JSON.parse(old(this.cacheKey())).filter(([, e]) => e && typeof e === "object" && (e.prs ?? []).every((pr) => pr.repo)));
      for (const [id, r] of JSON.parse(old("prs:remotes"))) if (r && typeof r === "object" && r.key) this.remotes.set(id, r);
    } catch { this.byRepo = new Map(); }
  }
  saveCache() {
    try {
      // Only real lists: errors and token prompts are asked again.
      localStorage.setItem(this.cacheKey(), JSON.stringify([...this.byRepo].filter(([, e]) => !e.error && !e.needToken)));
      localStorage.setItem("prs:remotes", JSON.stringify([...this.remotes]));
    } catch {}
  }

  follow(cx) {
    const k = key();
    if (k !== this.key) { this.key = k; this.focus(cx); }
  }

  toggleMine(cx) {
    this.mine = !this.mine;
    try { localStorage.setItem("prs:mine", this.mine ? "1" : "0"); } catch {}
    this.loadCache(); this.show(); cx.notify();
    this.poll(cx);
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
    // Each PR knows its repo, so its menu and popup can act on it.
    const repo = { key: r.key, name: r.name, host: r.host, path: r.path, cwd: r.cwd, on: r.on };
    if (r.host === "github.com") {
      const me = await this.ghLogin(r.on);
      return (await list(r.cwd, r.on, this.mine)).map((pr) => ({ ...pr, ...ghApprovals(pr, me), repo }));
    }
    const token = await gitlabToken(r.host);
    if (!token) throw Object.assign(new Error(`No GitLab token for ${r.host}`), { needToken: r.host });
    try { return (await listGitlab(r.host, r.path, token, this.mine)).map((pr) => ({ ...pr, repo })); }
    catch (e) { if (e.status === 401) throw Object.assign(new Error(`${r.host} rejected the saved token`), { needToken: r.host }); throw e; }
  }

  // My GitHub login on a machine (gh's account there), asked once.
  async ghLogin(on) {
    this.ghMe ??= {};
    if (!(on in this.ghMe)) {
      const r = await exec("gh", ["api", "user", "--jq", ".login"], { on }).catch(() => null);
      this.ghMe[on] = r?.code === 0 ? r.stdout.trim() : null;
    }
    return this.ghMe[on];
  }

  // Approve / take the approval back. GitLab both ways; GitHub can only approve (taking it back
  // is a dismissal, which needs admin rights). The panel re-fetches that repo afterwards.
  setApproval(pr, approve, cx) {
    const r = pr.repo;
    cx.spawn(async (cx) => {
      try {
        if (pr.provider === "gitlab") {
          const token = await gitlabToken(r.host);
          await gitlab(r.host, token, `/projects/${encodeURIComponent(r.path)}/merge_requests/${pr.number}/${approve ? "approve" : "unapprove"}`, "POST");
        } else {
          if (!approve) throw new Error("GitHub can't take an approval back from here");
          const x = await exec("gh", ["pr", "review", String(pr.number), "--approve"], { cwd: r.cwd, on: r.on });
          if (x.code !== 0) throw new Error((x.stderr || x.stdout).trim());
        }
        notify({ title: approve ? "Approved" : "Approval removed", body: `${pr.provider === "gitlab" ? "!" : "#"}${pr.number} ${pr.title}`, level: "success" });
      } catch (e) {
        notify({ title: "Approval failed", body: e.status === 403 ? "The token can't approve: it needs the api scope" : String(e.message ?? e), level: "error" });
      }
      setShared("wb.prs.changed", { repo: r, ts: Date.now() });
      if (this.detailPr) this.loadDetail(cx);
      else this.refreshOne(r, cx);
    });
  }

  // ── AI review ──
  draftInfo() { return (shared(DRAFTS) ?? {})[this.detailPr.url] ?? null; }
  get reviewing() { return liveJob((shared(REVIEW_GEN) ?? {})[this.detailPr.url]); }
  keepDraft(meta) {
    const url = this.detailPr.url, old = (shared(DRAFTS) ?? {})[url], text = this.draft.value();
    // A generated review this popup hasn't taken yet must not be overwritten by the stale box.
    if (!meta && old?.gen && old.gen !== this.seenGen) return;
    if (!meta && (old?.text ?? "") === text) return;
    if (!meta && !old && !text.trim()) return;
    patchShared(DRAFTS, url, { ...(old ?? {}), ...(meta ?? {}), text });
  }
  // The panel copy wrote a review: show it (and a failure, once).
  takeReview() {
    const url = this.detailPr.url, d = (shared(DRAFTS) ?? {})[url], j = (shared(REVIEW_GEN) ?? {})[url];
    let changed = false;
    if (d?.gen && d.gen !== this.seenGen) { this.seenGen = d.gen; this.draft.set_value(d.text ?? ""); changed = true; }
    if (j?.state === "error" && j.id !== this.seenError) { this.seenError = j.id; this.reviewError = `AI review failed: ${j.error}`; changed = true; }
    return changed;
  }

  // Runs queued jobs from the dialogs (see MR_GEN, REVIEW_GEN). Claimed by writing state "running" before any await.
  runQueued(cx) {
    for (const [id, g] of Object.entries(shared(MR_GEN) ?? {})) {
      if (g.state !== "queued") continue;
      patchShared(MR_GEN, id, { ...g, state: "running", at: Date.now() });
      cx.spawn(async (cx) => {
        try {
          const text = await generateMr(g);
          patchShared(MR_DRAFTS, id, { ...((shared(MR_DRAFTS) ?? {})[id] ?? { title: g.title, target: g.target, draft: false }), description: text, gen: g.id, at: Date.now() });
          patchShared(MR_GEN, id, null);
          notify({ title: "Description ready", body: g.branch, level: "success" });
        } catch (e) {
          patchShared(MR_GEN, id, { ...g, state: "error", error: String(e.message ?? e), at: Date.now() });
          notify({ title: "Description failed", body: String(e.message ?? e), level: "error" });
        }
        cx.notify();
      });
    }
    for (const [url, g] of Object.entries(shared(REVIEW_GEN) ?? {})) {
      if (g.state !== "queued") continue;
      patchShared(REVIEW_GEN, url, { ...g, state: "running", at: Date.now() });
      cx.spawn(async (cx) => {
        try {
          const cfg = settingsFor("review", g.pr.repo.key), model = cfg.model, d = g.detail;
          const diff = await this.diffText(g.pr);
          const prompt = `${cfg.template} ${languageLine(cfg.language)}\n\nTitle: ${d.title}\n\nDescription:\n${(d.body || "(none)").slice(0, 8000)}\n\nDiff (${d.from} → ${d.to}):\n${diff.slice(0, 90000)}${diff.length > 90000 ? "\n… (diff truncated)" : ""}`;
          // A CLI model runs inside the repo on its machine, so it can open more of the code than the diff.
          const text = await runModel(model, prompt, { cwd: g.pr.repo.cwd, on: g.pr.repo.on });
          if (!text) throw new Error("the model returned nothing");
          patchShared(DRAFTS, url, { ...((shared(DRAFTS) ?? {})[url] ?? {}), text, model: model?.name, at: new Date().toISOString(), gen: g.id });
          patchShared(REVIEW_GEN, url, null);
          notify({ title: "AI review ready", body: g.pr.title, level: "success" });
        } catch (e) {
          patchShared(REVIEW_GEN, url, { ...g, state: "error", error: String(e.message ?? e), at: Date.now() });
          notify({ title: "AI review failed", body: String(e.message ?? e), level: "error" });
        }
        cx.notify();
      });
    }
  }
  dropDraft() {
    const all = { ...(shared(DRAFTS) ?? {}) };
    delete all[this.detailPr.url];
    setShared(DRAFTS, all); this.draft.set_value("");
  }

  // The PR/MR as one unified diff (capped: a model's prompt has room for so much).
  async diffText(pr = this.detailPr) {
    const r = pr.repo;
    if (pr.provider === "gitlab") {
      const token = await gitlabToken(r.host), base = `/projects/${encodeURIComponent(r.path)}/merge_requests/${pr.number}`;
      const files = await gitlab(r.host, token, `${base}/diffs?per_page=100`).catch(async () => (await gitlab(r.host, token, `${base}/changes`)).changes ?? []);
      return files.map((f) => `diff --git a/${f.old_path} b/${f.new_path}\n--- a/${f.old_path}\n+++ b/${f.new_path}\n${f.diff}`).join("\n");
    }
    const x = await exec("gh", ["pr", "diff", String(pr.number)], { cwd: r.cwd, on: r.on });
    if (x.code !== 0) throw new Error((x.stderr || x.stdout).trim());
    return x.stdout;
  }

  // Queues the review for the panel copy and returns: the text lands in the draft even if this popup is closed.
  aiReview(cx) {
    if (this.reviewing || !this.detail) return;
    const pr = this.detailPr, d = this.detail;
    this.reviewError = null; this.aiMenu = false;
    patchShared(REVIEW_GEN, pr.url, { id: `${Date.now()}`, state: "queued", pr, detail: { title: d.title, body: (d.body ?? "").slice(0, 8000), from: d.from, to: d.to }, at: Date.now() });
    cx.notify();
  }

  // The draft, as it is now (edited or not), becomes a comment on the PR/MR.
  postDraft(cx) {
    const pr = this.detailPr, r = pr.repo, body = this.draft.value().trim();
    if (!body || this.posting) return;
    this.posting = true; this.reviewError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (pr.provider === "gitlab") {
          const token = await gitlabToken(r.host);
          await gitlab(r.host, token, `/projects/${encodeURIComponent(r.path)}/merge_requests/${pr.number}/notes`, "POST", { body });
        } else {
          const x = await exec("gh", ["pr", "comment", String(pr.number), "--body", body], { cwd: r.cwd, on: r.on });
          if (x.code !== 0) throw new Error((x.stderr || x.stdout).trim());
        }
        this.dropDraft();
        notify({ title: "Review posted", body: `${pr.provider === "gitlab" ? "!" : "#"}${pr.number} ${pr.title}`, level: "success" });
        this.loadDetail(cx);
      } catch (e) { this.reviewError = `Post failed: ${e.status === 403 ? "the token can't comment (needs the api scope)" : e.message ?? e}`; }
      finally { this.posting = false; cx.notify(); }
    });
  }

  // ── the PR/MR popup ──
  loadDetail(cx) {
    const pr = this.detailPr, r = pr.repo;
    cx.spawn(async (cx) => {
      try {
        if (pr.provider === "gitlab") {
          const token = await gitlabToken(r.host), base = `/projects/${encodeURIComponent(r.path)}/merge_requests/${pr.number}`;
          const [mr, a, notes] = await Promise.all([gitlab(r.host, token, base), gitlab(r.host, token, `${base}/approvals`).catch(() => null),
            gitlab(r.host, token, `${base}/notes?sort=asc&order_by=created_at&per_page=100`).catch(() => [])]);
          this.detail = { title: mr.title, body: mr.description ?? "", author: mr.author?.name, from: mr.source_branch, to: mr.target_branch,
            created: mr.created_at, url: mr.web_url, approvedBy: (a?.approved_by ?? []).map((x) => x.user?.name), mineApproved: Boolean(a?.user_has_approved),
            comments: notes.filter((n) => !n.system).map((n) => ({ id: n.id, author: n.author?.name, at: n.created_at, body: n.body, extra: n.type === "DiffNote" ? n.position?.new_path : null })) };
        } else {
          const x = await exec("gh", ["pr", "view", String(pr.number), "--json", "title,body,author,url,headRefName,baseRefName,createdAt,comments,reviews"], { cwd: r.cwd, on: r.on });
          if (x.code !== 0) throw new Error((x.stderr || x.stdout).trim());
          const v = JSON.parse(x.stdout), ap = ghApprovals(v, await this.ghLogin(r.on));
          const items = [...(v.comments ?? []).map((c) => ({ author: c.author?.login, at: c.createdAt, body: c.body })),
            ...(v.reviews ?? []).filter((rv) => rv.body || rv.state !== "COMMENTED").map((rv) => ({ author: rv.author?.login, at: rv.submittedAt, body: rv.body, extra: rv.state.toLowerCase().replace("_", " ") }))]
            .sort((p, q) => String(p.at).localeCompare(String(q.at))).map((c, i) => ({ ...c, id: i }));
          this.detail = { title: v.title, body: v.body ?? "", author: v.author?.login, from: v.headRefName, to: v.baseRefName, created: v.createdAt, url: v.url, ...ap, comments: items };
        }
        this.detailError = null;
      } catch (e) { this.detailError = String(e.message ?? e); }
      cx.notify();
    });
  }

  detailView(t) {
    const pr = this.detailPr, d = this.detail, gl = pr.provider === "gitlab", num = `${gl ? "!" : "#"}${pr.number}`;
    const btn = (id, label, act, primary = false) => div().id(id).h(26).px(10).flex().items_center().rounded(6).border_1().text_size(12).cursor_pointer()
      .border_color(primary ? t.done : t.border).text_color(primary ? t.done : t.foreground).hover((s) => s.bg(t.hover)).on_click(act).child(label);
    const meta = (label, value) => !value ? null : h_flex().gap(8).items_center().text_size(12)
      .child(div().w(80).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).truncate().child(value));
    const canApprove = d && (gl || !d.mineApproved);
    const menu = !this.aiMenu ? null : v_flex().id("ai-menu-list").absolute().top(40).right(16).w(280).p(4).gap(1).rounded(8)
      .border_1().border_color(t.border).bg(t.popover).shadow_lg().on_mouse_down_out((_e, cx) => { this.aiMenu = false; cx.notify(); })
      .child(div().px(8).py(4).text_size(10).font_semibold().text_color(t.dim).child("REVIEW WITH"))
      .children(models().map((m) => h_flex().id(`rv-${m.id}`).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer()
        .when(modelFor("review", pr.repo.key)?.id === m.id, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { setUse("review", m.id, pr.repo.key); this.aiMenu = false; cx.notify(); })
        .child(div().flex_1().truncate().text_size(12).child(m.name)).child(div().text_size(11).text_color(t.dim).child(describe(m)))))
      .when(installed("wb-ai"), (e) => e.child(div().h(1).my(2).bg(t.border)))
      .when(installed("wb-ai"), (e) => e.child(h_flex().id("rv-project").h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.aiMenu = false; openReviewSettings(pr.repo); cx.notify(); }).child("Review settings…")))
      .when(installed("wb-ai"), (e) => e.child(h_flex().id("rv-settings").h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.aiMenu = false; openAiModels(); cx.notify(); }).child("AI models…")));
    return v_flex().id("pr-detail").size_full().min_h(0).relative().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.dim).child(num))
        .when(Boolean(d?.approvedBy?.length), (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(t.done).text_size(11).text_color(t.done).child(`✓ approved · ${d.approvedBy.length}`)))
        .child(div().flex_1())
        // Approve first: it appears once details load, and on the left it doesn't push the buttons after it.
        .when(Boolean(canApprove), (e) => e.child(btn("approve", d.mineApproved ? "Remove approval" : "Approve", (_e, cx) => this.setApproval(pr, !d.mineApproved, cx), !d.mineApproved)))
        // AI review, and ▾: which model reviews (shared list) and the AI models window.
        .child(h_flex().id("ai-review").h(26).flex_none().rounded(6).border_1().border_color(t.accent).overflow_hidden()
          .child(h_flex().id("ai-run").h_full().px(10).gap(6).items_center().text_size(12).text_color(t.accent).cursor_pointer()
            .hover((s) => s.bg(t.hover)).tooltip(`Review with ${modelFor("review", pr.repo.key)?.name ?? "no model"} (${describe(modelFor("review", pr.repo.key))})`)
            .on_click((_e, cx) => this.aiReview(cx))
            .child(this.reviewing ? svg("mods/wb-prs/icons/spinner.svg").size(12).text_color(t.accent).spin(900) : div().child("✦"))
            .child(this.reviewing ? "Reviewing…" : "AI review"))
          .child(div().id("ai-menu").w(22).h_full().flex().items_center().justify_center().border_l(1).border_color(t.border).text_color(t.muted)
            .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.aiMenu = !this.aiMenu; cx.notify(); })
            .child(svg("mods/wb-prs/icons/chevron-down.svg").size(11))))
        .child(btn("open", "Open", () => exec("open", [pr.url])))
        .child(btn("copy", "Copy link", (_e, cx) => cx.write_to_clipboard(pr.url)))
        .child(div().id("close").size(26).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props()?.overlay)).child("✕")))
      .child(v_flex().id("pr-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(14)
        .when(!d, (e) => e.child(div().text_color(this.detailError ? t.ansi1 : t.dim).child(this.detailError ?? "Loading…")))
        .when(Boolean(d), (e) => e
          .child(div().text_size(17).font_semibold().child(d.title))
          .child(v_flex().gap(5).children([meta("Author", d.author), meta("Branches", `${d.from} → ${d.to}`), meta("Opened", when(d.created)),
            meta("Approved by", d.approvedBy.length ? d.approvedBy.join(", ") : "nobody yet")].filter(Boolean)))
          .child(div().h(1).bg(t.border))
          .child(d.body.trim() ? TextView.markdown(`pr-desc-${pr.number}`, d.body) : div().text_color(t.dim).child("No description"))
          .when(Boolean(this.reviewError), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.reviewError)))
          // The AI review as a draft: edit it, then post it as a comment (or regenerate / discard).
          .when(Boolean(this.draftInfo()) || this.reviewing, (e) => e.child(v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.accent).bg(t.raised)
            .child(h_flex().gap(8).items_center().text_size(11)
              .child(div().font_semibold().text_color(t.accent).child("AI REVIEW · DRAFT"))
              .child(div().text_color(t.dim).child(this.reviewing ? `${modelFor("review", pr.repo.key)?.name ?? ""} is reviewing…` : [this.draftInfo()?.model, when(this.draftInfo()?.at)].filter(Boolean).join(" · ")))
              .child(div().flex_1())
              .child(btn("draft-discard", "Discard", (_e, cx) => { this.dropDraft(); cx.notify(); }))
              .child(btn("draft-again", "Regenerate", (_e, cx) => this.aiReview(cx)))
              .child(btn("draft-post", this.posting ? "Posting…" : "Post as comment", (_e, cx) => this.postDraft(cx), true)))
            .child(div().id("draft-box").h(260).px(10).py(8).rounded(7).border_1().border_color(t.border).bg(t.background).cursor_text()
              .child(Textarea.new(this.draft).w_full().h(244).text_size(12).text_color(t.foreground)))))
          .when(d.comments.length > 0, (e) => e
            .child(div().h(1).bg(t.border))
            .child(div().text_size(11).font_semibold().text_color(t.dim).child(`COMMENTS · ${d.comments.length}`))
            .children(d.comments.map((c) => v_flex().gap(4).p(10).rounded(8).bg(t.raised)
              .child(h_flex().gap(8).text_size(11).child(div().font_semibold().child(c.author ?? "")).child(div().text_color(t.dim).child(when(c.at)))
                .when(Boolean(c.extra), (e) => e.child(div().text_color(t.muted).child(c.extra))))
              .when(Boolean(c.body), (e) => e.child(TextView.markdown(`pr-c-${c.id}`, c.body))))))))
      .when(Boolean(menu), (e) => e.child(menu));
  }

  // The right-click menu of a row.
  menuView(t) {
    const { pr, x, y } = this.menu, w = 200, gl = pr.provider === "gitlab";
    const item = (id, label, action) => div().id(id).h(26).px(10).flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .hover((s) => s.bg(t.hover))
      // The menu lies over the rows: keep the press and click from reaching the row (which opens the PR).
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.menu = null; action(cx); cx.notify(); }).child(label);
    return v_flex().id("pr-menu").absolute().top(y).left(Math.max(4, Math.min(x, (this.width ?? w) - w - 4))).w(w).p(4).gap(1)
      .rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      .child(item("m-open", "Open in browser", () => exec("open", [pr.url])))
      .child(item("m-copy", "Copy link", (cx) => cx.write_to_clipboard(pr.url)))
      .when(gl || !pr.mineApproved, (e) => e.child(item("m-approve", pr.mineApproved ? "Remove approval" : "Approve", (cx) => this.setApproval(pr, !pr.mineApproved, cx))));
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
        await setSecret(GL_SERVICE, host, token);
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
    this.error = e?.error ?? (!location().cwd ? "No folder" : null);
  }

  // A project switch: show that repo's list from the cache right away, then refresh
  // just that repo in the background when its list is older than 30 s or missing.
  focus(cx) {
    const k = this.key, loc = location();
    cx.spawn(async (cx) => {
      const r = await this.repoOf(loc);
      if (key() !== k) return; // switched again meanwhile: that switch handles it
      this.focusRepo = r.key; this.show(); cx.notify();
      const e = this.byRepo.get(r.key);
      if (r.host && loc.cwd && (!e || e.error || Date.now() - (e.at ?? 0) > 30000)) this.refreshOne({ ...r, ...loc }, cx);
    });
  }

  // The create dialog for the focused folder's repo.
  openCreate(cx) {
    const loc = location();
    cx.spawn(async (cx) => {
      const r = await this.repoOf(loc);
      if (!r.host || !loc.cwd) { notify({ title: "No git remote (origin) in this folder", level: "error" }); return; }
      openOverlay({ mod: "wb-prs", kind: "dialog", modal: true, width: 620, height: 0.85, props: { create: { repo: { ...r, ...loc } } } });
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
      } catch (e) { this.byRepo.set(r.key, { name: r.name, prs: old?.prs ?? [], error: e.needToken ? null : String(e.message ?? e), needToken: e.needToken ?? null, provider: r.host === "github.com" ? "github" : "gitlab" }); }
      finally {
        this.fetching.delete(r.key); this.saveCache();
        if (this.focusRepo === r.key) this.show();
        cx.notify();
      }
    });
  }

  // On start and on the refresh button: the open PRs of every repo among all spaces' folders and the focused one,
  // one gh call per repo. No timer: a project switch refreshes its own repo when the list is stale.
  poll(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true; cx.notify();
    const focus = location(), places = new Map();
    for (const p of [focus, ...spaces().map((s) => ({ cwd: s.folder, on: s.machine ?? null }))]) if (p.cwd) places.set(`${p.on}|${p.cwd}`, p);
    cx.spawn(async (cx) => {
      try {
        const repos = new Map();
        for (const p of places.values()) { const r = await this.repoOf(p); if (!repos.has(r.key)) repos.set(r.key, { ...r, ...p }); }
        await Promise.all([...repos].map(async ([k, r]) => {
          const old = this.byRepo.get(k);
          try {
            const prs = await this.fetchRepo(r);
            this.byRepo.set(k, { name: r.name, prs, error: null, provider: r.host === "github.com" ? "github" : "gitlab", at: Date.now() });
          } catch (e) { this.byRepo.set(k, { name: r.name, prs: old?.prs ?? [], error: e.needToken ? null : String(e.message ?? e), needToken: e.needToken ?? null, provider: "gitlab" }); }
        }));
        // Where focus is now (it may have moved during the poll).
        this.focusRepo = (await this.repoOf(location())).key; this.show(); this.saveCache();
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
      .when(this.menu?.pr?.url === pr.url, (s) => s.bg(t.selected))
      // Click: the whole PR/MR in a popup; right-click: its menu (placed by the panel's handler).
      .on_click(() => openOverlay({ mod: "wb-prs", kind: "dialog", width: 780, height: 0.85, props: { pr } }))
      .on_mouse_down("right", () => { this.menuPr = pr; })
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
        // Approvals right in the list: ✓ and how many; brighter when one of them is mine.
        .when(Boolean(pr.approvedBy?.length), (e) => e.child(div().flex_none().px(4).rounded(3).text_size(10).font_semibold()
          .bg(pr.mineApproved ? t.done : t.background).border_1().border_color(t.done).text_color(pr.mineApproved ? t.background : t.done)
          .tooltip(`Approved by ${pr.approvedBy.join(", ")}${pr.mineApproved ? " (you too)" : ""}`).child(`✓${pr.approvedBy.length > 1 ? ` ${pr.approvedBy.length}` : ""}`)))
        .when(Boolean(review), (e) => e.child(div().flex_none().text_size(10).text_color(review[1]).child(review[0]))))
      .child(h_flex().pl(13).gap(6).text_size(10).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(pr.headRefName))
        .when(!this.mine, (e) => e.child(div().flex_none().max_w(120).truncate().text_color(t.muted).child(pr.provider === "gitlab" ? pr.author : pr.author?.login ?? ""))));
  }

  tokenForm(t) {
    const host = this.needToken;
    const button = (id, label, primary, onClick) => div().id(id).h(28).px(12).flex().flex_1().items_center().justify_center().rounded(7).cursor_pointer().text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.9)).on_click(onClick).child(label);
    if (!secretsSupported()) return v_flex().p(8).gap(8).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child(`Connect ${host}`))
      .child(div().text_size(11).child(UNSUPPORTED));
    return v_flex().p(8).gap(8).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child(`Connect ${host}`))
      .child(div().text_size(11).child("A personal access token with the api scope lets this panel list merge requests and approve them (read_api: list only)."))
      .child(div().id("gl-token").h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.tokenInput).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(6)
        .child(button("gl-open", "Create token", false, () => exec("open", [`https://${host}/-/user_settings/personal_access_tokens?name=Herdr&scopes=api`])))
        .child(button("gl-save", this.savingToken ? "Checking…" : "Save", true, (_e, cx) => this.saveToken(cx))))
      .when(Boolean(this.tokenError), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.tokenError)))
      .child(div().text_size(10).text_color(t.dim).child(`Checked against ${host} before saving; kept in the macOS Keychain (${GL_SERVICE}).`));
  }

  render(cx) {
    if (this.creating) return this.creating.render(theme());
    if (this.detailPr) return this.detailView(theme());
    this.follow(cx);
    // An approval made in a popup: re-fetch that repo here.
    const changed = shared("wb.prs.changed");
    if (changed && changed.ts !== this.changedTs) { this.changedTs = changed.ts; if (this.changedTs > (this.started ?? 0)) this.refreshOne(changed.repo, cx); }
    const t = theme(), busy = this.loading || this.fetching.has(this.focusRepo);
    const empty = this.error || (busy && !this.prs.length ? "Loading…" : !this.prs.length ? (this.mine ? "None of mine open · All shows everyone's" : "No open pull requests") : null);
    const refresh = div().id("refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Refresh").on_click((_e, cx) => { cx.stop_propagation(); this.poll(cx); })
      .child(svg("mods/wb-prs/refresh.svg").size(14).when(busy, (s) => s.spin(900)));
    const sec = S.sectionOf("wb-prs"), ov = S.overlay(sec);
    return v_flex().id("prs").size_full().min_h(0).relative()
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .on_mouse_down("right", (e, cx) => {
        if (!this.menuPr) return;
        this.menu = { pr: this.menuPr, x: e.local_position?.x ?? 8, y: e.local_position?.y ?? 8 }; this.menuPr = null;
        cx.stop_propagation(); cx.notify();
      }).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
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
        .child(div().id("create").h(24).px(7).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_pointer().text_size(10).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("New pull/merge request from the current branch")
          .on_click((_e, cx) => { cx.stop_propagation(); this.openCreate(cx); }).child("+ Create"))
        .child(refresh))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("prs-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(Boolean(this.needToken), (e) => e.child(this.tokenForm(t)))
          .when(Boolean(empty) && !this.needToken, (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .children(this.prs.map((pr) => this.row(pr, t))))
        .child(Scrollbar.vertical("prs-list").absolute().inset_0()))
      .when(Boolean(this.menu), (e) => e.child(this.menuView(t)))
      .when(Boolean(ov), (e) => e.child(ov));
  }
}
