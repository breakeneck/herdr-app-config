// The title a new pull/merge request starts with, from its branch name:
//   feature/PROJ-123-fix-login-redirect → "PROJ-123 <the Jira issue's summary>"  (summary known)
//                                      → "PROJ-123 Fix login redirect"          (not known)
//   oleh/fix-login-redirect             → "Fix login redirect"
// The summary comes from the Tasks panel's cache (data/wb-tasks/cache.json), else from Jira itself,
// with the accounts the Tasks panel keeps (shared "wb.tasks.accounts".jira, tokens in the Keychain).
import { shared } from "herdr";
import { fileCache } from "./cache.js";
import { getSecret } from "./secrets.js";

const MAX = 90;
const KEY = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?![A-Za-z0-9])/;
const PREFIXES = /^(feature|feat|fix|bugfix|hotfix|bug|chore|refactor|release|task|story|review|wip|docs|test)$/i;
const known = {}; // key → summary (or null: looked up, not found) for this run

// The Jira key in a branch name (uppercased), or null. Written in lowercase ("proj-12-…") it counts only
// when a Jira account's project is that prefix, so "release-2024" or "v2-1" aren't keys.
export function jiraKey(branch) {
  const m = KEY.exec(branch ?? "");
  if (!m) return null;
  const k = m[1].toUpperCase();
  if (m[1] === k && /^[A-Z][A-Z0-9]+-\d+$/.test(k)) return k;
  const projects = ((shared("wb.tasks.accounts") ?? {}).jira ?? []).map((a) => String(a.project ?? "").toUpperCase());
  return projects.includes(k.split("-")[0]) ? k : null;
}

const clip = (s) => {
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= MAX) return s;
  const cut = s.slice(0, MAX), sp = cut.lastIndexOf(" ");
  return (sp > MAX * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "") + "…";
};

// The words of a branch name: no folder prefixes (feature/, a person's name/), no Jira key, no separators.
function words(branch, key) {
  const parts = (branch ?? "").split("/").filter(Boolean);
  // The last segment carries the description; a key-only last segment ("PROJ-1") leaves the one before it.
  let tail = parts.pop() ?? "";
  if (key) tail = tail.replace(new RegExp(key.replace("-", "[-_]?"), "i"), " ");
  let text = tail.replace(/[-_.]+/g, " ").trim();
  if (!text && parts.length && !PREFIXES.test(parts[parts.length - 1])) text = parts.pop().replace(/[-_.]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

// The title from the branch alone (sync): "KEY Words" / "Words" / the branch itself.
export function branchTitle(branch) {
  const key = jiraKey(branch), w = words(branch, key);
  if (key && known[key]) return clip(`${key} ${known[key]}`);
  return clip([key, w].filter(Boolean).join(" ") || branch || "");
}

// The issue's summary, or null (no key, no account, not found). Cached for the run.
export async function jiraSummary(key) {
  if (!key) return null;
  if (key in known) return known[key];
  known[key] = (await fromCache(key)) ?? (await fromJira(key));
  return known[key];
}

async function fromCache(key) {
  try {
    const store = fileCache("wb-tasks");
    await store.load();
    const accounts = (shared("wb.tasks.accounts") ?? {}).jira ?? [];
    for (const k of [...accounts.map((a) => `jira:cache:${a.id}`), "jira:cache"]) {
      const c = store.get(k, null);
      const hit = [...(c?.issues ?? []), ...(c?.backlog ?? [])].find((i) => i.key === key);
      if (hit?.fields?.summary) return hit.fields.summary;
    }
  } catch {}
  return null;
}

async function fromJira(key) {
  const accounts = (shared("wb.tasks.accounts") ?? {}).jira ?? [];
  const project = key.split("-")[0];
  // The account whose project is this key's first, then the rest.
  const ordered = [...accounts].sort((a, b) => (b.project === project) - (a.project === project));
  for (const acc of ordered) {
    try {
      const token = await getSecret("herdr-jira", acc.id);
      if (!token) continue;
      const auth = "Basic " + Buffer.from(`${acc.email}:${token}`).toString("base64");
      const r = await fetch(`${acc.base ?? acc.site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`, { headers: { Authorization: auth, Accept: "application/json" } });
      if (!r.ok) continue;
      const s = (await r.json())?.fields?.summary;
      if (s) return s;
    } catch {}
  }
  return null;
}
