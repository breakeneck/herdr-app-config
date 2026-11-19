import { exec } from "herdr";

// Shelf = PhpStorm's Shelf: patches kept outside git's stash, per repo, in <git-dir>/herdr-shelf/ (never the working tree).
// Each entry is <id>.patch (git diff --binary HEAD) + <id>.json { id, name, branch, at (unix s), files }; the json is written last, so it marks a complete entry.
// All file I/O goes through exec("sh", ["-c", script, "sh", ...args]) so paths are positional params (never interpolated) and it works on remote machines.
const run = (cmd, args, root, on, timeout = 60000) => exec(cmd, args, { cwd: root, on, timeout });
const git = (root, on, args, timeout) => run("git", ["--literal-pathspecs", ...args], root, on, timeout);
const sh = (root, on, script, ...args) => run("sh", ["-c", script, "sh", ...args], root, on);
const msg = (r, what) => (((r.stderr || r.stdout) || what).trim());
const SAFE = /^[A-Za-z0-9._-]+$/;

export async function gitDirOf(root, on) {
  const r = await run("git", ["rev-parse", "--absolute-git-dir"], root, on, 15000);
  return r.code === 0 ? r.stdout.trim() : null;
}
const patchOf = (dir, id) => `${dir}/herdr-shelf/${id}.patch`, jsonOf = (dir, id) => `${dir}/herdr-shelf/${id}.json`;

// [{ id, name, branch, at, files }] newest first; [] when none or not a repo.
export async function loadShelf(root, on, dir) {
  dir ??= await gitDirOf(root, on);
  if (!dir) return [];
  const r = await sh(root, on, 'for f in "$1"/herdr-shelf/*.json; do [ -f "$f" ] && cat "$f"; done; exit 0', dir);
  const out = [];
  for (const l of r.stdout.split("\n")) {
    try { const e = JSON.parse(l); if (e && SAFE.test(String(e.id)) && Array.isArray(e.files)) out.push({ ...e, at: Number(e.at) || 0, name: String(e.name ?? e.id) }); } catch {}
  }
  return out.sort((a, b) => b.at - a.at);
}
export const shelfCounts = (list) => ({ k: list.length, n: list.reduce((s, e) => s + e.files.length, 0) });

// Shelve the changed files under `paths` (files or folders; null = every changed file), then revert them. Returns { id, name, files }.
// Order matters: nothing is reverted unless both the patch and its json were written.
export async function shelve(root, on, paths, name) {
  const dir = await gitDirOf(root, on);
  if (!dir) throw new Error("Not a git repository");
  if ((await run("git", ["rev-parse", "--verify", "-q", "HEAD"], root, on, 15000)).code !== 0) throw new Error("No commits yet: nothing to shelve against");
  const st = await git(root, on, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], 30000);
  if (st.code !== 0) throw new Error(msg(st, "git status failed"));
  let list = st.stdout.split("\0").filter(Boolean).map((e) => ({ xy: e.slice(0, 2), path: e.slice(3) }));
  if (paths) list = list.filter((e) => paths.some((p) => e.path === p || e.path.startsWith(`${p.replace(/\/$/, "")}/`)));
  if (!list.length) throw new Error("No changes to shelve");
  if (list.some((e) => e.xy.includes("U") || e.xy === "AA" || e.xy === "DD")) throw new Error("Resolve conflicts first");
  const files = list.map((e) => e.path), fresh = list.filter((e) => e.xy === "??").map((e) => e.path);
  const ls = await git(root, on, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD", "--", ...files]);
  if (ls.code !== 0) throw new Error(msg(ls, "git ls-tree failed"));
  const inHead = new Set(ls.stdout.split("\0").filter(Boolean));
  const old = files.filter((p) => inHead.has(p)), added = files.filter((p) => !inHead.has(p));
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const b = (await run("git", ["branch", "--show-current"], root, on, 15000)).stdout.trim() || "detached HEAD";
  const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
  name ||= `Shelved on ${b} ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  // Intent-to-add makes untracked files part of the diff; undone (they stay on disk) if anything fails before the revert.
  const undo = async () => {
    await sh(root, on, 'rm -f -- "$1" "$2"', patchOf(dir, id), jsonOf(dir, id));
    if (fresh.length) await git(root, on, ["rm", "--cached", "-q", "-f", "--ignore-unmatch", "--", ...fresh]);
  };
  if (fresh.length) {
    const r = await git(root, on, ["add", "-N", "--", ...fresh]);
    if (r.code !== 0) throw new Error(msg(r, "git add -N failed"));
  }
  const w = await sh(root, on, 'd=$1; p=$2; shift 2; mkdir -p "$d" && git --literal-pathspecs diff --binary HEAD -- "$@" > "$p" && [ -s "$p" ]', `${dir}/herdr-shelf`, patchOf(dir, id), ...files);
  if (w.code !== 0) { await undo(); throw new Error(msg(w, "could not write the patch") + "\nNothing was reverted."); }
  const j = await sh(root, on, 'printf "%s\\n" "$1" > "$2"', JSON.stringify({ id, name, branch: b, at: Math.floor(Date.now() / 1000), files }), jsonOf(dir, id));
  if (j.code !== 0) { await undo(); throw new Error(msg(j, "could not write the shelf entry") + "\nNothing was reverted."); }
  // Revert: tracked files back to HEAD (index and tree); files HEAD lacks (untracked, staged-new) out of the index and deleted.
  if (old.length) {
    const r = await git(root, on, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...old]);
    if (r.code !== 0) throw new Error(`Shelved, but reverting failed: ${msg(r, "git restore failed")}`);
  }
  if (added.length) {
    await git(root, on, ["rm", "--cached", "-q", "-f", "--ignore-unmatch", "--", ...added]);
    const r = await run("rm", ["-f", "--", ...added], root, on);
    if (r.code !== 0) throw new Error(`Shelved, but deleting new files failed: ${msg(r, "rm failed")}`);
  }
  return { id, name, files };
}

// Apply an entry (3-way, so it merges into edited files), falling back to a plain apply (new files, an index that differs).
// On success the entry is deleted. Returns { ok, conflict?, out }; on failure the entry is kept.
export async function unshelve(root, on, dir, e) {
  const p = patchOf(dir, e.id);
  let r = await git(root, on, ["apply", "--3way", "--binary", p]);
  if (r.code !== 0 && !/with conflicts/.test(`${r.stderr}${r.stdout}`)) {
    const plain = await git(root, on, ["apply", "--binary", p]);
    if (plain.code === 0) r = plain; else r = { code: 1, stderr: `${msg(r, "")}\n${msg(plain, "")}`.trim(), stdout: "" };
  }
  if (r.code !== 0) return { ok: false, conflict: /with conflicts/.test(`${r.stderr}${r.stdout}`), out: msg(r, "git apply failed") };
  await removeEntry(root, on, dir, e);
  return { ok: true };
}
export async function removeEntry(root, on, dir, e) {
  const r = await sh(root, on, 'rm -f -- "$1" "$2"', patchOf(dir, e.id), jsonOf(dir, e.id));
  if (r.code !== 0) throw new Error(msg(r, "could not delete the shelf entry"));
}
