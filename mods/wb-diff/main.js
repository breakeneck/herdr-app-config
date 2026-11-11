// PhpStorm-style side-by-side diff, opened as a tab in the main area when a changed
// file is clicked in the Changes panel. The panel sends { root, on, path, against,
// fresh } through props (first open) and shared("wb.diff.request") (later files), so one
// diff tab serves the space and just swaps its file. Prev/next jump between hunks.
// Both sides share one vertical scroll; each side scrolls sideways on its own.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { highlight, languageFor } from "./highlight.js";
import { props, shared, spaces, panes, theme, settings, exec, readTextFile, run } from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const ROW = 20, CHAR_W = 11 * 0.6;

// Aligned rows from a unified diff: each row has left/right sides (null: that side is blank).
// A run of removals pairs with the run of additions line by line, like PhpStorm does.
function sideBySide(lines) {
  const rows = [], hunks = [];
  let i = 0, old = 0, next = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) {
      hunks.push(rows.length);
      old = +m[1]; next = +m[2];
      rows.push({ kind: "@", text: line });
      i++;
      continue;
    }
    if (line[0] === " ") {
      rows.push({ kind: " ", left: { num: old++, text: line.slice(1) }, right: { num: next++, text: line.slice(1) } });
      i++;
      continue;
    }
    if (line[0] === "-" || line[0] === "+") {
      const dels = [], adds = [];
      while (i < lines.length && lines[i][0] === "-") { dels.push({ num: old++, text: lines[i].slice(1) }); i++; }
      while (i < lines.length && lines[i][0] === "+") { adds.push({ num: next++, text: lines[i].slice(1) }); i++; }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) rows.push({ kind: "x", left: dels[k] ?? null, right: adds[k] ?? null });
      continue;
    }
    i++; // "\ No newline at end of file" and other noise
  }
  return { rows, hunks };
}

export default class DiffView extends View {
  init(_props, cx) {
    this.req = props()?.path ? props() : shared("wb.diff.request") ?? null;
    // "file" (default): the whole file, changes highlighted, prev/next scroll to them; "diff": hunks only.
    this.mode = (() => { try { return localStorage.getItem("mode") || "file"; } catch { return "file"; } })();
    this.runs = []; // file mode: [from, to) row ranges of each change, matching this.hunks
    this.rows = []; this.hunks = []; this.cur = -1; this.scrollY = 0; this.viewH = 400;
    this.leftW = 300; this.rightW = 300; this.error = null; this.loading = false;
    this.applied = this.req?.ts ?? 0; this.lang = null; this.thumbDrag = null;
    this.handle = cx.focus_handle();
    // A copy starts the first time it shows, so the active space/tab now are its own.
    const sp = spaces().find((s) => s.active);
    this.space = props()?.space ?? sp?.id ?? null;
    this.tab = sp?.tabs.find((t) => t.active)?.id ?? null;
    if (this.req) this.load(this.req, cx);
  }

  load(req, cx) {
    this.loading = true; this.error = null; this.rows = []; this.hunks = []; this.runs = []; this.cur = -1; this.scrollY = 0;
    cx.spawn(async (cx) => {
      try {
        // `commit`: that commit's own change to the file (from the Git panel), not the working tree's.
        const { root, on, path, against, fresh, commit } = req;
        let lines;
        if (fresh && !commit) {
          const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
          if (text === null) throw new Error("cannot read this file (binary, too large, or unreadable)");
          lines = text.replace(/\n$/, "").split("\n").slice(0, 20000).map((l) => "+" + l);
        } else {
          // Full-file mode: huge context so git emits the whole file, aligned, with changes tinted.
          const r = await exec("git", [...READ, "diff", ...(commit ? [`${commit}^!`] : against ? [against] : []), "--no-ext-diff", "--no-color", this.mode === "file" ? "-U1000000" : "-U3", "--", path], { cwd: root, on });
          if (r.code !== 0) throw new Error(r.stderr.trim() || "git diff failed");
          const all = r.stdout.replace(/\n$/, "").split("\n");
          const at = all.findIndex((l) => l.startsWith("@@"));
          if (at < 0) throw new Error("no text diff available (binary file?)");
          lines = all.slice(at).slice(0, 20000);
        }
        const { rows, hunks } = sideBySide(lines);
        if (this.mode === "file") {
          // One @@ header for the whole file: jump between the change runs themselves instead.
          hunks.length = 0;
          for (let k = 0; k < rows.length; k++) {
            if (rows[k].kind !== "x" || rows[k - 1]?.kind === "x") continue;
            let e = k; while (rows[e]?.kind === "x") e++;
            hunks.push(k); this.runs.push([k, e]);
          }
        }
        const cell = (r, s) => r[s]?.text.length ?? 0;
        this.lang = languageFor(path);
        this.rows = rows; this.hunks = hunks;
        this.leftW = Math.min(2400, Math.max(20, ...rows.map((r) => (r.kind === "@" ? 0 : cell(r, "left")))) * CHAR_W + 60);
        this.rightW = Math.min(2400, Math.max(20, ...rows.map((r) => (r.kind === "@" ? 0 : cell(r, "right")))) * CHAR_W + 60);
        this.loading = false;
        // Whole file: start at the first change, like a cursor placed on it.
        if (this.mode === "file" && hunks.length) this.goto(0);
      } catch (e) { this.error = String(e); this.loading = false; }
      cx.notify();
    });
  }

