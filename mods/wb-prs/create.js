// The "Create pull/merge request" dialog (PhpStorm-style): From (current branch) → Into (searchable
// remote branches), title, description with AI Generate, Draft, Create. Opened by main.js with props { create: { repo } }.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, notify, props, openOverlay, closeOverlay, setShared, shared } from "herdr";
import { models, modelFor, settingsFor, setUse, languageLine, NO_TRAILERS, runModel, describe } from "./ai.js";

const LONG = { timeout: 600000 };
const BASES = ["main", "master", "develop", "production"];
const humanize = (b) => b.replace(/^[^/]+\//, "").replace(/[-_]+/g, " ").trim() || b;

// Drafts and generations outlive the dialog (an overlay's tasks are cancelled when it closes, AGENTS.md "Cleanup"):
//   shared "wb.mr.drafts" = { [`${repo.key}|${branch}`]: { title, description, target, draft, at, gen? } }
//   shared "wb.mr.gen"    = { [same key]: { id, state: "queued" | "running" | "error", repo, branch, target, title, at, error? } }
// The dialog only queues a request; the wb-prs panel copy (alive while its block is in the layout) runs it
// (runMrGeneration, from its timer) and writes the text into the draft, so closing the dialog loses nothing.
export const DRAFTS = "wb.mr.drafts", GEN = "wb.mr.gen";
// Targets of the requests created from this dialog, newest first, per repo: shown at the top of Into and picked by default.
//   shared "wb.mr.recent" = { [repo.key]: [branch, ...] }
const RECENT = "wb.mr.recent", RECENT_MAX = 5;
const BOOT = Date.now(); // a job started before this module loaded belonged to code that no longer runs
export const liveJob = (g) => Boolean(g) && (g.state === "queued" || g.state === "running") && g.at >= BOOT && Date.now() - g.at < 660000;
export function patchShared(key, id, value) {
  const all = { ...(shared(key) ?? {}) };
  if (value == null) delete all[id]; else all[id] = value;
  setShared(key, all);
}

// Runs the AI description for a queued request; returns the text. Pure of dialog state: used by the panel copy.
export async function generateMr(req) {
  const r = req.repo, cfg = settingsFor("mr", r.key), model = cfg.model;
  const git = (args) => exec("git", args, { cwd: r.cwd, on: r.on });
  const base = `origin/${req.target}`;
  const log = await git(["log", "--format=%s%n%b", `${base}..HEAD`]);
  const diff = await git(["diff", `${base}...HEAD`]);
  if (diff.code !== 0) throw new Error((diff.stderr || diff.stdout).trim());
  const d = diff.stdout;
  const prompt = `${cfg.template} ${NO_TRAILERS} ${languageLine(cfg.language)}\n\nTitle: ${req.title}\n\nCommits:\n${log.stdout.slice(0, 8000)}\n\nDiff (${req.target} ← ${req.branch}):\n${d.slice(0, 90000)}${d.length > 90000 ? "\n… (diff truncated)" : ""}`;
  const text = await runModel(model, prompt, { cwd: r.cwd, on: r.on });
  if (!text) throw new Error("the model returned nothing");
  return text;
}

export class CreateDialog {
  // deps: { gitlab, gitlabToken, installed } from main.js
  constructor(repo, deps) { this.repo = repo; this.deps = deps; }

  git(args, opts = {}) { return exec("git", args, { cwd: this.repo.cwd, on: this.repo.on, ...opts }); }

  init(cx) {
    this.branches = []; this.target = null; this.branch = null; this.ahead = null; this.commits = [];
    this.fetching = true; this.error = null; this.busy = ""; this.restored = false; this.seenGen = null; this.wantTarget = null; this.aiMenu = false; this.draft = false;
    this.autoTitle = ""; this.fatal = false; this.def = null; this.aiClosedAt = 0;
    this.search = InputState.new({ placeholder: "Search branches…" });
    this.search.on("change", (_e, cx) => { this.filter = this.search.value(); cx.notify(); });
    this.search.on("submit", (_e, cx) => { const b = this.visible()[0]; if (b) this.pick(b, cx); });
    this.filter = "";
    this.title = InputState.new({ placeholder: "Title" });
    this.body = TextareaState.new({ placeholder: "Description", rows: 10 });
    this.title.on("change", () => this.save());
    this.body.on("change", () => this.save());
    // A generation finishes in the panel copy: its text arrives through the shared draft.
    cx.timer.every(500, (cx) => { if (this.takeGenerated()) cx.notify(); });
    cx.spawn(async (cx) => {
      try {
        const h = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
        this.branch = h.stdout.trim();
        if (h.code !== 0 || this.branch === "HEAD") { this.fatal = true; throw new Error("No branch is checked out (detached HEAD)"); }
        this.restore();
        await this.loadBranches(cx);
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
      if (this.fatal) { this.fetching = false; cx.notify(); return; }
      // Refresh the remote in the background, then reload the list; the dialog is usable meanwhile.
      try { await this.git(["fetch", "--prune", "origin"], LONG); await this.loadBranches(cx, true); } catch {}
      this.fetching = false; cx.notify();
    });
  }

  async loadBranches(cx, keep = false) {
    const r = await this.git(["for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin"]);
    this.branches = r.stdout.split("\n").map((s) => s.trim()).filter((b) => b && b !== "HEAD" && b !== this.branch);
    const d = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const def = d.code === 0 ? d.stdout.trim().replace(/^origin\//, "") : null;
    this.def = def;
    if (keep && this.target && this.branches.includes(this.target)) { await this.pickNow(this.target, cx); return; }
    const t = [this.wantTarget, ...this.recent(), def, "main", "master", "develop"].find((b) => b && this.branches.includes(b)) ?? this.branches[0] ?? null;
    if (t) await this.pickNow(t, cx); else cx.notify();
  }

  // ── drafts: one per repo and source branch, kept until the request is created ──
  dk() { return this.branch ? `${this.repo.key}|${this.branch}` : null; }
  stored() { const k = this.dk(); return k ? (shared(DRAFTS) ?? {})[k] ?? null : null; }
  job() { const k = this.dk(); return k ? (shared(GEN) ?? {})[k] ?? null : null; }
  isGenerating() { return liveJob(this.job()); }
  restore() {
    const d = this.stored();
    if (d) {
      // A restored title is not an auto title: pickNow leaves it alone.
      if (d.title) this.title.set_value(d.title);
      if (d.description) this.body.set_value(d.description);
      this.draft = Boolean(d.draft); this.wantTarget = d.target ?? null; this.seenGen = d.gen ?? null;
    }
    this.restored = true;
  }
  save() {
    const k = this.dk();
    if (!k || !this.restored) return;
    const old = this.stored();
    // A generated description the dialog hasn't taken yet must not be overwritten by the stale box.
    const description = old?.gen && old.gen !== this.seenGen ? old.description : this.body.value();
    const title = this.title.value(), next = { title: title === this.autoTitle ? "" : title, description, target: this.target, draft: this.draft };
    if (!next.title.trim() && !next.description.trim() && !old) return;
    if (old && ["title", "description", "target", "draft"].every((f) => old[f] === next[f])) return;
    patchShared(DRAFTS, k, { ...(old ?? {}), ...next, at: Date.now() });
  }
  // The panel copy wrote a generated description: show it (and a failure, once).
  takeGenerated() {
    const d = this.stored(), j = this.job();
    let changed = false;
    if (d?.gen && d.gen !== this.seenGen) { this.seenGen = d.gen; this.body.set_value(d.description ?? ""); changed = true; }
    if (j?.state === "error" && j.id !== this.seenError) { this.seenError = j.id; this.error = `Generating failed: ${j.error}`; changed = true; }
    return changed;
  }

  // Recent targets that still exist on origin, newest first.
  recent() { return ((shared(RECENT) ?? {})[this.repo.key] ?? []).filter((b) => this.branches.includes(b)); }
  remember(b) {
    const k = this.repo.key; if (!k || !b) return;
    patchShared(RECENT, k, [b, ...((shared(RECENT) ?? {})[k] ?? []).filter((x) => x !== b)].slice(0, RECENT_MAX));
  }
  visible() {
    const f = (this.filter ?? "").toLowerCase(), hit = (b) => b.toLowerCase().includes(f);
    const rec = this.recent().filter(hit), set = new Set(rec);
    this.recentCount = rec.length;
    return [...rec, ...this.branches.filter((b) => !set.has(b) && hit(b))];
  }

  pick(b, cx) { if (this.fatal) return; this.target = b; this.save(); cx.spawn(async (cx) => { await this.pickNow(b, cx); cx.notify(); }); }

  // The branch the MR comes from: the upstream's name when the local branch tracks a differently named, non-base
  // remote branch (review/1128 → origin/oleh/1128-…), else the local name.
  async resolveSource(target) {
    const L = this.branch;
    const up = await this.git(["rev-parse", "--abbrev-ref", "@{u}"]);
    const u = up.code === 0 ? up.stdout.trim() : "";
    const X = u.startsWith("origin/") ? u.slice(7) : "";
    if (X && ![target, this.def, ...BASES].includes(X)) return { name: X, upstream: true };
    return { name: L, upstream: false };
  }

  // Choose the target: count what's ahead and prefill the title (unless the person typed their own).
  async pickNow(b, cx) {
    if (this.fatal) return;
    this.target = b; this.ahead = null; cx.notify();
    try {
      const [c, src] = await Promise.all([this.git(["log", "--format=%s", `origin/${b}..HEAD`]), this.resolveSource(b)]);
      if (this.target !== b) return;
      this.source = src.name;
      this.commits = c.code === 0 ? c.stdout.split("\n").filter(Boolean) : [];
      this.ahead = this.commits.length;
      const cur = this.title.value(), next = this.commits.length === 1 ? this.commits[0] : humanize(this.source);
      if (!cur.trim() || cur === this.autoTitle) { this.title.set_value(next); this.autoTitle = next; }
    } catch (e) { this.error = `Could not compare with ${b}: ${e.message ?? e}`; cx.notify(); }
  }

  // Queues the job for the wb-prs panel copy and returns: the result is written into the draft even if this dialog is closed.
  generate(cx) {
    const k = this.dk();
    if (!k || this.isGenerating() || !this.target || this.fatal) return;
    this.error = null; this.aiMenu = false;
    this.save();
    patchShared(GEN, k, { id: `${Date.now()}`, state: "queued", repo: this.repo, branch: this.branch, target: this.target, title: this.title.value(), at: Date.now() });
    cx.notify();
  }

  create(cx) {
    const r = this.repo, title = this.title.value().trim();
    if (this.fatal || this.busy || !this.target || !title) { if (!title) { this.error = "Give it a title"; cx.notify(); } return; }
    this.error = null; this.busy = "Checking…"; cx.notify();
    const body = this.body.value();
    cx.spawn(async (cx) => {
      try {
        const src = await this.resolveSource(this.target), name = src.name;
        let needPush;
        if (src.upstream) {
          const n = await this.git(["rev-list", "--count", `origin/${name}..HEAD`]);
          needPush = n.code !== 0 || Number(n.stdout.trim()) > 0;
        } else {
          const ex = await this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
          if (ex.code !== 0) needPush = true;
          else { const n = await this.git(["rev-list", "--count", `origin/${name}..HEAD`]); needPush = n.code !== 0 || Number(n.stdout.trim()) > 0; }
        }
        if (needPush) {
          this.busy = "Pushing…"; cx.notify();
          const p = await this.git(src.upstream ? ["push", "origin", `HEAD:${name}`] : ["push", "-u", "origin", `HEAD:${name}`], LONG);
          if (p.code !== 0) throw new Error(`git push failed: ${(p.stderr || p.stdout).trim()}`);
        }
        this.busy = "Creating…"; cx.notify();
        const gl = r.host !== "github.com";
        if (gl) {
          const token = await this.deps.gitlabToken(r.host);
          if (!token) throw new Error(`No GitLab token for ${r.host}`);
          await this.deps.gitlab(r.host, token, `/projects/${encodeURIComponent(r.path)}/merge_requests`, "POST",
            { source_branch: name, target_branch: this.target, title: this.draft ? `Draft: ${title}` : title, description: body });
        } else {
          const args = ["pr", "create", "--base", this.target, "--head", name, "--title", title, "--body", body, ...(this.draft ? ["--draft"] : [])];
          const x = await exec("gh", args, { cwd: r.cwd, on: r.on, ...LONG });
          if (x.code !== 0) throw new Error((x.stderr || x.stdout).trim());
        }
        this.remember(this.target);
        notify({ title: gl ? "Merge request created" : "Pull request created", body: title, level: "success" });
        setShared("wb.prs.changed", { repo: r, ts: Date.now() });
        const k = this.dk();
        if (k) { patchShared(DRAFTS, k, null); if (liveJob(this.job())) patchShared(GEN, k, null); }
        closeOverlay(props()?.overlay);
        return;
      } catch (e) {
        this.error = e.status === 403 ? "GitLab refused: the token needs the api scope (read_api only lists). Create a new token with api." : String(e.message ?? e);
      }
      this.busy = ""; cx.notify();
    });
  }

  render(t) {
    const r = this.repo, gl = r.host !== "github.com", noun = gl ? "Merge request" : "Pull request";
    const btn = (id, label, act, primary = false, dim = false) => div().id(id).h(28).px(14).flex().items_center().rounded(6).border_1().text_size(12).cursor_pointer().when(dim, (s) => s.opacity(0.4))
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.background).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.9)).on_click(act).child(label);
    const label = (s) => div().text_size(10).font_semibold().text_color(t.dim).child(s);
    const field = (id, el, h = 28) => div().id(id).h(h).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background).cursor_text().child(el);
    const all = this.visible(), list = all.slice(0, 200), more = all.length - list.length;
    const off = this.fatal, generating = this.isGenerating();
    const aiOn = this.deps.installed("wb-ai");
    const mdl = modelFor("mr", r.key);
    const menu = !this.aiMenu ? null : v_flex().id("mr-ai-list").absolute().top(30).right(0).w(280).p(4).gap(1).rounded(8)
      .border_1().border_color(t.border).bg(t.popover).shadow_lg().on_mouse_down_out((_e, cx) => { this.aiMenu = false; this.aiClosedAt = Date.now(); cx.notify(); })
      .child(div().px(8).py(4).text_size(10).font_semibold().text_color(t.dim).child("DESCRIBE WITH"))
      .children(models().map((m) => h_flex().id(`mr-${m.id}`).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer()
        .when(mdl?.id === m.id, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { setUse("mr", m.id, r.key); this.aiMenu = false; cx.notify(); })
        .child(div().flex_1().truncate().text_size(12).child(m.name)).child(div().text_size(11).text_color(t.dim).child(describe(m)))))
      .when(aiOn, (e) => e.child(div().h(1).my(2).bg(t.border)))
      .when(aiOn, (e) => e.child(h_flex().id("mr-project").h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.aiMenu = false; openOverlay({ mod: "wb-ai", kind: "dialog", modal: true, width: 560, props: { use: "mr", project: r.key, projectName: r.name } }); cx.notify(); }).child("MR description settings…")))
      .when(aiOn, (e) => e.child(h_flex().id("mr-models").h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.aiMenu = false; openOverlay({ mod: "wb-ai", kind: "dialog", modal: true, width: 580 }); cx.notify(); }).child("AI models…")));
    return v_flex().id("mr-create").size_full().min_h(0).relative().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(16).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().child(`Create ${noun.toLowerCase()}`))
        .child(div().text_size(11).text_color(t.dim).child(r.name ?? ""))
        .child(div().id("mr-close").size(26).ml(8).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props()?.overlay)).child("✕")))
      .child(v_flex().id("mr-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(12)
        .child(v_flex().gap(4).child(label("FROM"))
          .child(h_flex().h(28).px(8).gap(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.raised)
            .child(div().flex_1().truncate().child(this.source && this.source !== this.branch ? `${this.branch} → origin/${this.source}` : (this.branch ?? "…")))
            .when(this.ahead != null, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${this.ahead} commit${this.ahead === 1 ? "" : "s"} ahead`)))))
        .child(v_flex().gap(4)
          .child(h_flex().gap(6).items_center().child(label("INTO")).when(this.fetching, (e) => e.child(div().text_size(10).text_color(t.dim).child("fetching origin…"))))
          .child(field("mr-search", Input.new(this.search).h_full().w_full().text_size(12).text_color(t.foreground)))
          .child(div().relative().h(132).rounded(6).border_1().border_color(t.border)
            .child(v_flex().id("mr-targets").absolute().inset_0().overflow_y_scroll().p(3).gap(1)
              .when(list.length === 0, (e) => e.child(div().p(6).text_size(12).text_color(t.dim).child(this.branches.length ? "No branch matches" : "No remote branches")))
              .children(list.flatMap((b, i) => {
                const rec = i < this.recentCount;
                const row = h_flex().id(`mr-t-${b}`).h(24).px(8).gap(6).flex_none().items_center().rounded(4).cursor_pointer().text_size(12)
                  .when(this.target === b, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.pick(b, cx))
                  .child(div().flex_1().truncate().child(b))
                  .when(rec, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("recent")));
                return rec && i === this.recentCount - 1 && list.length > this.recentCount ? [row, div().flex_none().h(1).mx(4).my(2).bg(t.border)] : [row];
              }))
              .when(more > 0, (e) => e.child(div().p(6).flex_none().text_size(11).text_color(t.dim).child(`… ${more} more, type to filter`))))
            .child(Scrollbar.vertical("mr-targets").absolute().inset_0())))
        .child(v_flex().gap(4).child(label("TITLE")).child(field("mr-title", Input.new(this.title).h_full().w_full().text_size(12).text_color(t.foreground))))
        .child(v_flex().gap(4)
          .child(h_flex().gap(8).items_center().child(label("DESCRIPTION")).child(div().flex_1())
            .child(div().relative().flex_none().child(h_flex().id("mr-gen").h(26).rounded(6).border_1().border_color(t.accent).overflow_hidden().when(off, (s) => s.opacity(0.4))
              .child(h_flex().id("mr-gen-run").h_full().px(10).gap(6).items_center().text_size(12).text_color(t.accent).cursor_pointer()
                .hover((s) => s.bg(t.hover)).tooltip(`Describe with ${mdl?.name ?? "no model"} (${describe(mdl)})`)
                .when(!off, (s) => s.on_click((_e, cx) => this.generate(cx)))
                .child(generating ? svg("mods/wb-prs/icons/spinner.svg").size(12).text_color(t.accent).spin(900) : div().child("✦"))
                .child(generating ? "Generating…" : "Generate"))
              .child(div().id("mr-gen-menu").w(22).h_full().flex().items_center().justify_center().border_l(1).border_color(t.border).text_color(t.muted)
                .cursor_pointer().hover((s) => s.bg(t.hover))
                .when(!off, (s) => s.on_click((_e, cx) => {
                  // The menu's outside-press handler already closed it on this same press: don't reopen.
                  if (this.aiMenu) this.aiMenu = false;
                  else if (Date.now() - this.aiClosedAt > 400) this.aiMenu = true;
                  this.aiClosedAt = 0; cx.notify();
                }))
                .child(svg("mods/wb-prs/icons/chevron-down.svg").size(11))))
              .when(Boolean(menu), (e) => e.child(menu))))
          .child(div().id("mr-desc").h(220).px(10).py(8).rounded(7).border_1().border_color(t.border).bg(t.background).cursor_text()
            .child(Textarea.new(this.body).w_full().h(204).text_size(12).text_color(t.foreground))))
        .child(h_flex().id("mr-draft").h(24).gap(6).items_center().cursor_pointer().on_click((_e, cx) => { this.draft = !this.draft; this.save(); cx.notify(); })
          .child(div().size(14).flex().items_center().justify_center().rounded(3).border_1().text_size(10).font_semibold()
            .border_color(this.draft ? t.accent : t.border).bg(this.draft ? t.accent : t.background).text_color(t.accent_foreground).child(this.draft ? "✓" : ""))
          .child(div().text_size(12).child("Draft")))
        .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error))))
      .child(h_flex().h(52).flex_none().px(16).gap(8).items_center().justify_end().border_t(1).border_color(t.border)
        .when(Boolean(this.busy), (e) => e.child(div().text_size(12).text_color(t.muted).child(this.busy)))
        .child(btn("mr-cancel", "Cancel", () => closeOverlay(props()?.overlay)))
        .child(btn("mr-submit", this.busy || "Create", off ? () => {} : (_e, cx) => this.create(cx), true, off)))
      ;
  }
}
