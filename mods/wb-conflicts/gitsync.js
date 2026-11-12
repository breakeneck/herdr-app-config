// Git updates and conflicts shared by the git mods (the Changes panel's log, the branch picker, the
// conflicts dialog): one way to update a branch, one signal that a repo's refs moved.
// SAME FILE in every mod that uses it. The canonical copy is mods/wb-changes/gitsync.js: edit it there,
// then run `scripts/sync-helpers.sh --write` to copy it over the others.
//
// shared "wb.git.sync" = { rk, op, ts }: a person's action moved this repo's refs (fetch, update,
// continue, abort). rk = `${on}|${root}` (on: the machine, "null" here). Whoever shows that repo reloads.

import { exec, readTextFile, writeTextFile, shared, setShared, openOverlay } from "herdr";

export const SYNC = "wb.git.sync";
export const repoKey = (on, root) => `${on ?? null}|${root}`;
export const lastSync = () => shared(SYNC) ?? null;
export function announce(on, root, op) {
  const ts = Date.now();
  setShared(SYNC, { rk: repoKey(on, root), op, ts });
  setShared("wb.branch.switched", ts); // the branch chip and the Changes panel ask again
}

const git = (root, on, args, timeout = 180000) => exec("git", args, { cwd: root, on, timeout });
const tail = (r) => (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).slice(-3).join(" ");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function fetchRepo(root, on) {
  const r = await git(root, on, ["fetch", "--prune", "--quiet"]);
  announce(on, root, "fetch");
  if (r.code !== 0) throw new Error(tail(r) || "git fetch failed");
}

