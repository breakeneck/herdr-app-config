'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// A Claude terminal's model (state: x.model, e.g. "fable", "opus", "claude-opus-5-5") as a family + a coloured tag.
const modelFamily = (x) => { const m = String((x && x.model) || '').toLowerCase(); return ['fable', 'opus', 'sonnet', 'haiku'].find((f) => m.includes(f)) || (m ? 'other' : ''); };
const modelTag = (x) => { const f = modelFamily(x); return f ? `<span class="mtag ${f}">${esc(f === 'other' ? x.model : f[0].toUpperCase() + f.slice(1))}</span>` : ''; };
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
  if (typeof wideTheme === 'function') wideTheme();
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
  ws.onmessage = (e) => { state = JSON.parse(e.data); if (!term) render(); else if (view && view.kind === 't' && !isWide()) termHead(); };
  ws.onclose = () => setTimeout(connect, 1500);
}
connect();
document.addEventListener('visibilitychange', () => { if (!document.hidden && ws && ws.readyState > 1) connect(); });

const spaceById = (id) => state.spaces.find((s) => s.id === id);
const dot = (s, open) => `<span class="dot ${s || (open ? 'open' : '')}"></span>`;
// Unread: an agent finished while nobody looked (status "done"); opening its terminal reads it.
const udot = (n) => n > 0 ? `<span class="udot" title="${n} unread result${n > 1 ? 's' : ''}"></span>` : '';
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
  if (isWide() && view.kind !== 'add') return renderWide();
  const app = $('#app');
  if (view.kind === 'home') app.innerHTML = home();
  else if (view.kind === 'p') { if (!$('#fbranch') || !$('#cmsg') || app.dataset.v !== 'p' + view.id) { app.innerHTML = project(); app.dataset.v = 'p' + view.id; bind(app); enterProject(); return; } else updateProjectLive(); }
  else if (view.kind === 'o') { app.innerHTML = project(); app.dataset.v = 'o' + view.id; }
  else if (view.kind === 't') { if (term && tAddr !== view.id) closeTerm(); if (!term) openTerm(view.id); else termHead(); return; }
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
    h += `<div class="row" data-go="/p/${p.idx}">${dot(p.status, p.open)}<div class="main"><div class="name${p.unread ? ' unread' : ''}">${esc(p.name)}${udot(p.unread)}</div><div class="meta">${gitLine(p.git)}<span class="path">${esc(p.path.replace(/^\/home\/[^/]+/, '~'))}</span></div></div>${p.working && p.status !== 'working' ? '<span class="tag working">working</span>' : ''}${p.status ? `<span class="tag ${p.status}">${p.status}</span>` : ''}</div>`;
  }
  if (state.other.length) {
    h += `<div class="sec">Other spaces</div>`;
    for (const id of state.other) { const s = spaceById(id); if (!s) continue; h += `<div class="row" data-go="/o/${esc(s.id)}">${dot(s.status, true)}<div class="main"><div class="name${s.unread ? ' unread' : ''}">${esc(s.name)}${udot(s.unread)}</div><div class="sub">${esc(s.folder || '')}</div></div><span class="tag ${s.status}">${s.status}</span></div>`; }
  }
  return h;
}

