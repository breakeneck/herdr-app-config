'use strict';
// Pull/merge requests of a repo, as the desktop's wb-prs: github.com through `gh` (logged in on this
// machine), any other host as GitLab through its REST API with the token from secrets.json.
const { execFile } = require('child_process');

const run = (cmd, args, opts = {}) => new Promise((res) => {
  execFile(cmd, args, { maxBuffer: 32 << 20, timeout: 120000, ...opts }, (err, stdout, stderr) =>
    res({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});
const errText = (r) => (r.stderr || r.stdout).trim().split('\n').pop() || 'failed';

function remoteOf(url) {
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url) || /^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? { host: m[1].toLowerCase(), path: m[2] } : null;
}
async function repoOf(dir) {
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  const cwd = top.ok ? top.stdout.trim() : dir;
  const r = await run('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
  const rm = r.ok ? remoteOf(r.stdout.trim()) : null;
  return rm ? { key: `${rm.host}|${rm.path}`, name: rm.path, host: rm.host, path: rm.path, cwd, github: rm.host === 'github.com' } : { key: `server:${cwd}`, name: null, cwd };
}

const CI_BAD = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
function ci(rollup) {
  if (!rollup || !rollup.length) return '';
  if (rollup.some((c) => CI_BAD.includes(c.conclusion) || c.state === 'FAILURE' || c.state === 'ERROR')) return 'fail';
  if (rollup.some((c) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED')) return 'wait';
  return 'ok';
}
const pipelineState = (st) => !st ? '' : ['success', 'skipped', 'manual'].includes(st) ? 'ok' : ['failed', 'canceled'].includes(st) ? 'fail' : 'wait';
const MERGE_LABEL = { mergeable: 'ready', not_approved: 'review', discussions_not_resolved: 'threads', conflict: 'conflict', need_rebase: 'rebase', broken_status: 'broken', blocked_status: 'blocked' };
function ghApprovals(pr, me) {
  const last = new Map();
  for (const r of pr.reviews || []) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) last.set((r.author || {}).login, r.state);
  const by = [...last].filter(([, s]) => s === 'APPROVED').map(([l]) => l).filter(Boolean);
  return { approvedBy: by, mineApproved: Boolean(me && by.includes(me)) };
}

// Branch name → MR title: "PROJ-123 <summary>" / "PROJ-123 Words" / "Words" (wb-prs/title.js).
const KEY = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?![A-Za-z0-9])/;
const PREFIXES = /^(feature|feat|fix|bugfix|hotfix|bug|chore|refactor|release|task|story|review|wip|docs|test)$/i;
function jiraKey(branch) { const m = KEY.exec(branch || ''); return m && /^[A-Z][A-Z0-9]+-\d+$/.test(m[1]) ? m[1] : null; }
function branchWords(branch, key) {
  const parts = (branch || '').split('/').filter(Boolean);
  let tail = parts.pop() || '';
  if (key) tail = tail.replace(new RegExp(key.replace('-', '[-_]?'), 'i'), ' ');
  let text = tail.replace(/[-_.]+/g, ' ').trim();
  if (!text && parts.length && !PREFIXES.test(parts[parts.length - 1])) text = parts.pop().replace(/[-_.]+/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function make(conf, ai, tasks) {
  const glToken = (host) => conf.secret('gitlab', host);
  async function gitlab(host, p, method = 'GET', body) {
    const token = glToken(host);
    if (!token) throw new Error(`No GitLab token for ${host} on this server (run the desktop sync)`);
    const r = await fetch(`https://${host}/api/v4${p}`, { method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
      // git.allmylinks.com's firewall answers Node's default User-Agent with a 403 page.
      headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json', 'User-Agent': 'herdr-mobile', ...(body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!r.ok) throw Object.assign(new Error(r.status === 403 ? 'GitLab refused: the token needs the api scope' : `GitLab ${r.status}: ${(await r.text()).slice(0, 160)}`), { status: r.status });
    return r.json();
  }
  const proj = (r) => `/projects/${encodeURIComponent(r.path)}`;
  let ghMe;
  async function ghLogin(cwd) { if (ghMe === undefined) { const r = await run('gh', ['api', 'user', '--jq', '.login'], { cwd }); ghMe = r.ok ? r.stdout.trim() : null; } return ghMe; }
  const gh = async (r, args, opts) => { const x = await run('gh', args, { cwd: r.cwd, ...opts }); if (!x.ok) throw new Error(errText(x)); return x.stdout; };

  async function list(r, mine) {
    if (!r.host) throw new Error('No git remote (origin) in this folder');
    if (r.github) {
      const out = await gh(r, ['pr', 'list', ...(mine ? ['--author', '@me'] : []), '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,isDraft,reviewDecision,url,statusCheckRollup,reviews,author']);
      const me = await ghLogin(r.cwd);
      return JSON.parse(out).map((p) => ({ provider: 'github', number: p.number, title: p.title, branch: p.headRefName, draft: p.isDraft, url: p.url, author: (p.author || {}).login,
        ci: ci(p.statusCheckRollup), badge: p.reviewDecision === 'APPROVED' ? 'approved' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : '', ...ghApprovals(p, me) }));
    }
    const mrs = await gitlab(r.host, `${proj(r)}/merge_requests?state=opened&scope=${mine ? 'created_by_me' : 'all'}&per_page=100`);
    return Promise.all(mrs.map(async (mr) => {
      const [d, a] = await Promise.all([gitlab(r.host, `${proj(r)}/merge_requests/${mr.iid}`).catch(() => mr), gitlab(r.host, `${proj(r)}/merge_requests/${mr.iid}/approvals`).catch(() => null)]);
      return { provider: 'gitlab', number: mr.iid, title: mr.title, branch: mr.source_branch, draft: Boolean(mr.draft ?? mr.work_in_progress), url: mr.web_url,
        author: (mr.author || {}).name || (mr.author || {}).username, ci: pipelineState((d.head_pipeline || d.pipeline || {}).status), badge: MERGE_LABEL[d.detailed_merge_status] || '',
        approvedBy: ((a || {}).approved_by || []).map((x) => (x.user || {}).name).filter(Boolean), mineApproved: Boolean(a && a.user_has_approved) };
    }));
  }

  async function detail(r, n) {
    if (r.github) {
      const v = JSON.parse(await gh(r, ['pr', 'view', String(n), '--json', 'title,body,author,url,headRefName,baseRefName,createdAt,comments,reviews,isDraft']));
      const items = [...(v.comments || []).map((c) => ({ author: (c.author || {}).login, at: c.createdAt, body: c.body })),
        ...(v.reviews || []).filter((rv) => rv.body || rv.state !== 'COMMENTED').map((rv) => ({ author: (rv.author || {}).login, at: rv.submittedAt, body: rv.body, extra: rv.state.toLowerCase().replace('_', ' ') }))]
        .sort((p, q) => String(p.at).localeCompare(String(q.at)));
      return { provider: 'github', number: n, title: v.title, body: v.body || '', author: (v.author || {}).login, from: v.headRefName, to: v.baseRefName, created: v.createdAt, url: v.url, ...ghApprovals(v, await ghLogin(r.cwd)), comments: items };
    }
    const base = `${proj(r)}/merge_requests/${n}`;
    const [mr, a, notes] = await Promise.all([gitlab(r.host, base), gitlab(r.host, `${base}/approvals`).catch(() => null), gitlab(r.host, `${base}/notes?sort=asc&order_by=created_at&per_page=100`).catch(() => [])]);
    return { provider: 'gitlab', number: n, title: mr.title, body: mr.description || '', author: (mr.author || {}).name, from: mr.source_branch, to: mr.target_branch, created: mr.created_at, url: mr.web_url,
      approvedBy: ((a || {}).approved_by || []).map((x) => (x.user || {}).name), mineApproved: Boolean(a && a.user_has_approved),
      comments: notes.filter((x) => !x.system).map((x) => ({ author: (x.author || {}).name, at: x.created_at, body: x.body, extra: x.type === 'DiffNote' ? (x.position || {}).new_path : null })) };
  }

  async function diffText(r, n) {
    if (r.github) return gh(r, ['pr', 'diff', String(n)]);
    const base = `${proj(r)}/merge_requests/${n}`;
    const files = await gitlab(r.host, `${base}/diffs?per_page=100`).catch(async () => (await gitlab(r.host, `${base}/changes`)).changes || []);
    return files.map((f) => `diff --git a/${f.old_path} b/${f.new_path}\n--- a/${f.old_path}\n+++ b/${f.new_path}\n${f.diff}`).join('\n');
  }

  const git = (r, args, opts) => run('git', ['-C', r.cwd, ...args], opts);

  return {
    repoOf, list, detail,
    async approve(r, n, yes) {
      if (!r.github) return gitlab(r.host, `${proj(r)}/merge_requests/${n}/${yes ? 'approve' : 'unapprove'}`, 'POST');
      if (!yes) throw new Error("GitHub can't take an approval back from here");
      return gh(r, ['pr', 'review', String(n), '--approve']);
    },
    async comment(r, n, body) {
      if (!r.github) return gitlab(r.host, `${proj(r)}/merge_requests/${n}/notes`, 'POST', { body });
      return gh(r, ['pr', 'comment', String(n), '--body', body]);
    },
    async review(r, n) {
      const d = await detail(r, n), cfg = ai.settingsFor(conf.wb(), 'review', r.key), diff = await diffText(r, n);
      const prompt = `${cfg.template} ${ai.languageLine(cfg.language)}\n\nTitle: ${d.title}\n\nDescription:\n${(d.body || '(none)').slice(0, 8000)}\n\nDiff (${d.from} → ${d.to}):\n${diff.slice(0, 90000)}${diff.length > 90000 ? '\n… (diff truncated)' : ''}`;
      const text = await ai.runModel(cfg.model, prompt, { cwd: r.cwd, language: cfg.language });
      if (!text) throw new Error('the model returned nothing');
      return { text, model: cfg.model && cfg.model.name };
    },
    // What the Create dialog needs: the current branch, origin's branches, recent targets, a title.
    async createInfo(r) {
      const h = await git(r, ['rev-parse', '--abbrev-ref', 'HEAD']), branch = h.stdout.trim();
      if (!h.ok || branch === 'HEAD') throw new Error('No branch is checked out (detached HEAD)');
      await git(r, ['fetch', '--prune', 'origin'], { timeout: 60000 });
      const refs = await git(r, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin']);
      const branches = refs.stdout.split('\n').filter((b) => b && b !== 'origin' && !b.endsWith('/HEAD')).map((b) => b.replace(/^origin\//, '')).filter((b) => b !== branch);
      const head = await git(r, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      const def = head.ok ? head.stdout.trim().replace(/^origin\//, '') : ['main', 'master', 'develop', 'production'].find((b) => branches.includes(b)) || branches[0] || null;
      const recent = ((((conf.wb().mr || {}).recent) || {})[r.key] || []).filter((b) => branches.includes(b));
      const key = jiraKey(branch), sum = key ? await tasks.jiraSummary(r.key, key) : null;
      const title = sum ? `${key} ${sum}` : [key, branchWords(branch, key)].filter(Boolean).join(' ') || branch;
      return { branch, branches, recent, target: recent[0] || def, def, title: title.slice(0, 120), gitlab: !r.github, draft: (conf.drafts().mr || {})[`${r.key}|${branch}`] || null };
    },
    async commits(r, target) {
      const x = await git(r, ['log', '--format=%h%x09%s', `origin/${target}..HEAD`, '-50']);
      return x.ok ? x.stdout.split('\n').filter(Boolean).map((l) => { const [h, ...s] = l.split('\t'); return { hash: h, subject: s.join('\t') }; }) : [];
    },
    async describe(r, { branch, target, title }) {
      const cfg = ai.settingsFor(conf.wb(), 'mr', r.key);
      const log = await git(r, ['log', '--format=%s%n%b', `origin/${target}..HEAD`]);
      const diff = await git(r, ['diff', `origin/${target}...HEAD`]);
      if (!diff.ok) throw new Error(errText(diff));
      const d = diff.stdout;
      const prompt = `${cfg.template} ${ai.NO_TRAILERS} ${ai.languageLine(cfg.language)}\n\nTitle: ${title}\n\nCommits:\n${log.stdout.slice(0, 8000)}\n\nDiff (${target} ← ${branch}):\n${d.slice(0, 90000)}${d.length > 90000 ? '\n… (diff truncated)' : ''}`;
      const text = await ai.runModel(cfg.model, prompt, { cwd: r.cwd, language: cfg.language });
      if (!text) throw new Error('the model returned nothing');
      return { text };
    },
    async create(r, { target, title, body, draft }) {
      const h = await git(r, ['rev-parse', '--abbrev-ref', 'HEAD']), name = h.stdout.trim();
      if (!h.ok || name === 'HEAD') throw new Error('No branch is checked out');
      if (!/^[\w./-]+$/.test(target || '')) throw new Error('Pick a target branch');
      const ex = await git(r, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]);
      let needPush = !ex.ok;
      if (ex.ok) { const n = await git(r, ['rev-list', '--count', `origin/${name}..HEAD`]); needPush = !n.ok || Number(n.stdout.trim()) > 0; }
      if (needPush) { const p = await git(r, ['push', '-u', 'origin', `HEAD:${name}`], { timeout: 300000 }); if (!p.ok) throw new Error(`git push failed: ${(p.stderr || p.stdout).trim()}`); }
      let url;
      if (!r.github) url = (await gitlab(r.host, `${proj(r)}/merge_requests`, 'POST', { source_branch: name, target_branch: target, title: draft ? `Draft: ${title}` : title, description: body })).web_url;
      else url = (await gh(r, ['pr', 'create', '--base', target, '--head', name, '--title', title, '--body', body, ...(draft ? ['--draft'] : [])], { timeout: 300000 })).trim().split('\n').pop();
      const wb = conf.wb(), mr = wb.mr || {}, recent = (mr.recent || {})[r.key] || [];
      conf.setWb({ mr: { ...mr, recent: { ...(mr.recent || {}), [r.key]: [target, ...recent.filter((b) => b !== target)].slice(0, 5) } } });
      conf.setDraft('mr', `${r.key}|${name}`, null);
      return { url };
    },
  };
}

module.exports = { make, repoOf };
