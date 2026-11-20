'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let state = { projects: [], spaces: [], other: [] };
let ws, view = null, term = null;

// ---- theme ----
const THEMES = ['auto', 'light', 'dark'];
const XT_DARK = { background: '#000000', foreground: '#e4e7ee', cursor: '#4c8dff', selectionBackground: '#3a4a6b' };
const XT_LIGHT = { background: '#fbf9f4', foreground: '#2b2e35', cursor: '#2f6fe0', cursorAccent: '#fbf9f4', selectionBackground: '#b9d0f7',
  black: '#2b2e35', red: '#c93232', green: '#1d7a45', yellow: '#8a6100', blue: '#2159c4', magenta: '#9a3fa8', cyan: '#12768a', white: '#6b7280',
  brightBlack: '#5d6370', brightRed: '#d9453d', brightGreen: '#2a8f55', brightYellow: '#9c7000', brightBlue: '#2f6fe0', brightMagenta: '#ad4fbb', brightCyan: '#1a8aa0', brightWhite: '#9aa0ab' };
function themePref() { try { const t = localStorage.getItem('hm-theme'); return THEMES.includes(t) ? t : 'auto'; } catch { return 'auto'; } }
const isLight = () => { const p = themePref(); return p === 'light' || (p === 'auto' && matchMedia('(prefers-color-scheme: light)').matches); };
function applyTheme() {
  const p = themePref(), r = document.documentElement;
  if (p === 'auto') delete r.dataset.theme; else r.dataset.theme = p;
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = isLight() ? '#ffffff' : '#1c1f26';
  if (term) term.options.theme = isLight() ? XT_LIGHT : XT_DARK;
}
function cycleTheme() { try { localStorage.setItem('hm-theme', THEMES[(THEMES.indexOf(themePref()) + 1) % 3]); } catch {} applyTheme(); render(); }
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
const THEME_ICON = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
applyTheme();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function toast(msg, ms = 4000) { const t = $('#toast'); t.textContent = msg; t.className = 'on'; clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), ms); }
async function api(path, body) {
  try {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, ...j };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---- live state ----
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/events');
  ws.onmessage = (e) => { state = JSON.parse(e.data); if (!term) render(); };
  ws.onclose = () => setTimeout(connect, 1500);
}
connect();
document.addEventListener('visibilitychange', () => { if (!document.hidden && ws && ws.readyState > 1) connect(); });

const spaceById = (id) => state.spaces.find((s) => s.id === id);
const dot = (s, open) => `<span class="dot ${s || (open ? 'open' : '')}"></span>`;
const gitLine = (g) => g ? `<span class="git"><b>${esc(g.branch)}</b>${g.ahead ? ` ↑${g.ahead}` : ''}${g.behind ? ` ↓${g.behind}` : ''}${g.dirty ? ' <span class="dirty">●</span>' : ''}</span>` : '';

// ---- routing ----
addEventListener('hashchange', route);
function route() {
  const h = location.hash.slice(1) || '/';
  const [, kind, id] = h.split('/');
  view = { kind: kind || 'home', id: id ? decodeURIComponent(id) : null };
  if (view.kind !== 't') closeTerm();
  render();
}
function render() {
  if (!view) return route();
  const app = $('#app');
  if (view.kind === 'home') app.innerHTML = home();
  else if (view.kind === 'p') { if (!$('#branchcard') || app.dataset.v !== 'p' + view.id) { app.innerHTML = project(); app.dataset.v = 'p' + view.id; loadBranches(); } else updateProjectLive(); }
  else if (view.kind === 'o') { app.innerHTML = project(); app.dataset.v = 'o' + view.id; }
  else if (view.kind === 't') { if (!term) openTerm(view.id); return; }
  if (view.kind === 'home') app.dataset.v = 'home';
  bind(app);
}
function bind(root) {
  root.querySelectorAll('[data-go]').forEach((el) => (el.onclick = () => (location.hash = el.dataset.go)));
  root.querySelectorAll('[data-act]').forEach((el) => (el.onclick = () => acts[el.dataset.act](el)));
}

function home() {
  let h = `<header class="bar"><h1>Herdr</h1><button data-act="theme">${THEME_ICON[themePref()]}</button><button class="icon" data-act="reload">⟳</button></header>`;
  if (!state.projects.length && !state.spaces.length) h += `<div class="empty">Connecting...</div>`;
  h += `<div class="sec">Projects</div>`;
  const rank = (p) => (!p.open ? 3 : p.status === 'blocked' ? 0 : p.status === 'done' ? 1 : 2);
  for (const p of [...state.projects].sort((x, y) => rank(x) - rank(y))) {
    h += `<div class="row" data-go="/p/${p.idx}">${dot(p.status, p.open)}<div class="main"><div class="name">${esc(p.name)}</div><div class="meta">${gitLine(p.git)}<span class="path">${esc(p.path.replace(/^\/home\/[^/]+/, '~'))}</span></div></div>${p.status ? `<span class="tag ${p.status}">${p.status}</span>` : ''}</div>`;
  }
  if (state.other.length) {
    h += `<div class="sec">Other spaces</div>`;
    for (const id of state.other) { const s = spaceById(id); if (!s) continue; h += `<div class="row" data-go="/o/${esc(s.id)}">${dot(s.status, true)}<div class="main"><div class="name">${esc(s.name)}</div><div class="sub">${esc(s.folder || '')}</div></div><span class="tag ${s.status}">${s.status}</span></div>`; }
  }
  return h;
}

