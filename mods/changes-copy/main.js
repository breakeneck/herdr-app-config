import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { highlight, languageFor } from "./highlight.js";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

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
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Which lines of the new file the diff added, and where lines were removed (before that new line).
function changeMarks(lines) {
  const added = new Set(), removed = new Map();
  let next = 0;
  for (const line of lines) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { next = +match[1]; continue; }
    const kind = line[0];
    if (kind === "+") added.add(next++);
    else if (kind === "-") removed.set(next, (removed.get(next) ?? 0) + 1);
    else if (kind === " ") next++;
  }
  return { added, removed };
}

// ponytail: one advance for every glyph (monospace, 11px code text at 0.6em); tabs and wide
// (CJK, emoji) characters put the selection off by their extra width. Measure text if that matters.
const CHAR_W = 11 * 0.6, ROW = 20, ITEM = 22, INDENT = 10; // ROW: code line, ITEM: changed-file list row, INDENT: per tree level
const ahead = (p, q) => p.row < q.row || (p.row === q.row && p.col <= q.col);

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line, raw: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " ", raw: line };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " ", raw: line };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " ", raw: line }; }
    return { kind: "", text: line, raw: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.mode = "diff"; this.sel = null; this.scrollY = { diff: 0, file: 0 }; this.view = "list"; this.scope = "head"; this.collapsed = new Set();
    try { if (localStorage.getItem("view") === "tree") this.view = "tree"; if (localStorage.getItem("scope") === "base") this.scope = "base"; } catch {}
    this.code = null; this.codeText = null; this.marks = { added: new Set(), removed: new Map() }; this.fileWidth = 0; this.codePath = null; this.codeError = null; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
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
      this.context = context; this.releaseCode(); this.collapsed = new Set(); this.root = null; this.files = []; this.open = null; this.scrollY = { diff: 0, file: 0 };
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    const scope = this.scope, stale = () => key() !== context || this.scope !== scope;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd, on });
        if (stale()) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
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
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
        if (this.mode === "file") await this.loadCode(this.open, context);
        else this.releaseCode();
      } catch (e) { if (!stale()) this.error = String(e); }
      finally { this.loading = false; if (this.scope !== scope) this.refresh(cx); cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.against ? [this.against] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  releaseCode() { this.code = null; this.codeText = null; this.codePath = null; this.codeError = null; }

  // Full file as lines of a virtual list, with the diff's added/removed lines marked.
  async loadCode(path, context) {
    if (!path) { this.releaseCode(); return; }
    const file = this.files.find((f) => f.path === path);
    if (!file || file.status === "D") { this.releaseCode(); this.codePath = path; this.codeError = "File is deleted · no full view"; return; }
    let text;
    try { text = await readTextFile(`${this.root}/${path}`, { on: this.on }); }
    catch { text = null; }
    if (key() !== context || this.open !== path || this.mode !== "file") return;
    if (text === null) { this.releaseCode(); this.codePath = path; this.codeError = "Cannot preview this file (unreadable or too large)"; return; }
    if (text.includes("\0")) { this.releaseCode(); this.codePath = path; this.codeError = "Binary file · no text preview"; return; }
    const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
    if (this.code && this.codePath === path && this.codeText === value) return;
    this.codeText = value;
    this.code = value.replace(/\n$/, "").split("\n");
    this.fileWidth = Math.max(300, ...this.code.map(line => Math.min(line.length, 600) * 7 + 80));
    this.codePath = path; this.codeError = null;
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
    this.files = []; this.open = null; this.closed = false; this.note = null; this.releaseCode(); this.setLines([]); this.scrollY = { diff: 0, file: 0 };
    this.refresh(cx); cx.notify();
  }

  // Icon toggle group: options are [value, icon in ./icons, tooltip]; `warn` paints that option red.
  segment(name, current, options, pick, t, warn = null) {
    return h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
      .children(options.map(([v, icon, tip]) => div().id(`${name}-${v}`).w(26).h(20).flex().items_center().justify_center().cursor_pointer().tooltip(tip)
        .text_color(v === warn ? t.ansi1 : current === v ? t.foreground : t.muted)
        .when(current === v, (e) => e.bg(t.selected)).when(current !== v, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => pick(v, cx)).child(svg(`mods/changes-copy/icons/${icon}.svg`).size(13))));
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

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "file") {
      const context = this.context;
      cx.spawn(async (cx) => { await this.loadCode(this.open, context); cx.notify(); });
    } else this.releaseCode();
    cx.notify();
  }

  // Text selection drawn by the rows themselves, so the view (and its scroll position) never changes.
  // A row's line as copied: diff lines without their +/-/space marker.
  lineText(i) {
    if (this.mode === "file") return this.code?.[i] ?? "";
    const r = this.rows[i];
    return !r ? "" : r.kind === "+" || r.kind === "-" || r.kind === " " ? r.raw.slice(1) : r.raw;
  }

  // The selection of what is shown now, ordered start → end; null when empty or made in another file/mode.
  selection() {
    const s = this.sel;
    if (!s || s.id !== `${this.mode}:${this.open}` || (s.a.row === s.b.row && s.a.col === s.b.col)) return null;
    return ahead(s.a, s.b) ? [s.a, s.b] : [s.b, s.a];
  }

  selectionText() {
    const [p, q] = this.selection(), out = [];
    for (let i = p.row; i <= q.row; i++) out.push(this.lineText(i).slice(i === p.row ? p.col : 0, i === q.row ? q.col : undefined));
    return out.join("\n");
  }

  // Where row i's text starts, in px from the row's left edge (see diffRow / fileRow).
  textX(i) { return this.mode === "file" ? 53 : this.rows[i]?.kind === "@" ? 12 : 40; }

  // Rows drawn from our own scroll offset, like the shipped picker: a virtual list takes no mouse
  // handlers in its rows and never says where it is scrolled, and selection needs both. Only the
  // rows on screen are built. Press, drag, shift-click; double-click a word, triple-click a line.
  codeView(name, count, width, row, t) {
    const z = settings().zoom || 1, H = this.viewH || 400, total = count * ROW, max = Math.max(0, total - H);
    const cur = () => Math.min(this.scrollY[name] ?? 0, max), off = cur();
    const first = Math.floor(off / ROW), last = Math.min(count, Math.ceil((off + H) / ROW));
    const thumb = max ? Math.max(24, H * H / total) : 0, thumbTop = max ? off / max * (H - thumb) : 0;
    const scroll = (to, cx) => { const v = Math.max(0, Math.min(max, to)); if (v !== cur()) { this.scrollY[name] = v; cx.notify(); } };
    const at = (e) => {
      const y = (e.local_position?.y ?? 0) / z, x = (e.local_position?.x ?? 0) / z;
      const i = Math.min(count - 1, Math.max(0, Math.floor((y + cur()) / ROW)));
      return { y, p: { row: i, col: Math.min(this.lineText(i).length, Math.max(0, Math.round((x - this.textX(i)) / CHAR_W))) } };
    };
    return div().id(`${name}-view`).size_full().relative()
      .on_size_change((s, cx) => { const h = s.height / z; if (h !== this.viewH) { this.viewH = h; cx.notify(); } })
      .on_hover((hovered) => { if (!hovered) { this.dragging = false; this.thumbDrag = null; } })
      .on_mouse_up("left", () => { this.dragging = false; this.thumbDrag = null; })
      .on_mouse_move((e, cx) => { if (this.thumbDrag) scroll(this.thumbDrag.off + (e.position.y - this.thumbDrag.y) / z * max / Math.max(1, H - thumb), cx); })
      .child(div().id(`${name}-x`).size_full().overflow_x_scrollbar()
        .child(div().id(`${name}-rows`).min_w(width).w_full().h_full().relative().overflow_hidden().cursor_text()
          .on_scroll_wheel((e, cx) => {
            // Vertical is ours; sideways goes on to the horizontal scroll area.
            if (Math.abs(e.delta.y) < Math.abs(e.delta.x)) return;
            scroll(cur() - e.delta.y / z, cx); cx.stop_propagation();
          })
          .on_mouse_down("left", (e, cx) => {
            if (!count) return;
            const { p } = at(e), id = `${this.mode}:${this.open}`, text = this.lineText(p.row);
            this.handle.focus(); this.dragging = false;
            if (e.click_count >= 3) this.sel = { id, a: { row: p.row, col: 0 }, b: { row: p.row, col: text.length } };
            else if (e.click_count === 2) {
              let a = p.col, b = p.col;
              while (a > 0 && /\w/.test(text[a - 1])) a--;
              while (b < text.length && /\w/.test(text[b])) b++;
              this.sel = { id, a: { row: p.row, col: a }, b: { row: p.row, col: b } };
            } else {
              this.sel = { id, a: e.modifiers.shift && this.sel?.id === id ? this.sel.a : p, b: p };
              this.dragging = true;
            }
            cx.notify();
          })
          .on_mouse_move((e, cx) => {
            if (!this.dragging || !this.sel || !count) return;
            const { y, p } = at(e);
            // ponytail: scrolls one row per pointer move near an edge; a timer would keep going while the pointer rests.
            if (y < ROW) scroll(cur() - ROW, cx); else if (y > H - ROW) scroll(cur() + ROW, cx);
            if (p.row !== this.sel.b.row || p.col !== this.sel.b.col) { this.sel.b = p; cx.notify(); }
          })
          .child(v_flex().absolute().left(0).right(0).top(first * ROW - off).children(Array.from({ length: Math.max(0, last - first) }, (_, k) => row(first + k, t))))))
      .when(thumb > 0, (e) => e.child(div().id(`${name}-thumb`).absolute().right(2).top(thumbTop).w(6).h(thumb).rounded(3).bg(t.border).hover((s) => s.bg(t.input))
        .on_mouse_down("left", (ev, cx) => { this.thumbDrag = { y: ev.position.y, off }; cx.stop_propagation(); })));
  }

  // [startCol, endCol) selected on row i; a selected line break shows as one extra cell.
  selRange(i) {
    const s = this.selection();
    if (!s || i < s[0].row || i > s[1].row) return null;
    const start = i === s[0].row ? s[0].col : 0, end = i === s[1].row ? s[1].col : this.lineText(i).length + 1;
    return end > start ? [start, end] : null;
  }

  setLines(lines) {
    this.lang = languageFor(this.open);
    this.rows = diffRows(lines);
    this.marks = changeMarks(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null; this.scrollY = { diff: 0, file: 0 };
    this.closed = !this.open;
    if (this.mode === "file") this.releaseCode();
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); if (this.mode === "file") await this.loadCode(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
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

  diffRow(i, t) {
    const { kind, number, text } = this.rows[i];
    if (kind === "@") return h_flex().w_full().px(12).h(ROW).flex_none().bg(t.raised).text_color(t.dim).child(this.codeCell(text, t, i, true));
    return h_flex().w_full().h(ROW).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(this.codeCell(text, t, i));
  }

  fileRow(i, t) {
    const n = i + 1, last = i === this.code.length - 1, { added, removed } = this.marks;
    const before = removed.has(n), after = last && [...removed.keys()].some((k) => k > this.code.length), isAdded = added.has(n);
    return h_flex().w_full().h(ROW).flex_none().gap(8)
      .when(isAdded, (e) => e.bg(t.ansi2 + "18"))
      .when(before, (e) => e.border_t(2).border_color(t.ansi1)).when(after, (e) => e.border_b(2).border_color(t.ansi1))
      .child(div().w(3).h_full().flex_none().when(isAdded, (e) => e.bg(t.ansi2)))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(String(n)))
      .child(this.codeCell(this.code[i] || " ", t, i));
  }

  // Colored spans for one source line, over its selection; headers and unknown file types stay plain.
  codeCell(text, t, i, plain = false) {
    const lang = plain ? null : this.lang, range = this.selRange(i);
    return h_flex().flex_1().min_w(0).h_full().items_center().relative().overflow_hidden().whitespace_nowrap()
      .when(Boolean(range), (e) => e.child(div().absolute().top(0).bottom(0).left(range[0] * CHAR_W).w((range[1] - range[0]) * CHAR_W).bg(t.selection)))
      .children(!lang || text.length > 600 ? [div().child(text)] : highlight(text, lang, t).map((p) => p.color ? div().text_color(p.color).child(p.text) : div().child(p.text)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const rows = this.listRows(), tree = this.view === "tree";
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const noBase = this.scope === "base" && Boolean(this.root) && !this.base && !this.loading;
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
        if (this.typing) return;
        if (e.keystroke === "cmd-c" && this.selection()) { cx.write_to_clipboard(this.selectionText()); cx.stop_propagation(); }
        else if (e.keystroke === "cmd-a" && this.open) {
          const last = (this.mode === "file" ? this.code?.length ?? 0 : this.rows.length) - 1;
          if (last >= 0) { this.sel = { id: `${this.mode}:${this.open}`, a: { row: 0, col: 0 }, b: { row: last, col: this.lineText(last).length } }; cx.stop_propagation(); cx.notify(); }
        } else if (e.key === "escape" && this.sel) { this.sel = null; cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1())
        .child(this.segment("scope", this.scope, [["head", "uncommitted", "Uncommitted changes"],
          ["base", "branch", this.base ? `Branch changes vs ${this.base} (incl. uncommitted)` : noBase ? "No base branch (origin/HEAD, main, master) · showing uncommitted" : "Branch changes vs base"]],
          (v, cx) => this.setScope(v, cx), t, noBase ? "base" : null))
        .child(this.segment("view", this.view, [["list", "list", "List"], ["tree", "tree", "Tree"]], (v, cx) => this.setView(v, cx), t))
        .child(this.segment("mode", this.mode, [["diff", "diff", "Diff"], ["file", "file", "Full file"]], (v, cx) => this.setMode(v, cx), t))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(rows.length * ITEM + 12).relative().border_b(1).border_color(t.border)
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
      // ponytail: a selection drag ends when the pointer leaves the code (moves arrive only while hovered).
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .when(this.mode === "file", (e) => e.child(this.code ? this.codeView("file", this.code.length, this.fileWidth, (i, t) => this.fileRow(i, t), t)
          : div().p(12).text_color(t.dim).child(this.open ? (this.codeError || "Loading file…") : "Select a file to view it")))
        .when(this.mode !== "file", (e) => e.child(this.codeView("diff", this.rows.length, this.diffWidth, (i, t) => this.diffRow(i, t), t)))
        .when(this.mode !== "file" && !this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
