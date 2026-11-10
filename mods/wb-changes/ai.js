// AI models shared by the whole app: one list of models, and each use (commit messages, PR review,
// MR descriptions) picks its own, per project (repo) when set there. SAME FILE in every mod that uses it. The canonical copy is mods/wb-ai/ai.js:
// edit it there, then run `scripts/sync-helpers.sh --write` to copy it over the others.
//
// shared "wb.ai.models" = [{ id, name, provider: "claude" | "codex" | "local", command?, args?, model, url? }]
// shared "wb.ai.use"    = { commit: <model id>, review: <model id>, mr: <model id> }  (global default model per use)
// shared "wb.ai.project" = { [projectKey]: { [use]: { model?, template?, language?, noBlank? } } }
//   projectKey = "<host>|<path>" of the origin remote (see projectKey()); "*" holds defaults for every project.
// claude / codex run their CLI (the person's subscription) inside the repo folder, on the repo's
// machine; local calls an OpenAI-compatible server (Ollama, LM Studio, llama.cpp).

import { exec, readTextFile, shared, setShared } from "herdr";

export const MODELS = "wb.ai.models", USE = "wb.ai.use";
export const USES = [["commit", "Commit messages"], ["review", "PR review"], ["mr", "MR description"]];
export const PROJECT = "wb.ai.project";
export const DEFAULTS = {
  commit: "A first line of up to 72 characters in imperative mood. Then, only when they add something, short bullet details (\"- ...\"), one per line, right under it. No blank lines anywhere.",
  review: "You are reviewing a pull request. Write a concise code review in GitHub-flavored markdown: "
    + "a short summary of what it changes, then the concrete problems you find (bugs, risks, missing tests, unclear code) as a list, "
    + "each with a file:line reference and why it matters, then optional suggestions. Skip praise and nitpicks; if nothing is wrong, say so briefly. "
    + "Reply with the review only.",
  mr: "Write a merge request description in GitHub-flavored markdown: a one-paragraph summary of what it changes and why, then a short bullet list of the notable changes, then how to test it if that is not obvious. No title line, no praise.",
};
export const LANGUAGES = ["English", "Ukrainian", "Polish", "German", "Spanish", "French"];
export const languageLine = (lang) => `Write it in ${lang || "English"}.`;
export const PROVIDERS = {
  claude: { label: "Claude", command: "claude", args: "-p", hint: "The claude CLI on the repo's machine, on your subscription." },
  codex: { label: "Codex", command: "codex", args: "exec", hint: "The codex CLI on the repo's machine (codex login: your ChatGPT subscription), read-only sandbox." },
  local: { label: "Local", hint: "An OpenAI-compatible server: /v1/models and /v1/chat/completions." },
};
// Model suggestions per CLI; empty = whatever the CLI defaults to. Any name can be typed too.
export const SUGGEST = {
  claude: [["", "CLI default"], ["fable", "fable"], ["opus", "opus"], ["sonnet", "sonnet"], ["haiku", "haiku"]],
  codex: [["", "CLI default"]],
};
export const DEFAULT_URL = "http://localhost:11434/v1";

// One-time: the keys used to be unprefixed ("ai.models"); copy them to "wb.*" when the new one is empty.
export function migrateAi() {
  for (const k of ["ai.models", "ai.use", "ai.reviewDrafts", "ai.localMigrated", "commit.gen"]) {
    if (shared("wb." + k) == null && shared(k) != null) setShared("wb." + k, shared(k));
  }
}

