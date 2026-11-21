'use strict';
// The wide (desktop browser) layout, shaped like the Herdr app's main window: spaces on the left,
// the shown tab's terminals as cards in the middle (its splits kept), a tab bar of pills on top,
// the project's Changes / Tasks / PR / AI on the right, a status bar below.
// Phones keep the stacked layout (app.js). Loaded before app.js; uses its helpers at call time.

const WIDE = matchMedia('(min-width: 1000px)');
const isWide = () => WIDE.matches;
WIDE.addEventListener('change', () => {
  for (const v of tviews.values()) v.dispose();
  tviews.clear(); wideSig = '';
  const app = $('#app'); app.innerHTML = ''; app.dataset.v = ''; document.body.classList.toggle('wide', isWide());
  if (typeof closeTerm === 'function') closeTerm();
  render();
});
document.body.classList.toggle('wide', isWide());

// Desktop colors: a project's pick from the desktop (shared wb.colors), else a hash of its name.
const PALETTE = ['#22a99a', '#e3814f', '#5b8def', '#8b7cf6', '#3fae6a', '#d9649a', '#b8860b', '#2a9cae', '#c2508f', '#8a9a4a'];
function colorOf(name) {
  if (!name) return PALETTE[0];
  const picked = (state.colors || {})[name];
  if (picked) return picked;
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const initial = (name) => esc((String(name || '?').replace(/^[^A-Za-z0-9]+/, '')[0] || '?').toUpperCase());
const tile = (name) => `<span class="tile" style="background:${colorOf(name)}">${initial(name)}</span>`;
const short = (p) => String(p || '').replace(/^\/home\/[^/]+/, '~');
const isAgent = (x) => x && (x.app || /claude|codex|gemini|aider|opencode/i.test(x.program || ''));
const progName = (x) => !x ? '' : x.app === 'claude-code' || /claude/i.test(x.program) ? 'Claude Code' : x.app || x.program || x.address;
const statusMark = (s) => s === 'working' ? '<span class="spin"></span>' : s === 'blocked' || s === 'done' ? `<span class="dot ${s}"></span>` : '';
const I_TERM = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>';
const I_AGENT = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/></svg>';

// ---- a live terminal in a card ----
class TermView {
  constructor(addr) {
    this.addr = addr; this.closed = false;
    this.host = document.createElement('div'); this.host.className = 'xthost';
    this.term = new Terminal({ fontSize: 13, fontFamily: '"JetBrains Mono", ui-monospace, Menlo, "DejaVu Sans Mono", monospace', theme: isLight() ? XT_LIGHT : XT_DARK,
      scrollback: 5000, cursorBlink: false, allowProposedApi: true });
    this.fit = new FitAddon.FitAddon(); this.term.loadAddon(this.fit);
    this.ro = new ResizeObserver(() => this.refit());
  }
  mount(slot) {
    slot.appendChild(this.host);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.host);
      this.term.onData((d) => this.send({ t: 'i', d }));
      this.term.onResize(({ cols, rows }) => this.send({ t: 'r', cols, rows }));
      this.ro.observe(this.host);
      this.refit(); this.connect();
    } else this.refit();
  }
  refit() { if (this.closed || !this.host.isConnected || this.host.clientWidth < 20) return; try { this.fit.fit(); } catch {} }
  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  connect() {
    if (this.closed) return;
    this.term.reset();
    const ws = this.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + `/attach?t=${encodeURIComponent(this.addr)}&cols=${this.term.cols}&rows=${this.term.rows}`);
    ws.onopen = () => { this.host.classList.remove('lost'); this.send({ t: 'r', cols: this.term.cols, rows: this.term.rows }); };
    ws.onmessage = (e) => this.term.write(e.data);
    ws.onclose = () => { if (this.ws !== ws || this.closed) return; this.host.classList.add('lost'); setTimeout(() => this.ws === ws && this.connect(), 2500); };
  }
  dispose() { this.closed = true; try { this.ws && this.ws.close(); } catch {} this.ro.disconnect(); try { this.term.dispose(); } catch {} this.host.remove(); }
}
const tviews = new Map(); // address -> TermView, kept while its tab is shown
function wideTheme() { for (const v of tviews.values()) v.term.options.theme = isLight() ? XT_LIGHT : XT_DARK; }