  // Next / previous hunk, wrapping around; the current one is painted highlighted.
  jump(dir, cx) {
    const n = this.hunks.length;
    if (!n) return;
    let idx;
    if (this.cur >= 0 && this.scrollY === this.jumpedY) idx = (this.cur + dir + n) % n; // still where the last jump left it
    else {
      // Scrolled by hand since: the next/previous change from what's on screen now.
      const top = this.scrollY / ROW + (this.mode === "file" ? (this.viewH || 400) / 3 / ROW : 0);
      if (dir > 0) { idx = this.hunks.findIndex((h) => h > top + 1); if (idx < 0) idx = 0; }
      else { idx = -1; this.hunks.forEach((h, k) => { if (h < top - 1) idx = k; }); if (idx < 0) idx = n - 1; }
    }
    this.goto(idx);
    cx.notify();
  }

  // Scroll so change `idx` is in view: in file mode a third down the view, with context above.
  goto(idx) {
    this.cur = idx;
    const at = this.hunks[idx];
    const lead = this.mode === "file" ? Math.floor((this.viewH || 400) / 3 / ROW) : 0;
    const max = Math.max(0, this.rows.length * ROW - (this.viewH || 400));
    this.scrollY = Math.max(0, Math.min(max, (at - lead) * ROW - (this.mode === "file" ? 0 : 8)));
    this.jumpedY = this.scrollY;
  }

  // The tab holding this diff, looked up when needed: the id kept at start can be gone or wrong.
  ownTab() {
    const mine = panes().filter((p) => p.mod === "wb-diff");
    if (mine.some((p) => p.tab === this.tab)) return this.tab;
    const inSpace = new Set(spaces().find((s) => s.id === this.space)?.tabs.map((t) => t.id) ?? []);
    return mine.find((p) => p.focused)?.tab ?? mine.find((p) => inSpace.has(p.tab))?.tab ?? null;
  }

  // One source line as colored spans (same rule as the Changes panel: plain when long or unknown).
  cell(text, t) {
    return h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden().whitespace_nowrap()
      .children(!this.lang || text.length > 600 ? [div().child(text)] : highlight(text, this.lang, t).map((p) => (p.color ? div().text_color(p.color).child(p.text) : div().child(p.text))));
  }

  // One row of one side: hunk header, or a line with its gutter number and change tint.
  row(i, t, name, width) {
    const r = this.rows[i];
    if (r.kind === "@") {
      const now = this.cur >= 0 && i === this.hunks[this.cur];
      return h_flex().w(width).h(ROW).flex_none().px(12).items_center().overflow_hidden().whitespace_nowrap()
        .when(now, (e) => e.bg(t.selection)).when(!now, (e) => e.bg(t.raised))
        .text_color(t.dim).text_size(11).child(r.text);
    }
    const c = r[name];
    const run = this.mode === "file" && this.cur >= 0 ? this.runs[this.cur] : null;
    const now = run && i >= run[0] && i < run[1];
    const tint = r.kind === "x" && c ? (name === "left" ? t.ansi1 : t.ansi2) + (now ? "30" : "18") : null;
    return h_flex().w(width).h(ROW).flex_none().gap(10)
      .when(Boolean(tint), (e) => e.bg(tint))
      .when(Boolean(now), (e) => e.border_l(2).border_color(t.accent))
      .child(div().w(30).flex_none().text_right().text_size(11).text_color(t.dim).child(c?.num === undefined ? "" : String(c.num)))
      .child(this.cell(c ? c.text || " " : "", t));
  }

