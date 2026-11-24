'use strict';
// herdr-mobile: watch and drive Herdr terminals/agents from a phone browser.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const clients = new Set();
const PORT = +process.env.PORT || 7681;
const HOME = os.homedir();
const CONF = process.env.HERDR_MOBILE_HOME || path.join(HOME, '.config', 'herdr-mobile');
const TOKEN_FILE = path.join(CONF, 'token');
const PROJECTS_FILE = path.join(CONF, 'projects.json');
const PUB = path.join(__dirname, 'public');
const HC = process.env.HC || 'hc';
const MACHINE = process.env.HERDR_MACHINE || 'server';

fs.mkdirSync(CONF, { recursive: true });
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, TOKEN + '\n', { mode: 0o600 });
}

// ---------- auth ----------
const eq = (a, b) => { const x = Buffer.from(a || ''), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function cookieOf(req) {
  const m = /(?:^|;\s*)hm=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}
const authed = (req, url) => eq(cookieOf(req), TOKEN) || eq(url.searchParams.get('token') || '', TOKEN);
const setCookie = `hm=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 3650}`;
const OPEN_PATHS = new Set(['/manifest.json', '/icon-192.png', '/icon-512.png', '/icon.svg']);

// ---------- helpers ----------
const run = (cmd, args, opts = {}) => new Promise((res) => {
  execFile(cmd, args, { maxBuffer: 16 << 20, timeout: 60000, ...opts }, (err, stdout, stderr) =>
    res({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});
const rid = () => crypto.randomBytes(16).toString('hex');
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const worst = (a, b) => ((RANK[b] || 0) > (RANK[a] || 0) ? b : a);

// ---------- hc connect (JSON-RPC) ----------
// events.subscribe turns a connection into a stream (it ignores further requests),
// so one long-lived child streams events and a second one answers requests.
let terminals = [], doc = null, refreshTimer = null;

function conn(onMsg, onReady) {
  const c = { child: null, pending: new Map(), nextId: 1 };
  c.rpc = (method, params, timeout = 15000) => new Promise((res, rej) => {
    if (!c.child) return rej(new Error('core not connected'));
    const id = c.nextId++;
    const t = setTimeout(() => { c.pending.delete(id); rej(new Error('rpc timeout ' + method)); }, timeout);
    c.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const start = () => {
    const ch = spawn(HC, ['connect'], { stdio: ['pipe', 'pipe', 'inherit'] });
    c.child = ch; let buf = '';
    ch.stdout.setEncoding('utf8');
    ch.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && c.pending.has(m.id)) {
          const p = c.pending.get(m.id); c.pending.delete(m.id);
          if (m.error) p.rej(new Error(m.error.message || JSON.stringify(m.error))); else p.res(m.result);
        } else onMsg && onMsg(m);
      }
    });
    ch.stdin.on('error', () => {});
    ch.on('error', (e) => console.error('hc connect error', e.message));
    ch.on('exit', () => {
      if (c.child === ch) c.child = null;
      for (const [, p] of c.pending) p.rej(new Error('core connection lost'));
      c.pending.clear();
      setTimeout(start, 1500);
    });
    c.rpc('hello', {}).then(() => onReady && onReady(c)).catch((e) => console.error('core init', e.message));
  };
  c.start = start;
  return c;
}
const reqConn = conn(null, () => { fetchDoc().then(refreshTerminals).catch((e) => console.error(e.message)); });
const rpc = (m, p, t) => reqConn.rpc(m, p, t);
const evConn = conn((m) => {
  if (m.method !== 'event') return;
  if ((m.params || {}).type === 'doc') fetchDoc().then(scheduleRebuild).catch(() => {});
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshTerminals, 120);
}, (c) => {
  c.rpc('events.subscribe', {}).then(() => { fetchDoc().then(refreshTerminals).catch(() => {}); }).catch((e) => console.error(e.message));
});
async function fetchDoc() { const r = await rpc('doc.get', { name: 'herdr-app' }); doc = r.value; }
async function refreshTerminals() {
  try { const r = await rpc('terminal.list', {}); terminals = (r.terminals || r).filter((t) => t.state === 'live'); updateSeen(); scheduleRebuild(); } catch (e) { console.error(e.message); }
}

// ---------- seen: "done" = finished while nobody looked; it becomes "idle" once someone looks (as the desktop) ----------
// Looking = a viewer attached to the terminal (phone terminal screen or a wide-layout card).
// seen.json keeps the done terminals already looked at; an entry goes when the agent leaves "done".
const SEEN_FILE = path.join(CONF, 'seen.json');
const watching = new Map(); // address -> open attach count
let seen = new Set();
try { seen = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch {}
const rawState = (t) => (t.status && t.status.state) || '';
function saveSeen() { try { fs.writeFileSync(SEEN_FILE + '.tmp', JSON.stringify([...seen])); fs.renameSync(SEEN_FILE + '.tmp', SEEN_FILE); } catch (e) { console.error('seen:', e.message); } }
function updateSeen() {
  const next = new Set();
  for (const t of terminals) if (rawState(t) === 'done' && (seen.has(t.address) || watching.get(t.address) > 0)) next.add(t.address);
  if (next.size !== seen.size || [...next].some((a) => !seen.has(a))) { seen = next; saveSeen(); }
}

// ---------- projects ----------
let projects = [];
function loadProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.projects || [];
    const seen = new Set(); const out = [];
    for (const p of list) {
      if (p.machine && p.machine !== MACHINE) continue;
      let pa = String(p.path || '').replace(/^~(?=$|\/)/, HOME).replace(/\/+$/, '');
      if (!pa || seen.has(pa)) continue;
      seen.add(pa); out.push({ name: p.name || path.basename(pa), path: pa });
    }
    projects = out;
  } catch (e) { projects = []; }
  scheduleRebuild();
}