// ---- what is selected ----
let wsel = { tab: {}, pending: null }; // tab: { [space key]: tab id }
try { wsel.tab = JSON.parse(localStorage.getItem('hm-wtabs') || '{}'); } catch {}
let wideSig = '', wideKey = '';
function shownSpaces() {
  if (view.kind === 'p') { const p = state.projects[+view.id]; return p ? p.spaces.map(spaceById).filter(Boolean) : []; }
  if (view.kind === 'o') { const s = spaceById(view.id); return s ? [s] : []; }
  return [];
}
function activeTab(spaces) {
  const key = view.kind + view.id, all = spaces.flatMap((s) => s.tabs.map((t) => ({ s, t })));
  if (wsel.pending) { const hit = all.find((x) => x.t.terminals.some((y) => y.address === wsel.pending)); if (hit) { wsel.tab[key] = hit.t.id; wsel.pending = null; } }
  return all.find((x) => x.t.id === wsel.tab[key]) || all[0] || null;
}
function selectTab(id) {
  wsel.tab[view.kind + view.id] = id;
  try { localStorage.setItem('hm-wtabs', JSON.stringify(wsel.tab)); } catch {}
  renderWide();
}

// ---- the parts ----
function sideHtml() {
  const open = state.projects.filter((p) => p.open), closed = state.projects.filter((p) => !p.open);
  const sel = (k, id) => view.kind === k && String(view.id) === String(id) ? ' sel' : '';
  const item = (go, name, right, status, cls) => `<div class="sitem${cls}" data-go="${go}">${tile(name)}<span class="sname">${esc(name)}</span><span class="sright">${right}</span>${statusMark(status)}</div>`;
  const br = (g) => g ? `${esc(g.branch)}${g.behind ? ` <span class="behind">↓${g.behind}</span>` : ''}${g.ahead ? ` <span class="ahead">↑${g.ahead}</span>` : ''}` : '';
  let h = `<div class="shead"><span class="logo">❖</span><b>Herdr</b><span class="flex"></span><button class="ghost" data-go="/add" title="Add project">＋</button></div>
    <div class="ssec">Spaces</div><div class="smachine">${esc(state.machine || 'server')}<span class="okdot"></span></div>`;
  h += open.map((p) => item('/p/' + p.idx, p.name, br(p.git), p.status, sel('p', p.idx))).join('');
  h += state.other.map(spaceById).filter(Boolean).map((s) => item('/o/' + encodeURIComponent(s.id), s.name || short(s.folder), '', s.status, sel('o', s.id))).join('');
  if (!open.length && !state.other.length) h += '<div class="cnote">No open spaces</div>';
  const fo = foldOpen('wprojects');
  h += `<details class="sfold" data-fold="wprojects"${fo ? ' open' : ''}><summary><span class="mark"></span>Projects<span class="pill">${closed.length}</span></summary>
    ${closed.map((p) => item('/p/' + p.idx, p.name, br(p.git), '', sel('p', p.idx))).join('')}</details>`;
  h += `<div class="sfoot"><button class="ghost" data-act="theme">${THEME_ICON[themePref()]}</button></div>`;
  return h;
}
function tabsBarHtml(spaces, act) {
  const p = view.kind === 'p' ? state.projects[+view.id] : null;
  let h = p && p.git ? `<button class="pill-btn" data-act="wbranch" title="Branches">${I_BRANCH}${esc(p.git.branch)}${p.git.dirty ? ' <span class="dirty">●</span>' : ''}</button>` : '';
  for (const s of spaces) for (const t of s.tabs) {
    const first = t.terminals.find(isAgent) || t.terminals[0];
    const name = t.name || (isAgent(first) ? progName(first) : String(t.index));
    h += `<div class="tpill${act && act.t.id === t.id ? ' on' : ''}" data-act="wtab" data-t="${esc(t.id)}">${isAgent(first) ? I_AGENT : I_TERM}<span>${esc(name)}</span>${statusMark(t.status)}<button class="x" data-act="closetab" data-s="${esc(s.id)}" data-t="${esc(t.id)}" title="Close tab">×</button></div>`;
  }
  h += '<span class="flex"></span>';
  if (p) h += `<div class="newwrap"><button class="ghost" data-act="wnew" title="New tab">＋</button><div class="newmenu" id="newmenu"><div data-act="new" data-kind="claude">${I_AGENT} Claude Code</div><div data-act="new" data-kind="shell">${I_TERM} Shell</div></div></div>`;
  return h;
}
function layoutHtml(n) {
  if (!n) return '';
  const grow = `flex:${n.w || 1} 1 0`;
  if (n.children) return `<div class="split ${n.type === 'column' ? 'vsplit' : 'hsplit'}" style="${grow}">${n.children.map(layoutHtml).join('')}</div>`;
  if (n.mod) return `<div class="tcard mod" style="${grow}"><div class="chead">${esc(n.mod)}</div><div class="cnote">A desktop panel (${esc(n.mod)}): open it in the Herdr app</div></div>`;
  return `<div class="tcard" style="${grow}" data-addr="${esc(n.t)}"><div class="chead"></div><div class="cbody"></div></div>`;
}
function cardHead(x) {
  return `${isAgent(x) ? I_AGENT : I_TERM}<b>${esc(progName(x))}</b><span class="cwd">${esc(short(x.cwd))}</span><span class="flex"></span><span class="sub">${esc(x.msg || '')}</span>${statusMark(x.status)}<span class="addr">${esc(x.address)}</span>`;
}
function statusHtml(p, spaces) {
  const terms = state.spaces.flatMap((s) => s.tabs.flatMap((t) => t.terminals)), agents = terms.filter(isAgent);
  const n = (st) => agents.filter((a) => a.status === st).length;
  return `<span>🖥 ${esc(state.machine || 'server')}</span>${p && p.git ? `<span>${I_BRANCH}${esc(p.git.branch)}</span>` : ''}<span><span class="dot ${n('working') ? 'working' : 'idle'}"></span> ${agents.length} agents</span>
    ${n('blocked') ? `<span class="warn">${n('blocked')} blocked</span>` : ''}${n('done') ? `<span class="ok">${n('done')} done</span>` : ''}<span class="flex"></span><span class="sub">${esc(spaces.map((s) => short(s.folder)).join(' · '))}</span>`;
}

