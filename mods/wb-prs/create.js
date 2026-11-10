// The "Create pull/merge request" dialog (PhpStorm-style): From (current branch) → Into (searchable
// remote branches), title, description with AI Generate, Draft, Create. Opened by main.js with props { create: { repo } }.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, notify, props, openOverlay, closeOverlay, setShared } from "herdr";
import { models, modelFor, settingsFor, setUse, languageLine, runModel, describe } from "./ai.js";

const humanize = (b) => b.replace(/^[^/]+\//, "").replace(/[-_]+/g, " ").trim() || b;

export class CreateDialog {
  // deps: { gitlab, gitlabToken, installed } from main.js
  constructor(repo, deps) { this.repo = repo; this.deps = deps; }

  git(args) { return exec("git", args, { cwd: this.repo.cwd, on: this.repo.on }); }

  init(cx) {
    this.branches = []; this.target = null; this.branch = null; this.ahead = null; this.commits = [];
    this.fetching = true; this.error = null; this.busy = ""; this.generating = false; this.aiMenu = false; this.draft = false;
    this.autoTitle = "";
    this.search = InputState.new({ placeholder: "Search branches…" });
    this.search.on("change", (_e, cx) => { this.filter = this.search.value(); cx.notify(); });
    this.search.on("submit", (_e, cx) => { const b = this.visible()[0]; if (b) this.pick(b, cx); });
    this.filter = "";
    this.title = InputState.new({ placeholder: "Title" });
    this.body = TextareaState.new({ placeholder: "Description", rows: 10 });
    cx.spawn(async (cx) => {
      try {
        const h = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
        this.branch = h.stdout.trim();
        if (h.code !== 0 || this.branch === "HEAD") throw new Error("No branch is checked out (detached HEAD)");
        await this.loadBranches(cx);
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
      // Refresh the remote in the background, then reload the list; the dialog is usable meanwhile.
      try { await this.git(["fetch", "--prune", "origin"]); await this.loadBranches(cx, true); } catch {}
      this.fetching = false; cx.notify();
    });
  }

  async loadBranches(cx, keep = false) {
    const r = await this.git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
    this.branches = r.stdout.split("\n").map((s) => s.trim().replace(/^origin\//, "")).filter((b) => b && b !== "HEAD" && b !== "origin" && b !== this.branch);
    if (keep && this.target && this.branches.includes(this.target)) { cx.notify(); return; }
    const d = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const def = d.code === 0 ? d.stdout.trim().replace(/^origin\//, "") : null;
    const t = [def, "main", "master", "develop"].find((b) => b && this.branches.includes(b)) ?? this.branches[0] ?? null;
    if (t) await this.pickNow(t, cx); else cx.notify();
  }

  visible() { const f = (this.filter ?? "").toLowerCase(); return this.branches.filter((b) => b.toLowerCase().includes(f)); }

  pick(b, cx) { cx.spawn(async (cx) => { await this.pickNow(b, cx); cx.notify(); }); }

  // Choose the target: count what's ahead and prefill the title (unless the person typed their own).
  async pickNow(b, cx) {
    this.target = b; this.ahead = null; cx.notify();
    const c = await this.git(["log", "--format=%s", `origin/${b}..HEAD`]);
    if (this.target !== b) return;
    this.commits = c.code === 0 ? c.stdout.split("\n").filter(Boolean) : [];
    this.ahead = this.commits.length;
    const cur = this.title.value(), next = this.commits.length === 1 ? this.commits[0] : humanize(this.branch);
    if (!cur.trim() || cur === this.autoTitle) { this.title.set_value(next); this.autoTitle = next; }
  }

  generate(cx) {
    if (this.generating || !this.target) return;
    const r = this.repo, cfg = settingsFor("mr", r.key), model = cfg.model;
    this.generating = true; this.error = null; this.aiMenu = false; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const base = `origin/${this.target}`;
        const log = await this.git(["log", "--format=%s%n%b", `${base}..HEAD`]);
        const diff = await this.git(["diff", `${base}...HEAD`]);
        if (diff.code !== 0) throw new Error((diff.stderr || diff.stdout).trim());
        const d = diff.stdout;
        const prompt = `${cfg.template} ${languageLine(cfg.language)}\n\nTitle: ${this.title.value()}\n\nCommits:\n${log.stdout.slice(0, 8000)}\n\nDiff (${this.target} ← ${this.branch}):\n${d.slice(0, 90000)}${d.length > 90000 ? "\n… (diff truncated)" : ""}`;
        const text = await runModel(model, prompt, { cwd: r.cwd, on: r.on });
        if (!text) throw new Error("the model returned nothing");
        this.body.set_value(text);
      } catch (e) { this.error = `Generating failed: ${e.message ?? e}`; }
      finally { this.generating = false; cx.notify(); }
    });
  }

  create(cx) {
    const r = this.repo, title = this.title.value().trim();
    if (this.busy || !this.target || !title) { if (!title) { this.error = "Give it a title"; cx.notify(); } return; }
    this.error = null; this.busy = "Checking…"; cx.notify();
    const body = this.body.value();
    cx.spawn(async (cx) => {
      try {
        const up = await this.git(["rev-parse", "--abbrev-ref", "@{u}"]);
        let needPush = up.code !== 0;
        if (!needPush) { const n = await this.git(["rev-list", "--count", "@{u}..HEAD"]); needPush = n.code !== 0 || Number(n.stdout.trim()) > 0; }
        if (needPush) {
          this.busy = "Pushing…"; cx.notify();
          const p = await this.git(["push", "-u", "origin", "HEAD"]);
          if (p.code !== 0) throw new Error(`git push failed: ${(p.stderr || p.stdout).trim()}`);
        }
        this.busy = "Creating…"; cx.notify();
        const gl = r.host !== "github.com";
        if (gl) {
          const token = await this.deps.gitlabToken(r.host);
          if (!token) throw new Error(`No GitLab token for ${r.host}`);
          await this.deps.gitlab(r.host, token, `/projects/${encodeURIComponent(r.path)}/merge_requests`, "POST",
            { source_branch: this.branch, target_branch: this.target, title: this.draft ? `Draft: ${title}` : title, description: body });
        } else {
          const args = ["pr", "create", "--base", this.target, "--head", this.branch, "--title", title, "--body", body, ...(this.draft ? ["--draft"] : [])];
          const x = await exec("gh", args, { cwd: r.cwd, on: r.on });
          if (x.code !== 0) throw new Error((x.stderr || x.stdout).trim());
        }
        notify({ title: gl ? "Merge request created" : "Pull request created", body: title, level: "success" });
        setShared("wb.prs.changed", { repo: r, ts: Date.now() });
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
    const btn = (id, label, act, primary = false) => div().id(id).h(28).px(14).flex().items_center().rounded(6).border_1().text_size(12).cursor_pointer()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.background).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.9)).on_click(act).child(label);
    const label = (s) => div().text_size(10).font_semibold().text_color(t.dim).child(s);
    const field = (id, el, h = 28) => div().id(id).h(h).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background).cursor_text().child(el);
    const list = this.visible();
    const aiOn = this.deps.installed("wb-ai");
    const mdl = modelFor("mr", r.key);
    const menu = !this.aiMenu ? null : v_flex().id("mr-ai-list").absolute().top(46).right(20).w(280).p(4).gap(1).rounded(8)
      .border_1().border_color(t.border).bg(t.popover).shadow_lg().on_mouse_down_out((_e, cx) => { this.aiMenu = false; cx.notify(); })
      .child(div().px(8).py(4).text_size(10).font_semibold().text_color(t.dim).child("DESCRIBE WITH"))
      .children(models().map((m) => h_flex().id(`mr-${m.id}`).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer()
        .when(mdl?.id === m.id, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { setUse("mr", m.id, r.key); this.aiMenu = false; cx.notify(); })
        .child(div().flex_1().truncate().text_size(12).child(m.name)).child(div().text_size(11).text_color(t.dim).child(describe(m)))))
      .when(aiOn, (e) => e.child(div().h(1).my(2).bg(t.border)))
      .when(aiOn, (e) => e.child(h_flex().id("mr-project").h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.aiMenu = false; openOverlay({ mod: "wb-ai", kind: "dialog", width: 560, props: { use: "mr", project: r.key, projectName: r.name } }); cx.notify(); }).child("MR description settings…")))
      .when(aiOn, (e) => e.child(h_flex().id("mr-models").h(26).px(8).items_center().rounded(5).cursor_pointer().text_size(12).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.aiMenu = false; openOverlay({ mod: "wb-ai", kind: "window", key: "wb-ai", width: 580 }); cx.notify(); }).child("AI models…")));
    return v_flex().id("mr-create").size_full().min_h(0).relative().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(16).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().child(`Create ${noun.toLowerCase()}`))
        .child(div().text_size(11).text_color(t.dim).child(r.name ?? ""))
        .child(div().id("mr-close").size(26).ml(8).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props()?.overlay)).child("✕")))
      .child(v_flex().id("mr-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(12)
        .child(v_flex().gap(4).child(label("FROM"))
          .child(h_flex().h(28).px(8).gap(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.raised)
            .child(div().flex_1().truncate().child(this.branch ?? "…"))
            .when(this.ahead != null, (e) => e.child(div().text_size(11).text_color(t.dim).child(`${this.ahead} commit${this.ahead === 1 ? "" : "s"} ahead`)))))
        .child(v_flex().gap(4)
          .child(h_flex().gap(6).items_center().child(label("INTO")).when(this.fetching, (e) => e.child(div().text_size(10).text_color(t.dim).child("fetching origin…"))))
          .child(field("mr-search", Input.new(this.search).h_full().w_full().text_size(12).text_color(t.foreground)))
          .child(div().relative().h(132).rounded(6).border_1().border_color(t.border)
            .child(v_flex().id("mr-targets").absolute().inset_0().overflow_y_scroll().p(3).gap(1)
              .when(list.length === 0, (e) => e.child(div().p(6).text_size(12).text_color(t.dim).child(this.branches.length ? "No branch matches" : "No remote branches")))
              .children(list.map((b) => div().id(`mr-t-${b}`).h(24).px(8).flex().flex_none().items_center().rounded(4).cursor_pointer().text_size(12)
                .when(this.target === b, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover)).truncate()
                .on_click((_e, cx) => this.pick(b, cx)).child(b))))
            .child(Scrollbar.vertical("mr-targets").absolute().inset_0())))
        .child(v_flex().gap(4).child(label("TITLE")).child(field("mr-title", Input.new(this.title).h_full().w_full().text_size(12).text_color(t.foreground))))
        .child(v_flex().gap(4)
          .child(h_flex().gap(8).items_center().child(label("DESCRIPTION")).child(div().flex_1())
            .child(h_flex().id("mr-gen").h(26).flex_none().rounded(6).border_1().border_color(t.accent).overflow_hidden()
              .child(h_flex().id("mr-gen-run").h_full().px(10).gap(6).items_center().text_size(12).text_color(t.accent).cursor_pointer()
                .hover((s) => s.bg(t.hover)).tooltip(`Describe with ${mdl?.name ?? "no model"} (${describe(mdl)})`)
                .on_click((_e, cx) => this.generate(cx))
                .child(this.generating ? svg("mods/wb-prs/icons/spinner.svg").size(12).text_color(t.accent).spin(900) : div().child("✦"))
                .child(this.generating ? "Generating…" : "Generate"))
              .child(div().id("mr-gen-menu").w(22).h_full().flex().items_center().justify_center().border_l(1).border_color(t.border).text_color(t.muted)
                .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.aiMenu = !this.aiMenu; cx.notify(); })
                .child(svg("mods/wb-prs/icons/chevron-down.svg").size(11)))))
          .child(div().id("mr-desc").h(220).px(10).py(8).rounded(7).border_1().border_color(t.border).bg(t.background).cursor_text()
            .child(Textarea.new(this.body).w_full().h(204).text_size(12).text_color(t.foreground))))
        .child(h_flex().id("mr-draft").h(24).gap(6).items_center().cursor_pointer().on_click((_e, cx) => { this.draft = !this.draft; cx.notify(); })
          .child(div().size(14).flex().items_center().justify_center().rounded(3).border_1().text_size(10).font_semibold()
            .border_color(this.draft ? t.accent : t.border).bg(this.draft ? t.accent : t.background).text_color(t.accent_foreground).child(this.draft ? "✓" : ""))
          .child(div().text_size(12).child("Draft")))
        .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error))))
      .child(h_flex().h(52).flex_none().px(16).gap(8).items_center().justify_end().border_t(1).border_color(t.border)
        .when(Boolean(this.busy), (e) => e.child(div().text_size(12).text_color(t.muted).child(this.busy)))
        .child(btn("mr-cancel", "Cancel", () => closeOverlay(props()?.overlay)))
        .child(btn("mr-submit", this.busy || "Create", (_e, cx) => this.create(cx), true)))
      .when(Boolean(menu), (e) => e.child(menu));
  }
}