function tabsHtml(spaces) {
  let h = '';
  for (const s of spaces) {
    for (const t of s.tabs) {
      h += `<div class="row" style="cursor:default">${dot(t.status)}<div class="main"><div class="name" style="font-size:13px">${esc(t.name || 'Tab ' + t.index)}</div></div><span class="tag ${t.status}">${t.status}</span></div>`;
      for (const x of t.terminals) h += `<div class="term-row" data-go="/t/${esc(x.address)}">${dot(x.status)}<div class="main"><div class="name" style="font-weight:500">${esc(x.app || x.program || x.address)} <span class="sub">${esc(x.address)}</span></div><div class="sub">${esc(x.msg || x.title)}</div></div></div>`;
    }
  }
  return h || '<div class="empty">No tabs</div>';
}
function project() {
  if (view.kind === 'o') {
    const s = spaceById(view.id);
    return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>${esc(s ? s.name : 'Space')}</h1></header>${s ? tabsHtml([s]) : '<div class="empty">Space closed</div>'}`;
  }
  const p = state.projects[+view.id];
  if (!p) return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>?</h1></header>`;
  const sp = p.spaces.map(spaceById).filter(Boolean);
  return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>${esc(p.name)}</h1><span class="meta" id="pgit">${gitLine(p.git)}</span></header>
  <div class="actions"><button class="primary" data-act="new" data-kind="claude">+ Claude</button><button data-act="new" data-kind="shell">+ Shell</button></div>
  <div id="tabs">${p.open ? tabsHtml(sp) : '<div class="empty">No open space. The buttons create one.</div>'}</div>
  <div class="card" id="branchcard"><h3>Branch</h3><div id="branches">Loading...</div></div>`;
}
function updateProjectLive() {
  const p = state.projects[+view.id]; if (!p) return;
  const sp = p.spaces.map(spaceById).filter(Boolean);
  $('#tabs').innerHTML = p.open ? tabsHtml(sp) : '<div class="empty">No open space. The buttons create one.</div>';
  $('#pgit').innerHTML = gitLine(p.git);
  bind($('#tabs'));
}

async function loadBranches(msg) {
  const el = $('#branches'); if (!el) return;
  const r = await api('/api/branches?project=' + view.id);
  if (!r.ok) { el.textContent = r.error || 'failed'; return; }
  const row = (b, remote) => `<div class="branch ${b === r.current ? 'cur' : ''}"><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(b)}${remote ? ' <span class="tag">origin</span>' : ''}</span>${b === r.current ? '' : `<button data-act="co" data-b="${esc(b)}">Checkout</button>`}</div>`;
  el.innerHTML = `<div class="actions" style="padding:0 0 10px"><button data-act="pull">Pull</button><button data-act="fetch">Fetch</button></div>
    <div style="display:flex;gap:6px;margin-bottom:8px"><input type="text" id="nb" placeholder="New branch name" autocapitalize="off" autocomplete="off"><button data-act="nbranch">Create</button></div>
    <div id="gitout">${msg || ''}</div>
    <div class="sec" style="padding-left:0">Local</div>${r.local.map((b) => row(b)).join('')}
    ${r.remote.length ? `<div class="sec" style="padding-left:0">Remote</div>${r.remote.map((b) => row(b, 1)).join('')}` : ''}`;
  bind(el);
}
async function gitAct(body, label) {
  toast(label + '...', 30000);
  const r = await api('/api/git', { project: +view.id, ...body });
  toast(r.ok ? 'Done' : 'Failed', 1500);
  let msg = r.out || r.error || '';
  let extra = '';
  if (!r.ok && body.action === 'checkout' && !body.stash) extra = `<button class="danger" data-act="costash" data-b="${esc(body.branch)}">Stash &amp; checkout</button>`;
  await loadBranches(msg || extra ? `<pre class="out">${esc(msg)}</pre>${extra}` : '');
  bind($('#branches'));
}
const acts = {
  reload() { location.reload(); },
  theme() { cycleTheme(); },
  async new(el) {
    toast('Creating...', 10000);
    const r = await api('/api/new', { project: +view.id, kind: el.dataset.kind });
    toast(r.ok ? 'Created' : (r.error || 'Failed'), 3000);
  },
  co(el) { gitAct({ action: 'checkout', branch: el.dataset.b }, 'Checkout'); },
  costash(el) { gitAct({ action: 'checkout', branch: el.dataset.b, stash: true }, 'Stash & checkout'); },
  pull() { gitAct({ action: 'pull' }, 'Pull'); },
  fetch() { gitAct({ action: 'fetch' }, 'Fetch'); },
  nbranch() { const b = $('#nb').value.trim(); if (b) gitAct({ action: 'new', branch: b }, 'Create branch'); },
};

// ---- terminal screen ----
let tws, fit, ctrl = false, tAddr, backHash = '/';
function closeTerm() {
  if (tws) { tws.onclose = null; try { tws.close(); } catch {} tws = null; }
  if (term) { term.dispose(); term = null; }
  document.body.style.height = '';
}
function findOwner(addr) {
  for (const p of state.projects) for (const sid of p.spaces) { const s = spaceById(sid); if (s && s.tabs.some((t) => t.terminals.some((x) => x.address === addr))) return '/p/' + p.idx; }
  for (const id of state.other) { const s = spaceById(id); if (s && s.tabs.some((t) => t.terminals.some((x) => x.address === addr))) return '/o/' + id; }
  return '/';
}
function openTerm(addr) {
  tAddr = addr; backHash = findOwner(addr);
  const info = state.spaces.flatMap((s) => s.tabs.flatMap((t) => t.terminals)).find((x) => x.address === addr);
  $('#app').dataset.v = 't';
  $('#app').innerHTML = `<div class="termscreen" id="ts"><header class="bar"><button class="icon" id="back">‹</button><h1>${esc(info ? (info.app || info.program) + ' ' : '')}<span class="sub">${esc(addr)}</span></h1><span id="tdot"></span></header>
  <div class="conn" id="conn">Disconnected. Tap to reconnect.</div>
  <div id="xt"></div>
  <div class="keys"><button data-k="\x1b">Esc</button><button data-k="\t">Tab</button><button id="kctrl">Ctrl</button><button data-k="\x1b[A">↑</button><button data-k="\x1b[B">↓</button><button data-k="\x1b[D">←</button><button data-k="\x1b[C">→</button><button data-k="\x03">^C</button><button data-k="\r">Enter</button></div>
  <div class="sendbox"><textarea id="sendtxt" rows="1" placeholder="Reply (pasted + Enter)"></textarea><button class="primary" id="sendbtn">Send</button></div></div>`;
  $('#back').onclick = () => (location.hash = backHash);
  term = new Terminal({ fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, "DejaVu Sans Mono", monospace', theme: isLight() ? XT_LIGHT : XT_DARK, scrollback: 3000, cursorBlink: false, allowProposedApi: true });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  term.open($('#xt'));
  const doFit = () => { try { fit.fit(); } catch {} };
  doFit();
  term.onData((d) => {
    if (ctrl && d.length === 1) { const c = d.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64); setCtrl(false); }
    tsend({ t: 'i', d });
  });
  term.onResize(({ cols, rows }) => tsend({ t: 'r', cols, rows }));
  document.querySelectorAll('.keys [data-k]').forEach((b) => (b.onpointerdown = (e) => { e.preventDefault(); let k = JSON.parse('"' + b.dataset.k.replace(/\\x1b/g, '\\u001b').replace(/\\x03/g, '\\u0003').replace(/\\t/g, '\\t').replace(/\\r/g, '\\r') + '"'); tsend({ t: 'i', d: k }); }));
  $('#kctrl').onpointerdown = (e) => { e.preventDefault(); setCtrl(!ctrl); };
  $('#sendbtn').onclick = sendText;
  $('#conn').onclick = () => attach();
  const reflow = () => { const vv = window.visualViewport; const ts = $('#ts'); if (vv && ts) { ts.style.height = vv.height + 'px'; ts.style.top = vv.offsetTop + 'px'; ts.style.bottom = 'auto'; } doFit(); };
  window.visualViewport && window.visualViewport.addEventListener('resize', reflow);
  window.visualViewport && window.visualViewport.addEventListener('scroll', reflow);
  window.addEventListener('resize', reflow); window.addEventListener('orientationchange', () => setTimeout(reflow, 250));
  reflow();
  attach();
}
function setCtrl(v) { ctrl = v; const b = $('#kctrl'); if (b) b.className = v ? 'on' : ''; }
function tsend(m) { if (tws && tws.readyState === 1) tws.send(JSON.stringify(m)); }
function attach() {
  if (tws) { tws.onclose = null; try { tws.close(); } catch {} }
  term.reset();
  tws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + `/attach?t=${encodeURIComponent(tAddr)}&cols=${term.cols}&rows=${term.rows}`);
  const mine = tws;
  mine.onopen = () => { $('#conn') && ($('#conn').className = 'conn'); tsend({ t: 'r', cols: term.cols, rows: term.rows }); };
  mine.onmessage = (e) => term && term.write(e.data);
  mine.onclose = () => { if (tws === mine && $('#conn')) $('#conn').className = 'conn on'; };
}
async function sendText() {
  const ta = $('#sendtxt'); const text = ta.value; if (!text.trim()) return;
  const r = await api('/api/send', { terminal: tAddr, text });
  if (r.ok) { ta.value = ''; ta.style.height = '44px'; } else toast(r.error || 'Send failed');
}
document.addEventListener('input', (e) => { if (e.target.id === 'sendtxt') { e.target.style.height = '44px'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; } });
route();