  render(cx) {
    const t = theme();
    const req = shared("wb.diff.request");
    // Requests are per space: another space's Changes panel doesn't swap this tab's file.
    if (req && req.ts !== this.applied && (!req.space || req.space === this.space)) { this.applied = req.ts; this.req = req; this.load(req, cx); }
    const r = this.req;
    const z = settings().zoom || 1, H = this.viewH || 400, total = this.rows.length * ROW, max = Math.max(0, total - H);
    const off = Math.min(this.scrollY, max);
    const first = Math.floor(off / ROW), last = Math.min(this.rows.length, Math.ceil((off + H) / ROW));
    const thumb = max ? Math.max(24, H * H / total) : 0, thumbTop = max ? off / max * (H - thumb) : 0;
    const scroll = (to) => { this.scrollY = Math.max(0, Math.min(max, to)); };
    const nav = (id, icon, tip, dir) => div().id(id).w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6)
      .border_1().border_color(t.border).text_color(this.hunks.length ? t.muted : t.dim).tooltip(tip)
      .when(this.hunks.length, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.jump(dir, cx))
      .child(svg(`mods/wb-diff/icons/${icon}.svg`).size(13));
    const modeBtn = (m, icon, tip) => div().id(`mode-${m}`).w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6)
      .border_1().border_color(t.border).when(this.mode === m, (e) => e.bg(t.selected)).when(this.mode !== m, (e) => e.hover((s) => s.bg(t.hover)))
      .text_color(this.mode === m ? t.foreground : t.muted).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (this.mode !== m && this.req) { this.mode = m; try { localStorage.setItem("mode", m); } catch {} this.load(this.req, cx); cx.notify(); } })
      .child(svg(`mods/wb-diff/icons/${icon}.svg`).size(13));
    const stop = (_e, cx) => cx.stop_propagation();
    const column = (name, width) => div().id(`diff-${name}`).flex_1().min_w(0).h_full().overflow_x_scrollbar()
      .child(div().min_w(width).h_full().relative()
        .child(v_flex().absolute().left(0).top(first * ROW - off).children(Array.from({ length: Math.max(0, last - first) }, (_, k) => this.row(first + k, t, name, width)))));
    return v_flex().id("diff-view").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "down" && e.modifiers.alt) { this.jump(1, cx); cx.stop_propagation(); }
        else if (e.key === "up" && e.modifiers.alt) { this.jump(-1, cx); cx.stop_propagation(); }
      })
      // Takes the keyboard on any press, so Alt+↑/↓ reach it.
      .on_mouse_down("left", () => this.handle.focus())
      .child(h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/wb-diff/icons/diff.svg").size(14).text_color(t.muted))
        .child(div().flex_none().max_w(260).truncate().font_semibold().child(r?.path?.split("/").pop() ?? "Diff"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r?.path ?? ""))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.hunks.length ? `change ${this.cur >= 0 ? this.cur + 1 : "–"} of ${this.hunks.length}` : ""))
        .child(modeBtn("diff", "diff", "Changed hunks only"))
        .child(modeBtn("file", "file", "Whole file, changes highlighted"))
        .child(nav("diff-prev", "chevron-left", "Previous change (Alt+↑)", -1))
        .child(nav("diff-next", "chevron-right", "Next change (Alt+↓)", 1))
        .child(div().id("diff-close").w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close").on_mouse_down("left", stop).on_click(() => { const id = this.ownTab(); if (id) run("tab.close", { id, confirmed: true }); }).child(svg("mods/wb-diff/icons/close.svg").size(12))))
      .child(div().id("diff-body").flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .on_size_change((s, cx) => { const h = s.height / z; if (h !== this.viewH) { this.viewH = h; cx.notify(); } })
        .on_hover((hovered) => { if (!hovered) this.thumbDrag = null; })
        .on_mouse_up("left", () => { this.thumbDrag = null; })
        .on_mouse_move((e, cx) => { if (this.thumbDrag) { scroll(this.thumbDrag.off + (e.position.y - this.thumbDrag.y) / z * max / Math.max(1, H - thumb)); cx.notify(); } })
        .on_scroll_wheel((ev, cx) => {
          if (Math.abs(ev.delta.y) < Math.abs(ev.delta.x)) return;
          scroll(off - ev.delta.y / z); cx.stop_propagation(); cx.notify();
        })
        .when(this.rows.length > 0, (e) => e.child(h_flex().size_full()
          .child(column("left", this.leftW))
          .child(div().w(1).h_full().flex_none().bg(t.border))
          .child(column("right", this.rightW))))
        .when(!this.rows.length, (e) => e.child(div().p(12).text_color(t.dim).child(this.error || (this.loading ? "Loading diff…" : r ? "No text changes" : "Open a changed file from the Changes panel"))))
        .when(thumb > 0, (e) => e.child(div().id("diff-thumb").absolute().right(2).top(thumbTop).w(6).h(thumb).rounded(3).bg(t.border).hover((s) => s.bg(t.input))
          .on_mouse_down("left", (ev, cx) => { this.thumbDrag = { y: ev.position.y, off }; cx.stop_propagation(); }))));
  }
}