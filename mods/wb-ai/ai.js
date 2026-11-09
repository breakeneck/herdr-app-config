// AI models shared by the whole app: one list of models, and each use (commit messages, PR review)
// picks its own. SAME FILE in every mod that uses it. The canonical copy is mods/wb-ai/ai.js:
// edit it there, then run `scripts/sync-helpers.sh --write` to copy it over the others.
//
// shared "wb.ai.models" = [{ id, name, provider: "claude" | "codex" | "local", command?, args?, model, url? }]
// shared "wb.ai.use"    = { commit: <model id>, review: <model id> }
// claude / codex run their CLI (the person's subscription) inside the repo folder, on the repo's
// machine; local calls an OpenAI-compatible server (Ollama, LM Studio, llama.cpp).

import { exec, readTextFile, shared, setShared } from "herdr";

export const MODELS = "wb.ai.models", USE = "wb.ai.use";
export const USES = [["commit", "Commit messages"], ["review", "PR review"]];
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
export function modelFor(use) {
  const list = models(), id = (shared(USE) ?? {})[use];
  return list.find((m) => m.id === id) ?? list[0] ?? null;
}
export const setUse = (use, id) => setShared(USE, { ...(shared(USE) ?? {}), [use]: id });
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
    const r = await exec(m.command || "codex", args, { cwd, on, timeout: 600000 });
    const text = await readTextFile(out, { on }).catch(() => null);
    exec("rm", ["-f", out], { on }).catch(() => {});
    if (r.code !== 0 && !text) throw new Error((r.stderr || r.stdout || "codex failed").trim().slice(-300));
    return clean(text ?? r.stdout);
  }
  const r = await exec(m.command || "claude", [...split(m.args ?? "-p"), ...(m.model ? ["--model", m.model] : []), prompt], { cwd, on, timeout: 600000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "no output").trim().slice(0, 300));
  return clean(r.stdout);
}
