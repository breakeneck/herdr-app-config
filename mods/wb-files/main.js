// A lazy file browser for the focused pane's folder; a clicked file opens read-only in the main area (props.view: that viewer tab).
// Files move between this computer and the space's machine (transfer.js): drop files from Finder onto a folder
// (or the list) to upload them there; ⌘C / ⌘V copy and paste, also to and from Finder; right-click → Download.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, shared, setShared, props, run, notify, openOverlay, closeOverlay, pickFolder, checking } from "herdr";
import * as T from "./transfer.js";
import * as S from "./section.js";
import { colorOf } from "./colors.js";
import { blame, label, tooltip, tint as ageTint, openCommit, BLAME_W } from "./blame.js";
import { highlight, languageFor } from "./highlight.js";

// Annotate with Git Blame in the viewer tab: the Blame button (or the gutter's right-click menu) swaps the editor
// for a read-only annotated copy of the saved file, opened at the cursor's line. The native editor has no gutter
// hooks, so annotations can't sit beside it. "wb.blame.close" = a timestamp the gutter menu sets to turn it off.
const AROW = 18, ACHAR = 12 * 0.6;


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
// The panel's own clipboard ({ on, paths: absolute, sys: the local copies on the system clipboard, or null
// while they're made }) and menu actions sent from the popup ({ action, ts, ... }).
const CLIP = "wb.files.clip", ACTION = "wb.files.action";
// The folder last downloaded into (the menu offers it again); Downloads until one is picked.
const DL_DIR = "wb.files.downloadDir";
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
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
    if (props()?.menu || props()?.gutterMenu) return;
    if (props()?.view) { this.viewer = true; this.req = props(); this.root = this.req.root; this.on = this.req.on; this.show(this.req.path, cx); return; }
    S.migrateKeys(["sections.collapsed"]);
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.sel = new Set(); this.handle = cx.focus_handle(); this.status = null; this.busy = 0; this.lastAction = Date.now();
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
      this.pending = new Set(); this.marks = {}; this.sel = new Set(); this.watched = null; this.error = null; this.limited = false;
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
    this.annotate = false; this.ann = null; this.annError = null;
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

  // Where a paste lands: the selected folder, else the selected file's folder, else the list's root ("").
  pasteTarget() {
    const last = [...this.sel].pop();
    if (last == null) return "";
    const parent = last.includes("/") ? last.slice(0, last.lastIndexOf("/")) : "";
    return (this.entries.get(parent) ?? []).find((e) => e.name === last.split("/").pop())?.dir ? last : parent;
  }
  full(rel) { return rel ? `${this.root}/${rel}` : this.root; }

  // One file operation at a time shows in the footer; failures toast. The list refreshes after.
  job(label, work, cx) {
    if (!this.root) return;
    this.busy++; this.status = label; cx.notify();
    cx.spawn(async (cx) => {
      try { const done = await work(); this.status = done ?? null; }
      catch (e) { this.status = null; notify({ title: label.replace(/…$/, "") + " failed", body: String(e.message ?? e), level: "error" }); }
      finally { this.busy--; this.refresh(cx); cx.notify(); }
      if (this.status && !this.busy) { const s = this.status; cx.timer?.after?.(4000, (cx) => { if (this.status === s) { this.status = null; cx.notify(); } }); }
    });
  }

  // Finder files dropped on a folder row (or a file's folder, or the list): copied there, here or remote.
  upload(paths, rel, cx) {
    if (!paths?.length || !this.root) return;
    const on = this.on, dir = this.full(rel), n = paths.length;
    this.job(`${on ? "Uploading" : "Copying"} ${n === 1 ? paths[0].split("/").pop() : n + " items"}…`, async () => {
      const names = await T.transfer(null, paths, on, dir);
      if (rel) this.folders.add(rel);
      return `${on ? "Uploaded" : "Copied"} ${names.length === 1 ? names[0] : names.length + " items"}`;
    }, cx);
  }

  // ⌘C: the panel's clipboard, and the system's too (remote files as local copies), so Finder can paste them.
  copy(rels, cx) {
    if (!rels.length || !this.root) return;
    const on = this.on ?? null, paths = rels.map((r) => this.full(r)), ts = Date.now();
    setShared(CLIP, { on, paths, sys: null, ts });
    const what = rels.length === 1 ? rels[0].split("/").pop() : `${rels.length} items`;
    if (!T.clipboardFiles()) { this.status = `Copied ${what}`; cx.notify(); return; }
    this.job(on ? `Copying ${what} from ${on}…` : `Copying ${what}…`, async () => {
      let sys = [];
      try { sys = on ? await T.stageLocally(on, paths) : paths; if (!(await T.writeClipboardFiles(sys))) sys = []; }
      finally { if (shared(CLIP)?.ts === ts) setShared(CLIP, { on, paths, sys, ts }); }
      return `Copied ${what}`;
    }, cx);
  }

  // ⌘V: Finder's copied files, or the panel's own (straight from machine to machine when they're the newest).
  paste(rel, cx) {
    if (!this.root) return;
    const on = this.on ?? null, dir = this.full(rel);
    this.job("Pasting…", async () => {
      const sys = await T.readClipboardFiles(), clip = shared(CLIP);
      const own = clip && (!sys.length || clip.sys === null || same(sys, clip.sys));
      const from = own ? clip.on : null, paths = own ? clip.paths : sys;
      if (!paths.length) return "Nothing to paste";
      const names = await T.transfer(from, paths, on, dir);
      if (rel) this.folders.add(rel);
      return `Pasted ${names.length === 1 ? names[0] : names.length + " items"}`;
    }, cx);
  }

  // Remote (or local) files into a folder on this computer: Downloads, or one picked.
  download(rels, dir, cx) {
    if (!rels.length || !this.root) return;
    const on = this.on ?? null, paths = rels.map((r) => this.full(r));
    this.job(`Downloading ${rels.length === 1 ? rels[0].split("/").pop() : rels.length + " items"}…`, async () => {
      const target = dir ?? await pickFolder({ prompt: "Download to" });
      if (!target) return null;
      setShared(DL_DIR, target);
      const names = await T.transfer(on, paths, null, target);
      if (names.length) await T.reveal(`${target}/${names[0]}`);
      return `Downloaded ${names.length === 1 ? names[0] : names.length + " items"}`;
    }, cx);
  }

  menu(path, dir, cx) {
    cx.stop_propagation();
    if (!this.sel.has(path)) this.sel = new Set([path]);
    this.handle.focus();
    const paths = [...this.sel];
    openOverlay({ mod: "wb-files", kind: "popup", width: 260, height: 6 * 30 + 14 + 9,
      props: { menu: { root: this.root, on: this.on ?? null, paths, label: paths.length === 1 ? path.split("/").pop() : `${paths.length} items`, dir } } });
    cx.notify();
  }

  // The right-click menu (a popup copy): its choice goes back to the list as a shared action, so the
  // copy or download keeps running after the popup closes.
  menuView() {
    const t = theme(), m = props().menu, close = () => closeOverlay(props()?.overlay);
    const act = (action) => { setShared(ACTION, { action, root: m.root, on: m.on, paths: m.paths, ts: Date.now() }); close(); };
    const item = (id, label, hint, action) => h_flex().id(id).h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .text_size(12.5).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => action(cx))
      .child(div().flex_1().min_w(0).truncate().child(label)).when(Boolean(hint), (e) => e.child(div().text_size(11).text_color(t.dim).child(hint)));
    const last = shared(DL_DIR) || T.downloads(), lastName = last.split("/").filter(Boolean).pop() || last;
    return v_flex().p(6).gap(1).w_full().bg(t.raised).text_color(t.foreground)
      .child(item("fm-dlto", "Download…", "choose folder", () => act("downloadTo")))
      .child(item("fm-dl", `Download to ${lastName}`, null, () => act("download")))
      .child(div().h(1).mx(6).my(4).bg(t.border))
      .child(item("fm-copy", `Copy ${m.label}`, "⌘C", () => act("copy")))
      .child(item("fm-paste", m.dir ? "Paste into folder" : "Paste here", "⌘V", () => act("paste")))
      .child(item("fm-path", "Copy path", null, (cx) => { cx.write_to_clipboard(m.paths.map((p) => `${m.root}/${p}`).join("\n")); close(); }))
      .child(item("fm-reveal", m.on ? `On ${m.on}` : "Reveal in Finder", null, () => { if (!m.on) T.reveal(`${m.root}/${m.paths[0]}`); close(); }));
  }

  // A menu choice from the popup, for the folder this list shows.
  takeAction(cx) {
    const a = shared(ACTION);
    if (!a || a.ts <= this.lastAction) return;
    this.lastAction = a.ts;
    if (a.root !== this.root || (a.on ?? null) !== (this.on ?? null)) return;
    if (a.action === "copy") this.copy(a.paths, cx);
    else if (a.action === "paste") this.paste(this.pasteTarget(), cx);
    else if (a.action === "download") this.download(a.paths, shared(DL_DIR) || T.downloads(), cx);
    else if (a.action === "downloadTo") this.download(a.paths, null, cx);
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const selected = this.sel.has(path), parent = prefix;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(selected, s => s.bg(t.selected)).hover(s => s.bg(selected ? t.selected : t.hover))
        // Dragging a row onto a terminal types its path there (Herdr only drops onto terminals).
        .drag_paths((selected ? [...this.sel] : [path]).map((p) => `${this.root}/${p}`), { on: this.on ?? null })
        .on_drop((e, cx) => { cx.stop_propagation(); this.upload(e.paths, entry.dir ? path : parent, cx); })
        .on_mouse_down("right", (_e, cx) => this.menu(path, entry.dir, cx))
        .on_click((e, cx) => {
          cx.stop_propagation(); this.handle.focus();
          if (e.modifiers?.platform || e.modifiers?.control) { this.sel.has(path) ? this.sel.delete(path) : this.sel.add(path); cx.notify(); return; }
          this.sel = new Set([path]);
          entry.dir ? this.toggle(path, cx) : (openInMain(this.root, this.on, path), cx.notify());
        })
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

  // Blame on: the saved file's lines with who changed each and when, from `git blame` (its text comes with it).
  toggleAnnotate(cx) {
    if (this.annotate) { this.annotate = false; this.ann = null; cx.notify(); return; }
    if (!this.file || !this.root) return;
    let line = 0;
    try { const v = this.code?.value() ?? "", at = this.code?.selected_range()?.start ?? 0; line = v.slice(0, at).split("\n").length - 1; } catch {}
    const path = this.file, root = this.root, on = this.on;
    this.annotate = true; this.ann = null; this.annError = null; this.annSince = Date.now(); this.annY = 0; this.annLine = line;
    cx.spawn(async (cx) => {
      try {
        const lines = await blame({ root, on, path });
        if (!this.annotate || this.file !== path) return;
        this.ann = lines; this.lang = languageFor(path);
        this.annW = Math.min(4000, Math.max(20, ...lines.slice(0, 20000).map((l) => l.text.length)) * ACHAR + 40);
        this.annY = Math.max(0, (this.annLine - Math.floor((this.annH || 400) / 3 / AROW)) * AROW);
      } catch (e) { if (this.file === path) this.annError = String(e.message ?? e).split("\n")[0]; }
      cx.notify();
    });
    cx.notify();
  }

  gutterMenuView() {
    const t = theme();
    return v_flex().p(6).w_full().bg(t.raised).text_color(t.foreground)
      .child(h_flex().id("gm-blame").h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12.5).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => { setShared("wb.blame.close", Date.now()); closeOverlay(props()?.overlay); })
        .child(div().w(14).text_color(t.accent).child("✓")).child("Annotate with Git Blame"));
  }

  // The annotated file: the gutter (date and author, tinted by age; a click shows the commit) and the code.
  annotatedView(t) {
    const z = settings().zoom || 1, lines = this.ann ?? [], H = this.annH || 400;
    const total = lines.length * AROW, max = Math.max(0, total - H), off = Math.min(this.annY ?? 0, max);
    const first = Math.floor(off / AROW), last = Math.min(lines.length, Math.ceil((off + H) / AROW));
    const where = { root: this.root, on: this.on, path: this.file };
    const menu = (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "wb-files", kind: "popup", width: 230, height: 44, props: { gutterMenu: true } }); };
    const cell = (text) => h_flex().flex_1().min_w(0).h_full().items_center().whitespace_nowrap()
      .children(!this.lang || text.length > 600 ? [div().child(text || " ")] : highlight(text, this.lang, t).map((p) => (p.color ? div().text_color(p.color).child(p.text) : div().child(p.text))));
    const rows = Array.from({ length: Math.max(0, last - first) }, (_, k) => {
      const i = first + k, l = lines[i], c = l.c;
      return h_flex().h(AROW).flex_none().gap(10)
        .child(div().id(`ba-${i}`).w(BLAME_W).h_full().flex_none().px(6).flex().items_center().overflow_hidden().whitespace_nowrap()
          .bg(ageTint(c, t.accent)).text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .tooltip(tooltip(c)).on_click(() => openCommit(where, c)).on_mouse_down("right", menu).child(label(c)))
        .child(div().id(`ln-${i}`).w(36).flex_none().text_right().text_size(11).text_color(i === this.annLine ? t.foreground : t.dim)
          .on_mouse_down("right", menu).child(String(i + 1)))
        .child(cell(l.text));
    });
    return div().id("annotated").flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .on_size_change((s, cx) => { const h = s.height / z; if (h !== this.annH) { this.annH = h; cx.notify(); } })
      .on_scroll_wheel((ev, cx) => {
        if (Math.abs(ev.delta.y) < Math.abs(ev.delta.x)) return;
        this.annY = Math.max(0, Math.min(max, off - ev.delta.y / z)); cx.stop_propagation(); cx.notify();
      })
      .when(!this.ann, (e) => e.child(div().p(12).text_color(this.annError ? t.ansi1 : t.dim).child(this.annError ?? "Running git blame…")))
      .when(Boolean(this.ann), (e) => e.child(div().id("ann-x").size_full().overflow_x_scrollbar()
        .child(div().min_w(BLAME_W + 56 + (this.annW ?? 400)).h_full().relative()
          .child(v_flex().absolute().left(0).top(first * AROW - off).children(rows)))));
  }

  // Closing the tab keeps the edits (saved, like the IDE); a refused save still shows its toast.
  async close() { if (this.viewer && this.dirty) await this.save(); }

  // The viewer tab: the requested file, full size and editable; a newer request for this space replaces
  // it (unsaved edits are saved first, like the IDE switching files).
  viewerView(cx) {
    const r = shared(REQUEST), t = theme();
    if (this.annotate && (shared("wb.blame.close") ?? 0) > this.annSince) { this.annotate = false; this.ann = null; }
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
          .child(this.saving ? "Saving…" : this.dirty ? "Save" : "Saved")))
        .when(Boolean(this.code), (e) => e.child(div().id("blame").h(22).px(8).flex_none().flex().items_center().rounded(5).text_size(11).cursor_pointer()
          .border_1().border_color(this.annotate ? t.accent : t.border).text_color(this.annotate ? t.accent : t.muted).when(this.annotate, (s) => s.bg(t.selected))
          .hover((h) => h.bg(t.hover)).tooltip(this.annotate ? "Close annotations, back to the editor" : `Annotate with Git Blame: who changed each line and when${this.dirty ? " (of the saved file)" : ""}`)
          .on_click((_e, cx) => this.toggleAnnotate(cx)).child("Blame"))))
      .child(this.annotate ? this.annotatedView(t) : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"));
  }

  render(cx) {
    if (props()?.gutterMenu) return this.gutterMenuView();
    if (props()?.menu) return this.menuView();
    if (this.viewer) return this.viewerView(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    this.takeAction(cx);
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
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .track_focus(this.handle)
        .on_key_down((e, cx) => {
          const mod = e.modifiers?.platform || e.modifiers?.control;
          if (!mod || e.modifiers?.shift || e.modifiers?.alt) return;
          if (e.key === "c") { cx.stop_propagation(); this.copy([...this.sel], cx); }
          else if (e.key === "v") { cx.stop_propagation(); this.paste(this.pasteTarget(), cx); }
        })
        // A click on empty space clears the selection, so ⌘V goes to the root; a Finder drop there lands in the root.
        .on_click((_e, cx) => { this.handle.focus(); if (this.sel.size) { this.sel = new Set(); cx.notify(); } })
        .on_drop((e, cx) => this.upload(e.paths, "", cx))
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))))
      .when(Boolean(this.status), el => el.child(h_flex().h(26).flex_none().px(12).gap(6).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
        .when(this.busy > 0, e => e.child(div().flex_none().text_color(t.accent).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(div().flex_1().min_w(0).truncate().child(this.status))))
      .when(Boolean(ov), el => el.child(ov));
  }
}
