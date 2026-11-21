'use strict';
// Tasks for a repo, as the desktop's wb-tasks shows them: the repo's source (shared "wb.tasks.sources"
// mirrored into workbench.json) is Jira (my open issues by board column, plus the project's backlog) or
// a Trello board (its lists and cards). Tokens come from secrets.json.

const MINE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY Rank ASC';
const backlogJql = (project) => `project = "${project}" AND sprint is EMPTY AND statusCategory != Done ORDER BY rank ASC`;
const TRELLO = 'https://api.trello.com/1';
const qs = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

function make(conf) {
  const accounts = () => (conf.wb().tasks || {}).accounts || {};
  const jiraAcc = (id) => (accounts().jira || []).find((a) => a.id === id) || null;
  const trelloAcc = (id) => (accounts().trello || []).find((a) => a.id === id) || null;
  function source(repoKey) {
    const s = (((conf.wb().tasks || {}).sources) || {})[repoKey] || { kind: 'none' };
    if (s.kind === 'jira' && !jiraAcc(s.account)) return { kind: 'none' };
    if (s.kind === 'trello' && !trelloAcc(s.account)) return { kind: 'none' };
    return s;
  }
  function setSource(repoKey, next) {
    const wb = conf.wb(), tasks = wb.tasks || {};
    conf.setWb({ tasks: { ...tasks, sources: { ...(tasks.sources || {}), [repoKey]: next } } });
  }

  // ---- Jira ----
  function jiraCreds(acc) {
    const token = conf.secret('jira', acc.id) || conf.secret('jira', acc.email);
    if (!token) throw new Error(`No Jira token for ${acc.email} on this server (run the desktop sync)`);
    return { base: acc.base || acc.site, auth: 'Basic ' + Buffer.from(`${acc.email}:${token}`).toString('base64') };
  }
  async function jira(c, p, body) {
    const r = await fetch(c.base + p, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
      headers: { Authorization: c.auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw Object.assign(new Error(`Jira ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
    return r.status === 204 ? null : r.json();
  }
  const boards = new Map(); // base|project -> { columns, estimate }
  async function boardConfig(c, project) {
    const k = c.base + '|' + project;
    if (boards.has(k)) return boards.get(k);
    let cfg = null;
    try {
      const { values = [] } = await jira(c, `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}&maxResults=50`);
      const board = values.find((b) => b.location && b.location.projectKey === project) || values[0];
      if (board) {
        const x = await jira(c, `/rest/agile/1.0/board/${board.id}/configuration`);
        cfg = { columns: ((x.columnConfig || {}).columns || []).map((col) => ({ name: col.name, statuses: (col.statuses || []).map((s) => String(s.id)) })),
          estimate: x.estimation && x.estimation.type === 'field' ? (x.estimation.field || {}).fieldId || null : null };
      }
    } catch {}
    boards.set(k, cfg);
    return cfg;
  }
  function estimateText(fields, field) {
    const v = field ? (fields || {})[field] : null;
    if (v == null || v === '') return null;
    if (field === 'timeoriginalestimate' || field === 'timeestimate') { const h = Number(v) / 3600; return h >= 8 && h % 8 === 0 ? `${h / 8}d` : `${+h.toFixed(1)}h`; }
    if (typeof v === 'number') return `${+v.toFixed(1)} SP`;
    return String(v.value ?? v.name ?? v);
  }
  const slim = (i, est) => ({ id: i.key, key: i.key, title: i.fields.summary, status: (i.fields.status || {}).name || '', statusId: String((i.fields.status || {}).id || ''),
    cat: ((i.fields.status || {}).statusCategory || {}).key || '', type: (i.fields.issuetype || {}).name || '', project: (i.fields.project || {}).key || '', estimate: estimateText(i.fields, est) });

  async function jiraList(acc) {
    const c = jiraCreds(acc), fields = ['summary', 'status', 'issuetype', 'labels', 'project'];
    const search = (jql, f, maxResults) => jira(c, '/rest/api/3/search/jql', { jql, fields: f, maxResults });
    let { issues = [] } = await search(MINE_JQL, fields, 100);
    const keys = [...new Set([...issues.map((i) => (i.fields.project || {}).key), acc.project].filter(Boolean))];
    const cfgs = {}; for (const k of keys) cfgs[k] = await boardConfig(c, k);
    const est = [...new Set(Object.values(cfgs).map((x) => x && x.estimate).filter(Boolean))];
    if (est.length) ({ issues = [] } = await search(MINE_JQL, [...fields, ...est], 100));
    const backlog = acc.project ? (await search(backlogJql(acc.project), [...fields, ...est], 50)).issues || [] : [];
    // Columns per project (projects with most of my issues first); unmapped statuses get a group at the end.
    const byProject = new Map();
    for (const i of issues) { const k = (i.fields.project || {}).key || '?'; if (!byProject.has(k)) byProject.set(k, []); byProject.get(k).push(i); }
    const many = byProject.size > 1, groups = [];
    for (const [project, list] of [...byProject].sort((a, b) => b[1].length - a[1].length)) {
      const cfg = cfgs[project], mine = ((cfg && cfg.columns) || []).map((col) => ({ id: `${project}:${col.name}`, name: many ? `${project} · ${col.name}` : col.name, statuses: col.statuses, items: [] }));
      for (const i of list) {
        const sid = String((i.fields.status || {}).id || '');
        let g = mine.find((x) => x.statuses.includes(sid));
        if (!g) { const name = (i.fields.status || {}).name || 'No status'; g = mine.find((x) => x.id === `${project}:?${name}`); if (!g) mine.push(g = { id: `${project}:?${name}`, name: many ? `${project} · ${name}` : name, statuses: [sid], items: [] }); }
        g.items.push(slim(i, cfg && cfg.estimate));
      }
      groups.push(...mine);
    }
    if (backlog.length) groups.push({ id: 'backlog', name: `Backlog · ${acc.project}`, statuses: [], items: backlog.map((i) => slim(i, (cfgs[acc.project] || {}).estimate)), backlog: true });
    return { kind: 'jira', account: acc.email, site: acc.site, groups, count: issues.length };
  }
  async function jiraDetail(acc, key) {
    const c = jiraCreds(acc), est = (await boardConfig(c, key.split('-')[0]) || {}).estimate;
    const f = 'summary,status,issuetype,priority,assignee,reporter,labels,description,comment,created,updated,parent,project' + (est ? `,${est}` : '');
    const d = await jira(c, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${f}`), x = d.fields;
    return { kind: 'jira', key, title: x.summary, url: `${acc.site}/browse/${key}`, status: (x.status || {}).name, type: (x.issuetype || {}).name,
      meta: [['Status', (x.status || {}).name], ['Type', (x.issuetype || {}).name], ['Priority', (x.priority || {}).name], ['Assignee', (x.assignee || {}).displayName],
        ['Reporter', (x.reporter || {}).displayName], ['Estimate', estimateText(x, est)], ['Parent', x.parent ? `${x.parent.key} ${(x.parent.fields || {}).summary || ''}` : null],
        ['Labels', (x.labels || []).join(', ')], ['Updated', x.updated]].filter((m) => m[1]),
      body: adf(x.description), comments: ((x.comment || {}).comments || []).slice(-30).map((cm) => ({ author: (cm.author || {}).displayName, at: cm.created, body: adf(cm.body) })) };
  }
  // Moves an issue to a column: the transition that leads to one of the column's statuses.
  async function jiraMove(acc, key, statuses) {
    const c = jiraCreds(acc);
    const { transitions = [] } = await jira(c, `/rest/api/3/issue/${key}/transitions`);
    const tr = transitions.find((x) => statuses.includes(String((x.to || {}).id)));
    if (!tr) throw new Error(`No transition to that column for ${key}`);
    await jira(c, `/rest/api/3/issue/${key}/transitions`, { transition: { id: tr.id } });
  }

  // ---- Trello ----
  function trelloCreds(acc) {
    const v = conf.secret('trello', acc.id) || '', at = v.indexOf(':');
    if (at <= 0) throw new Error(`No Trello token for ${acc.name} on this server (run the desktop sync)`);
    return { key: v.slice(0, at), token: v.slice(at + 1) };
  }
  async function trello(c, p, query = {}, method = 'GET') {
    const r = await fetch(`${TRELLO}${p}?${qs({ ...query, key: c.key, token: c.token })}`, { method, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw Object.assign(new Error(`Trello ${r.status}: ${(await r.text()).slice(0, 160)}`), { status: r.status });
    return r.json();
  }
  const ESTIMATE = /estimat|story ?points?|^sp$|^points?$|оцінк|естімейт/i;
  function estimateOf(items, field) {
    const it = field && (items || []).find((i) => i.idCustomField === field.id);
    if (!it) return null;
    if (it.idValue) { const o = (field.options || []).find((x) => x.id === it.idValue); return o ? o.value.text : null; }
    const v = it.value && (it.value.number ?? it.value.text);
    return v == null || v === '' ? null : String(v);
  }
  async function trelloList(acc, board, mine) {
    const c = trelloCreds(acc);
    const [lists, fields] = await Promise.all([
      trello(c, `/boards/${board.id}/lists`, { filter: 'open', fields: 'name,pos', cards: 'open', card_fields: 'name,idMembers,labels,pos,due,dueComplete,idShort,shortUrl' }),
      trello(c, `/boards/${board.id}/customFields`).catch(() => []),
    ]);
    const field = (fields || []).find((f) => ESTIMATE.test(f.name || ''));
    let est = {};
    if (field) est = Object.fromEntries((await trello(c, `/boards/${board.id}/cards`, { filter: 'open', fields: 'id', customFieldItems: 'true' })).map((x) => [x.id, estimateOf(x.customFieldItems, field)]));
    const groups = lists.map((l) => ({ id: l.id, name: l.name, items: l.cards.filter((x) => !mine || x.idMembers.includes(acc.id)).map((x) => ({
      id: x.id, key: `#${x.idShort}`, title: x.name, estimate: est[x.id] || null, due: x.due, dueComplete: x.dueComplete, labels: (x.labels || []).map((lb) => lb.color).slice(0, 4) })) }));
    return { kind: 'trello', account: acc.name, board: board.name, groups, count: groups.reduce((n, g) => n + g.items.length, 0) };
  }
  async function trelloDetail(acc, id) {
    const c = trelloCreds(acc);
    const x = await trello(c, `/cards/${id}`, { fields: 'name,desc,due,dueComplete,labels,shortUrl,idShort,dateLastActivity,idBoard', members: 'true', member_fields: 'fullName',
      list: 'true', list_fields: 'name', board: 'true', board_fields: 'name', checklists: 'all', actions: 'commentCard', actions_limit: 30 });
    let body = x.desc || '';
    for (const cl of x.checklists || []) body += `\n\n**${cl.name}**\n` + [...cl.checkItems].sort((a, b) => a.pos - b.pos).map((i) => `- [${i.state === 'complete' ? 'x' : ' '}] ${i.name}`).join('\n');
    return { kind: 'trello', key: `#${x.idShort}`, title: x.name, url: x.shortUrl, status: (x.list || {}).name,
      meta: [['List', (x.list || {}).name], ['Board', (x.board || {}).name], ['Members', (x.members || []).map((m) => m.fullName).join(', ')], ['Labels', (x.labels || []).map((l) => l.name || l.color).join(', ')],
        ['Due', x.due ? `${x.due}${x.dueComplete ? ' · done' : ''}` : null], ['Activity', x.dateLastActivity]].filter((m) => m[1]),
      body, comments: (x.actions || []).map((a) => ({ author: (a.memberCreator || {}).fullName, at: a.date, body: (a.data || {}).text || '' })).reverse() };
  }

  return {
    source, setSource,
    options() {
      const a = accounts();
      return { jira: (a.jira || []).map((x) => ({ id: x.id, name: `${x.email} · ${String(x.site || '').replace(/^https?:\/\//, '')}` })), trello: (a.trello || []).map((x) => ({ id: x.id, name: x.name })) };
    },
    async trelloBoards(accountId) {
      const acc = trelloAcc(accountId); if (!acc) throw new Error('Unknown Trello account');
      const b = await trello(trelloCreds(acc), '/members/me/boards', { filter: 'open', fields: 'name,dateLastActivity' });
      return b.sort((x, y) => String(y.dateLastActivity || '').localeCompare(String(x.dateLastActivity || ''))).map((x) => ({ id: x.id, name: x.name }));
    },
    async list(repoKey, { mine } = {}) {
      const s = source(repoKey);
      if (s.kind === 'jira') return jiraList(jiraAcc(s.account));
      if (s.kind === 'trello') return s.board ? trelloList(trelloAcc(s.account), s.board, mine) : { kind: 'trello', needBoard: true, account: s.account };
      return { kind: 'none' };
    },
    async detail(repoKey, id) {
      const s = source(repoKey);
      if (s.kind === 'jira') return jiraDetail(jiraAcc(s.account), id);
      if (s.kind === 'trello') return trelloDetail(trelloAcc(s.account), id);
      throw new Error('No task source');
    },
    async move(repoKey, id, groupId) {
      const s = source(repoKey);
      if (s.kind === 'trello') return trello(trelloCreds(trelloAcc(s.account)), `/cards/${id}`, { idList: groupId, pos: 'top' }, 'PUT');
      if (s.kind === 'jira') {
        const l = await jiraList(jiraAcc(s.account)), g = l.groups.find((x) => x.id === groupId);
        if (!g || g.backlog) throw new Error('Unknown column');
        return jiraMove(jiraAcc(s.account), id, g.statuses);
      }
      throw new Error('No task source');
    },
    // "PROJ-123 summary" for a branch's Jira key (MR titles), or null.
    async jiraSummary(repoKey, key) {
      const s = source(repoKey); if (s.kind !== 'jira') return null;
      try { const c = jiraCreds(jiraAcc(s.account)); return (await jira(c, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`)).fields.summary; } catch { return null; }
    },
  };
}

// Atlassian Document Format → markdown.
function adf(node) {
  if (!node) return '';
  const kids = (n, sep = '') => (n.content || []).map((c) => adf(c)).join(sep);
  const item = (li, marker) => { const [first, ...rest] = li.content || []; const tail = rest.map(adf).filter(Boolean).map((x) => x.replace(/^/gm, '  ')).join('\n'); return `${marker} ${first ? adf(first) : ''}${tail ? '\n' + tail : ''}`; };
  switch (node.type) {
    case 'doc': return kids(node, '\n\n');
    case 'paragraph': return kids(node);
    case 'text': {
      let t = node.text || '';
      for (const m of node.marks || []) {
        if (m.type === 'strong') t = `**${t}**`; else if (m.type === 'em') t = `*${t}*`; else if (m.type === 'code') t = '`' + t + '`';
        else if (m.type === 'strike') t = `~~${t}~~`; else if (m.type === 'link') t = `[${t}](${(m.attrs || {}).href})`;
      }
      return t;
    }
    case 'hardBreak': return '\n';
    case 'heading': return `${'#'.repeat(Math.min(6, (node.attrs || {}).level || 2))} ${kids(node)}`;
    case 'bulletList': return (node.content || []).map((li) => item(li, '-')).join('\n');
    case 'orderedList': return (node.content || []).map((li, i) => item(li, `${((node.attrs || {}).order || 1) + i}.`)).join('\n');
    case 'taskList': return (node.content || []).map((li) => `- [${(li.attrs || {}).state === 'DONE' ? 'x' : ' '}] ${kids(li)}`).join('\n');
    case 'codeBlock': return '```\n' + (node.content || []).map((c) => c.text || '').join('') + '\n```';
    case 'blockquote': case 'panel': return kids(node, '\n\n').replace(/^/gm, '> ');
    case 'rule': return '---';
    case 'mention': return `**@${String((node.attrs || {}).text || '').replace(/^@/, '')}**`;
    case 'emoji': return (node.attrs || {}).text || '';
    case 'status': return `\`${(node.attrs || {}).text || ''}\``;
    case 'inlineCard': case 'blockCard': case 'embedCard': return (node.attrs || {}).url || '';
    case 'mediaSingle': case 'mediaGroup': case 'media': case 'mediaInline': return '*[attachment, open in Jira]*';
    default: return kids(node);
  }
}

module.exports = { make };
