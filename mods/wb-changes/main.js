import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { spaces, panes, exec, watchFolder, appHome, readTextFile, notify, theme, settings, run, shared, setShared, props, openOverlay, closeOverlay } from "herdr";
import * as S from "./section.js";
import { Log, remoteOf, installed, location, READ, getPrefs, setPrefs, getAuthor, setAuthor, nameColor, prHintFor } from "./log.js";
import { migrate, models, modelFor, settingsFor, setUse, projectKey, projectName, languageLine, NO_TRAILERS, runModel, describe } from "./ai.js";
const key = () => JSON.stringify(location());

// Commit message drafts survive switching windows, spaces and folders: shared "wb.commit.drafts" = { [repoId]: { text, at } },
// repoId = "<machine|local>:<git toplevel>". A running generation is shared "wb.commit.generating" = { [repoId]: startedAt },
// so every copy (and a return to that repo) shows it; its result always lands in that repo's draft.
const COMMIT_ACTION = "wb.commit.action"; // "commit" | "push": what the Commit button does
const commitAction = () => (shared(COMMIT_ACTION) === "push" ? "push" : "commit");
const DRAFTS = "wb.commit.drafts", GENERATING = "wb.commit.generating";
const BOOT = Date.now(); // module load: a flag started before it belongs to code that no longer runs (hot reload, restart)
const repoIdOf = (on, root) => `${on ?? "local"}:${root}`;
const running = (id) => { const at = id && (shared(GENERATING) ?? {})[id]; return Boolean(at) && at >= BOOT && Date.now() - at < 660000; };
const setGenerating = (id, on) => {
  const all = { ...(shared(GENERATING) ?? {}) };
  if (on) all[id] = Date.now(); else delete all[id];
  setShared(GENERATING, all);
};
const storeDraft = (id, text) => {
  const all = { ...(shared(DRAFTS) ?? {}) };
  if (!String(text ?? "").trim()) { if (!(id in all)) return; delete all[id]; }
  else if (all[id]?.text === text) return;
  else all[id] = { text, at: Date.now() };
  setShared(DRAFTS, all);
};

const ITEM = 22, INDENT = 10; // ITEM: changed-file list row, INDENT: per tree level
const COMMIT_MIN = 40, COMMIT_MAX = 420; // commit message box height, px
const LOG_MIN = 80, LOG_MAX = 700; // log body height, px
// Per-project generation settings (model, language, template) live in shared("wb.ai.project"), edited in the wb-ai window.
const openGenSettings = () => openOverlay({ mod: "wb-ai", kind: "window", key: "wb-ai", width: 580 });
const openCommitSettings = (project) => openOverlay({ mod: "wb-ai", kind: "dialog", width: 560, props: { use: "commit", project, projectName: projectName(project) } });

