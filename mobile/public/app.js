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
  if (sheetOn) { sheetOn = false; $('#sheet').className = 'sheet'; }
  if (view.kind !== 't') closeTerm();
  render();
}
function render() {
  if (!view) return route();
  const app = $('#app');
  if (view.kind === 'home') app.innerHTML = home();
  else if (view.kind === 'p') { if (!$('#fbranch') || !$('#cmsg') || app.dataset.v !== 'p' + view.id) { app.innerHTML = project(); app.dataset.v = 'p' + view.id; bind(app); enterProject(); return; } else updateProjectLive(); }
  else if (view.kind === 'o') { app.innerHTML = project(); app.dataset.v = 'o' + view.id; }
  else if (view.kind === 't') { if (!term) openTerm(view.id); return; }
  else if (view.kind === 'add') { if (app.dataset.v !== 'add') { app.innerHTML = addView(); app.dataset.v = 'add'; enterAdd(); } return; }
  if (view.kind === 'home') app.dataset.v = 'home';
  bind(app);
}
function bind(root) {
  root.querySelectorAll('[data-go]').forEach((el) => (el.onclick = () => (location.hash = el.dataset.go)));
  root.querySelectorAll('[data-act]').forEach((el) => (el.onclick = (e) => acts[el.dataset.act](el, e)));
}

function home() {
  let h = `<header class="bar"><h1>Herdr</h1><button class="icon" data-go="/add" aria-label="Add project" title="Add project">+</button><button data-act="theme">${THEME_ICON[themePref()]}</button><button class="icon" data-act="reload">⟳</button></header>`;
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
      h += `<div class="row" style="cursor:default">${dot(t.status)}<div class="main"><div class="name" style="font-size:13px">${esc(t.name || 'Tab ' + t.index)}</div></div><span class="tag ${t.status}">${t.status}</span><button class="xbtn" data-act="closetab" data-s="${esc(s.id)}" data-t="${esc(t.id)}" aria-label="Close tab">×</button></div>`;
      for (const x of t.terminals) h += `<div class="term-row" data-go="/t/${esc(x.address)}">${dot(x.status)}<div class="main"><div class="name" style="font-weight:500">${esc(x.app || x.program || x.address)} <span class="sub">${esc(x.address)}</span></div><div class="sub">${esc(x.msg || x.title)}</div></div></div>`;
    }
  }
  return h || '<div class="empty">No tabs</div>';
}
// ---- sections: collapsible like the desktop workbench (wb-*/section.js): click the title, ▾/▸ in front ----
const I_BRANCH = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/></svg>'; // Lucide (ISC)
const FOLD_DEFAULT = { branch: false, changes: true, tasks: false, prs: false, ai: false, blocal: true, bremote: false };
// Local / Remote inside the Branch section: same ▾/▸ toggle, remembered.
const subFold = (k, title, n, body) => `<details class="subfold" data-fold="${k}"${foldOpen(k) ? ' open' : ''}><summary><span class="mark"></span>${title}<span class="pill">${n}</span></summary>${body}</details>`;
function foldOpen(k) { try { const v = localStorage.getItem('hm-fold-' + k); return v === null ? FOLD_DEFAULT[k] : v === '1'; } catch { return FOLD_DEFAULT[k]; } }
function bindFolds(root) {
  root.querySelectorAll('details.fold').forEach((d) => (d.ontoggle = () => {
    try { localStorage.setItem('hm-fold-' + d.dataset.fold, d.open ? '1' : '0'); } catch {}
    if (d.open && d.dataset.fold === 'branch' && !d.dataset.loaded) loadBranches();
    if (d.open && d.dataset.fold === 'changes') loadChanges();
    if (d.open && d.dataset.fold === 'tasks') loadTasks();
    if (d.open && d.dataset.fold === 'prs') loadPrs();
  }));
}
const fold = (k, title, body) => `<details class="fold" data-fold="${k}" id="f${k}"${foldOpen(k) ? ' open' : ''}><summary><span class="mark"></span>${title}</summary>${body}</details>`;

