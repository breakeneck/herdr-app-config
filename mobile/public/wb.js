'use strict';
// Workbench sections for a project (desktop wb-tasks / wb-prs / wb-ai) and the folder browser.
// Loaded before app.js; uses its helpers ($, esc, api, toast, bind, view, fold) at call time only.

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const ago = (iso) => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};
// A job runs on the server (AI can take minutes); poll until it ends. Throws its error.
async function waitJob(id) {
  for (;;) {
    await sleep(2000);
    const r = await api('/api/job?id=' + id);
    if (r.state === 'done') return r.result;
    if (r.state === 'error') throw new Error(r.error);
    if (!r.ok && r.error === 'unknown job') throw new Error('the server restarted; try again');
  }
}

// ---- markdown (enough for descriptions, reviews, comments) ----
function md(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>').replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const lines = String(src || '').replace(/\r/g, '').split('\n'), out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { flush(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre class="code">${esc(buf.join('\n'))}</pre>`); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)/.exec(l))) { flush(); out.push(`<h${Math.min(6, m[1].length + 2)}>${inline(m[2])}</h${Math.min(6, m[1].length + 2)}>`); i++; continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush(); const ordered = /^\s*\d/.test(l), items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        let t = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''), box = '';
        if ((m = /^\[([ xX])\]\s*(.*)/.exec(t))) { box = m[1] === ' ' ? '☐ ' : '☑ '; t = m[2]; }
        items.push(`<li>${box}${inline(t)}</li>`); i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`); continue;
    }
    if (/^>\s?/.test(l)) { flush(); const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\|.*\|\s*$/.test(l)) {
      flush(); const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { if (!/^\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('')); i++; }
      out.push(`<div class="tablewrap"><table>${rows.map((r) => `<tr>${r}</tr>`).join('')}</table></div>`); continue;
    }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l); i++;
  }
  flush();
  return out.join('');
}

// ---- sheet: a full-screen page over the project (Back closes it) ----
let sheetOn = false;
// Wide: a list popup (Tasks, PRs) opens its details in the same popup; ‹ goes back to the list.
let sheetList = null, sheetPrev = null;
function openSheet(title, html) {
  if (sheetOn && sheetList && isWide() && !sheetPrev && !html.includes('id="tbody"') && !html.includes('id="prbody"')) sheetPrev = sheetList;
  const s = $('#sheet');
  $('#sheettitle').textContent = title;
  $('#sheetbody').innerHTML = html;
  $('#sheetbody').scrollTop = 0;
  s.className = 'sheet on';
  if (!sheetOn) { sheetOn = true; history.pushState({ sheet: 1 }, ''); }
  bind(s);
}
function sheetBody(html) { $('#sheetbody').innerHTML = html; bind($('#sheet')); }
// After an action in a popup: back to its list (wide), else closed.
function sheetDone() { if (isWide() && sheetList && sheetOn) { sheetPrev = null; sheetList(); } else closeSheet(); }
function closeSheet(fromPop) {
  sheetList = null; sheetPrev = null;
  if (!sheetOn) return;
  sheetOn = false; $('#sheet').className = 'sheet';
  if (!fromPop) history.back();
}
addEventListener('popstate', () => { if (sheetOn) closeSheet(true); });

// ---- the project's repo: AI picks, task source, drafts ----
let wb = { pid: null, repo: null };
async function loadRepo() {
  const pid = view.id;
  const r = await api('/api/repo?project=' + pid);
  if (view.kind !== 'p' || view.id !== pid) return;
  wb = { pid, ...(r.ok ? r : { error: r.error }) };
  renderAi(); genState();
  const m = $('#cmsg');
  if (m && !m.value.trim() && wb.commitDraft) { m.value = wb.commitDraft; commitState(); }
  if (wb.commitJob) followCommitJob(wb.commitJob);
  if ($('#ftasks') && $('#ftasks').open) loadTasks();
  if ($('#fprs') && $('#fprs').open) loadPrs();
}
const modelName = (use) => { const u = ((wb.ai || {}).uses || []).find((x) => x.use === use), m = ((wb.ai || {}).models || []).find((x) => x.id === (u && u.model)); return m ? m.name : 'no model'; };

// ---- AI settings section ----
function renderAi() {
  const el = $('#aibody'); if (!el) return;
  if (wb.error) { el.innerHTML = `<div class="cnote bad">${esc(wb.error)}</div>`; return; }
  if (!wb.ai) { el.innerHTML = '<div class="cnote">Loading…</div>'; return; }
  el.innerHTML = wb.ai.uses.map((u) => `<label class="airow"><span>${esc(u.label)}</span><select data-use="${u.use}">${wb.ai.models.map((m) =>
    `<option value="${esc(m.id)}"${m.id === u.model ? ' selected' : ''}>${esc(m.name)} · ${esc(m.describe)}</option>`).join('')}</select></label>`).join('')
    + `<div class="cnote">For ${esc((wb.repo && wb.repo.name) || 'this project')}. Models and prompts come from the desktop's AI settings.</div>`;
  el.querySelectorAll('select[data-use]').forEach((s) => (s.onchange = async () => {
    const r = await api('/api/ai-use', { project: +view.id, use: s.dataset.use, model: s.value });
    if (!r.ok) toast(r.error || 'failed'); else { const u = wb.ai.uses.find((x) => x.use === s.dataset.use); u.model = s.value; genState(); toast('Saved', 1200); }
  }));
}