export default class Changes extends View {
  init(_props, cx) {
    // Popups (menus) are separate copies: they only draw, the panel copy does all the work.
    if (props()?.menu || props()?.commitMenu || props()?.viewMenu || props()?.authorMenu) return;
    S.migrateKeys(["sections.collapsed"]);
    migrate();
    this.files = []; this.collapsed = new Set(); this.unchecked = new Map(); this.prHint = null;
    // view/scope/log prefs live in shared state (the ⋯ popup is another copy); the old per-copy keys are migrated once.
    // v2: everyone starts on uncommitted changes (what the IDE's Commit window shows), even if an earlier build saved "base".
    if (!shared("wb.changes.prefs")?.v2) {
      const patch = { v2: true, scope: "head" };
      try { if (localStorage.getItem("view") === "tree") patch.view = "tree"; } catch {}
      setPrefs(patch);
    }
    this.scope = getPrefs().scope;
    this.log = new Log({ pushed: (root, on, cx) => this.showPrHint(root, on, cx) });
    this.log.init(cx);
    this.logH = Math.min(LOG_MAX, Math.max(LOG_MIN, Number(localStorage.getItem("logH")) || 240));
    this.message = ""; this.handle = cx.focus_handle(); this.repoId = null; this.lastSet = null; this.draftTimer = null; this.pending = new Map();
    this.input = TextareaState.new({ placeholder: "Commit message" });
    // The box height (px) is a splitter choice: drag the handle above it up to grow it, remembered per person.
    // The textarea is sized by this height, not by rows (a Textarea's layout height is its element's).
    this.commitH = Math.min(COMMIT_MAX, Math.max(COMMIT_MIN, Number(localStorage.getItem("commitH")) || 72));
    this.splitDrag = null; // { kind: "commit" | "log", y, h }
    this.input.set_rows(16);
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
      // Programmatic values (a loaded or generated draft) are already stored; an edit is saved shortly after the last key.
      if (this.message === this.lastSet) return;
      this.lastSet = null;
      this.draftTimer?.cancel?.();
      this.draftTimer = cx.timer.after(300, () => this.saveDraft());
    });
    this.input.on("submit", (e, cx) => { if (!e.modifiers?.shift) this.commit(cx); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; this.saveDraft(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // The textarea's text, set from code (not typed).
  setText(text) { this.lastSet = text; this.input.set_value(text); this.message = text; }
  saveDraft() {
    this.draftTimer?.cancel?.(); this.draftTimer = null;
    if (this.repoId) storeDraft(this.repoId, this.message);
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
      this.saveDraft(); this.repoId = null;
      this.context = context; this.collapsed = new Set(); this.root = null; this.files = []; this.open = null;
      this.pk = null; this.setText(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
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
          // The base is the candidate the branch is closest to (fewest commits ahead), like a PR's target:
          // the repo's recent MR targets first, then the usual names, then the newest remote branches.
          let recent = [];
          try {
            const o = await git(["remote", "get-url", "origin"]), rm = o.code === 0 ? remoteOf(o.stdout.trim()) : null;
            if (rm) recent = ((shared("wb.mr.recent") ?? {})[`${rm.host}|${rm.path}`] ?? []).map((b) => `origin/${b}`);
          } catch {}
          const [up, cur, newest] = await Promise.all([git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), git(["rev-parse", "--abbrev-ref", "HEAD"]),
            git(["for-each-ref", "--sort=-committerdate", "--count=10", "--format=%(refname:short)", "refs/remotes/origin"])]);
          const skip = new Set(["origin", "origin/HEAD", up.code === 0 ? up.stdout.trim() : "", `origin/${cur.stdout.trim()}`]);
          const cands = [...new Set([...recent, "origin/HEAD", "origin/main", "origin/master", "origin/develop", "origin/dev", "main", "master", ...newest.stdout.split("\n").map((l) => l.trim())])]
            .filter((c) => c && (c === "origin/HEAD" || !skip.has(c)));
          const scored = await Promise.all(cands.map(async (ref) => {
            const [name, n, b] = await Promise.all([git(["rev-parse", "--abbrev-ref", ref]), git(["rev-list", "--count", `${ref}..HEAD`]), git(["rev-list", "--count", `HEAD..${ref}`])]);
            return name.code === 0 && n.code === 0 ? { name: name.stdout.trim(), n: Number(n.stdout.trim()), behind: Number(b.stdout.trim()) || 0 } : null;
          }));
          // Ties: the one with fewer commits of its own (a sibling feature branch cut from the same base loses), then candidate order; origin/HEAD resolves to its target's name, so a duplicate of it ties and loses.
          let best = null;
          for (const c of scored) if (c && (!best || c.n < best.n || (c.n === best.n && c.behind < best.behind)) && c.name !== `origin/${cur.stdout.trim()}` && c.name !== (up.stdout.trim() || "\0")) best = c;
          if (best) {
            const mb = await git(["merge-base", "HEAD", best.name]);
            if (mb.code === 0) { base = best.name; against = mb.stdout.trim(); }
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
        if (base && shared("wb.changes.base") !== base) setShared("wb.changes.base", base);
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.against = against; this.base = base; this.files = files; this.limited = entries.length > 1000; this.error = null;
        const id = repoIdOf(on, root);
        if (this.repoId !== id) {
          this.repoId = id;
          // The repo's draft comes back; text typed before the repo was known (and no draft yet) is kept and stored.
          const saved = (shared(DRAFTS) ?? {})[id]?.text ?? "";
          if (saved || !this.message.trim()) this.setText(saved); else this.saveDraft();
          const failed = this.pending.get(id);
          if (failed) { this.note = failed; this.pending.delete(id); }
        }
        this.watch(root, gitDir, cx);
        // The project (repo) key for per-project AI settings; cached in ai.js after the first lookup.
        const pk = await projectKey({ cwd: root, on });
        if (stale()) return;
        this.pk = pk;
        const unc = this.unc(), have = new Set(files.map((f) => f.path));
        for (const p of unc) if (!have.has(p)) unc.delete(p);
        if (this.open && !files.some((f) => f.path === this.open)) this.open = null;
        // The first changed file is highlighted; its diff itself opens in the main area on click.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
      } catch (e) { if (!stale()) this.error = String(e); }
      finally { this.loading = false; if (this.scope !== scope) this.refresh(cx); cx.notify(); }
    });
  }


  // Commit selection: paths the person unchecked, per repo, in memory (so new files start checked).
  unc() { const k = this.repoId ?? ""; if (!this.unchecked.has(k)) this.unchecked.set(k, new Set()); return this.unchecked.get(k); }
  checkedFiles() { const u = this.unc(); return this.files.filter((f) => !u.has(f.path)); }
  setChecked(paths, on, cx) {
    const u = this.unc();
    for (const p of paths) if (on) u.delete(p); else u.add(p);
    cx.notify();
  }

  // The "Create pull request?" hint after a push that created the upstream.
  showPrHint(root, on, cx) {
    if (!installed("wb-prs")) return;
    cx.spawn(async (cx) => { try { const h = await prHintFor(root, on); if (h) { this.prHint = h; cx.notify(); } } catch {} });
  }

  // 13px rounded square: state 0 none, 1 all (✓), 2 some (–).
  checkbox(id, state, t, toggle) {
    return div().id(id).size(13).flex_none().rounded(3).border_1().flex().items_center().justify_center().cursor_pointer().text_size(9).font_semibold()
      .border_color(state ? t.accent : t.input).when(state > 0, (e) => e.bg(t.accent).text_color(t.accent_foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); toggle(cx); }).child(state === 1 ? "✓" : state === 2 ? "–" : "");
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
    const under = this.files.filter((f) => f.path.startsWith(r.path + "/")), u = this.unc();
    const n = under.filter((f) => !u.has(f.path)).length, state = n === 0 ? 0 : n === under.length ? 1 : 2;
    return h_flex().id(`dir-${r.path}`).h(ITEM).flex_none().pl(8 + r.depth * INDENT).pr(8).gap(6).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleDir(r.path, cx))
      .child(div().w(12).text_size(10).text_color(t.muted).child(r.open ? "▾" : "▸"))
      .child(this.checkbox(`dcb-${r.path}`, state, t, (cx) => this.setChecked(under.map((f) => f.path), state !== 1, cx)))
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
  async openMain(path) {
    if (!this.root) return;
    if (!installed("wb-diff") && !(await installed("wb-diff", true))) { notify({ title: "Install wb-diff to see diffs", body: path, level: "info" }); return; }
    const file = this.files.find((f) => f.path === path);
    const space = spaces().find((s) => s.active);
    // `space`: each space's diff tab takes only its own space's requests.
    const req = { space: space?.id ?? null, root: this.root, on: this.on ?? null, path, against: this.against ?? null, status: file?.status ?? "M", fresh: Boolean(file?.fresh), ts: Date.now() };
    const ids = new Set((space?.tabs ?? []).map((t) => t.id));
    const existing = panes().find((p) => p.mod === "wb-diff" && ids.has(p.tab));
    setShared("wb.diff.request", req);
    // The tab is named after the file it shows.
    if (existing) { run("tab.select", { id: existing.tab }); run("tab.rename", { id: existing.tab, name: path.split("/").pop() }); }
    else run("tab.new", { name: path.split("/").pop(), mod: "wb-diff", props: req, space: space?.id ?? undefined });
  }

  // Ask the configured model for a commit message from the current diff, and drop it into the textarea.
  // Claude rides the person's subscription and starts inside the repo folder; local goes to the endpoint.
  generate(cx) {
    if (!this.root || running(this.repoId) || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, id = this.repoId, hasHead = this.hasHead, against = this.against;
    // Only the checked files are described; all checked: the whole tree.
    const picked = this.checkedFiles(), only = picked.length < this.files.length ? ["--", ...picked.map((f) => f.path)] : [];
    this.note = null;
    setGenerating(id, true);
    cx.spawn(async (cx) => {
      try {
        const cfg = settingsFor("commit", await projectKey({ cwd: root, on })), model = cfg.model;
        const git = (args) => exec("git", ["--literal-pathspecs", ...READ, ...args], { cwd: root, on });
        const [st, df] = await Promise.all([
          git(["status", "--short", ...only]),
          git(["diff", ...(hasHead ? [against ?? "HEAD"] : []), "--no-color", ...only]),
        ]);
        const fresh = (st.stdout || "").split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3)).slice(0, 20);
        let text = `Git status:\n${st.stdout}\n\nDiff:\n${(df.stdout || "").slice(0, 60000)}`;
        if (fresh.length) text += `\n\nNew untracked files (contents not shown): ${fresh.join(", ")}`;
        // The project's template (wb-ai settings) says how the message looks; blank lines are dropped unless allowed.
        const prompt = `Write one git commit message for these changes in this repository. Format: ${cfg.template}${cfg.noBlank !== false ? " No blank lines anywhere." : ""} Reply with the message only — no quotes, no code fences, no explanations. ${NO_TRAILERS} ${languageLine(cfg.language)}`;
        let msg = await runModel(model, `${prompt}\n\n${text}`, { cwd: root, on });
        if (cfg.noBlank !== false) msg = msg.split("\n").filter((l) => l.trim()).join("\n");
        if (!msg) throw new Error("the model returned nothing");
        // Always kept in that repo's draft; also in the box when that repo is the one shown now.
        storeDraft(id, msg);
        if (this.repoId === id) this.setText(msg);
        else notify({ title: "Commit message ready", body: id.replace(/^[^:]*:/, "").split("/").pop(), level: "success" });
      } catch (e) {
        const failed = `Generate failed: ${e}`;
        if (this.repoId === id) this.note = failed;
        else { this.pending.set(id, failed); notify({ title: "Commit message failed", body: String(e.message ?? e), level: "error" }); }
      }
      finally { setGenerating(id, false); cx.notify(); }
    });
  }

  // The thin dropdown beside the Generate button.
  menuView() {
    const t = theme();
    const item = (id, label, action) => h_flex().id(id).h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .text_size(12.5).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { closeOverlay(props()?.overlay); action(); })
      .child(svg("mods/wb-changes/icons/settings.svg").size(13).text_color(t.muted)).child(label);
    // Same shape as AI review's ▾ in wb-prs: the model that writes commit messages, then settings.
    const pk = props()?.project, cur = modelFor("commit", pk);
    return v_flex().p(6).gap(1).w_full().bg(t.raised).text_color(t.foreground)
      .when(installed("wb-ai"), (e) => e
        .child(div().px(8).py(4).text_size(10).font_semibold().text_color(t.dim).child("COMMIT WITH"))
        .children(models().map((m) => h_flex().id(`cm-${m.id}`).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer()
          .when(m.id === cur?.id, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => { setUse("commit", m.id, pk); closeOverlay(props()?.overlay); })
          .child(div().flex_1().truncate().text_size(12).child(m.name)).child(div().text_size(11).text_color(t.dim).child(describe(m)))))
        .child(div().h(1).my(2).bg(t.border))
        .when(Boolean(pk), (e) => e.child(item("gen-project", "Commit message settings…", () => openCommitSettings(pk))))
        .child(item("gen-settings", "AI models…", openGenSettings)))
      .when(!installed("wb-ai"), (e) => e.child(div().px(10).py(6).text_size(12).text_color(t.dim).child("Install wb-ai to pick models; using the default Claude CLI.")));
  }

  // The ▾ beside Commit: Commit or Commit and Push, the current one checked.
  commitMenuView() {
    const t = theme(), cur = commitAction();
    return v_flex().p(6).gap(1).w_full().bg(t.raised).text_color(t.foreground)
      .children([["commit", "Commit"], ["push", "Commit and Push"]].map(([id, label]) => h_flex().id(`ca-${id}`).h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer()
        .text_size(12.5).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => { setShared(COMMIT_ACTION, id); closeOverlay(props()?.overlay); })
        .child(div().w(14).text_size(12).text_color(t.accent).child(id === cur ? "✓" : "")).child(label)));
  }

  commit(cx) {
    if (!this.message.trim() || !this.checkedFiles().length || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim(), id = this.repoId, push = commitAction() === "push";
    // Everything checked: stage all. Otherwise stage and commit just the checked paths (literal, not globs).
    const picked = this.checkedFiles().map((f) => f.path), partial = picked.length < this.files.length;
    this.busy = true; this.note = null; this.phase = "Committing…";
    cx.spawn(async (cx) => {
      try {
        const cmds = partial ? [["--literal-pathspecs", "add", "-A", "--", ...picked], ["--literal-pathspecs", "commit", "-m", message, "--", ...picked]] : [["add", "-A"], ["commit", "-m", message]];
        for (const args of cmds) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        storeDraft(id, "");
        if (key() === context) this.setText("");
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; this.busy = false; this.refresh(cx); cx.notify(); return; }
      if (push) {
        try {
          this.phase = "Pushing…"; cx.notify();
          const up = await exec("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: root, on });
          const r = await exec("git", up.code === 0 ? ["push"] : ["push", "-u", "origin", "HEAD"], { cwd: root, on, timeout: 600000 });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
          if (up.code !== 0) this.showPrHint(root, on, cx);
        } catch (e) { if (key() === context) this.note = `Committed, but push failed: ${e}`; }
      }
      this.busy = false; this.refresh(cx); cx.notify();
    });
    cx.notify();
  }

  endSplit() {
    if (!this.splitDrag) return;
    const kind = this.splitDrag.kind;
    this.splitDrag = null;
    try { localStorage.setItem(kind === "log" ? "logH" : "commitH", String(kind === "log" ? this.logH : this.commitH)); } catch {}
  }

  // The ⋯ dropdown: every display pref, checkmarked (shared prefs; the panel copy reacts).
  viewMenuView() {
    const t = theme(), p = getPrefs();
    const item = (id, label, on, pick) => h_flex().id(id).h(28).px(10).gap(8).items_center().rounded(6).cursor_pointer().text_size(12.5).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { pick(); closeOverlay(props()?.overlay); })
      .child(div().w(14).text_size(12).text_color(t.accent).child(on ? "✓" : "")).child(label);
    const line = () => div().h(1).my(3).bg(t.border);
    return v_flex().p(6).gap(1).w_full().bg(t.raised).text_color(t.foreground)
      .child(item("vm-head", "Uncommitted changes", p.scope === "head", () => setPrefs({ scope: "head" })))
      .child(item("vm-base", (shared("wb.changes.base") ? `Branch changes vs ${shared("wb.changes.base").replace(/^origin\//, "")}` : "Branch changes vs base"), p.scope === "base", () => setPrefs({ scope: "base" })))
      .child(line())
      .child(item("vm-list", "List", p.view === "list", () => setPrefs({ view: "list" })))
      .child(item("vm-tree", "Tree", p.view === "tree", () => setPrefs({ view: "tree" })))
      .child(line())
      .child(item("vm-branch", "Log: this branch", !p.logAll, () => setPrefs({ logAll: false })))
      .child(item("vm-all", "Log: all branches", p.logAll, () => setPrefs({ logAll: true })))
      .child(line())
      .child(item("vm-log", "Show log", p.logOpen, () => setPrefs({ logOpen: !p.logOpen })));
  }

  // The author filter's list: All, me, then the log's authors by commit count.
  authorMenuView() {
    const t = theme(), cur = getAuthor(), { authors = [], me = "" } = props() ?? {};
    const item = (id, label, name, hint) => h_flex().id(id).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer().flex_none().text_size(12).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { setAuthor(name); closeOverlay(props()?.overlay); })
      .child(div().w(12).text_size(12).text_color(t.accent).child(cur === name ? "✓" : "")).child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(hint), (e) => e.child(div().text_size(10.5).text_color(t.dim).child(hint)));
    return v_flex().id("author-menu").p(6).gap(1).w_full().h_full().overflow_y_scroll().bg(t.raised).text_color(t.foreground)
      .child(item("au-all", "All authors", null))
      .when(Boolean(me), (e) => e.child(item("au-me", "Me", me, me)))
      .children(authors.map((a, i) => item(`au-${i}`, a, a)));
  }

  render(cx) {
    if (props()?.menu) return this.menuView();
    if (props()?.commitMenu) return this.commitMenuView();
    if (props()?.viewMenu) return this.viewMenuView();
    if (props()?.authorMenu) return this.authorMenuView();
    if (key() !== this.context) this.refresh(cx);
    // Prefs changed in the ⋯ popup: a new scope reloads the list (the log follows its own pref in log.sync).
    const pr = getPrefs();
    this.view = pr.view;
    if (pr.scope !== this.scope) { this.scope = pr.scope; this.files = []; this.open = null; this.closed = false; this.note = null; this.refresh(cx); }
    this.log.sync(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const rows = this.listRows(), tree = this.view === "tree", unc = this.unc();
    const nChecked = this.files.filter((f) => !unc.has(f.path)).length, total = this.files.length, allState = nChecked === 0 ? 0 : nChecked === total ? 1 : 2;
    const enabled = Boolean(this.message.trim() && nChecked && this.root && !this.busy && !this.loading);
    const generating = running(this.repoId);
    const genEnabled = Boolean(this.root && !generating && !this.busy && !this.loading && this.context === key());
    const noBase = this.scope === "base" && Boolean(this.root) && !this.base && !this.loading;
    const sec = S.sectionOf("wb-changes"), ov = S.overlay(sec);
    const lr = this.log.current(), fetching = this.log.busy === "Fetch";
    // The hint goes away when the repo or branch it was for is no longer the one shown.
    if (this.prHint && (this.prHint.id !== this.repoId || (lr?.branch && lr.branch !== this.prHint.branch))) this.prHint = null;
    const hint = this.prHint;
    const hbtn = (id, label, tip, icon, act, extra = null) => h_flex().id(id).h(22).px(7).gap(4).flex_none().items_center().rounded(6).cursor_pointer().border_1().border_color(t.border)
      .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); act(cx); })
      .child(icon).child(label).when(Boolean(extra), (e) => e.child(extra));
    const popup = (mod, width) => () => openOverlay({ mod, kind: "popup", width, height: 620, props: { popup: true } });
    return v_flex().id("changes").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
      })
      // The splitters (commit box, log): the handle grabs, the panel tracks the drag even outside it.
      .on_mouse_move((e, cx) => {
        const d = this.splitDrag;
        if (!d) return;
        const z = settings().zoom || 1, log = d.kind === "log", lo = log ? LOG_MIN : COMMIT_MIN, hi = log ? LOG_MAX : COMMIT_MAX;
        // The handle sits above what it sizes: dragging up grows it.
        const h = Math.round(Math.max(lo, Math.min(hi, d.h - (e.position.y - d.y) / z)));
        if (h !== (log ? this.logH : this.commitH)) { if (log) this.logH = h; else this.commitH = h; cx.notify(); }
      })
      .on_mouse_up("left", () => this.endSplit())
      .on_hover((hovered) => { if (!hovered) this.endSplit(); })
      .child(S.header(h_flex().h(42).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border), sec, 44)
        .child(S.mark(sec))
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).flex_none().child(nChecked < total ? `${nChecked} of ${total} files` : `${total} files`))
        .when(installed("wb-tasks"), (e) => e.child(hbtn("open-tasks", "Tasks", "Tasks", svg("mods/wb-changes/icons/jira.svg").size(12), popup("wb-tasks", 440))))
        .when(installed("wb-prs"), (e) => e.child(hbtn("open-prs", "PR", "Pull requests", svg("mods/wb-changes/icons/pr.svg").size(12), popup("wb-prs", 460))))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(hbtn("fetch", "", "git fetch --prune: see what's new upstream", fetching ? svg("mods/wb-changes/icons/spinner.svg").size(12).spin(900) : svg("mods/wb-changes/icons/refresh.svg").size(12),
          (cx) => { if (this.log.cur) this.log.fetch(this.log.cur, cx); }, lr?.behind ? div().text_color(t.accent).child(`↓${lr.behind}`) : null))
        .child(div().id("view-menu").size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip(noBase ? "No base branch (origin/HEAD, main, master) · showing uncommitted" : "View options")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => openOverlay({ mod: "wb-changes", kind: "popup", width: 220, height: 250, props: { viewMenu: true } })).child("⋯")))
      .when(total > 0, (e) => e.child(h_flex().h(26).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.checkbox("cb-all", allState, t, (cx) => this.setChecked(this.files.map((f) => f.path), allState !== 1, cx)))
        .child(div().text_size(11).text_color(t.dim).child(this.base && this.scope === "base" ? `Changes vs ${this.base}` : "Select all"))))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(rows.map((r) => {
        if (r.dir) return this.dirRow(r, t);
        const f = r.file, parts = tree ? [] : f.path.split("/"), name = tree ? r.name : parts.pop();
        const kind = f.status === "U" ? "X" : f.fresh ? "U" : f.status;
        return h_flex().id(`change-${f.path}`).h(ITEM).flex_none().px(8).pl(tree ? 8 + r.depth * INDENT + 18 : 8).gap(6).items_center().rounded(5).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(this.checkbox(`cb-${f.path}`, unc.has(f.path) ? 0 : 1, t, (cx) => this.setChecked([f.path], unc.has(f.path), cx)))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().text_color(nameColor(kind)).when(kind === "D", (s) => s.line_through()).child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (this.base ? `No changes since ${this.base}` : "No uncommitted changes") : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      // Explicit height: the layout under-measures the Textarea inside, which pushed the buttons off the bottom.
      // 10+10 padding, 8 handle, 8+8 gaps, 30 buttons, 1 border (+ 26 and a gap for the PR hint).
      .child(v_flex().flex_none().h(this.commitH + 75 + (hint ? 34 : 0)).overflow_hidden().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-split").h(12).flex_none().ml(-10).mr(-10).mt(-4).flex().items_center().justify_center().cursor_row_resize().tooltip("Drag to resize the message box").hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (e, cx) => { this.splitDrag = { kind: "commit", y: e.position.y, h: this.commitH }; cx.stop_propagation(); })
          .child(div().w(36).h(4).rounded(2).bg(t.border)))
        .child(div().id("commit-message").w_full().h(this.commitH).flex_none().overflow_hidden().px(10).py(6).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.input).w_full().h(this.commitH - 14).text_size(12).text_color(t.foreground)))
        .when(Boolean(hint), (e) => e.child(h_flex().h(26).flex_none().rounded(8).border_1().border_color(t.accent).bg(t.selected).items_center().overflow_hidden()
          .child(h_flex().id("pr-hint").flex_1().min_w(0).h_full().px(10).items_center().cursor_pointer().text_size(11.5).text_color(t.accent).hover((s) => s.bg(t.hover)).tooltip("Open the pull request dialog")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              const h = this.prHint; if (!h) return;
              this.prHint = null; cx.notify();
              openOverlay({ mod: "wb-prs", kind: "dialog", modal: true, width: 620, height: 0.85, props: { create: { repo: h.repo } } });
            }).child(div().truncate().child(`Pushed ${hint?.branch} · Create pull request?`)))
          .child(div().id("pr-hint-x").w(26).h_full().flex().items_center().justify_center().cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Dismiss")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { this.prHint = null; cx.notify(); }).child("✕"))))
        .child(h_flex().gap(8).items_center()
          .child(h_flex().id("generate").h(30).flex_none().rounded(8).overflow_hidden().border_1().border_color(genEnabled ? t.accent : t.border)
            .child(h_flex().id("generate-run").px(12).h_full().items_center().gap(6).text_size(12).text_color(generating ? t.accent : genEnabled ? t.accent : t.dim).when(genEnabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.generate(cx)).tooltip(`Write the commit message from the ${nChecked < total ? "checked files' " : ""}diff with ${modelFor("commit", this.pk)?.name ?? "no model"} (${describe(modelFor("commit", this.pk))})`)
              .child(generating ? svg("mods/wb-changes/icons/spinner.svg").size(12).text_color(t.accent).spin(900) : svg("mods/wb-changes/icons/layers.svg").size(12))
              .child(generating ? "Generating…" : "Generate"))
            .child(div().id("generate-menu").w(26).h_full().flex().items_center().justify_center().border_l(1).border_color(t.border).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("More").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => openOverlay({ mod: "wb-changes", kind: "popup", width: 300, height: 26 * Math.max(1, models().length) + 130, props: { menu: true, project: this.pk } })).child(svg("mods/wb-changes/icons/chevron-down.svg").size(12))))
          .child(div().flex_1())
          .child(h_flex().id("commit").h(30).flex_none().rounded(8).overflow_hidden().bg(enabled ? t.solid : t.raised)
            .child(h_flex().id("commit-run").px(14).h_full().items_center().text_size(12).text_color(enabled ? t.solid_foreground : t.dim).when(enabled, (e) => e.cursor_pointer()).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.commit(cx))
              .tooltip((commitAction() === "push" ? "Commit the checked files with this message, then push (sets origin upstream if the branch has none)" : "Commit the checked files with this message") + (nChecked ? "" : " · nothing checked"))
              .child(this.busy ? (this.phase ?? "Committing…") : commitAction() === "push" ? "Commit and Push" : "Commit"))
            .child(div().id("commit-menu").w(26).h_full().flex().items_center().justify_center().border_l(1).border_color(t.border).text_color(enabled ? t.solid_foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Commit or Commit and Push").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => openOverlay({ mod: "wb-changes", kind: "popup", width: 190, height: 74, props: { commitMenu: true } })).child(svg("mods/wb-changes/icons/chevron-down.svg").size(12))))))
      .child(this.log.view(t, { open: pr.logOpen, h: this.logH, startDrag: (e) => { this.splitDrag = { kind: "log", y: e.position.y, h: this.logH }; }, toggle: () => setPrefs({ logOpen: !pr.logOpen }) }))
      .when(Boolean(ov), (e) => e.child(ov));
  }
}