function project() {
  if (view.kind === 'o') {
    const s = spaceById(view.id);
    return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>${esc(s ? s.name : 'Space')}</h1></header>${s ? tabsHtml([s]) : '<div class="empty">Space closed</div>'}`;
  }
  const p = state.projects[+view.id];
  if (!p) return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>?</h1></header>`;
  const sp = p.spaces.map(spaceById).filter(Boolean);
  return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>${esc(p.name)}</h1></header>
  ${fold('branch', `${I_BRANCH}<span class="ft" id="pgit">${gitLine(p.git) || 'Branch'}</span>`, '<div id="branches" class="fbody">Loading...</div>')}
  <div class="actions"><button class="primary" data-act="new" data-kind="claude">+ Claude</button><button data-act="new" data-kind="shell">+ Shell</button></div>
  <div id="tabs">${p.open ? tabsHtml(sp) : '<div class="empty">No open space. The buttons create one.</div>'}</div>
  ${fold('changes', '<span class="ft">Changes</span><span class="pill" id="ccount"></span>',
    `<div id="changes"><div id="callrow"></div><div id="clist"><div class="cnote">Loading changes…</div></div>
    <div class="commit"><textarea id="cmsg" rows="2" placeholder="Commit message" autocomplete="off"></textarea><div class="crow"><button id="cgen" data-act="gen" disabled>✦ Generate</button><span class="sub" id="cinfo"></span><button id="cbtn" data-act="commit" disabled>Commit</button></div><div class="sub" id="cgenm"></div></div></div>`)}
  ${fold('tasks', '<span class="ft">Tasks</span><span class="pill" id="tcount"></span>', '<div id="tbody"></div>')}
  ${fold('prs', `<span class="ft">${'Pull requests'}</span><span class="pill" id="prcount"></span>`, '<div id="prbody"></div>')}
  ${fold('ai', '<span class="ft">AI models</span>', '<div id="aibody" class="fbody"></div>')}`;
}
let lastGit = '';
function enterProject() {
  if (!$('#cmsg')) return; // the project isn't known yet: the next state push renders it again
  lastGit = JSON.stringify((state.projects[+view.id] || {}).git || null);
  bindFolds($('#app'));
  let unc = [];
  try { unc = JSON.parse(localStorage.getItem('hm-unc-' + view.id) || '[]'); } catch {}
  chg = { pid: view.id, files: [], open: null, sig: '', unc: new Set(unc) };
  let dt; $('#cmsg').oninput = () => { commitState(); clearTimeout(dt); const pid = view.id, v = $('#cmsg').value; dt = setTimeout(() => api('/api/commit-draft', { project: +pid, text: v }), 1000); };
  if (foldOpen('branch')) loadBranches();
  loadChanges();
  tk.data = null; pr.list = null; wb = { pid: view.id };
  loadRepo();
}
function updateProjectLive() {
  const p = state.projects[+view.id]; if (!p) return;
  const sp = p.spaces.map(spaceById).filter(Boolean);
  $('#tabs').innerHTML = p.open ? tabsHtml(sp) : '<div class="empty">No open space. The buttons create one.</div>';
  $('#pgit').innerHTML = gitLine(p.git) || 'Branch';
  bind($('#tabs'));
  const g = JSON.stringify(p.git || null);
  if (g !== lastGit) { lastGit = g; loadChanges(); }
}

// ---- changes: mirrors wb-changes (checkboxes, Select all, names colored by status, commit the checked files) ----
let chg = { pid: null, files: [], open: null, sig: '', unc: new Set() };
// wb-changes/log.js NAME_COLORS: M blue, A/U green, D gray struck through, X conflict red.
const kindOf = (f) => (f.status === 'U' ? 'X' : f.fresh ? 'U' : f.status);
const saveUnc = () => { try { localStorage.setItem('hm-unc-' + chg.pid, JSON.stringify([...chg.unc])); } catch {} };
const cbox = (state, act, extra = '') => `<span class="cb${state ? ' on' : ''}" data-act="${act}" ${extra}>${state === 1 ? '✓' : state === 2 ? '–' : ''}</span>`;
async function loadChanges() {
  if (!$('#clist') || chg.loading) return;
  const pid = view.id; chg.loading = true;
  const r = await api('/api/changes?project=' + pid).finally(() => (chg.loading = false));
  if (view.id !== pid || chg.pid !== pid || !$('#clist')) return;
  const files = r.ok ? r.files : [];
  const sig = JSON.stringify(files) + (r.error || '') + (r.notRepo ? 'x' : '');
  if (sig === chg.sig) return; // nothing changed: keep the list and the open diff as they are
  chg.sig = sig; chg.files = files; chg.last = r;
  const paths = new Set(files.map((f) => f.path));
  for (const x of chg.unc) if (!paths.has(x)) chg.unc.delete(x);
  if (chg.open && !paths.has(chg.open)) chg.open = null;
  renderChanges();
}
function renderChanges() {
  const el = $('#clist'), r = chg.last, files = chg.files; if (!el || !r) return;
  const nChecked = files.filter((f) => !chg.unc.has(f.path)).length, total = files.length;
  $('#ccount').textContent = r.ok && !r.notRepo ? String(total) : '';
  $('#callrow').innerHTML = total ? `<div class="allrow">${cbox(nChecked === 0 ? 0 : nChecked === total ? 1 : 2, 'checkall')}<span>Select all</span></div>` : '';
  bind($('#callrow'));
  commitState();
  if (!total) { el.innerHTML = `<div class="cnote">${esc(!r.ok ? r.error || 'failed' : r.notRepo ? 'Not a git repository' : 'No uncommitted changes')}</div>`; return; }
  el.innerHTML = files.map((f, i) => {
    const parts = f.path.split('/'), name = parts.pop(), k = kindOf(f);
    return `<div class="chg${chg.open === f.path ? ' sel' : ''}" data-act="pick" data-i="${i}">${cbox(chg.unc.has(f.path) ? 0 : 1, 'check', `data-i="${i}"`)}<span class="fp"><span class="fdir">${esc(parts.length ? parts.join('/') + '/' : '')}</span><span class="fname k${k}">${esc(name)}</span></span>${f.add ? `<span class="plus">+${f.add}</span>` : ''}${f.del ? `<span class="minus">−${f.del}</span>` : ''}</div>${chg.open === f.path ? '<div class="diff" id="cdiff"><div class="cnote">Loading…</div></div>' : ''}`;
  }).join('') + (r.limited ? '<div class="cnote">Showing the first 1,000 changed files</div>' : '');
  bind(el);
  genState();
  if (chg.open) showDiff(chg.open);
}
function commitState() {
  const b = $('#cbtn'), m = $('#cmsg'); if (!b || !m) return;
  const n = chg.files.filter((f) => !chg.unc.has(f.path)).length;
  b.disabled = !m.value.trim() || !n || chg.busy;
  $('#cinfo').textContent = chg.files.length ? (n < chg.files.length ? `${n} of ${chg.files.length} files checked` : '') : '';
}
function diffHtml(lines) {
  let old = 0, nw = 0;
  return lines.map((l) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (m) { old = +m[1]; nw = +m[2]; return `<div class="dl hh">${esc(l)}</div>`; }
    const k = l[0];
    let n = '', c = '';
    if (k === '-') { n = old++; c = 'd'; } else if (k === '+') { n = nw++; c = 'a'; } else if (k === ' ') { old++; n = nw++; } else return `<div class="dl">${esc(l)}</div>`;
    return `<div class="dl ${c}"><span class="ln">${n}</span>${esc(l.slice(1)) || ' '}</div>`;
  }).join('');
}
async function showDiff(path) {
  const pid = view.id;
  const r = await api(`/api/diff?project=${pid}&file=${encodeURIComponent(path)}`);
  const box = $('#cdiff');
  if (!box || chg.open !== path || view.id !== pid) return;
  box.innerHTML = r.ok ? `<div class="dscroll"><div class="dinner">${diffHtml(r.lines)}</div></div>` : `<div class="cnote bad">${esc(r.error || 'failed')}</div>`;
}
setInterval(() => { if (view && view.kind === 'p' && !document.hidden && $('#fchanges') && $('#fchanges').open) loadChanges(); }, 10000);

async function loadBranches(msg) {
  const el = $('#branches'); if (!el) return;
  $('#fbranch').dataset.loaded = '1';
  const r = await api('/api/branches?project=' + view.id);
  if (!r.ok) { el.textContent = r.error || 'failed'; return; }
  const row = (b, remote) => `<div class="branch ${b === r.current ? 'cur' : ''}"><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(b)}${remote ? ' <span class="tag">origin</span>' : ''}</span>${b === r.current ? '' : `<button data-act="co" data-b="${esc(b)}">Checkout</button>`}</div>`;
  el.innerHTML = `<div class="actions" style="padding:0 0 10px"><button data-act="pull">Pull</button><button data-act="fetch">Fetch</button></div>
    <div style="display:flex;gap:6px;margin-bottom:8px"><input type="text" id="nb" placeholder="New branch name" autocapitalize="off" autocomplete="off"><button data-act="nbranch">Create</button></div>
    <div id="gitout">${msg || ''}</div>
    ${subFold('blocal', 'Local', r.local.length, `<div class="blist">${r.local.map((b) => row(b)).join('')}</div>`)}
    ${r.remote.length ? subFold('bremote', 'Remote', r.remote.length, `<div class="blist">${r.remote.map((b) => row(b, 1)).join('')}</div>`) : ''}`;
  el.querySelectorAll('details.subfold').forEach((d) => (d.ontoggle = () => { try { localStorage.setItem('hm-fold-' + d.dataset.fold, d.open ? '1' : '0'); } catch {} }));
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
  loadChanges();
}
const acts = {
  reload() { location.reload(); },
  theme() { cycleTheme(); },
  async closetab(el) {
    const s = spaceById(el.dataset.s); const t = s && s.tabs.find((x) => x.id === el.dataset.t); if (!t) return;
    const name = t.name || 'Tab ' + t.index, n = t.terminals.length;
    const risky = t.terminals.filter((x) => x.status === 'working' || x.status === 'blocked');
    const warn = risky.map((x) => `\nWarning: ${x.app || x.program} ${x.address} is ${x.status}.`).join('');
    if (!confirm(`Close tab ${name}? Ends ${n} terminal(s).${warn}`)) return;
    toast('Closing...', 10000);
    const r = await api('/api/close-tab', { spaceId: s.id, tabId: t.id });
    toast(r.ok ? 'Closed' : 'Close failed: ' + (r.error || 'error'), r.ok ? 1500 : 6000);
  },
  async new(el) {
    if (el.disabled) return;
    el.disabled = true;
    toast('Creating...', 10000);
    const r = await api('/api/new', { project: +view.id, kind: el.dataset.kind });
    el.disabled = false;
    toast(r.ok ? 'Created' : (r.error || 'Failed'), r.ok ? 1200 : 6000);
    if (r.ok && r.address) location.hash = '/t/' + r.address;
  },
  ...wbActs,
  pick(el) {
    const f = chg.files[+el.dataset.i]; if (!f) return;
    chg.open = chg.open === f.path ? null : f.path;
    renderChanges();
  },
  check(el, e) {
    e.stopPropagation();
    const f = chg.files[+el.dataset.i]; if (!f) return;
    if (!chg.unc.delete(f.path)) chg.unc.add(f.path);
    saveUnc(); renderChanges();
  },
  checkall() {
    const all = chg.files.every((f) => !chg.unc.has(f.path));
    chg.unc = all ? new Set(chg.files.map((f) => f.path)) : new Set();
    saveUnc(); renderChanges();
  },
  async commit() {
    const m = $('#cmsg'), msg = m.value.trim(), paths = chg.files.filter((f) => !chg.unc.has(f.path)).map((f) => f.path);
    if (!msg || !paths.length || chg.busy) return;
    chg.busy = true; commitState(); $('#cbtn').textContent = 'Committing…';
    const r = await api('/api/commit', { project: +view.id, message: msg, paths });
    chg.busy = false;
    if (!$('#cbtn')) return;
    $('#cbtn').textContent = 'Commit';
    if (r.ok) { m.value = ''; api('/api/commit-draft', { project: +view.id, text: '' }); toast('Committed', 1500); } else toast(r.error || 'Commit failed', 8000);
    commitState();
    chg.sig = ''; loadChanges();
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
  // xterm has no touch scrolling on mobile. Normal buffer: scrollLines directly.
  // Alternate buffer (TUIs like Claude Code): dispatch a wheel event on the viewport —
  // xterm encodes it into the exact mouse format the app expects (SGR/X10 per DEC modes).
  let ty = 0;
  const scr = $('#xt');
  const vp = () => scr.querySelector('.xterm-viewport') || scr;
  const inTerm = (e) => e.target && scr.contains(e.target);
  const isAlt = () => { try { return term.buffer.active.type === 'alternate'; } catch { return false; } };
  // capture phase: xterm's own touch handlers may stopPropagation before bubbling
  scr.addEventListener('touchstart', (e) => { if (inTerm(e) && e.touches.length === 1) ty = e.touches[0].clientY; }, { passive: true, capture: true });
  scr.addEventListener('touchmove', (e) => {
    if (!inTerm(e) || e.touches.length !== 1 || !term) return;
    const y = e.touches[0].clientY, dy = y - ty; ty = y;
    if (!dy) return;
    if (isAlt()) vp().dispatchEvent(new WheelEvent('wheel', { deltaY: -dy, bubbles: true, cancelable: true }));
    else term.scrollLines(Math.trunc(-dy / ((scr.clientHeight || term.rows * 16) / Math.max(1, term.rows))));
  }, { passive: true, capture: true });
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
