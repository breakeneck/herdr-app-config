// Git blame for the annotation gutter (PhpStorm's "Annotate with Git Blame").
// Mods can't import each other's files, so wb-files keeps an identical copy: change both.

import { exec, openOverlay } from "herdr";

export const NOT_COMMITTED = "0000000000000000000000000000000000000000";
export const BLAME_W = 150; // the annotation column, px

// One entry per line of `path` at `rev` (omitted: the working tree): { c: commit, text }.
// c = { hash, author, mail, time (unix s), summary }; uncommitted lines have hash NOT_COMMITTED.
export async function blame({ root, on, path, rev }) {
  const args = ["--no-optional-locks", "blame", "--porcelain", ...(rev ? [rev] : []), "--", path];
  const r = await exec("git", args, { cwd: root, on: on ?? undefined, timeout: 60000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git blame failed");
  return parse(r.stdout);
}

export function parse(out) {
  const commits = {}, lines = [];
  let cur = null;
  for (const l of out.split("\n")) {
    if (l.startsWith("\t")) { if (cur) lines.push({ c: cur, text: l.slice(1) }); continue; }
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(l);
    if (m) { cur = commits[m[1]] ??= { hash: m[1] }; continue; }
    if (!cur) continue;
    const sp = l.indexOf(" "), k = sp < 0 ? l : l.slice(0, sp), v = sp < 0 ? "" : l.slice(sp + 1);
    if (k === "author") cur.author = v;
    else if (k === "author-mail") cur.mail = v.replace(/^<|>$/g, "");
    else if (k === "author-time") cur.time = Number(v);
    else if (k === "summary") cur.summary = v;
  }
  return lines;
}

const pad = (n) => String(n).padStart(2, "0");
export const dateOf = (time) => { const d = new Date(time * 1000); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };

// "25.05.2026 Datsenko" — what the gutter shows for a line, as the IDE does: date and the author's last name.
export function label(c) {
  if (!c || c.hash === NOT_COMMITTED) return "Not committed";
  const parts = String(c.author ?? "").trim().split(/\s+/);
  return `${dateOf(c.time)} ${parts[parts.length - 1] || "?"}`;
}

export const tooltip = (c) => !c || c.hash === NOT_COMMITTED ? "Not committed yet" : `${c.hash.slice(0, 8)} · ${c.author} · ${dateOf(c.time)}\n${c.summary ?? ""}`;

// Newer commits get a stronger tint, like the IDE's: a hex alpha from the line's age in days.
export function tint(c, accent) {
  if (!c) return null;
  if (c.hash === NOT_COMMITTED) return accent + "38";
  const days = (Date.now() / 1000 - (c.time ?? 0)) / 86400;
  const a = days < 7 ? 0x30 : days < 30 ? 0x24 : days < 180 ? 0x18 : days < 730 ? 0x0e : 0x06;
  return accent + a.toString(16).padStart(2, "0");
}

// The commit behind a line: its message and files, in a dialog (the wb-blame mod).
export function openCommit({ root, on, path }, c) {
  if (!c || c.hash === NOT_COMMITTED) return;
  openOverlay({ mod: "wb-blame", kind: "dialog", width: 640, height: 520, props: { root, on: on ?? null, path, hash: c.hash } });
}
