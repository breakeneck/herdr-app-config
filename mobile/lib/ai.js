'use strict';
// AI models for commit messages, PR review and MR descriptions: the same settings and prompts as the
// desktop's wb-ai (mods/wb-ai/ai.js). claude / codex run their CLI inside the repo through the person's
// interactive shell (nvm, shell functions); local calls an OpenAI-compatible server.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  commit: 'A first line of up to 72 characters in imperative mood. Then, only when they add something, short bullet details ("- ..."), one per line, right under it.',
  review: 'You are reviewing a pull request. Write a concise code review in GitHub-flavored markdown: '
    + 'a short summary of what it changes, then the concrete problems you find (bugs, risks, missing tests, unclear code) as a list, '
    + 'each with a file:line reference and why it matters, then optional suggestions. Skip praise and nitpicks; if nothing is wrong, say so briefly. '
    + 'Reply with the review only.',
  mr: 'Write a merge request description in GitHub-flavored markdown: a one-paragraph summary of what it changes and why, then a short bullet list of the notable changes, then how to test it if that is not obvious. No title line, no praise.',
};
const USES = [['commit', 'Commit messages'], ['review', 'PR review'], ['mr', 'MR description']];
const NO_TRAILERS = 'Do not add any trailers (no Co-Authored-By, no Generated-with lines).';
const languageLine = (lang) => `Write it in ${lang || 'English'}.`;
const DEFAULT_MODELS = [{ id: 'claude', name: 'Claude', provider: 'claude', command: 'claude', args: '-p', model: '' }];

const models = (wb) => (wb.ai && wb.ai.models && wb.ai.models.length ? wb.ai.models : DEFAULT_MODELS);
const stored = (wb, use, key) => { const all = (wb.ai && wb.ai.project) || {}; return [((all[key] || {})[use]) || {}, ((all['*'] || {})[use]) || {}]; };
function modelFor(wb, use, key) {
  const list = models(wb), g = ((wb.ai && wb.ai.use) || {})[use], id = (key && stored(wb, use, key)[0].model) || g;
  return list.find((m) => m.id === id) || list.find((m) => m.id === g) || list[0] || null;
}
function settingsFor(wb, use, key) {
  const [p, g] = stored(wb, use, key);
  return { model: modelFor(wb, use, key), template: p.template || g.template || DEFAULTS[use], language: p.language || g.language || 'English',
    noBlank: use === 'commit' ? (p.noBlank ?? g.noBlank ?? true) : undefined };
}
const describe = (m) => !m ? 'no model' : `${{ claude: 'Claude', codex: 'Codex', local: 'Local' }[m.provider] || m.provider} · ${m.model || (m.provider === 'local' ? 'no model' : 'default')}`;

const NOISE = [/^\s*co-authored-by:/i, /generated with \[?claude code/i, /^\s*🤖/, /^\s*signed-off-by:.*(claude|anthropic|codex|openai|gpt|copilot|\bai\b)/i];
const clean = (text) => String(text ?? '').replace(/^```[^\n]*\n/, '').replace(/\n?```\s*$/, '').split('\n').filter((l) => !NOISE.some((re) => re.test(l))).join('\n').replace(/\s+$/, '').trim();
const split = (s) => String(s || '').split(/\s+/).filter(Boolean);

// The CLI through the interactive shell, the prompt on stdin (no argv size limit).
function runCli(cmd, args, { cwd, input }) {
  const shell = process.env.SHELL || '/bin/bash';
  return new Promise((res) => {
    const ch = spawn(shell, ['-ic', '"$0" "$@"', cmd, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch {} err += '\ntimed out after 10 minutes'; }, 600000);
    ch.stdout.on('data', (d) => (out += d)); ch.stderr.on('data', (d) => (err += d));
    ch.on('error', (e) => { clearTimeout(t); res({ code: 127, stdout: out, stderr: e.message }); });
    ch.on('close', (code) => {
      clearTimeout(t);
      err = err.split('\n').filter((l) => !/^\S+: (cannot set terminal process group|no job control in this shell)/.test(l)).join('\n');
      res({ code: code ?? 1, stdout: out, stderr: err });
    });
    ch.stdin.on('error', () => {});
    ch.stdin.end(input || '');
  });
}

const LATIN = new Set(['English', 'Polish', 'German', 'Spanish', 'French']);
function wrongScript(text, language) {
  if (!LATIN.has(language)) return false;
  const prose = String(text ?? '').replace(/`[^`]*`/g, ' ');
  return (prose.match(/[Ѐ-ӿ]/g) || []).length > (prose.match(/[A-Za-z]/g) || []).length;
}

async function runOnce(m, prompt, { cwd, extra = [] }) {
  if (!m) throw new Error('No AI model configured');
  if (m.provider === 'local') {
    const base = String(m.url || '').replace(/\/+$/, '');
    if (!base) throw new Error(`${m.name}: no server URL`);
    if (!m.model) throw new Error(`${m.name}: no model picked`);
    const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: m.model, messages: [{ role: 'user', content: prompt }], stream: false }), signal: AbortSignal.timeout(600000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return clean(((await r.json()).choices || [])[0]?.message?.content);
  }
  if (m.provider === 'codex') {
    const out = path.join(os.tmpdir(), `herdr-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
    const r = await runCli(m.command || 'codex', [...split(m.args || 'exec'), ...(m.model ? ['-m', m.model] : []), '--skip-git-repo-check', '-s', 'read-only', '-o', out, '-'], { cwd, input: prompt });
    let text = null; try { text = fs.readFileSync(out, 'utf8'); fs.unlinkSync(out); } catch {}
    if (r.code !== 0 && !text) throw new Error((r.stderr || r.stdout || 'codex failed').trim().slice(-300));
    return clean(text ?? r.stdout);
  }
  const r = await runCli(m.command || 'claude', [...split(m.args ?? '-p'), ...(m.model ? ['--model', m.model] : []), ...extra], { cwd, input: prompt });
  if (r.code === 127) throw new Error(`\`${m.command || 'claude'}\` isn't installed on this machine`);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'no output').trim().slice(0, 300));
  return clean(r.stdout);
}

async function runModel(m, prompt, { cwd, language } = {}) {
  if (!language) return runOnce(m, prompt, { cwd });
  const tail = `\n\n---\nIMPORTANT: ${languageLine(language)} Every word of the answer must be in ${language}, whatever language the input, the code comments or your own settings use.`;
  const extra = m && m.provider === 'claude' ? ['--settings', JSON.stringify({ language: language.toLowerCase() })] : [];
  let text = await runOnce(m, prompt + tail, { cwd, extra });
  if (wrongScript(text, language)) text = await runOnce(m, `${prompt}${tail}\n\nYour previous answer was not in ${language}. Answer again, in ${language} only.`, { cwd, extra });
  return text;
}

module.exports = { DEFAULTS, USES, NO_TRAILERS, languageLine, models, modelFor, settingsFor, describe, runModel };
