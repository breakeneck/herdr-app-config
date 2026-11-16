// Moving files between this computer and a space's machine, both ways, and the system clipboard's files.
// Everything goes as a tar stream: here `tar`, there `hc exec --on <machine> [-i]` (binary-safe stdin/stdout),
// so folders, modes and names travel whole. The receiving end unpacks into a hidden temp folder inside the
// destination, then moves each item in under a free name ("a copy.txt", "a copy 2.txt"), like Finder.
import { exec, home, window } from "herdr";

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const TIMEOUT = 600;

// stdin: a tar stream. $1: the destination folder. Prints each landed name on its own line.
const RECV = [
  'dest=$1; mkdir -p "$dest" || exit 1',
  'tmp=$(mktemp -d "$dest/.herdr-in.XXXXXX") || exit 1',
  'tar -C "$tmp" -xf - || { rm -rf "$tmp"; exit 1; }',
  'for p in "$tmp"/* "$tmp"/.[!.]* "$tmp"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue',
  '  n=${p##*/}; t=$n; i=1',
  '  case $n in ?*.*) b=${n%.*}; e=.${n##*.};; *) b=$n; e=;; esac',
  '  while [ -e "$dest/$t" ] || [ -L "$dest/$t" ]; do if [ $i = 1 ]; then t="$b copy$e"; else t="$b copy $i$e"; fi; i=$((i+1)); done',
  '  mv "$p" "$dest/$t" && printf "%s\\n" "$t"',
  'done',
  'rmdir "$tmp" 2>/dev/null; true',
].join("\n");

// macOS tar would add AppleDouble (._x) files and xattrs that Linux tar warns about.
const localTar = () => window()?.platform === "macos" ? "COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata" : "tar";
const remote = (on, stdin) => `hc exec --on ${q(on)}${stdin ? " -i" : ""} --timeout ${TIMEOUT} --`;
const tarArgs = (parent, names) => `-C ${q(parent)} -cf - ${names.map((n) => q("./" + n)).join(" ")}`;

function pipeline(on, parent, names, to, dir) {
  const recv = `sh -c ${q(RECV)} recv ${q(dir)}`;
  // Same machine, not here: one remote shell, nothing crosses the network twice.
  if (on && on === to) return `${remote(on)} sh -c ${q(`tar ${tarArgs(parent, names)} | ${recv}`)}`;
  const src = on ? `${remote(on)} tar ${tarArgs(parent, names)}` : `${localTar()} ${tarArgs(parent, names)}`;
  const dst = to ? `${remote(to, true)} ${recv}` : recv;
  return `${src} | ${dst}`;
}

const split = (p) => { const i = p.replace(/\/+$/, "").lastIndexOf("/"); return [i > 0 ? p.slice(0, i) : "/", p.slice(i + 1)]; };

// Copies `paths` (absolute, on machine `from`; null: here) into folder `dir` on machine `to`.
// Returns the names they landed under. Throws with the tools' message on failure.
export async function transfer(from, paths, to, dir) {
  from = from || null; to = to || null; dir = dir.replace(/\/+$/, "") || "/";
  for (const p of paths) if (from === to && (dir === p || dir.startsWith(p + "/"))) throw new Error(`Can't copy ${split(p)[1]} into itself`);
  const groups = new Map();
  for (const p of paths) { const [parent, name] = split(p); if (!groups.has(parent)) groups.set(parent, []); groups.get(parent).push(name); }
  const landed = [];
  for (const [parent, names] of groups) {
    const r = await exec("sh", ["-c", "set -o pipefail 2>/dev/null; " + pipeline(from, parent, names, to, dir)], { timeout: TIMEOUT * 1000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "copy failed").trim().split("\n").slice(-3).join("\n"));
    landed.push(...r.stdout.split("\n").filter(Boolean));
  }
  return landed;
}

export const downloads = () => `${home()}/Downloads`;
const cache = () => `${home()}/Library/Caches/herdr-files`;

// The system clipboard's files (Finder's ⌘C), and putting files there (Finder's ⌘V takes them). macOS only.
const CLIP = `ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  if (argv[0] === 'set') {
    pb.clearContents;
    const a = $.NSMutableArray.array;
    for (const p of argv.slice(1)) a.addObject($.NSURL.fileURLWithPath(p));
    return pb.writeObjects(a) ? 'ok' : 'fail';
  }
  const it = pb.pasteboardItems, out = [];
  for (let i = 0; i < it.count; i++) {
    const u = it.objectAtIndex(i).stringForType('public.file-url');
    if (u && !u.isNil()) out.push($.NSURL.URLWithString(u).path.js);
  }
  return out.join('\\n');
}`;
export const clipboardFiles = () => window()?.platform === "macos";

export async function readClipboardFiles() {
  if (!clipboardFiles()) return [];
  const r = await exec("osascript", ["-l", "JavaScript", "-e", CLIP, "get"]).catch(() => null);
  return r?.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export async function writeClipboardFiles(paths) {
  if (!clipboardFiles() || !paths.length) return false;
  const r = await exec("osascript", ["-l", "JavaScript", "-e", CLIP, "set", ...paths]).catch(() => null);
  return r?.code === 0 && r.stdout.trim() === "ok";
}

// Files on another machine reach the system clipboard as local copies in a cache folder
// (the previous copies there go: the clipboard no longer points at them).
export async function stageLocally(on, paths) {
  const dir = `${cache()}/clip-${Date.now()}`;
  await exec("sh", ["-c", 'mkdir -p "$1" && find "$1" -mindepth 1 -maxdepth 1 -name "clip-*" -exec rm -rf {} +', "clean", cache()]).catch(() => null);
  const names = await transfer(on, paths, null, dir);
  return names.map((n) => `${dir}/${n}`);
}

export async function reveal(path) {
  if (window()?.platform === "macos") await exec("open", ["-R", path]).catch(() => null);
}