// The first build had one commit-message setting (shared "wb.commit.gen"): it becomes the first models.
function ensure() {
  migrateAi();
  const existing = shared(MODELS);
  if (existing) {
    // Once: a local server set up in the old settings (while Claude was picked) joins the list too.
    const c = shared("wb.commit.gen") ?? {};
    if (!shared("wb.ai.localMigrated") && c.url && c.url !== DEFAULT_URL && !existing.some((m) => m.provider === "local")) {
      setShared(MODELS, [...existing, { id: "local", name: "Local", provider: "local", url: c.url, model: c.provider === "local" ? c.model || "" : "" }]);
    }
    if (!shared("wb.ai.localMigrated")) setShared("wb.ai.localMigrated", true);
    return;
  }
  const c = shared("wb.commit.gen") ?? {}, local = c.provider === "local";
  const list = [{ id: "claude", name: "Claude", provider: "claude", command: (!local && c.command) || "claude", args: (!local && c.args) || "-p", model: (!local && c.model) || "" }];
  if (local && c.url) list.push({ id: "local", name: "Local", provider: "local", url: c.url, model: c.model || "" });
  setShared(MODELS, list);
  setShared(USE, { commit: local && c.url ? "local" : "claude", review: "claude" });
}

export function models() { ensure(); return shared(MODELS) ?? []; }

// One-time: the old global commit template / "No blank lines" (shared "wb.commit.gen") become the
// commit defaults for every project (key "*").
function migrateProject() {
  if (shared("wb.ai.projectMigrated")) return;
  setShared("wb.ai.projectMigrated", true);
  const c = shared("wb.commit.gen") ?? {}, tpl = String(c.template ?? "").trim();
  if (!tpl && c.noBlank !== false) return;
  const all = shared(PROJECT) ?? {};
  setShared(PROJECT, { ...all, "*": { ...all["*"], commit: { ...(tpl ? { template: tpl } : {}), ...(c.noBlank === false ? { noBlank: false } : {}), ...all["*"]?.commit } } });
}
const stored = (use, key) => { migrateProject(); const all = shared(PROJECT) ?? {}; return [all[key]?.[use] ?? {}, all["*"]?.[use] ?? {}]; };

// The model for a use: the project's pick, else the global one, else the first model.
export function modelFor(use, key) {
  const list = models(), id = (key && stored(use, key)[0].model) || (shared(USE) ?? {})[use];
  return list.find((m) => m.id === id) ?? list.find((m) => m.id === (shared(USE) ?? {})[use]) ?? list[0] ?? null;
}
// Effective settings of a use in a project; missing fields fall back project -> "*" -> built-in.
export function settingsFor(use, key) {
  const [p, g] = stored(use, key);
  return {
    model: modelFor(use, key),
    template: p.template || g.template || DEFAULTS[use],
    language: p.language || g.language || "English",
    noBlank: use === "commit" ? (p.noBlank ?? g.noBlank ?? true) : undefined,
  };
}
export function setSetting(use, key, patch) {
  const all = shared(PROJECT) ?? {};
  setShared(PROJECT, { ...all, [key]: { ...all[key], [use]: { ...all[key]?.[use], ...patch } } });
}
export function setUse(use, id, key) {
  if (key) setSetting(use, key, { model: id });
  else setShared(USE, { ...(shared(USE) ?? {}), [use]: id });
}