// ---------- git ----------
const gitInfo = new Map(); // path -> {branch, ahead, behind, dirty}
async function git(dir, args) { return run('git', ['-C', dir, ...args]); }
async function pollGit() {
  await Promise.all(projects.map(async (p) => {
    const r = await git(p.path, ['status', '--porcelain=v2', '--branch']);
    if (!r.ok) { gitInfo.set(p.path, null); return; }
    const g = { branch: '', ahead: 0, behind: 0, dirty: false };
    for (const l of r.stdout.split('\n')) {
      if (l.startsWith('# branch.head ')) g.branch = l.slice(14);
      else if (l.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(l); if (m) { g.ahead = +m[1]; g.behind = +m[2]; } }
      else if (l && l[0] !== '#') g.dirty = true;
    }
    if (g.branch === '(detached)') { const h = await git(p.path, ['rev-parse', '--short', 'HEAD']); g.branch = '@' + h.stdout.trim(); }
    gitInfo.set(p.path, g);
  }));
  scheduleRebuild();
}
setInterval(() => { if (clients.size) pollGit(); }, 10000);
// Working-tree changes, same rules as the desktop Changes mod (defaults/mods/changes in herdr-app).
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie).
const GIT_READ = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false'];
const countLines = (t) => (t ? t.split('\n').length - Number(t.endsWith('\n')) : 0);
async function changedFiles(dir) {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const root = top.stdout.trim(), g = (args) => git(root, [...GIT_READ, ...args]);
  const [status, head] = await Promise.all([g(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']), g(['rev-parse', '--verify', 'HEAD'])]);
  if (!status.ok) return null;
  const stats = {};
  const results = head.ok ? [await g(['diff', 'HEAD', '--numstat', '-z', '--no-renames'])] : [await g(['diff', '--cached', '--numstat', '-z', '--no-renames']), await g(['diff', '--numstat', '-z', '--no-renames'])];
  for (const r of results) for (const e of r.stdout.split('\0')) {
    const [a, d, ...parts] = e.split('\t'); if (!parts.length) continue;
    const path = parts.join('\t'), old = stats[path] || { add: 0, del: 0 };
    stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === '-' };
  }
  const entries = status.stdout.split('\0').filter(Boolean), files = [];
  for (const e of entries.slice(0, 1000)) {
    const xy = e.slice(0, 2), path = e.slice(3), fresh = xy === '??';
    const conflict = xy.includes('U') || xy === 'AA' || xy === 'DD';
    const st = conflict ? 'U' : xy.includes('D') ? 'D' : fresh || xy.includes('A') ? 'A' : 'M';
    files.push({ path, status: st, fresh, ...(stats[path] || { add: 0, del: 0 }) });
  }
  return { root, hasHead: head.ok, files, limited: entries.length > 1000 };
}
async function fileDiff(ch, f) {
  let lines;
  if (f.fresh || (!ch.hasHead && f.status === 'A')) {
    let text = null;
    try { const full = path.join(ch.root, f.path); if (fs.statSync(full).size <= 4e6) text = fs.readFileSync(full, 'utf8'); } catch {}
    if (text === null) lines = ['Cannot preview this file (binary, too large, or unreadable)'];
    else if (text.includes('\0')) lines = ['Binary file · no text diff'];
    else { const n = countLines(text); lines = [`@@ -0,0 +1,${n} @@`, ...text.slice(0, 400000).replace(/\n$/, '').split('\n').slice(0, 1500).map((l) => '+' + l)]; }
  } else {
    const r = await git(ch.root, [...GIT_READ, 'diff', ...(ch.hasHead ? ['HEAD'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '--', f.path]);
    if (!r.ok) throw new Error(r.stderr.trim() || 'git diff failed');
    const all = r.stdout.replace(/\n$/, '').split('\n'), first = all.findIndex((l) => l.startsWith('@@'));
    lines = first < 0 ? [f.binary ? 'Binary file changed' : 'No text diff available'] : all.slice(first);
  }
  return lines.slice(0, 1500).map((l) => (l.length > 4000 ? l.slice(0, 4000) + '… (line truncated)' : l));
}

// ---------- state ----------
function walk(node, out) {
  if (!node) return out;
  if (node.type === 'block') { if (node.content && node.content.terminal) out.push(node.content.terminal); }
  else (node.children || []).forEach((c) => walk(c, out));
  return out;
}
// A tab's split tree for the wide (desktop) layout: rows/columns with weights, terminal or mod leaves.
function strip(n) {
  if (!n) return null;
  const w = n.size && n.size.weight;
  if (n.type === 'block') { const c = n.content || {}; return { t: c.terminal || null, mod: c.mod || null, w }; }
  return { type: n.type, w, children: (n.children || []).map(strip).filter(Boolean) };
}
function buildState() {
  const tmap = new Map(terminals.map((t) => [t.address, t]));
  const spaces = ((doc && doc.spaces) || []).map((s) => {
    let status = 'idle', any = false;
    const tabs = (s.tabs || []).map((tb, i) => {
      let tstatus = 'idle';
      const terms = walk(tb.root, []).map((a) => tmap.get(a)).filter(Boolean).map((t) => {
        let st = rawState(t);
        if (st === 'done' && seen.has(t.address)) st = 'idle';
        tstatus = worst(tstatus, st);
        any = true;
        return { address: t.address, title: t.title || '', program: (t.foreground && t.foreground.name) || (t.argv && t.argv[0]) || '', app: (t.status && t.status.app) || '', status: st || 'idle', msg: (t.status && t.status.msg) || '', cwd: t.cwd, cols: t.cols, rows: t.rows };
      });
      status = worst(status, tstatus);
      const unread = terms.filter((x) => x.status === 'done').length; // finished while nobody looked
      return { id: tb.id, name: tb.name || '', index: i + 1, status: tstatus, unread, terminals: terms, root: strip(tb.root) };
    });
    return { id: s.id, name: s.name, folder: s.folder, status, unread: tabs.reduce((n, t) => n + t.unread, 0), tabs, _cwds: tabs.flatMap((t) => t.terminals.map((x) => x.cwd)) };
  });
  const deepest = (p) => projects.filter((pr) => inside(p, pr.path)).sort((a, b) => b.path.length - a.path.length)[0];
  const owner = new Map(); // space id -> project path
  for (const s of spaces) {
    let o = s.folder && deepest(s.folder);
    if (!o) { const counts = {}; for (const c of s._cwds) { const d = c && deepest(c); if (d) counts[d.path] = (counts[d.path] || 0) + 1; } const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]; if (best) o = projects.find((p) => p.path === best[0]); }
    if (o) owner.set(s.id, o.path);
  }
  const plist = projects.map((p, i) => {
    const sp = spaces.filter((s) => owner.get(s.id) === p.path);
    let status = ''; for (const s of sp) status = worst(status, s.status);
    const g = gitInfo.get(p.path);
    const working = sp.some((s) => s.tabs.some((tb) => tb.terminals.some((x) => x.status === 'working')));
    const unread = sp.reduce((n, s) => n + s.unread, 0);
    return { idx: i, name: p.name, path: p.path, git: g || null, open: sp.length > 0, status: sp.length ? status : '', working, unread, spaces: sp.map((s) => s.id) };
  });
  for (const s of spaces) delete s._cwds;
  let colors = {}; try { colors = conf.wb().colors || {}; } catch {}
  return { projects: plist, spaces, other: spaces.filter((s) => !owner.has(s.id)).map((s) => s.id), colors, machine: MACHINE, time: Date.now() };
}
let lastJson = '', rebuildTimer = null, stateObj = { projects: [], spaces: [], other: [] };
function scheduleRebuild() { if (!rebuildTimer) rebuildTimer = setTimeout(rebuild, 50); }
function rebuild() {
  rebuildTimer = null;
  stateObj = buildState();
  const { time, ...rest } = stateObj;
  const j = JSON.stringify(rest);
  if (j === lastJson) return;
  lastJson = j;
  const msg = JSON.stringify(stateObj);
  for (const c of clients) if (c.readyState === 1) c.send(msg);
}

// ---------- adopt: a new terminal becomes a tab in the herdr-app document ----------
// Compare-and-set on the doc version; a conflict (the desktop wrote meanwhile) re-reads and retries.
async function adopt(address, spaceId, tabId, folder, tabName) {
  for (let i = 0; i < 6; i++) {
    const r = await rpc('doc.get', { name: 'herdr-app' });
    const d = r.value && typeof r.value === 'object' ? r.value : { spaces: [] };
    d.spaces = d.spaces || [];
    if (d.spaces.some((s) => (s.tabs || []).some((t) => walk(t.root, []).includes(address)))) return; // the desktop got there first
    let sp = d.spaces.find((s) => s.id === spaceId);
    if (!sp) { sp = { folder, id: spaceId, name: '', tabs: [] }; d.spaces.push(sp); }
    sp.tabs = sp.tabs || [];
    let tb = sp.tabs.find((t) => t.id === tabId);
    if (!tb) sp.tabs.push(tb = { id: tabId, name: tabName || '', root: { children: [], id: tabId, type: 'row' } });
    tb.root.children.push({ content: { terminal: address }, id: 'p' + rid(), type: 'block' });
    try { await rpc('doc.set', { name: 'herdr-app', value: d, version: r.version }); doc = d; scheduleRebuild(); return; }
    catch (e) { if (!/conflict/i.test(e.message)) throw e; await new Promise((ok) => setTimeout(ok, 150)); }
  }
  throw new Error('doc kept changing');
}

// ---------- workbench: tasks, pull requests, AI (desktop wb-tasks / wb-prs / wb-ai) ----------
const conf = require('./lib/conf').make(CONF);
const ai = require('./lib/ai');
const asr = require('./lib/asr');
const tasksApi = require('./lib/tasks').make(conf);
const prsApi = require('./lib/prs').make(conf, ai, tasksApi);
const repoCache = new Map(); // project path -> repo, for a minute
async function repoFor(idx) {
  const pr = projectByIdx(idx); if (!pr) throw Object.assign(new Error('no project'), { code: 404 });
  const c = repoCache.get(pr.path);
  if (c && Date.now() - c.at < 60000) return c.repo;
  const repo = await prsApi.repoOf(pr.path);
  repoCache.set(pr.path, { repo, at: Date.now() });
  return repo;
}
// AI work outlives the request (a phone sleeps): a job id to poll, the text also kept as a draft.
const jobs = new Map();
function startJob(kind, id, fn, save) {
  for (const [jid, j] of jobs) if (j.kind === kind && j.id === id && j.state === 'running') return jid;
  const jid = rid();
  const j = { kind, id, state: 'running', at: Date.now() };
  jobs.set(jid, j);
  fn().then((out) => { j.state = 'done'; j.result = out; try { save && save(out); } catch (e) { console.error(e); } },
    (e) => { j.state = 'error'; j.error = String(e.message || e); })
    .finally(() => { j.done = Date.now(); for (const [k, x] of jobs) if (x.done && Date.now() - x.done > 3600e3) jobs.delete(k); });
  return jid;
}
const runningJob = (kind, id) => { for (const [jid, j] of jobs) if (j.kind === kind && j.id === id && j.state === 'running') return jid; return null; };
const guard = async (fn) => { try { return await fn(); } catch (e) { return { error: String(e.message || e), code: e.code === 404 ? 404 : 500 }; } };

async function aiFor(repo) {
  const wb = conf.wb();
  return { models: ai.models(wb).map((m) => ({ id: m.id, name: m.name, describe: ai.describe(m) })),
    uses: ai.USES.map(([use, label]) => { const s = ai.settingsFor(wb, use, repo.key); return { use, label, model: s.model && s.model.id, language: s.language }; }) };
}
async function commitMessage(pr, paths) {
  const ch = await changedFiles(pr.path); if (!ch) throw new Error('Not a git repository');
  const known = new Set(ch.files.map((f) => f.path)), picked = (paths || []).filter((x) => known.has(x));
  const only = picked.length && picked.length < ch.files.length ? ['--', ...picked] : [];
  const repo = await prsApi.repoOf(pr.path), cfg = ai.settingsFor(conf.wb(), 'commit', repo.key);
  const g = (args) => git(ch.root, ['--literal-pathspecs', ...GIT_READ, ...args]);
  const [st, df] = await Promise.all([g(['status', '--short', ...only]), g(['diff', ...(ch.hasHead ? ['HEAD'] : []), '--no-color', ...only])]);
  const fresh = st.stdout.split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3)).slice(0, 20);
  let text = `Git status:\n${st.stdout}\n\nDiff:\n${df.stdout.slice(0, 60000)}`;
  if (fresh.length) text += `\n\nNew untracked files (contents not shown): ${fresh.join(', ')}`;
  const prompt = `Write one git commit message for these changes in this repository. Format: ${cfg.template}${cfg.noBlank !== false ? ' No blank lines anywhere.' : ''} Reply with the message only — no quotes, no code fences, no explanations. ${ai.NO_TRAILERS} ${ai.languageLine(cfg.language)}`;
  let msg = await ai.runModel(cfg.model, `${prompt}\n\n${text}`, { cwd: ch.root, language: cfg.language });
  if (cfg.noBlank !== false) msg = msg.split('\n').filter((l) => l.trim()).join('\n');
  if (!msg) throw new Error('the model returned nothing');
  return { text: msg, model: cfg.model && cfg.model.name };
}

async function workbenchGet(p, q) {
  const idx = q.get('project');
  if (p === '/api/job') { const j = jobs.get(q.get('id') || ''); return j ? { state: j.state, result: j.result, error: j.error } : { error: 'unknown job', code: 404 }; }
  if (p === '/api/repo') return guard(async () => {
    const r = await repoFor(idx), pr = projectByIdx(idx), d = conf.drafts();
    return { repo: { key: r.key, name: r.name, host: r.host, github: r.github }, ai: await aiFor(r), tasks: tasksApi.source(r.key), taskOptions: tasksApi.options(),
      commitDraft: (d.commit || {})[pr.path] || null, commitJob: runningJob('commit', pr.path) };
  });
  if (p === '/api/tasks') return guard(async () => tasksApi.list((await repoFor(idx)).key, { mine: q.get('mine') === '1' }));
  if (p === '/api/task') return guard(async () => tasksApi.detail((await repoFor(idx)).key, q.get('id')));
  if (p === '/api/trello-boards') return guard(async () => ({ boards: await tasksApi.trelloBoards(q.get('account')) }));
  if (p === '/api/prs') return guard(async () => ({ prs: await prsApi.list(await repoFor(idx), q.get('mine') === '1') }));
  if (p === '/api/pr') return guard(async () => {
    const d = await prsApi.detail(await repoFor(idx), +q.get('n'));
    return { ...d, draft: (conf.drafts().review || {})[d.url] || null, reviewJob: runningJob('review', d.url) };
  });
  if (p === '/api/mr-info') return guard(async () => { const r = await repoFor(idx), info = await prsApi.createInfo(r); return { ...info, job: runningJob('mr', `${r.key}|${info.branch}`) }; });
  if (p === '/api/mr-commits') return guard(async () => ({ commits: await prsApi.commits(await repoFor(idx), q.get('target')) }));
  return null;
}
async function workbenchPost(p, b) {
  if (p === '/api/task-source') return guard(async () => { const r = await repoFor(b.project); tasksApi.setSource(r.key, b.source || { kind: 'none' }); return { ok: true }; });
  if (p === '/api/task-move') return guard(async () => { await tasksApi.move((await repoFor(b.project)).key, String(b.id), String(b.group)); return { ok: true }; });
  if (p === '/api/ai-use') return guard(async () => {
    const r = await repoFor(b.project), wb = conf.wb(), a = wb.ai || {}, all = a.project || {};
    if (!ai.models(wb).some((m) => m.id === b.model)) throw new Error('unknown model');
    conf.setWb({ ai: { ...a, project: { ...all, [r.key]: { ...all[r.key], [b.use]: { ...(all[r.key] || {})[b.use], model: b.model } } } } });
    return { ok: true };
  });
  if (p === '/api/ai-commit') return guard(async () => {
    const pr = projectByIdx(b.project); if (!pr) throw Object.assign(new Error('no project'), { code: 404 });
    return { job: startJob('commit', pr.path, () => commitMessage(pr, b.paths), (out) => conf.setDraft('commit', pr.path, out.text)) };
  });
  if (p === '/api/commit-draft') return guard(async () => { const pr = projectByIdx(b.project); conf.setDraft('commit', pr.path, b.text ? String(b.text) : null); return { ok: true }; });
  if (p === '/api/pr-approve') return guard(async () => { await prsApi.approve(await repoFor(b.project), +b.n, b.approve !== false); return { ok: true }; });
  if (p === '/api/pr-comment') return guard(async () => {
    const text = String(b.body || '').trim(); if (!text) throw new Error('empty comment');
    await prsApi.comment(await repoFor(b.project), +b.n, text);
    if (b.url && b.fromDraft) conf.setDraft('review', String(b.url), null);
    return { ok: true };
  });
  if (p === '/api/pr-review') return guard(async () => {
    const r = await repoFor(b.project), url = String(b.url || '');
    return { job: startJob('review', url, () => prsApi.review(r, +b.n), (out) => conf.setDraft('review', url, { text: out.text, model: out.model, at: new Date().toISOString() })) };
  });
  if (p === '/api/review-draft') return guard(async () => { conf.setDraft('review', String(b.url || ''), b.text ? { text: String(b.text), at: new Date().toISOString() } : null); return { ok: true }; });
  if (p === '/api/mr-describe') return guard(async () => {
    const r = await repoFor(b.project), id = `${r.key}|${b.branch}`;
    return { job: startJob('mr', id, () => prsApi.describe(r, b), (out) => conf.setDraft('mr', id, { ...((conf.drafts().mr || {})[id] || {}), title: b.title, target: b.target, description: out.text, at: Date.now() })) };
  });
  if (p === '/api/mr-draft') return guard(async () => { const r = await repoFor(b.project); conf.setDraft('mr', `${r.key}|${b.branch}`, { title: b.title, target: b.target, description: b.description, draft: Boolean(b.draft), at: Date.now() }); return { ok: true }; });
  if (p === '/api/mr-create') return guard(async () => {
    const title = String(b.title || '').trim(); if (!title) throw new Error('Title is empty');
    const out = await prsApi.create(await repoFor(b.project), { target: String(b.target || ''), title, body: String(b.description || ''), draft: Boolean(b.draft) });
    pollGit();
    return { ok: true, ...out };
  });
  return null;
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); });
const projectByIdx = (i) => projects[+i];

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/state') return send(res, 200, stateObj);
  if (p === '/api/branches') {
    const pr = projectByIdx(url.searchParams.get('project')); if (!pr) return send(res, 404, { error: 'no project' });
    const [loc, rem, cur] = await Promise.all([
      git(pr.path, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']),
      git(pr.path, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin']),
      git(pr.path, ['branch', '--show-current']),
    ]);
    const local = loc.stdout.split('\n').filter(Boolean);
    const remote = rem.stdout.split('\n').filter((b) => b && b !== 'origin' && !b.endsWith('/HEAD')).map((b) => b.replace(/^origin\//, '')).filter((b) => !local.includes(b));
    return send(res, 200, { current: cur.stdout.trim(), local, remote });
  }
  if (p === '/api/changes') {
    const pr = projectByIdx(url.searchParams.get('project')); if (!pr) return send(res, 404, { error: 'no project' });
    const ch = await changedFiles(pr.path);
    if (!ch) return send(res, 200, { notRepo: true, files: [] });
    return send(res, 200, { files: ch.files, limited: ch.limited });
  }
  if (p === '/api/diff') {
    const pr = projectByIdx(url.searchParams.get('project')); if (!pr) return send(res, 404, { error: 'no project' });
    // Only paths git itself reports as changed are accepted, never arbitrary client paths.
    const ch = await changedFiles(pr.path);
    const f = ch && ch.files.find((x) => x.path === url.searchParams.get('file'));
    if (!f) return send(res, 404, { error: 'file not changed' });
    try { return send(res, 200, { lines: await fileDiff(ch, f) }); }
    catch (e) { return send(res, 500, { error: 'Cannot preview this diff (too large or unreadable): ' + e.message }); }
  }
  if (p === '/api/folders') {
    const want = String(url.searchParams.get('path') || '~').replace(/^~(?=$|\/)/, HOME);
    let dir;
    try { dir = fs.realpathSync(want); } catch { return send(res, 404, { error: 'No such folder: ' + want }); }
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return send(res, 403, { error: e.code === 'EACCES' ? 'Permission denied' : e.message }); }
    const dirs = ents.filter((e) => e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; } })()))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const git = fs.existsSync(path.join(dir, '.git'));
    return send(res, 200, { path: dir, home: HOME, shown: dir === HOME ? '~' : dir.startsWith(HOME + '/') ? '~' + dir.slice(HOME.length) : dir, dirs, git,
      known: projects.some((x) => x.path === dir) });
  }
  if (p === '/api/reply-draft') {
    // The terminal screen's unsent reply, per terminal (kept on the server: every device and the http and
    // https pages see the same one). GET ?t= → { text }; POST { terminal, text } ('' removes it).
    if (req.method === 'GET') return send(res, 200, { text: ((conf.drafts().reply || {})[url.searchParams.get('t') || '']) || '' });
    const chunks = []; await new Promise((ok) => { req.on('data', (d) => chunks.push(d)); req.on('end', ok); req.on('error', ok); });
    let b = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
    const t = String(b.terminal || ''); if (!/^[\w\/-]+$/.test(t)) return send(res, 400, { error: 'bad terminal' });
    const d = conf.drafts(), reply = d.reply || {}, live = new Set(terminals.map((x) => x.address));
    if (live.size) for (const k of Object.keys(reply)) if (!live.has(k)) conf.setDraft('reply', k, null); // closed terminals
    conf.setDraft('reply', t, String(b.text || '').trim() ? String(b.text).slice(0, 100000) : null);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/upload') {
    // An image for an agent (pasted or picked on the phone): the raw file is the body. It is saved under
    // ~/.cache/herdr-mobile/uploads and the answer is its path, which goes into the reply text
    // (Claude Code and Codex read an image from a path in the prompt). Files older than 7 days are removed.
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/bmp': 'bmp' }[type];
    if (!ext) return send(res, 415, { error: 'Not an image: ' + (type || 'unknown type') });
    const chunks = []; let size = 0, big = false;
    await new Promise((ok) => { req.on('data', (d) => { size += d.length; if (size > 30e6) big = true; else chunks.push(d); }); req.on('end', ok); req.on('error', ok); });
    if (big) return send(res, 413, { error: 'Image too large (30 MB max)' });
    if (!size) return send(res, 400, { error: 'Empty image' });
    const dir = path.join(HOME, '.cache', 'herdr-mobile', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    try { const old = Date.now() - 7 * 864e5; for (const f of fs.readdirSync(dir)) { const fp = path.join(dir, f); if (fs.statSync(fp).mtimeMs < old) fs.unlinkSync(fp); } } catch {}
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = path.join(dir, `img-${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
    fs.writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 });
    return send(res, 200, { path: file });
  }
  if (p === '/api/asr') {
    // Dictation: the raw recording is the body (Content-Type = its audio type); answers { text }.
    if (req.method === 'GET') return send(res, 200, { enabled: asr.enabled(), https: httpsServer ? HTTPS_PORT : 0 });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    const chunks = []; let size = 0, big = false;
    await new Promise((ok) => { req.on('data', (d) => { size += d.length; if (size > 20e6) big = true; else chunks.push(d); }); req.on('end', ok); req.on('error', ok); });
    if (big) return send(res, 413, { error: 'Recording too long' });
    if (!size) return send(res, 400, { error: 'Empty recording' });
    try { return send(res, 200, { text: await asr.transcribe(Buffer.concat(chunks), req.headers['content-type']) }); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (req.method === 'GET') { const g = await workbenchGet(p, url.searchParams); if (g) return send(res, g.code || (g.error ? 500 : 200), g); }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
  const body = await readBody(req);
  if (p === '/api/send') {
    if (!/^[\w\/-]+$/.test(body.terminal || '')) return send(res, 400, { error: 'bad terminal' });
    try { await rpc('terminal.send', { terminal: body.terminal, text: String(body.text || ''), force: true }); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (p === '/api/new') {
    const pr = projectByIdx(body.project); if (!pr) return send(res, 404, { error: 'no project' });
    const st = stateObj.projects.find((x) => x.path === pr.path);
    let space = st && st.spaces[0], cwd = pr.path;
    if (space) { const sp = stateObj.spaces.find((s) => s.id === space); cwd = (sp && sp.folder) || cwd; }
    const spaceId = space || 'sp' + rid(), tabId = 'tb' + rid();
    const args = ['run', '--bg', '--keep', '--no-parent', '--cwd', cwd, '--label', 'herdr.space=' + spaceId, '--label', 'herdr.tab=' + tabId, '--json'];
    // Like the desktop's launcher: the agent in the interactive shell, which stays open after it exits.
    if (body.kind === 'claude') args.push('--', 'bash', '-ic', 'claude; exec bash -i');
    const r = await run(HC, args);
    if (!r.ok) return send(res, 500, { error: (r.stderr || r.stdout).trim() });
    let address = null; try { address = JSON.parse(r.stdout).address; } catch {}
    // The desktop app adopts labelled terminals into its document, but only while it runs: write the tab ourselves.
    if (address) {
      try { await adopt(address, spaceId, tabId, cwd, body.kind === 'claude' ? 'Claude Code' : ''); }
      catch (e) { console.error('adopt', e.message); }
    }
    return send(res, 200, { ok: true, address, newSpace: !space });
  }
  if (p === '/api/projects/add') {
    let dir = String(body.path || '').replace(/^~(?=$|\/)/, HOME).replace(/\/+$/, '') || '/';
    try { dir = fs.realpathSync(dir); if (!fs.statSync(dir).isDirectory()) throw new Error(); } catch { return send(res, 400, { error: 'Not a folder: ' + dir }); }
    let raw = { projects: [] };
    try { raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); if (Array.isArray(raw)) raw = { projects: raw }; } catch {}
    raw.projects = raw.projects || [];
    if (!raw.projects.some((x) => String(x.path).replace(/^~(?=$|\/)/, HOME).replace(/\/+$/, '') === dir)) {
      // from: "mobile" until the desktop's Remote projects takes it over (wb-projects), see deploy.sh.
      raw.projects.push({ machine: MACHINE, name: String(body.name || '').trim() || path.basename(dir), path: dir, from: 'mobile' });
      fs.writeFileSync(PROJECTS_FILE + '.tmp', JSON.stringify(raw, null, 2) + '\n'); fs.renameSync(PROJECTS_FILE + '.tmp', PROJECTS_FILE);
    }
    loadProjects();
    return send(res, 200, { ok: true, idx: projects.findIndex((x) => x.path === dir) });
  }
  const wbRes = await workbenchPost(p, body);
  if (wbRes) return send(res, wbRes.code || (wbRes.error ? 500 : 200), wbRes);
  if (p === '/api/close-tab') {
    // Addresses come from our own copy of the herdr-app doc, never from the client.
    try { await fetchDoc(); } catch (e) { return send(res, 502, { error: 'core unavailable: ' + e.message }); }
    const sp = ((doc && doc.spaces) || []).find((x) => x.id === body.spaceId);
    const tb = sp && (sp.tabs || []).find((x) => x.id === body.tabId);
    if (!tb) return send(res, 404, { error: 'tab not found' });
    const addrs = walk(tb.root, []);
    const results = [];
    for (const a of addrs) {
      try { await rpc('terminal.kill', { terminal: a }); results.push({ terminal: a, ok: true }); }
      catch (e) { results.push({ terminal: a, ok: false, error: e.message }); }
    }
    const ok = results.every((r) => r.ok);
    return send(res, ok ? 200 : 500, { ok, results, error: ok ? undefined : results.filter((r) => !r.ok).map((r) => r.terminal + ': ' + r.error).join('; ') });
  }
  if (p === '/api/commit') {
    // Like wb-changes: everything checked stages all; otherwise stage and commit just the checked paths (literal).
    const pr = projectByIdx(body.project); if (!pr) return send(res, 404, { error: 'no project' });
    const msg = String(body.message || '').trim(); if (!msg) return send(res, 400, { error: 'empty message' });
    const ch = await changedFiles(pr.path); if (!ch) return send(res, 400, { error: 'Not a git repository' });
    const known = new Set(ch.files.map((f) => f.path));
    const picked = [...new Set((Array.isArray(body.paths) ? body.paths : []).map(String))].filter((x) => known.has(x));
    if (!picked.length) return send(res, 400, { error: 'Nothing checked' });
    const partial = picked.length < ch.files.length || ch.limited;
    const cmds = partial ? [['--literal-pathspecs', 'add', '-A', '--', ...picked], ['--literal-pathspecs', 'commit', '-m', msg, '--', ...picked]] : [['add', '-A'], ['commit', '-m', msg]];
    for (const args of cmds) {
      const r = await git(ch.root, args);
      if (!r.ok) { pollGit(); return send(res, 409, { error: 'Commit failed: ' + (r.stderr || r.stdout).trim() }); }
    }
    pollGit();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/git') {
    const pr = projectByIdx(body.project); if (!pr) return send(res, 404, { error: 'no project' });
    const b = String(body.branch || '');
    if (/^-|\s|\.\.|[~^:?*\[\\]/.test(b) && body.action !== 'pull' && body.action !== 'fetch') return send(res, 400, { error: 'bad branch name' });
    let r;
    const a = body.action;
    if (a === 'pull') r = await git(pr.path, ['pull', '--ff-only']);
    else if (a === 'fetch') r = await git(pr.path, ['fetch', '--prune']);
    else if (a === 'new') r = await git(pr.path, ['checkout', '-b', b]);
    else if (a === 'checkout') {
      const hasLocal = (await git(pr.path, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + b])).ok;
      const co = hasLocal ? ['checkout', b] : ['checkout', '--track', 'origin/' + b];
      if (body.stash) {
        const s = await git(pr.path, ['stash', 'push', '-u', '-m', 'herdr-mobile auto-stash']);
        const stashed = s.ok && !/No local changes/.test(s.stdout);
        r = await git(pr.path, co);
        if (r.ok && stashed) { const pop = await git(pr.path, ['stash', 'pop']); if (!pop.ok) r = { ok: false, stderr: 'Checked out, but stash pop failed (stash kept):\n' + pop.stderr + pop.stdout, stdout: '' }; }
        else if (!r.ok && stashed) await git(pr.path, ['stash', 'pop']);
      } else r = await git(pr.path, co);
    } else return send(res, 400, { error: 'bad action' });
    pollGit();
    return send(res, r.ok ? 200 : 409, { ok: r.ok, out: (r.stdout + r.stderr).trim() });
  }
  send(res, 404, { error: 'not found' });
}

async function onRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/ca.crt' && tls) { res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="herdr-mobile-ca.crt"' }); return res.end(tls.ca); }
    if (OPEN_PATHS.has(url.pathname)) return serveFile(res, path.join(PUB, url.pathname));
    if (!authed(req, url)) return send(res, 401, { error: 'unauthorized' });
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token');
      res.writeHead(302, { 'set-cookie': setCookie, location: url.pathname + (url.search || '') });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/vendor/')) {
      const map = { 'xterm.js': '@xterm/xterm/lib/xterm.js', 'xterm.css': '@xterm/xterm/css/xterm.css', 'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js' };
      const f = map[url.pathname.slice(8)];
      return f ? serveFile(res, path.join(__dirname, 'node_modules', f)) : send(res, 404, {});
    }
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUB, rel));
    if (!file.startsWith(PUB + path.sep)) return send(res, 403, {});
    serveFile(res, file);
  } catch (e) { console.error(e); send(res, 500, { error: e.message }); }
}
const server = http.createServer(onRequest);

// ---------- https: browsers give the microphone (getUserMedia) only to secure pages ----------
// A local CA (tls/ca.pem, install /ca.crt on the phone once) signs a server certificate for this
// machine's names and IPs; the certificate is remade when an IP it lacks shows up.
const HTTPS_PORT = +(process.env.HTTPS_PORT ?? 7682);
const TLS_DIR = path.join(CONF, 'tls');
function ensureTls() {
  const names = ['localhost', os.hostname(), MACHINE].filter((v, i, a) => v && a.indexOf(v) === i);
  const ips = ['127.0.0.1', ...Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)];
  const f = (n) => path.join(TLS_DIR, n);
  const ossl = (args) => require('child_process').execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(f('ca.pem')) || !fs.existsSync(f('ca.key'))) {
    ossl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '3650', '-subj', '/CN=herdr-mobile local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  }
  const want = [...names.map((n) => 'DNS:' + n), ...ips.map((i) => 'IP:' + i)];
  let have = []; try { have = fs.readFileSync(f('san.txt'), 'utf8').split(','); } catch {}
  if (!fs.existsSync(f('cert.pem')) || want.some((w) => !have.includes(w))) {
    const san = [...new Set([...have.filter(Boolean), ...want])].join(',');
    fs.writeFileSync(f('ext.cnf'), `subjectAltName=${san}
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
`);
    ossl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('key.pem'), '-out', f('cert.csr'), '-subj', '/CN=' + os.hostname()]);
    // 825 days: the longest server certificate iOS accepts
    ossl(['x509', '-req', '-in', f('cert.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('cert.pem'), '-days', '825', '-extfile', f('ext.cnf')]);
    fs.writeFileSync(f('san.txt'), san);
  }
  for (const n of ['ca.key', 'key.pem']) fs.chmodSync(f(n), 0o600);
  return { key: fs.readFileSync(f('key.pem')), cert: fs.readFileSync(f('cert.pem')), ca: fs.readFileSync(f('ca.pem')) };
}
let tls = null, httpsServer = null;
if (HTTPS_PORT > 0) {
  try { tls = ensureTls(); httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, onRequest); }
  catch (e) { console.error('https disabled:', e.message); }
}

// ---------- websockets ----------
const wssEvents = new WebSocketServer({ noServer: true });
const wssAttach = new WebSocketServer({ noServer: true });
function onUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  if (!authed(req, url)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  if (url.pathname === '/events') wssEvents.handleUpgrade(req, socket, head, (ws) => onEvents(ws));
  else if (url.pathname === '/attach') wssAttach.handleUpgrade(req, socket, head, (ws) => onAttach(ws, url));
  else { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); }
}
server.on('upgrade', onUpgrade);
if (httpsServer) httpsServer.on('upgrade', onUpgrade);
function onEvents(ws) {
  clients.add(ws);
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify(stateObj));
  if (clients.size === 1) pollGit();
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => {});
}
setInterval(() => { for (const ws of [...clients, ...wssAttach.clients]) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 20000);

function onAttach(ws, url) {
  const t = url.searchParams.get('t') || '';
  const cols = Math.max(20, Math.min(400, +url.searchParams.get('cols') || 80));
  const rows = Math.max(5, Math.min(200, +url.searchParams.get('rows') || 24));
  if (!/^[\w\/-]+$/.test(t)) return ws.close(1008, 'bad terminal');
  const args = ['attach', t];
  if (url.searchParams.get('observe') === '1') args.push('--observe');
  const hist = +url.searchParams.get('history') || 0;
  if (hist > 0) args.push('--history', String(Math.min(hist, 5000)));
  let p;
  try { p = pty.spawn(HC, args, { name: 'xterm-256color', cols, rows, cwd: HOME, env: process.env }); }
  catch (e) { return ws.close(1011, 'spawn failed'); }
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  watching.set(t, (watching.get(t) || 0) + 1);
  if (!seen.has(t) && terminals.some((x) => x.address === t && rawState(x) === 'done')) { updateSeen(); scheduleRebuild(); }
  let gone = false;
  const unwatch = () => { if (gone) return; gone = true; const n = (watching.get(t) || 1) - 1; if (n > 0) watching.set(t, n); else watching.delete(t); };
  p.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  p.onExit(() => { try { ws.close(1000, 'detached'); } catch {} });
  ws.on('message', (data, isBinary) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === 'i' && typeof m.d === 'string') p.write(m.d);
    else if (m.t === 'r') { try { p.resize(Math.max(20, Math.min(400, m.cols | 0)), Math.max(5, Math.min(200, m.rows | 0))); } catch {} }
  });
  const kill = () => { unwatch(); try { p.kill(); } catch {} };
  ws.on('close', kill); ws.on('error', kill);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`herdr-mobile listening on :${PORT}`);
  for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) console.log(`open: http://${i.address}:${PORT}/?token=${TOKEN}`);
});
if (httpsServer) httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => console.log(`https on :${HTTPS_PORT} (install the CA once: http://<ip>:${PORT}/ca.crt)`));
loadProjects();
fs.watchFile(PROJECTS_FILE, { interval: 2000 }, loadProjects);
reqConn.start();
evConn.start();
process.on('SIGTERM', () => { try { reqConn.child && reqConn.child.kill(); evConn.child && evConn.child.kill(); } catch {} process.exit(0); });