// Update like the IDE's Update Project: fetch, then fast-forward; when the branches diverged, rebase the
// local commits onto the upstream. Uncommitted changes are stashed and put back (--autostash).
// Returns { text, conflict }: on a conflict the rebase/merge stays in progress for the conflicts dialog.
export async function updateRepo(root, on) {
  const up = await git(root, on, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (up.code !== 0) throw new Error("This branch has no upstream to update from (push it first)");
  const upstream = up.stdout.trim();
  const f = await git(root, on, ["fetch", "--prune", "--quiet"]);
  if (f.code !== 0) { announce(on, root, "fetch"); throw new Error(tail(f) || "git fetch failed"); }
  const cnt = await git(root, on, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  const [ahead = 0, behind = 0] = cnt.stdout.trim().split(/\s+/).map(Number);
  try {
    if (!behind) return { text: `Already up to date with ${upstream}` };
    const args = ahead
      ? ["-c", "core.editor=true", "rebase", "--autostash", "@{u}"]
      : ["merge", "--ff-only", "--autostash", "@{u}"];
    const r = await git(root, on, args, 600000);
    const st = await conflictState(root, on);
    if (st.files.length) return { conflict: true, text: `${plural(st.files.length, "conflict")} while updating from ${upstream}` };
    if (r.code !== 0) throw new Error(tail(r) || "update failed");
    return { text: ahead ? `Rebased ${plural(ahead, "local commit")} onto ${plural(behind, "new commit")} from ${upstream}` : `Pulled ${plural(behind, "commit")} from ${upstream}` };
  } finally { announce(on, root, "update"); }
}

// What's in progress and which files are unmerged.
// op: "rebase" | "merge" | "cherry-pick" | "revert" | null (e.g. an autostash that didn't apply cleanly).
// files: [{ path, ours, theirs }] — ours/theirs: whether git's stage 2/3 exists (false: deleted on that side).
// In a rebase git's "ours" is the upstream being rebased onto and "theirs" is your commit: yours names
// which git side is the person's own.
export async function conflictState(root, on) {
  const [gd, ls] = await Promise.all([
    git(root, on, ["rev-parse", "--absolute-git-dir"]),
    git(root, on, ["ls-files", "-u", "-z"]),
  ]);
  let op = null, subject = "", onto = "";
  if (gd.code === 0) {
    const dir = gd.stdout.trim();
    const marks = await exec("sh", ["-c", 'for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do [ -e "$1/$f" ] && echo "$f"; done; true', "st", dir], { on });
    const m = marks.stdout.split("\n").filter(Boolean);
    op = m.some((x) => x.startsWith("rebase")) ? "rebase" : m.includes("MERGE_HEAD") ? "merge" : m.includes("CHERRY_PICK_HEAD") ? "cherry-pick" : m.includes("REVERT_HEAD") ? "revert" : null;
    const head = op === "rebase" ? "REBASE_HEAD" : op === "merge" ? "MERGE_HEAD" : op === "cherry-pick" ? "CHERRY_PICK_HEAD" : op === "revert" ? "REVERT_HEAD" : null;
    if (head) subject = (await git(root, on, ["log", "-1", "--format=%s", head])).stdout.trim();
    // HEAD is detached mid-rebase: the branch being rebased is in rebase-merge/head-name; its upstream names "theirs".
    if (op === "rebase") {
      const hn = (await exec("sh", ["-c", 'cat "$1/rebase-merge/head-name" "$1/rebase-apply/head-name" 2>/dev/null; true', "st", dir], { on })).stdout.trim().split("\n")[0] ?? "";
      const br = hn.replace(/^refs\/heads\//, "");
      if (br) onto = (await git(root, on, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${br}@{u}`])).stdout.trim();
    }
  }
  const by = new Map();
  for (const rec of ls.stdout.split("\0").filter(Boolean)) {
    const tab = rec.indexOf("\t"), path = rec.slice(tab + 1), stage = rec.slice(0, tab).split(" ")[2];
    const f = by.get(path) ?? { path, ours: false, theirs: false };
    if (stage === "2") f.ours = true;
    if (stage === "3") f.theirs = true;
    by.set(path, f);
  }
  const files = [...by.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { op, subject, onto, files, yours: op === "rebase" ? "theirs" : "ours" };
}

// Takes one side of a file whole. side: "ours" | "theirs" (git's names); a side that deleted it deletes it.
export async function takeSide(root, on, f, side) {
  const exists = side === "ours" ? f.ours : f.theirs;
  const r = exists
    ? await git(root, on, ["checkout", `--${side}`, "--", f.path])
    : await git(root, on, ["rm", "-q", "--", f.path]);
  if (r.code !== 0) throw new Error(tail(r) || "could not take that side");
  if (exists) await markResolved(root, on, f.path);
}

export async function markResolved(root, on, path) {
  const r = await git(root, on, ["add", "--", path]);
  if (r.code !== 0) throw new Error(tail(r) || "git add failed");
}

// Finishes the operation once nothing is unmerged. A rebase may stop again on its next commit (more
// conflicts: the caller reloads); a commit that became empty is skipped, as the IDE does.
export async function continueOp(root, on, op) {
  if (!op) return;
  const r = await git(root, on, ["-c", "core.editor=true", op, "--continue"], 600000);
  if (r.code !== 0 && op === "rebase" && /nothing to commit|No changes|empty/i.test(r.stdout + r.stderr)) {
    const s = await git(root, on, ["-c", "core.editor=true", "rebase", "--skip"], 600000);
    announce(on, root, "continue");
    if (s.code !== 0 && !(await conflictState(root, on)).files.length) throw new Error(tail(s));
    return;
  }
  announce(on, root, "continue");
  if (r.code !== 0 && !(await conflictState(root, on)).files.length) throw new Error(tail(r) || `${op} --continue failed`);
}

export async function abortOp(root, on, op) {
  if (!op) return;
  const r = await git(root, on, [op, "--abort"]);
  announce(on, root, "abort");
  if (r.code !== 0) throw new Error(tail(r) || `${op} --abort failed`);
}

// The conflicts dialog for a repo.
export const openConflicts = (root, on) => openOverlay({ mod: "wb-conflicts", kind: "dialog", width: 860, height: 640, props: { root, on: on ?? null } });

// Conflict blocks of a file's text: [{ ours: [lines], base: [lines] | null, theirs: [lines], oursLabel, theirsLabel }].
export function conflictBlocks(text) {
  const out = [], lines = String(text ?? "").split("\n");
  let cur = null, part = null;
  for (const l of lines) {
    if (/^<{7}( |$)/.test(l)) { cur = { ours: [], base: null, theirs: [], oursLabel: l.slice(8).trim(), theirsLabel: "" }; part = "ours"; continue; }
    if (!cur) continue;
    if (/^\|{7}( |$)/.test(l)) { cur.base = []; part = "base"; continue; }
    if (/^={7}$/.test(l)) { part = "theirs"; continue; }
    if (/^>{7}( |$)/.test(l)) { cur.theirsLabel = l.slice(8).trim(); out.push(cur); cur = null; part = null; continue; }
    cur[part].push(l);
  }
  return out;
}
export const hasMarkers = (text) => /^(<{7}|>{7})( |$)/m.test(String(text ?? ""));

// UTF-8 text as base64, by hand (no TextEncoder/btoa assumed in the mod runtime).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(text) {
  const b = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
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

// Replaces a file's text, here or on another machine, only if it still reads `expected`.
export async function writeRepoFile(full, on, text, expected) {
  if (!on) return writeTextFile(full, text, expected);
  if ((await readTextFile(full, { on })) !== expected) throw new Error("changed on disk meanwhile");
  const b64 = base64(text), CHUNK = 96 * 1024, tmp = `${full}.herdr-save`;
  for (let i = 0; i === 0 || i < b64.length; i += CHUNK) {
    const r = await exec("sh", ["-c", `printf %s "$1" | base64 -d ${i ? ">>" : ">"} "$2"`, "save", b64.slice(i, i + CHUNK), tmp], { on });
    if (r.code !== 0) throw new Error((r.stderr || "write failed").trim());
  }
  const r = await exec("sh", ["-c", 'chmod --reference="$2" "$1" 2>/dev/null; mv -f "$1" "$2"', "save", tmp, full], { on });
  if (r.code !== 0) throw new Error((r.stderr || "write failed").trim());
}