// Compact: one row per terminal. The tab's name is shown only when it says something (not the default
// "Tab N"); a tab with several terminals gets one thin label line above them, × closes the whole tab.
function tabsHtml(spaces) {
  let h = '';
  for (const s of spaces) {
    for (const t of s.tabs) {
      const named = t.name && !/^Tab \d+$/.test(t.name);
      const x = `<button class="xbtn" data-act="closetab" data-s="${esc(s.id)}" data-t="${esc(t.id)}" aria-label="Close tab">×</button>`;
      const many = t.terminals.length > 1;
      if (many) h += `<div class="tabline"><span>${esc(named ? t.name : 'Tab ' + t.index)}${udot(t.unread)}</span>${x}</div>`;
      for (const r of t.terminals) {
        const title = !many && named ? t.name : (r.app || r.program || r.address);
        h += `<div class="trow${many ? ' in' : ''}" data-go="/t/${esc(r.address)}">${dot(r.status)}<div class="main"><div class="name${r.status === 'done' ? ' unread' : ''}">${esc(title)} ${modelTag(r)}${udot(r.status === 'done' ? 1 : 0)} <span class="addr">${esc(r.address)}</span></div><div class="sub">${esc(r.msg || r.title || '')}</div></div>${!many ? x : ''}</div>`;
      }
      if (!t.terminals.length) h += `<div class="trow">${dot(t.status)}<div class="main"><div class="name">${esc(named ? t.name : 'Tab ' + t.index)}</div><div class="sub">no terminals</div></div>${x}</div>`;
    }
  }
  return h ? `<div class="tlist">${h}</div>` : '<div class="empty">No tabs</div>';
}
// ---- sections: collapsible like the desktop workbench (wb-*/section.js): click the title, ▾/▸ in front ----
const I_BRANCH = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/></svg>'; // Lucide (ISC)
const I_SEND = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>'; // Lucide send (ISC)
const I_CLIP = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/></svg>'; // Lucide paperclip (ISC)
const I_MIC = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>'; // Lucide mic (ISC)
const I_KBD = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/></svg>'; // Lucide keyboard (ISC)
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
    return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>${esc(s ? s.name : 'Space')}</h1><button class="icon" data-act="reload" aria-label="Refresh" title="Refresh">⟳</button></header>${s ? tabsHtml([s]) : '<div class="empty">Space closed</div>'}`;
  }
  const p = state.projects[+view.id];
  if (!p) return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>?</h1></header>`;
  const sp = p.spaces.map(spaceById).filter(Boolean);
  return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>${esc(p.name)}</h1><button class="icon" data-act="reload" aria-label="Refresh" title="Refresh">⟳</button></header>
  ${fold('branch', `${I_BRANCH}<span class="ft" id="pgit">${gitLine(p.git) || 'Branch'}</span>`, '<div id="branches" class="fbody">Loading...</div>')}
  <div class="actions"><button class="primary" data-act="new" data-kind="claude">+ Claude</button><button class="fablebtn" data-act="new" data-kind="fable">+ Fable</button><button data-act="new" data-kind="shell">+ Shell</button></div>
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
  reload() { if (termRefresh && $('#ts')) termRefresh(); else location.reload(); },
  theme() { cycleTheme(); },
  async closetab(el, e) {
    if (e) e.stopPropagation();
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
    if (r.ok && r.address) {
      // Wide: stay on the project and show the new tab once the state push has it.
      if (isWide()) { const m = $('#newmenu'); if (m) m.classList.remove('on'); wsel.pending = r.address; renderWide(); }
      else location.hash = '/t/' + r.address;
    }
  },
  ...wbActs,
  ...wideActs,
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
  flushReplyDraft();
  if (tws) { tws.onclose = null; try { tws.close(); } catch {} tws = null; }
  if (term) { term.dispose(); term = null; }
  document.body.style.height = '';
}
function findOwner(addr) {
  for (const p of state.projects) for (const sid of p.spaces) { const s = spaceById(sid); if (s && s.tabs.some((t) => t.terminals.some((x) => x.address === addr))) return '/p/' + p.idx; }
  for (const id of state.other) { const s = spaceById(id); if (s && s.tabs.some((t) => t.terminals.some((x) => x.address === addr))) return '/o/' + id; }
  return '/';
}
// The terminal screen's title: program + model tag (Fable tints the whole screen); redone on state pushes,
// since a just-created terminal isn't in the state yet when the screen opens.
function termHead() {
  const ts = $('#ts'), h = $('#thead'); if (!ts || !h) return;
  const info = state.spaces.flatMap((s) => s.tabs.flatMap((t) => t.terminals)).find((x) => x.address === tAddr);
  const f = modelFamily(info), html = `${esc(info ? (info.app || info.program) + ' ' : '')}${modelTag(info)} <span class="sub">${esc(tAddr)}</span>`;
  if (h.innerHTML !== html) h.innerHTML = html;
  ts.className = 'termscreen' + (f ? ' m-' + f : '');
}
function openTerm(addr) {
  tAddr = addr; backHash = findOwner(addr);
  $('#app').dataset.v = 't';
  $('#app').innerHTML = `<div class="termscreen" id="ts"><header class="bar"><button class="icon" id="back">‹</button><h1 id="thead"></h1><span id="tdot"></span><button class="icon" id="kbd" aria-label="Keyboard" title="Keyboard">${I_KBD}</button><button class="icon" data-act="reload" aria-label="Refresh" title="Refresh">⟳</button></header>
  <div class="conn" id="conn">Disconnected. Tap to reconnect.</div>
  <div id="xt"></div>
  <div class="keys"><button data-k="esc">Esc</button><button data-k="tab">Tab</button><button id="kctrl">Ctrl</button><button data-k="ctrlc">^C</button><button id="kpaste">Paste</button><button data-k="enter">Enter</button></div>
  <div class="sendbox"><button class="micbtn attbtn" id="attbtn" aria-label="Attach image" title="Attach image">${I_CLIP}</button><input type="file" id="attfile" accept="image/*" multiple hidden><div class="sendwrap"><div id="sendtxt" class="ta" contenteditable="true" role="textbox" aria-multiline="true" data-ph="Reply (pasted + Enter)"></div><canvas id="wave" class="wave"></canvas><span class="wavemsg">Transcribing…</span></div><div class="sbtns"><button class="micbtn" id="micbtn" hidden aria-label="Dictate" title="Dictate">${I_MIC}</button><input type="file" id="micfile" accept="audio/*" capture hidden><button class="primary sendbtn" id="sendbtn" aria-label="Send" title="Send">${I_SEND}</button></div></div></div>`;
  termHead();
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
  document.querySelectorAll('.keys [data-k]').forEach((b) => (b.onpointerdown = (e) => { e.preventDefault(); tsend({ t: 'i', d: KEYS[b.dataset.k] }); }));
  $('#kctrl').onpointerdown = (e) => { e.preventDefault(); setCtrl(!ctrl); };
  $('#sendbtn').onclick = sendText;
  setupReplyBox($('#sendtxt'));
  loadReplyDraft(addr);
  setupMic();
  $('#kpaste').onpointerdown = (e) => { e.preventDefault(); pasteClip(); };
  $('#kbd').onpointerdown = (e) => { e.preventDefault(); setKbd(!kbdOn()); };
  setKbd(kbdOn());
  $('#conn').onclick = () => attach();
  // While the on-screen keyboard is up the screen follows the visual viewport; once it is down the inline
  // size goes, so the screen is full height again. Phones report the viewport in steps, so re-check a few times.
  const reflow = () => {
    const vv = window.visualViewport, ts = $('#ts'); if (!ts) return;
    if (vv && window.innerHeight - vv.height > 60) { ts.style.height = vv.height + 'px'; ts.style.top = vv.offsetTop + 'px'; ts.style.bottom = 'auto'; }
    else { ts.style.height = ''; ts.style.top = ''; ts.style.bottom = ''; }
    doFit();
  };
  let settleT = [];
  const settle = () => { reflow(); settleT.forEach(clearTimeout); settleT = [120, 350, 800].map((ms) => setTimeout(reflow, ms)); };
  window.visualViewport && window.visualViewport.addEventListener('resize', settle);
  window.visualViewport && window.visualViewport.addEventListener('scroll', settle);
  window.addEventListener('resize', settle); window.addEventListener('orientationchange', settle);
  $('#ts').addEventListener('focusout', settle);
  // ⟳ on this screen: fit to the screen again and re-attach (the agent redraws at the new size).
  termRefresh = () => { settle(); setTimeout(() => { reflow(); attach(); }, 150); };
  $('#ts [data-act=reload]').onclick = termRefresh;
  reflow();
  attach();
}
// The ⌨ button shows or hides the extra keys row (Esc, Tab, Ctrl…); remembered for every terminal.
const kbdOn = () => { try { return localStorage.getItem('hm-keys') !== '0'; } catch { return true; } };
function setKbd(v) {
  try { localStorage.setItem('hm-keys', v ? '1' : '0'); } catch {}
  const b = $('#kbd'), k = $('#ts .keys');
  if (b) b.classList.toggle('on', v);
  if (k) k.hidden = !v;
  try { fit && fit.fit(); } catch {}
}
// Clipboard reads need a secure context (https or localhost); over plain http on the LAN fall back to a prompt.
async function pasteClip() {
  let text = null;
  try { if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText(); } catch {}
  if (text === null) text = prompt('Paste text to send to the terminal');
  if (text && term) term.paste(text);
}
let termRefresh = null;
// The key row's bytes (by name: a raw ESC in an attribute broke JSON.parse, so no key was ever sent).
const KEYS = { esc: '\x1b', tab: '\t', ctrlc: '\x03', enter: '\r' };
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
  const ta = $('#sendtxt'), b = $('#sendbtn'); const text = ta.value; if (!text.trim() || b.classList.contains('busy')) return;
  b.classList.add('busy'); b.disabled = true;
  let r; try { r = await api('/api/send', { terminal: tAddr, text }); } catch (e) { r = { error: e.message }; }
  b.classList.remove('busy'); b.disabled = false;
  if (r.ok) { ta.value = ''; sizeReply(ta); replyDraftChanged(''); flushReplyDraft(); } else toast(r.error || 'Send failed');
}
// ---- reply box: a contenteditable (keyboards such as Gboard insert clipboard images only into rich fields) ----
// It behaves as a plain-text box (value, disabled) for the rest of the code. An image pasted, inserted by the
// keyboard, dropped or picked with the clip is uploaded (/api/upload) and its server path goes into the text.
function setupReplyBox(el) {
  Object.defineProperty(el, 'value', {
    get: () => el.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, ''),
    set: (v) => { el.textContent = v; },
  });
  Object.defineProperty(el, 'disabled', { get: () => el.contentEditable === 'false', set: (v) => { el.contentEditable = v ? 'false' : 'true'; } });
  const images = (dt) => [...((dt && dt.files) || [])].filter((f) => /^image\//.test(f.type));
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    const imgs = images(e.clipboardData);
    if (imgs.length) return imgs.forEach(uploadImage);
    const t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (t) document.execCommand('insertText', false, t);
  });
  el.addEventListener('drop', (e) => { const imgs = images(e.dataTransfer); if (imgs.length) { e.preventDefault(); imgs.forEach(uploadImage); } });
  // Anything rich that still lands inside (a keyboard's image, formatted text) is turned back into plain text.
  el.addEventListener('input', () => {
    for (const img of el.querySelectorAll('img')) { const src = img.src; img.remove(); if (src) fetch(src).then((r) => r.blob()).then(uploadImage, () => toast('Could not read the image')); }
    if (el.querySelector('*:not(br):not(div)') || el.querySelector('div div')) { const t = el.value; el.textContent = t; caretEnd(el); }
    if (!el.innerText.trim() && !el.querySelector('img')) el.innerHTML = '';
  });
  $('#attbtn').onclick = () => $('#attfile').click();
  $('#attfile').onchange = (e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; fs.forEach(uploadImage); };
}
function caretEnd(el) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
let uploads = 0;
async function uploadImage(blob) {
  const b = $('#attbtn'); uploads++; b && b.classList.add('busy');
  let j;
  try { const r = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': blob.type || 'image/png' }, body: blob }); j = await r.json().catch(() => ({ error: 'HTTP ' + r.status })); }
  catch (e) { j = { error: e.message }; }
  if (--uploads === 0 && b) b.classList.remove('busy');
  if (j.error || !j.path) return toast(j.error || 'Upload failed');
  const ta = $('#sendtxt'); if (!ta) return;
  const v = ta.value, ins = (v && !/\s$/.test(v) ? ' ' : '') + j.path + ' ';
  if (document.activeElement === ta) document.execCommand('insertText', false, ins);
  else { ta.value = v + ins; caretEnd(ta); }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
// ---- reply drafts: the unsent text of each terminal's reply box, kept on the server (/api/reply-draft) ----
const replyDrafts = {}; // address -> text, so coming back to a terminal shows it at once
let draftTimer = null, draftPending = null;
async function loadReplyDraft(addr) {
  const ta = $('#sendtxt'); if (!ta) return;
  if (replyDrafts[addr]) { ta.value = replyDrafts[addr]; sizeReply(ta); }
  let j; try { j = await (await fetch('/api/reply-draft?t=' + encodeURIComponent(addr))).json(); } catch { return; }
  // the person may have typed (or left) meanwhile
  if (tAddr !== addr || !$('#sendtxt') || ta.value || !j.text) return;
  replyDrafts[addr] = j.text; ta.value = j.text; sizeReply(ta);
}
function replyDraftChanged(text) {
  if (!tAddr) return;
  replyDrafts[tAddr] = text; draftPending = { terminal: tAddr, text };
  clearTimeout(draftTimer); draftTimer = setTimeout(flushReplyDraft, 600);
}
function flushReplyDraft() {
  clearTimeout(draftTimer); draftTimer = null;
  if (!draftPending) return;
  const body = JSON.stringify(draftPending); draftPending = null;
  try { fetch('/api/reply-draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {}); } catch {}
}
addEventListener('pagehide', flushReplyDraft);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushReplyDraft(); });
// The reply box grows up to 120px; once it holds more than one line, Mic and Send stack in a column.
function sizeReply(ta) {
  ta.style.height = '38px'; ta.style.height = Math.min(120, ta.scrollHeight + ta.offsetHeight - ta.clientHeight) + 'px';
  const box = ta.closest('.sendbox'); if (box) box.classList.toggle('multi', ta.scrollHeight > 44);
}
// ---- dictation: the mic records, the server transcribes (ASR_PROVIDER), the text lands in the reply box ----
// Tap = start, tap again = stop. While recording the reply box is disabled and shows a live waveform;
// while transcribing it shows "Transcribing…". Live recording needs a secure context (https/localhost);
// over plain http the mic opens the phone's own recorder through a file input instead.
let micRec = null, micOn = null, micStarting = false, micHttps = 0;
function micState(st) { // '' | 'rec' | 'busy'
  const box = $('#ts .sendbox'), ta = $('#sendtxt'), b = $('#micbtn');
  if (box) { box.classList.toggle('rec', st === 'rec'); box.classList.toggle('busy', st === 'busy'); }
  if (ta) ta.disabled = Boolean(st);
  if (b) { b.classList.toggle('rec', st === 'rec'); b.classList.toggle('busy', st === 'busy'); b.title = st === 'rec' ? 'Stop and transcribe' : 'Dictate'; }
}
async function setupMic() {
  const b = $('#micbtn'); if (!b) return;
  if (micOn === null) { const j = await api('/api/asr'); micOn = j.enabled === true; micHttps = j.https || 0; }
  if (!micOn || !$('#micbtn')) return;
  b.hidden = false;
  const live = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  $('#micfile').onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) transcribe(f); };
  // Pointerdown, not click: on a phone the first tap would otherwise blur the reply box, the keyboard
  // goes down, the screen reflows and the click lands beside the button (the "first tap does nothing").
  // preventDefault keeps the focus where it is. Click stays for keyboards (Enter/Space give detail 0).
  b.onpointerdown = (e) => { if (e.button) return; e.preventDefault(); toggle(); };
  b.onclick = (e) => { if (e.detail === 0) toggle(); };
  const toggle = async () => {
    if (b.classList.contains('busy') || micStarting) return;
    if (micRec) { micRec.stop(); return; }
    // Plain http has no getUserMedia: go to the server's https port (its CA is at /ca.crt).
    if (!live && !window.isSecureContext && micHttps) {
      const to = `https://${location.hostname}:${micHttps}`;
      b.classList.add('busy');
      // fails while this phone does not trust the certificate yet
      const ok = await fetch(to + '/icon.svg', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) }).then(() => true, () => false);
      b.classList.remove('busy');
      if (ok) { location.href = to + location.pathname + location.hash; return; }
      if (confirm('Live dictation needs HTTPS, and this phone does not trust the certificate yet.\n\nOK: download the certificate (install it as a CA certificate, then tap the mic again).\nCancel: record with the phone\'s recorder instead.')) { location.href = '/ca.crt'; return; }
    }
    if (!live) { $('#micfile').click(); return; }
    let stream;
    micStarting = true; b.classList.add('busy'); // opening the mic can take a second on a fresh page
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { toast('Microphone: ' + (e.message || e.name)); return; }
    finally { micStarting = false; b.classList.remove('busy'); }
    if (!$('#wave')) { stream.getTracks().forEach((t) => t.stop()); return; }
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : {}), parts = [];
    const stopWave = waveform(stream, $('#wave'));
    let discard = false;
    rec.ondataavailable = (e) => e.data && e.data.size && parts.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); stopWave();
      micRec = null; micState('');
      if (!discard && parts.length) transcribe(new Blob(parts, { type: rec.mimeType || type || 'audio/webm' }));
    };
    // Leaving the terminal screen mid-recording drops the recording.
    rec.abandon = () => { discard = true; try { rec.stop(); } catch {} };
    micRec = rec; rec.start(250); micState('rec');
  };
}
// Scrolling level bars, newest on the right (like the ChatGPT / Claude composers). Returns a stop function.
function waveform(stream, cv) {
  let ctx, raf = 0, last = 0;
  const levels = [];
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const draw = (now) => {
      raf = requestAnimationFrame(draw);
      if (!cv || !cv.isConnected) { if (micRec && micRec.abandon) micRec.abandon(); return; }
      if (now - last < 50) return; last = now;
      an.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      levels.push(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      g.fillStyle = getComputedStyle(cv).color;
      const step = 4, bw = 2, n = Math.floor(w / step);
      if (levels.length > n) levels.splice(0, levels.length - n);
      for (let i = 0; i < levels.length; i++) {
        const bh = Math.max(2, levels[levels.length - 1 - i] * (h - 8));
        const x = w - (i + 1) * step;
        g.beginPath(); g.roundRect ? g.roundRect(x, (h - bh) / 2, bw, bh, 1) : g.rect(x, (h - bh) / 2, bw, bh); g.fill();
      }
    };
    raf = requestAnimationFrame(draw);
  } catch {}
  return () => { cancelAnimationFrame(raf); try { ctx && ctx.close(); } catch {} if (cv && cv.isConnected) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); };
}
async function transcribe(blob) {
  micState('busy');
  let j;
  try { const r = await fetch('/api/asr', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob }); j = await r.json().catch(() => ({ error: 'HTTP ' + r.status })); }
  catch (e) { j = { error: e.message }; }
  micState('');
  if (j.error) return toast(j.error);
  const ta = $('#sendtxt'); if (!ta || !j.text) return j.text ? null : toast('Nothing recognized');
  ta.value = ta.value && !/\s$/.test(ta.value) ? ta.value + ' ' + j.text : ta.value + j.text;
  ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus();
}
document.addEventListener('input', (e) => { if (e.target.id === 'sendtxt') { sizeReply(e.target); replyDraftChanged(e.target.value); } });
route();
