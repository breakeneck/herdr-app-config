'use strict';
// herdr-mobile: watch and drive Herdr terminals/agents from a phone browser.
const http = require('http');
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
  try { const r = await rpc('terminal.list', {}); terminals = (r.terminals || r).filter((t) => t.state === 'live'); scheduleRebuild(); } catch (e) { console.error(e.message); }
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

// ---------- state ----------
function walk(node, out) {
  if (!node) return out;
  if (node.type === 'block') { if (node.content && node.content.terminal) out.push(node.content.terminal); }
  else (node.children || []).forEach((c) => walk(c, out));
  return out;
}
function buildState() {
  const tmap = new Map(terminals.map((t) => [t.address, t]));
  const spaces = ((doc && doc.spaces) || []).map((s) => {
    let status = 'idle', any = false;
    const tabs = (s.tabs || []).map((tb, i) => {
      let tstatus = 'idle';
      const terms = walk(tb.root, []).map((a) => tmap.get(a)).filter(Boolean).map((t) => {
        const st = (t.status && t.status.state) || '';
        tstatus = worst(tstatus, st);
        any = true;
        return { address: t.address, title: t.title || '', program: (t.foreground && t.foreground.name) || (t.argv && t.argv[0]) || '', app: (t.status && t.status.app) || '', status: st || 'idle', msg: (t.status && t.status.msg) || '', cwd: t.cwd, cols: t.cols, rows: t.rows };
      });
      status = worst(status, tstatus);
      return { id: tb.id, name: tb.name || '', index: i + 1, status: tstatus, terminals: terms };
    });
    return { id: s.id, name: s.name, folder: s.folder, status, tabs, _cwds: tabs.flatMap((t) => t.terminals.map((x) => x.cwd)) };
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
    return { idx: i, name: p.name, path: p.path, git: g || null, open: sp.length > 0, status: sp.length ? status : '', spaces: sp.map((s) => s.id) };
  });
  for (const s of spaces) delete s._cwds;
  return { projects: plist, spaces, other: spaces.filter((s) => !owner.has(s.id)).map((s) => s.id), time: Date.now() };
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
  if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
  const body = await readBody(req);
  if (p === '/api/send') {
    if (!/^[\w\/-]+$/.test(body.terminal || '')) return send(res, 400, { error: 'bad terminal' });
    try { await rpc('terminal.send', { terminal: body.terminal, text: String(body.text || ''), force: true }); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (p === '/api/new') {
    const pr = projectByIdx(body.project); if (!pr) return send(res, 404, { error: 'no project' });
    const st = stateObj.projects[pr ? projects.indexOf(pr) : 0];
    let space = st.spaces[0], cwd = pr.path;
    if (space) { const sp = stateObj.spaces.find((s) => s.id === space); cwd = (sp && sp.folder) || cwd; }
    const spaceId = space || 'sp' + rid();
    const args = ['run', '--bg', '--keep', '--no-parent', '--cwd', cwd, '--label', 'herdr.space=' + spaceId, '--label', 'herdr.tab=tb' + rid(), '--json'];
    if (body.kind === 'claude') args.push('--', 'bash', '-ic', 'claude; exec bash -i');
    const r = await run(HC, args);
    return send(res, r.ok ? 200 : 500, r.ok ? { ok: true, out: r.stdout.trim(), newSpace: !space } : { error: (r.stderr || r.stdout).trim() });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
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
});

// ---------- websockets ----------
const wssEvents = new WebSocketServer({ noServer: true });
const wssAttach = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (!authed(req, url)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  if (url.pathname === '/events') wssEvents.handleUpgrade(req, socket, head, (ws) => onEvents(ws));
  else if (url.pathname === '/attach') wssAttach.handleUpgrade(req, socket, head, (ws) => onAttach(ws, url));
  else { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); }
});
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
  p.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  p.onExit(() => { try { ws.close(1000, 'detached'); } catch {} });
  ws.on('message', (data, isBinary) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.t === 'i' && typeof m.d === 'string') p.write(m.d);
    else if (m.t === 'r') { try { p.resize(Math.max(20, Math.min(400, m.cols | 0)), Math.max(5, Math.min(200, m.rows | 0))); } catch {} }
  });
  const kill = () => { try { p.kill(); } catch {} };
  ws.on('close', kill); ws.on('error', kill);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`herdr-mobile listening on :${PORT}`);
  for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) console.log(`open: http://${i.address}:${PORT}/?token=${TOKEN}`);
});
loadProjects();
fs.watchFile(PROJECTS_FILE, { interval: 2000 }, loadProjects);
reqConn.start();
evConn.start();
process.on('SIGTERM', () => { try { reqConn.child && reqConn.child.kill(); evConn.child && evConn.child.kill(); } catch {} process.exit(0); });