// "<host>|<path>" of a git remote url (https://h/a/b.git, git@h:a/b.git, ssh://git@h:22/a/b); null if none.
export function remoteKey(url) {
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url) ?? /^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1].toLowerCase()}|${m[2]}` : null;
}
// Pure cache (module code is shared by copies), so sharing it is fine.
const keys = new Map();
export async function projectKey({ cwd, on }) {
  const id = `${on}|${cwd}`;
  if (keys.has(id)) return keys.get(id);
  let key = null;
  const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on }).catch(() => null);
  if (r?.code === 0) key = remoteKey(r.stdout.trim());
  if (!key) {
    const t = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
    key = `${on ?? "local"}:${(t?.code === 0 && t.stdout.trim()) || cwd}`;
  }
  keys.set(id, key);
  return key;
}
export const projectName = (key) => String(key ?? "").includes("|") ? key.split("|").slice(1).join("|") : String(key ?? "").replace(/\/+$/, "").split("/").pop() || String(key ?? "");
export function saveModel(m) {
  const list = models();
  setShared(MODELS, list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m]);
}
// A use whose model is deleted falls back to the first model (modelFor).
export const deleteModel = (id) => setShared(MODELS, models().filter((m) => m.id !== id));
export const describe = (m) => !m ? "no model" : `${PROVIDERS[m.provider]?.label ?? m.provider} · ${m.model || (m.provider === "local" ? "no model" : "default")}`;

// Model names a local server offers, newest-looking first.
export async function localModels(url) {
  const base = String(url || "").replace(/\/+$/, "");
  const r = await fetch(`${base}/models`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.data ?? j.models ?? []).map((m) => m.id ?? m.name).filter(Boolean).sort().reverse();
}

const split = (s) => String(s || "").split(/\s+/).filter(Boolean);
const clean = (text) => String(text ?? "").replace(/^```[^\n]*\n/, "").replace(/\n?```\s*$/, "").trim();

// Runs a model on a prompt and returns its answer. `cwd` / `on`: where a CLI runs (the repo).
// Starts `cmd` through the person's interactive shell, so shell functions, aliases and PATH set up
// in ~/.bashrc (nvm, a `claude` function picking an account per folder) work as in a terminal.
// sh -c: $0 = cmd, $@ = args; the shell gets them as its own $0 / $@ (fish: $argv), unquoted nowhere.
const VIA_SHELL = `case "\${SHELL##*/}" in fish) exec "$SHELL" -ic '$argv' "$0" "$@" ;; *) exec "\${SHELL:-/bin/sh}" -ic '"$0" "$@"' "$0" "$@" ;; esac`;

// exec; a CLI that doesn't start on its own (only a shell function, or on the shell's PATH) is
// retried through the interactive shell; one missing there too says so plainly.
async function run(cmd, args, { cwd, on }) {
  const missing = () => new Error(`\`${cmd}\` isn't installed on ${on ? `machine "${on}"` : "this computer"} (not even in its interactive shell): install it there, or set its full path in AI models settings`);
  try { return await exec(cmd, args, { cwd, on, timeout: 600000 }); }
  catch (e) {
    if (!/cannot start|No such file|not found/i.test(String(e?.message ?? e))) throw e;
  }
  const r = await exec("sh", ["-c", VIA_SHELL, cmd, ...args], { cwd, on, timeout: 600000 });
  if (r.code === 127) throw missing();
  // An interactive shell without a terminal says so on stderr first; that's not the CLI's error.
  return { ...r, stderr: String(r.stderr ?? "").split("\n").filter((l) => !/^\S+: (cannot set terminal process group|no job control in this shell)/.test(l)).join("\n") };
}

export async function runModel(m, prompt, { cwd, on } = {}) {
  if (!m) throw new Error("No AI model: add one in AI models settings");
  if (m.provider === "local") {
    const base = String(m.url || "").replace(/\/+$/, "");
    if (!base) throw new Error(`${m.name}: set its server URL`);
    if (!m.model) throw new Error(`${m.name}: pick a model`);
    const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: m.model, messages: [{ role: "user", content: prompt }], stream: false }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return clean((await r.json()).choices?.[0]?.message?.content);
  }
  if (m.provider === "codex") {
    // The final answer goes to a file (-o): codex's stdout also carries its progress.
    const out = `/tmp/herdr-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
    const args = [...split(m.args || "exec"), ...(m.model ? ["-m", m.model] : []), "--skip-git-repo-check", "-s", "read-only", "-o", out, prompt];
    const r = await run(m.command || "codex", args, { cwd, on });
    const text = await readTextFile(out, { on }).catch(() => null);
    exec("rm", ["-f", out], { on }).catch(() => {});
    if (r.code !== 0 && !text) throw new Error((r.stderr || r.stdout || "codex failed").trim().slice(-300));
    return clean(text ?? r.stdout);
  }
  const r = await run(m.command || "claude", [...split(m.args ?? "-p"), ...(m.model ? ["--model", m.model] : []), prompt], { cwd, on });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "no output").trim().slice(0, 300));
  return clean(r.stdout);
}
