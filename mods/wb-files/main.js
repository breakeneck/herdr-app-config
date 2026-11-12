// A lazy file browser for the focused pane's folder; a clicked file opens read-only in the main area (props.view: that viewer tab).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, shared, setShared, props, run, notify } from "herdr";
import * as S from "./section.js";
import { colorOf } from "./colors.js";


function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd
    // A mod pane (a file or diff tab) has no folder: the space's terminal one (shown tab first), so panels stay on the project.
    || panes().find((p) => p.cwd && p.tab === space?.tabs?.find((t) => t.active)?.id)?.cwd
    || panes().find((p) => p.cwd && space?.tabs?.some((t) => t.id === p.tab))?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// UTF-8 text as base64, by hand (no TextEncoder/btoa assumed in the mod runtime).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(text) {
  const b = [];
  for (const ch of text) {
    let c = ch.codePointAt(0);
    if (c < 0x80) b.push(c);
    else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else b.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const out = [];
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out.push(B64[n >> 18], B64[(n >> 12) & 63], i + 1 < b.length ? B64[(n >> 6) & 63] : "=", i + 2 < b.length ? B64[n & 63] : "=");
  }
  return out.join("");
}

// A clicked file opens in the main area as a tab (one viewer tab per space, reused: a new click sends it
// a request through shared state, like the diff tab). The viewer is this mod with props.view.
const REQUEST = "wb.files.request";
function openInMain(root, on, path) {
  const space = spaces().find((s) => s.active);
  const req = { view: true, space: space?.id ?? null, root, on: on ?? null, path, ts: Date.now() };
  const ids = new Set((space?.tabs ?? []).map((t) => t.id));
  const existing = panes().find((p) => p.mod === "wb-files" && ids.has(p.tab));
  setShared(REQUEST, req);
  const name = path.split("/").pop();
  if (existing) { run("tab.select", { id: existing.tab }); run("tab.rename", { id: existing.tab, name }); }
  else run("tab.new", { name, mod: "wb-files", props: req, space: space?.id ?? undefined });
}

export default class Files extends View {
  init(_props, cx) {
    if (props()?.view) { this.viewer = true; this.req = props(); this.root = this.req.root; this.on = this.req.on; this.show(this.req.path, cx); return; }
    S.migrateKeys(["sections.collapsed"]);
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || (!this.viewer && !this.current(context))) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        // The viewer tab edits (a truncated big file stays read-only: saving it would cut it).
        const big = text.length > 400000, editable = this.viewer && !big;
        this.original = text; this.dirty = false; this.saveError = null; this.editable = editable;
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: !editable,
          value: big ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        if (editable) this.code.on("change", (_e, cx) => { const d = this.code.value() !== this.original; if (d !== this.dirty) { this.dirty = d; cx.notify(); } });
      } catch { if (this.file === path && (this.viewer || this.current(context))) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : openInMain(this.root, this.on, path))
        .child(entry.dir ? svg(`mods/wb-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/wb-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // Saves the open file. The file must still be what was loaded: changed on disk meanwhile (git checkout,
  // another editor) is refused rather than overwritten. Here through writeTextFile; on another machine
  // through sh, the text base64'd in chunks (one argument is capped at 128 KB on Linux), into a temp file
  // that then replaces it.
  async save() {
    if (!this.code || !this.editable || this.saving) return false;
    const text = this.code.value(), path = this.file, full = `${this.root}/${path}`, on = this.on;
    if (text === this.original) return true;
    this.saving = true; this.saveError = null;
    try {
      if (!on) await writeTextFile(full, text, this.original);
      else {
        if ((await readTextFile(full, { on })) !== this.original) throw new Error("changed on disk since it was opened");
        const b64 = base64(text), CHUNK = 96 * 1024, tmp = `${full}.herdr-save`;
        for (let i = 0; i === 0 || i < b64.length; i += CHUNK) {
          const r = await exec("sh", ["-c", `printf %s "$1" | base64 -d ${i ? ">>" : ">"} "$2"`, "save", b64.slice(i, i + CHUNK), tmp], { on });
          if (r.code !== 0) throw new Error((r.stderr || "write failed").trim());
        }
        // Keep the file's mode (an executable script stays executable), then swap it in.
        const r = await exec("sh", ["-c", 'chmod --reference="$2" "$1" 2>/dev/null; mv -f "$1" "$2"', "save", tmp, full], { on });
        if (r.code !== 0) throw new Error((r.stderr || "replace failed").trim());
      }
      if (this.file === path) { this.original = text; this.dirty = this.code.value() !== text; }
      return true;
    } catch (e) {
      this.saveError = `Not saved: ${e.message ?? e}`;
      notify({ title: `${path.split("/").pop()} not saved`, body: String(e.message ?? e), level: "error" });
      return false;
    } finally { this.saving = false; }
  }

  // Closing the tab keeps the edits (saved, like the IDE); a refused save still shows its toast.
  async close() { if (this.viewer && this.dirty) await this.save(); }

  // The viewer tab: the requested file, full size and editable; a newer request for this space replaces
  // it (unsaved edits are saved first, like the IDE switching files).
  viewerView(cx) {
    const r = shared(REQUEST), t = theme();
    if (r && r.ts > (this.req.ts ?? 0) && (r.space == null || r.space === this.req.space) && !this.switching) {
      const go = () => { this.req = r; this.root = r.root; this.on = r.on; this.show(r.path, cx); };
      if (this.dirty) { this.switching = true; cx.spawn(async (cx) => { await this.save(); this.switching = false; go(); cx.notify(); }); }
      else go();
    }
    const saveNow = (cx) => cx.spawn(async (cx) => { cx.notify(); await this.save(); cx.notify(); });
    return v_flex().id("viewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "s" && (e.modifiers?.platform || e.modifiers?.control) && !e.modifiers?.shift) { cx.stop_propagation(); saveNow(cx); }
      })
      .child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/wb-files/file.svg").size(13).flex_none().text_color(t.muted))
        .child(div().flex_none().font_semibold().child(`${this.file?.split("/").pop() ?? ""}${this.dirty ? " ●" : ""}`))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.file ?? ""))
        .when(Boolean(this.saveError), (e) => e.child(div().flex_none().max_w(260).truncate().text_size(11).text_color(t.ansi1).child(this.saveError)))
        .when(this.code && !this.editable, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("read-only")))
        .when(Boolean(this.editable), (e) => e.child(div().id("save").h(22).px(8).flex_none().flex().items_center().rounded(5).text_size(11)
          .border_1().border_color(this.dirty ? t.accent : t.border).text_color(this.dirty ? t.accent : t.dim)
          .when(this.dirty, (s) => s.cursor_pointer().hover((h) => h.bg(t.hover)))
          .tooltip("Save (⌘S / Ctrl+S)").on_click((_e, cx) => { if (this.dirty) saveNow(cx); })
          .child(this.saving ? "Saving…" : this.dirty ? "Save" : "Saved"))))
      .child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"));
  }

  render(cx) {
    if (this.viewer) return this.viewerView(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), sec = S.sectionOf("wb-files"), ov = S.overlay(sec);
    // The header wears the active project's color (its tile in the Spaces list), so the project shows at a glance.
    const sp = spaces().find((s) => s.active);
    const fill = sp && sp.name !== "~" ? colorOf(sp.name) : null;
    return v_flex().id("files").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(S.header(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
          .when(Boolean(fill), el => el.bg(fill).text_color("#ffffff")), sec, 44)
        .child(S.mark(sec))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(fill ? "#ffffffcc" : t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))))
      .when(Boolean(ov), el => el.child(ov));
  }
}