// ---- commit message generation ----
let genBusy = false;
function genState() {
  const b = $('#cgen'); if (!b) return;
  b.disabled = genBusy || !chg.files.length;
  b.textContent = genBusy ? 'Generating…' : '✦ Generate';
  const s = $('#cgenm'); if (s) s.textContent = wb.ai ? modelName('commit') : '';
}
async function followCommitJob(job) {
  const pid = view.id;
  genBusy = true; genState();
  try {
    const out = await waitJob(job);
    if (view.id === pid && $('#cmsg')) { $('#cmsg').value = out.text; commitState(); $('#cmsg').style.height = Math.min(240, $('#cmsg').scrollHeight + 2) + 'px'; }
  } catch (e) { toast('Generate failed: ' + e.message, 8000); }
  genBusy = false; genState();
}

// ---- tasks ----
let tk = { data: null, mine: false };
try { tk.mine = localStorage.getItem('hm-tasks-mine') === '1'; } catch {}
async function loadTasks(quiet) {
  const el = $('#tbody'); if (!el) return;
  const pid = view.id;
  if (!quiet && !tk.data) el.innerHTML = '<div class="cnote">Loading tasks…</div>';
  const r = await api(`/api/tasks?project=${pid}&mine=${tk.mine ? 1 : 0}`);
  if (view.id !== pid || !$('#tbody')) return;
  tk.data = r; renderTasks();
}
function renderTasks() {
  const el = $('#tbody'), r = tk.data; if (!el || !r) return;
  const src = wb.tasks || {};
  $('#tcount').textContent = r.ok && r.count != null ? String(r.count) : '';
  const kind = r.kind || src.kind, label = kind === 'jira' ? 'Jira · ' + (r.account || '') : kind === 'trello' ? 'Trello · ' + (r.board || (src.board || {}).name || 'pick a board') : 'Not connected';
  const head = `<div class="toolrow"><span class="sub">${esc(label)}</span>
    ${kind === 'trello' && !r.needBoard ? `<button class="small${tk.mine ? ' on' : ''}" data-act="tmine">Mine</button>` : ''}
    <button class="small" data-act="tsrc">Source</button><button class="small" data-act="treload">⟳</button></div>`;
  if (!r.ok) { el.innerHTML = head + `<div class="cnote bad">${esc(r.error || 'failed')}</div>`; bind(el); return; }
  if (r.kind === 'none' || src.kind === 'none') { el.innerHTML = head + '<div class="cnote">No task source for this repo. Pick Jira or a Trello board.</div>'; bind(el); return; }
  if (r.needBoard) { el.innerHTML = head + '<div class="cnote">Pick the Trello board for this repo.</div>'; bind(el); return; }
  el.innerHTML = head + r.groups.filter((g) => g.items.length).map((g) => `<div class="tgroup">${esc(g.name)} <span>${g.items.length}</span></div>`
    + g.items.map((x) => `<div class="task" data-act="topen" data-id="${esc(x.id)}"><span class="tkey">${esc(x.key)}</span>${(x.labels || []).map((c) => `<span class="lbl" style="background:${LABEL[String(c).replace(/_(dark|light)$/, '')] || '#8590a2'}"></span>`).join('')}<span class="ttitle">${esc(x.title)}</span>${x.estimate ? `<span class="pill">${esc(x.estimate)}</span>` : ''}</div>`).join('')).join('')
    + (r.groups.some((g) => g.items.length) ? '' : '<div class="cnote">No open tasks</div>');
  bind(el);
}
const LABEL = { green: '#4bce97', yellow: '#e2b203', orange: '#faa53d', red: '#f87462', purple: '#9f8fef', blue: '#579dff', sky: '#6cc3e0', lime: '#94c748', pink: '#e774bb', black: '#8590a2' };
function metaHtml(meta) { return `<div class="meta2">${meta.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(/^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).toLocaleString() : v)}</b></div>`).join('')}</div>`; }
function commentsHtml(cs) {
  return cs.length ? `<div class="sec" style="padding-left:0">Comments · ${cs.length}</div>` + cs.map((c) => `<div class="cmt"><div class="cmeta"><b>${esc(c.author || '')}</b> ${esc(c.extra || '')} <span>${esc(ago(c.at))}</span></div>${md(c.body)}</div>`).join('') : '';
}
async function openTask(id) {
  const x = tk.data && tk.data.groups.flatMap((g) => g.items).find((i) => i.id === id);
  openSheet(x ? x.key : 'Task', '<div class="cnote">Loading…</div>');
  const d = await api(`/api/task?project=${view.id}&id=${encodeURIComponent(id)}`);
  if (!sheetOn) return;
  if (!d.ok) return sheetBody(`<div class="cnote bad">${esc(d.error || 'failed')}</div>`);
  const groups = (tk.data.groups || []).filter((g) => !g.backlog);
  sheetBody(`<div class="pad"><h2>${esc(d.title)}</h2>${metaHtml(d.meta)}
    <div class="actions" style="padding:8px 0"><a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">Open in ${d.kind === 'jira' ? 'Jira' : 'Trello'}</a>
    ${groups.length ? `<select id="tmove"><option value="">Move to…</option>${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select>` : ''}</div>
    <div class="mdbody">${d.body ? md(d.body) : '<p class="sub">No description</p>'}</div>${commentsHtml(d.comments || [])}</div>`);
  const mv = $('#tmove');
  if (mv) mv.onchange = async () => {
    if (!mv.value) return;
    toast('Moving…', 10000);
    const r = await api('/api/task-move', { project: +view.id, id, group: mv.value });
    toast(r.ok ? 'Moved' : r.error || 'Move failed', r.ok ? 1500 : 6000);
    if (r.ok) { sheetDone(); loadTasks(true); }
  };
}
function sourceSheet() {
  const o = wb.taskOptions || { jira: [], trello: [] }, s = wb.tasks || {};
  const row = (act, attrs, label, on) => `<div class="row" data-act="${act}" ${attrs}><div class="main"><div class="name">${esc(label)}</div></div>${on ? '<span class="tag done">current</span>' : ''}</div>`;
  openSheet('Task source', `<div class="sec">Jira</div>${o.jira.map((a) => row('tsetjira', `data-a="${esc(a.id)}"`, a.name, s.kind === 'jira' && s.account === a.id)).join('') || '<div class="cnote">No Jira account (add one on the desktop)</div>'}
    <div class="sec">Trello</div>${o.trello.map((a) => row('tpickboard', `data-a="${esc(a.id)}"`, a.name + ' · pick a board', s.kind === 'trello' && s.account === a.id)).join('') || '<div class="cnote">No Trello account (add one on the desktop)</div>'}
    <div class="sec">Other</div>${row('tsetnone', '', 'Not connected', s.kind === 'none' || !s.kind)}`);
}
async function setSource(source) {
  const r = await api('/api/task-source', { project: +view.id, source });
  if (!r.ok) return toast(r.error || 'failed');
  wb.tasks = source; tk.data = null; sheetDone(); loadTasks();
}

// ---- pull requests ----
let pr = { list: null, mine: false };
try { pr.mine = localStorage.getItem('hm-prs-mine') === '1'; } catch {}
const CI = { ok: 'done', fail: 'bad', wait: 'working' };
async function loadPrs(quiet) {
  const el = $('#prbody'); if (!el) return;
  const pid = view.id;
  if (!quiet && !pr.list) el.innerHTML = '<div class="cnote">Loading…</div>';
  const r = await api(`/api/prs?project=${pid}&mine=${pr.mine ? 1 : 0}`);
  if (view.id !== pid || !$('#prbody')) return;
  pr.list = r; renderPrs();
}
function renderPrs() {
  const el = $('#prbody'), r = pr.list; if (!el || !r) return;
  const gl = wb.repo && wb.repo.host && !wb.repo.github;
  $('#prcount').textContent = r.ok ? String(r.prs.length) : '';
  const head = `<div class="toolrow"><span class="sub">${esc((wb.repo && wb.repo.name) || '')}</span><button class="small${pr.mine ? ' on' : ''}" data-act="prmine">Mine</button><button class="small" data-act="prreload">⟳</button><button class="small primary" data-act="mrnew">+ ${gl ? 'MR' : 'PR'}</button></div>`;
  if (!r.ok) { el.innerHTML = head + `<div class="cnote bad">${esc(r.error || 'failed')}</div>`; bind(el); return; }
  el.innerHTML = head + (r.prs.map((x, i) => `<div class="pr" data-act="propen" data-i="${i}"><span class="dot ${CI[x.ci] || ''}"></span><div class="main"><div class="name">${x.draft ? '<span class="pill">draft</span> ' : ''}${esc(x.title)}</div>
    <div class="sub">${x.provider === 'gitlab' ? '!' : '#'}${x.number} · ${esc(x.branch)} · ${esc(x.author || '')}${x.approvedBy && x.approvedBy.length ? ` · ✓ ${x.approvedBy.length}` : ''}</div></div>${x.badge ? `<span class="tag">${esc(x.badge)}</span>` : ''}</div>`).join('')
    || '<div class="cnote">No open requests</div>');
  bind(el);
}
let cur = null; // the PR shown in the sheet
async function openPr(x, keepScroll) {
  cur = x;
  const num = `${x.provider === 'gitlab' ? '!' : '#'}${x.number}`;
  if (!keepScroll) openSheet(num, '<div class="cnote">Loading…</div>');
  const top = $('#sheetbody').scrollTop;
  const d = await api(`/api/pr?project=${view.id}&n=${x.number}`);
  if (!sheetOn || cur !== x) return;
  if (!d.ok) return sheetBody(`<div class="cnote bad">${esc(d.error || 'failed')}</div>`);
  x.detail = d;
  const gl = d.provider === 'gitlab', draft = (d.draft && d.draft.text) || '';
  sheetBody(`<div class="pad"><h2>${esc(d.title)}</h2>
    ${metaHtml([['From', d.from], ['Into', d.to], ['Author', d.author], ['Created', d.created], ['Approved', (d.approvedBy || []).join(', ')]].filter((m) => m[1]))}
    <div class="actions" style="padding:8px 0"><a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">Open</a>
      ${gl || !d.mineApproved ? `<button data-act="prapprove" data-v="${d.mineApproved ? 0 : 1}">${d.mineApproved ? 'Unapprove' : 'Approve'}</button>` : '<span class="tag done">approved by you</span>'}</div>
    <div class="mdbody">${d.body ? md(d.body) : '<p class="sub">No description</p>'}</div>
    <div class="card"><h3>AI review <span class="sub" id="rvmodel">${esc(modelName('review'))}</span></h3>
      <textarea id="rvtext" rows="8" placeholder="Generate a review, edit it, post it as a comment">${esc(draft)}</textarea>
      <div class="crow" style="margin-top:6px"><span class="sub" id="rvinfo">${d.draft && d.draft.model ? esc(d.draft.model + ' · ' + ago(d.draft.at)) : ''}</span>
      <button data-act="rvgen" id="rvgen">${d.reviewJob ? 'Reviewing…' : '✦ Review'}</button><button data-act="rvdrop">Discard</button><button class="primary" data-act="rvpost">Post</button></div></div>
    ${commentsHtml(d.comments || [])}
    <div class="card"><h3>Comment</h3><textarea id="prcmt" rows="3" placeholder="Write a comment"></textarea><div class="crow" style="margin-top:6px"><span class="sub"></span><button class="primary" data-act="prcomment">Send</button></div></div></div>`);
  $('#sheetbody').scrollTop = keepScroll ? top : 0;
  const ta = $('#rvtext');
  let t; ta.oninput = () => { clearTimeout(t); t = setTimeout(() => api('/api/review-draft', { project: +view.id, url: d.url, text: ta.value }), 800); };
  if (d.reviewJob) followReview(d.reviewJob, x);
}
async function followReview(job, x) {
  const b = $('#rvgen'); if (b) { b.disabled = true; b.textContent = 'Reviewing…'; }
  try {
    const out = await waitJob(job);
    if (cur === x && $('#rvtext')) { $('#rvtext').value = out.text; $('#rvinfo').textContent = out.model || ''; toast('Review ready', 1500); }
  } catch (e) { toast('AI review failed: ' + e.message, 8000); }
  const b2 = $('#rvgen'); if (b2 && cur === x) { b2.disabled = false; b2.textContent = '✦ Review'; }
}

// ---- create a pull/merge request ----
let mr = null;
async function openMr() {
  const gl = wb.repo && !wb.repo.github;
  openSheet(gl ? 'New merge request' : 'New pull request', '<div class="cnote">Fetching branches…</div>');
  const pid = view.id;
  const r = await api('/api/mr-info?project=' + pid);
  if (!sheetOn) return;
  if (!r.ok) return sheetBody(`<div class="cnote bad">${esc(r.error || 'failed')}</div>`);
  const d = r.draft || {};
  mr = { pid, ...r, target: d.target && r.branches.includes(d.target) ? d.target : r.target };
  const opts = (list) => list.map((b) => `<option value="${esc(b)}"${b === mr.target ? ' selected' : ''}>${esc(b)}${b === r.def ? ' (default)' : ''}</option>`).join('');
  sheetBody(`<div class="pad mrform">
    <label>From</label><div class="frombr">${esc(r.branch)}</div>
    <label>Into</label><select id="mrinto">${r.recent.length ? `<optgroup label="Recent">${opts(r.recent)}</optgroup><optgroup label="All">${opts(r.branches.filter((b) => !r.recent.includes(b)))}</optgroup>` : opts(r.branches)}</select>
    <label>Title</label><input type="text" id="mrtitle" value="${esc(d.title || r.title)}">
    <label class="lrow">Description <span class="sub" id="mrmodel">${esc(modelName('mr'))}</span><button class="small" data-act="mrgen" id="mrgen">${r.job ? 'Generating…' : '✦ Generate'}</button></label>
    <textarea id="mrbody" rows="9" placeholder="Description">${esc(d.description || '')}</textarea>
    <label class="lrow chk"><input type="checkbox" id="mrdraft"${d.draft ? ' checked' : ''}> Draft</label>
    <button class="primary wide" data-act="mrcreate" id="mrcreate">Create ${gl ? 'merge request' : 'pull request'}</button>
    <div class="sec" style="padding-left:0">Commits <span id="mrn"></span></div><div id="mrcommits" class="cnote">…</div></div>`);
  const save = () => api('/api/mr-draft', { project: +pid, branch: mr.branch, title: $('#mrtitle').value, target: $('#mrinto').value, description: $('#mrbody').value, draft: $('#mrdraft').checked });
  let t; const later = () => { clearTimeout(t); t = setTimeout(save, 800); };
  $('#mrtitle').oninput = later; $('#mrbody').oninput = later; $('#mrdraft').onchange = later;
  $('#mrinto').onchange = () => { mr.target = $('#mrinto').value; later(); loadCommits(); };
  loadCommits();
  if (r.job) followMr(r.job);
}
async function loadCommits() {
  const el = $('#mrcommits'); if (!el || !mr) return;
  const r = await api(`/api/mr-commits?project=${mr.pid}&target=${encodeURIComponent(mr.target)}`);
  if (!$('#mrcommits')) return;
  const cs = r.commits || [];
  $('#mrn').textContent = cs.length ? `· ${cs.length}` : '';
  el.className = cs.length ? 'commits' : 'cnote';
  el.innerHTML = cs.length ? cs.map((c) => `<div><code>${esc(c.hash.slice(0, 8))}</code> ${esc(c.subject)}</div>`).join('') : `Nothing to merge into ${esc(mr.target)} yet`;
}
async function followMr(job) {
  const b = $('#mrgen'); if (b) { b.disabled = true; b.textContent = 'Generating…'; }
  try { const out = await waitJob(job); if ($('#mrbody')) { $('#mrbody').value = out.text; toast('Description ready', 1500); } }
  catch (e) { toast('Generate failed: ' + e.message, 8000); }
  const b2 = $('#mrgen'); if (b2) { b2.disabled = false; b2.textContent = '✦ Generate'; }
}

// ---- add a project: browse the server's folders ----
let fb = { path: '~', hidden: false };
try { fb.hidden = localStorage.getItem('hm-fb-hidden') === '1'; fb.path = localStorage.getItem('hm-fb-path') || '~'; } catch {}
function addView() {
  return `<header class="bar"><button class="icon" data-go="/">‹</button><h1>Add project</h1><button class="small" data-act="fbhidden" id="fbh">${fb.hidden ? 'Hide .dirs' : 'Show .dirs'}</button></header>
  <div class="fbpath"><input type="text" id="fbin" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="~/dev/project"><button data-act="fbgo">Go</button></div>
  <div id="fblist"><div class="cnote">Loading…</div></div>
  <div class="fbfoot"><input type="text" id="fbname" placeholder="Name (the folder's by default)" autocomplete="off"><button class="primary" data-act="fbadd" id="fbadd">Add this folder</button><div class="sub" id="fbshown"></div></div>`;
}
async function fbGo(p) {
  const r = await api('/api/folders?path=' + encodeURIComponent(p));
  if (!$('#fblist')) return;
  if (!r.ok) { toast(r.error || 'Cannot open', 4000); if (!fb.data) $('#fblist').innerHTML = `<div class="cnote bad">${esc(r.error)}</div>`; return; }
  fb.data = r; fb.path = r.shown;
  try { localStorage.setItem('hm-fb-path', r.shown); } catch {}
  $('#fbin').value = r.shown === '~' ? '~/' : r.shown.replace(/\/?$/, '/');
  const up = r.path === '/' ? null : r.path.replace(/\/[^/]+$/, '') || '/';
  const dirs = r.dirs.filter((d) => fb.hidden || !d.startsWith('.'));
  $('#fblist').innerHTML = (up ? `<div class="frow up" data-act="fbinto" data-p="${esc(up)}">‹ ../</div>` : '')
    + dirs.map((d) => `<div class="frow" data-act="fbinto" data-p="${esc((r.path === '/' ? '' : r.path) + '/' + d)}">📁 ${esc(d)}</div>`).join('')
    + (dirs.length ? '' : '<div class="cnote">No folders here</div>');
  $('#fbshown').textContent = r.shown + (r.git ? ' · git repo' : '') + (r.known ? ' · already a project' : '');
  $('#fbname').placeholder = r.path.split('/').pop() || '/';
  bind($('#fblist'));
}
function enterAdd() {
  bind($('#app'));
  $('#fbin').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); fbGo($('#fbin').value.trim() || '~'); } };
  fbGo(fb.path);
}

const wbActs = {
  sheetclose() { if (sheetPrev) { const f = sheetPrev; sheetPrev = null; f(); } else closeSheet(); },
  gen() {
    if (genBusy || !chg.files.length) return;
    const paths = chg.files.filter((f) => !chg.unc.has(f.path)).map((f) => f.path);
    api('/api/ai-commit', { project: +view.id, paths }).then((r) => (r.ok ? followCommitJob(r.job) : toast(r.error || 'failed', 6000)));
    genBusy = true; genState();
  },
  tmine() { tk.mine = !tk.mine; try { localStorage.setItem('hm-tasks-mine', tk.mine ? '1' : '0'); } catch {} loadTasks(); },
  treload() { loadTasks(); },
  tsrc() { sourceSheet(); },
  topen(el) { openTask(el.dataset.id); },
  tsetjira(el) { setSource({ kind: 'jira', account: el.dataset.a }); },
  tsetnone() { setSource({ kind: 'none' }); },
  async tpickboard(el) {
    const acc = el.dataset.a;
    sheetBody('<div class="cnote">Loading boards…</div>');
    const r = await api('/api/trello-boards?account=' + encodeURIComponent(acc));
    if (!r.ok) return sheetBody(`<div class="cnote bad">${esc(r.error)}</div>`);
    fb.boards = r.boards;
    sheetBody(`<div class="sec">Trello board</div>` + r.boards.map((b, i) => `<div class="row" data-act="tsetboard" data-a="${esc(acc)}" data-i="${i}"><div class="main"><div class="name">${esc(b.name)}</div></div></div>`).join(''));
  },
  tsetboard(el) { const b = fb.boards[+el.dataset.i]; setSource({ kind: 'trello', account: el.dataset.a, board: { id: b.id, name: b.name } }); },
  prmine() { pr.mine = !pr.mine; try { localStorage.setItem('hm-prs-mine', pr.mine ? '1' : '0'); } catch {} pr.list = null; loadPrs(); },
  prreload() { loadPrs(); },
  propen(el) { const x = pr.list && pr.list.prs[+el.dataset.i]; if (x) openPr(x); },
  async prapprove(el) {
    const yes = el.dataset.v === '1'; el.disabled = true;
    const r = await api('/api/pr-approve', { project: +view.id, n: cur.number, approve: yes });
    toast(r.ok ? (yes ? 'Approved' : 'Approval removed') : r.error || 'failed', r.ok ? 1500 : 6000);
    openPr(cur, true); loadPrs(true);
  },
  async prcomment() {
    const ta = $('#prcmt'), body = ta.value.trim(); if (!body) return;
    const r = await api('/api/pr-comment', { project: +view.id, n: cur.number, body });
    if (!r.ok) return toast(r.error || 'failed', 6000);
    toast('Sent', 1200); openPr(cur, true);
  },
  async rvgen() {
    const r = await api('/api/pr-review', { project: +view.id, n: cur.number, url: cur.detail.url });
    if (!r.ok) return toast(r.error || 'failed', 6000);
    toast('Reviewing with ' + modelName('review') + '… you can close this page', 3000);
    followReview(r.job, cur);
  },
  async rvdrop() {
    if ($('#rvtext').value.trim() && !confirm('Discard the review draft?')) return;
    $('#rvtext').value = ''; $('#rvinfo').textContent = '';
    api('/api/review-draft', { project: +view.id, url: cur.detail.url, text: '' });
  },
  async rvpost() {
    const body = $('#rvtext').value.trim(); if (!body) return;
    if (!confirm('Post this review as a comment?')) return;
    const r = await api('/api/pr-comment', { project: +view.id, n: cur.number, body, url: cur.detail.url, fromDraft: true });
    if (!r.ok) return toast(r.error || 'failed', 6000);
    toast('Review posted', 1500); openPr(cur, true);
  },
  mrnew() { openMr(); },
  async mrgen() {
    const r = await api('/api/mr-describe', { project: +mr.pid, branch: mr.branch, target: $('#mrinto').value, title: $('#mrtitle').value });
    if (!r.ok) return toast(r.error || 'failed', 6000);
    followMr(r.job);
  },
  async mrcreate() {
    const b = $('#mrcreate'), title = $('#mrtitle').value.trim();
    if (!title) return toast('Title is empty');
    b.disabled = true; b.textContent = 'Pushing and creating…';
    const r = await api('/api/mr-create', { project: +mr.pid, target: $('#mrinto').value, title, description: $('#mrbody').value, draft: $('#mrdraft').checked });
    b.disabled = false; b.textContent = 'Create';
    if (!r.ok) return toast(r.error || 'failed', 10000);
    toast('Created', 2000); pr.list = null; sheetDone(); loadPrs();
  },
  fbgo() { fbGo($('#fbin').value.trim() || '~'); },
  fbinto(el) { fbGo(el.dataset.p); },
  fbhidden() { fb.hidden = !fb.hidden; try { localStorage.setItem('hm-fb-hidden', fb.hidden ? '1' : '0'); } catch {} $('#fbh').textContent = fb.hidden ? 'Hide .dirs' : 'Show .dirs'; if (fb.data) fbGo(fb.data.path); },
  async fbadd() {
    if (!fb.data) return;
    const r = await api('/api/projects/add', { path: fb.data.path, name: $('#fbname').value.trim() });
    if (!r.ok) return toast(r.error || 'failed', 6000);
    toast('Added', 1200);
    // The state push carries the new project shortly; go to it once it is there.
    for (let i = 0; i < 20 && !state.projects[r.idx]; i++) await sleep(150);
    location.hash = '/p/' + r.idx;
  },
};

addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOn && isWide()) closeSheet(); });