// ---- render ----
const SEGS = [['changes', 'Changes', 'ccount'], ['tasks', 'Tasks', 'tcount'], ['prs', 'PR', 'prcount'], ['ai', 'AI', null]];
let wseg = 'changes';
try { wseg = localStorage.getItem('hm-wseg') || 'changes'; } catch {}
function setSeg(k) {
  wseg = k; try { localStorage.setItem('hm-wseg', k); } catch {}
  const panel = $('#wpanel'); if (!panel) return;
  panel.dataset.seg = k;
  panel.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
  const d = $('#f' + k); if (d && !d.open) d.open = true; // its toggle event loads it
}
function segCounts() {
  for (const [k, , id] of SEGS) { const b = $(`#wpanel .seg button[data-k=${k}] .n`), src = id && $('#' + id); if (b) b.textContent = src ? src.textContent : ''; }
}
setInterval(() => { if (isWide()) segCounts(); }, 1000);

function renderWide() {
  const app = $('#app');
  if (view.kind === 'home' || view.kind === 't') {
    // /t/<address>: the project and tab that hold it; home: the first open project.
    const want = view.kind === 't' ? view.id : null;
    const owner = (sp) => want ? sp.tabs.some((t) => t.terminals.some((x) => x.address === want)) : true;
    const p = state.projects.find((x) => x.open && x.spaces.some((id) => { const s = spaceById(id); return s && owner(s); }));
    const o = !p && want && state.other.find((id) => { const s = spaceById(id); return s && owner(s); });
    if (want) wsel.pending = want;
    if (p) return location.replace('#/p/' + p.idx);
    if (o) return location.replace('#/o/' + encodeURIComponent(o));
  }
  if (app.dataset.v !== 'wide') {
    for (const v of tviews.values()) v.dispose();
    tviews.clear(); wideSig = ''; wideKey = '';
    app.dataset.v = 'wide';
    app.innerHTML = `<div class="wshell"><aside id="wside"></aside><main id="wmain"><div id="wtabs"></div><div id="wpanes"></div></main><aside id="wpanel"></aside><footer id="wstatus"></footer></div>`;
  }
  const spaces = shownSpaces(), act = activeTab(spaces), p = view.kind === 'p' ? state.projects[+view.id] : null;
  const side = $('#wside'); side.innerHTML = sideHtml(); bind(side);
  const sf = side.querySelector('details.sfold'); if (sf) sf.ontoggle = () => { try { localStorage.setItem('hm-fold-wprojects', sf.open ? '1' : '0'); } catch {} };
  const tabs = $('#wtabs'); tabs.innerHTML = tabsBarHtml(spaces, act); bind(tabs);
  tabs.querySelectorAll('.tpill .x').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); acts.closetab(b); }));
  $('#wstatus').innerHTML = statusHtml(p, spaces);

  // Terminals: rebuilt only when the shown tab or its splits change; live ones move into the new cards.
  const panes = $('#wpanes'), key = view.kind + view.id;
  const sig = key + '|' + (act ? act.t.id + JSON.stringify(act.t.root) : (p ? 'closed' : 'none'));
  if (sig !== wideSig) {
    wideSig = sig;
    if (!act) {
      panes.innerHTML = p ? `<div class="wempty">${tile(p.name)}<h2>${esc(p.name)}</h2><p class="sub">${esc(short(p.path))}</p><p>No open space for this project.</p>
        <div class="actions" style="justify-content:center"><button class="primary" data-act="new" data-kind="claude">+ Claude Code</button><button data-act="new" data-kind="shell">+ Shell</button></div></div>`
        : `<div class="wempty"><h2>${view.kind === 'o' ? 'Space closed' : 'Pick a space'}</h2></div>`;
      bind(panes);
    } else {
      panes.innerHTML = layoutHtml(act.t.root && act.t.root.children && act.t.root.children.length ? act.t.root : { t: (act.t.terminals[0] || {}).address });
      const keep = new Set();
      panes.querySelectorAll('.tcard[data-addr]').forEach((c) => {
        const a = c.dataset.addr; keep.add(a);
        let v = tviews.get(a); if (!v) tviews.set(a, v = new TermView(a));
        v.mount(c.querySelector('.cbody'));
        c.onmousedown = () => panes.querySelectorAll('.tcard').forEach((x) => x.classList.toggle('focus', x === c));
      });
      for (const [a, v] of tviews) if (!keep.has(a)) { v.dispose(); tviews.delete(a); }
      const firstCard = panes.querySelector('.tcard[data-addr]'); if (firstCard) { firstCard.classList.add('focus'); setTimeout(() => { const v = tviews.get(firstCard.dataset.addr); v && v.term.focus(); }, 50); }
    }
  }
  if (act) panes.querySelectorAll('.tcard[data-addr]').forEach((c) => { const x = act.t.terminals.find((y) => y.address === c.dataset.addr); c.querySelector('.chead').innerHTML = x ? cardHead(x) : `<span class="sub">${esc(c.dataset.addr)} · ended</span>`; });

  // The right panel: the project's sections (the same as on the phone), one at a time.
  const panel = $('#wpanel');
  if (!p) { if (wideKey !== key) { wideKey = key; panel.innerHTML = `<div class="cnote" style="padding:20px">${view.kind === 'o' ? 'This space is not one of your projects: changes, tasks and PRs show for projects.' : ''}</div>`; } return; }
  if (wideKey !== key || !$('#cmsg')) {
    panel.innerHTML = `<div class="seg">${SEGS.map(([k, l]) => `<button data-k="${k}">${l} <span class="n"></span></button>`).join('')}</div><div class="wpbody">${project()}</div>`;
    panel.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => setSeg(b.dataset.k)));
    bind(panel);
    if ($('#cmsg')) { wideKey = key; enterProject(); setSeg(wseg); }
  } else updateProjectLive();
}

const wideActs = {
  wtab(el, e) { if (e && e.target.closest('.x')) return; selectTab(el.dataset.t); },
  wnew(el, e) { e.stopPropagation(); $('#newmenu').classList.toggle('on'); },
  wbranch() { setSeg('changes'); const d = $('#fbranch'); if (d) { d.open = !d.open; if (d.open) d.scrollIntoView({ block: 'nearest' }); } },
};
document.addEventListener('click', (e) => { const m = $('#newmenu'); if (m && !e.target.closest('.newwrap')) m.classList.remove('on'); });
