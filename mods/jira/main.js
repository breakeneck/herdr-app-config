import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input, TextView } from "gpui-base";
import { exec, theme, shared, setShared, props, openOverlay, closeOverlay, spaces, panes, focused } from "herdr";
import * as S from "./section.js";
import { Trello, trelloAccount } from "./trello.js";
import { Buffer } from "buffer";

// My open Jira issues grouped by their board's columns ("folders": To Do, In Progress, ...), in the
// board's column order and rank order within a column, like the board itself; plus the project's backlog.
// Click selects an issue; drag it onto another column to move it there (a Jira transition);
// right-click: Go to Jira, Copy key.
// Accounts: shared "tasks.accounts".jira = [{ id: "<host>|<email>", site, email, base, project }] (no
// secrets); each one's API token in the macOS Keychain (service herdr-jira, account = that id).
// Nothing personal is in this repo.
// ponytail: an API token, not OAuth — OAuth needs a registered app with a secret and a local
// redirect server, which a mod can't host.
const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";
const MINE_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY Rank ASC";
const backlogJql = (project) => `project = "${project}" AND sprint is EMPTY AND statusCategory != Done ORDER BY rank ASC`;
const SERVICE = "herdr-jira";
const SETTINGS = "jira.settings";

const basic = (email, token) => "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

// Jira accounts (several logins: different emails, different sites).
const ACCOUNTS = "tasks.accounts";
const jiraAccounts = () => (shared(ACCOUNTS) ?? {}).jira ?? [];
const jiraAccount = (id) => jiraAccounts().find((a) => a.id === id) ?? null;
const jiraId = (site, email) => `${site.replace(/^https?:\/\//, "")}|${email.toLowerCase()}`;
function upsertJira(acc) {
  const all = shared(ACCOUNTS) ?? {}, list = all.jira ?? [];
  setShared(ACCOUNTS, { ...all, jira: list.some((a) => a.id === acc.id) ? list.map((a) => (a.id === acc.id ? acc : a)) : [...list, acc] });
}

// An account's email and auth header, or null (no token saved for it).
async function credentials(acc) {
  if (!acc) return null;
  const r = await exec("security", ["find-generic-password", "-s", SERVICE, "-a", acc.id, "-w"]);
  return r.code === 0 ? { email: acc.email, auth: basic(acc.email, r.stdout.trim()) } : null;
}

async function jira(base, auth, path, body) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: auth, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw Object.assign(new Error(`Jira ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
  return r.status === 204 ? null : r.json();
}

// A classic API token works against the site; a token "with scopes" only through Atlassian's gateway
// (read:jira-work and read:jira-user). /myself, not a search: Jira answers an unauthenticated search
// with 200 and no issues. Returns the base that took the credentials; throws Jira's 401/403 if none did.
async function findBase(site, auth) {
  const cloudId = await fetch(`${site}/_edge/tenant_info`).then((r) => r.json()).then((j) => j.cloudId, () => null);
  let rejected = null;
  for (const candidate of [site, ...(cloudId ? [`https://api.atlassian.com/ex/jira/${cloudId}`] : [])]) {
    try { await jira(candidate, auth, "/rest/api/3/myself"); return candidate; }
    catch (e) { if (e.status !== 401 && e.status !== 403) throw e; rejected = e; }
  }
  throw rejected;
}

// A project's board columns, in board order: [{ name, statuses: [status id] }], or null without a board.
// The board that belongs to the project (its location) wins over one that merely shows it.
async function boardColumns(base, auth, project) {
  const { values = [] } = await jira(base, auth, `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}&maxResults=50`);
  const board = values.find((b) => b.location?.projectKey === project) ?? values[0];
  if (!board) return null;
  const cfg = await jira(base, auth, `/rest/agile/1.0/board/${board.id}/configuration`);
  return (cfg.columnConfig?.columns ?? []).map((c) => ({ name: c.name, statuses: (c.statuses ?? []).map((x) => String(x.id)) }));
}

const normalizeSite = (text) => {
  const site = text.trim().replace(/\/+$/, "");
  return site && !/^https?:\/\//.test(site) ? `https://${site}` : site;
};

// Atlassian Document Format (descriptions, comments) → markdown for TextView.markdown.
function adf(node, depth = 0) {
  if (!node) return "";
  const kids = (n, sep = "") => (n.content ?? []).map((c) => adf(c, depth)).join(sep);
  const item = (li, marker) => {
    const [first, ...rest] = li.content ?? [];
    const head = first ? adf(first, depth + 1) : "";
    const tail = rest.map((c) => adf(c, depth + 1)).filter(Boolean).map((x) => x.replace(/^/gm, "  ")).join("\n");
    return `${marker} ${head}${tail ? "\n" + tail : ""}`;
  };
  switch (node.type) {
    case "doc": return kids(node, "\n\n");
    case "paragraph": return kids(node);
    case "text": {
      let t = node.text ?? "";
      for (const m of node.marks ?? []) {
        if (m.type === "strong") t = `**${t}**`; else if (m.type === "em") t = `*${t}*`;
        else if (m.type === "code") t = "`" + t + "`"; else if (m.type === "strike") t = `~~${t}~~`;
        else if (m.type === "link") t = `[${t}](${m.attrs?.href})`;
      }
      return t;
    }
    case "hardBreak": return "  \n";
    case "heading": return `${"#".repeat(Math.min(6, node.attrs?.level ?? 2))} ${kids(node)}`;
    case "bulletList": return (node.content ?? []).map((li) => item(li, "-")).join("\n");
    case "orderedList": return (node.content ?? []).map((li, i) => item(li, `${(node.attrs?.order ?? 1) + i}.`)).join("\n");
    case "taskList": return (node.content ?? []).map((li) => `- [${li.attrs?.state === "DONE" ? "x" : " "}] ${kids(li)}`).join("\n");
    case "codeBlock": return "```" + (node.attrs?.language ?? "") + "\n" + (node.content ?? []).map((c) => c.text ?? "").join("") + "\n```";
    case "blockquote": case "panel": return kids(node, "\n\n").replace(/^/gm, "> ");
    case "rule": return "---";
    case "mention": return `**@${String(node.attrs?.text ?? "").replace(/^@/, "")}**`;
    case "emoji": return node.attrs?.text ?? node.attrs?.shortName ?? "";
    case "date": return new Date(Number(node.attrs?.timestamp)).toLocaleDateString();
    case "status": return `\`${node.attrs?.text ?? ""}\``;
    case "inlineCard": case "blockCard": case "embedCard": return node.attrs?.url ? `<${node.attrs.url}>` : "";
    case "mediaSingle": case "mediaGroup": case "media": case "mediaInline": return "*[attachment — open in Jira]*";
    case "table": {
      const rows = (node.content ?? []).map((r) => (r.content ?? []).map((c) => kids(c, " ").replace(/\|/g, "\\|").replace(/\n/g, " ")));
      if (!rows.length) return "";
      const w = Math.max(...rows.map((r) => r.length));
      return [rows[0], Array(w).fill("---"), ...rows.slice(1)].map((r) => `| ${r.join(" | ")} |`).join("\n");
    }
    default: return kids(node);
  }
}
// The Tasks panel follows the focused project: its source is Jira (the default) or a Trello board,
// chosen per repo and kept in shared "tasks.sources" = { repoKey: { kind: "jira" | "trello", board?: { id, name } } }.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
// A repo's key from its origin remote (host|path, so every checkout of it shares the choice).
function remoteKey(url) {
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url) ?? /^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1].toLowerCase()}|${m[2]}` : null;
}
const STALE = 30000; // a cached list shows at once; a switch refreshes it when older than this
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

export default class Jira extends View {
  init(_props, cx) {
    // Opened as a popup for one issue (click on a row): show it whole, nothing else.
    if (props()?.issue) { this.detailKey = props().issue; this.detailAcc = jiraAccount(props().account); this.loadDetail(cx); return; }
    if (props()?.trelloCard) { this.trello = new Trello(this); this.trello.account = props().account; this.cardPopup = true; this.trello.loadCard(props().trelloCard, cx); return; }
    this.jst = {}; // Jira account id -> its list state (issues, columns, ...), see st()
    this.trello = new Trello(this);
    this.remotes = new Map(store.get("remotes", [])); // `${on}|${cwd}` -> repo key
    this.loc = null; this.repo = null; this.picking = false; this.trelloForm = false; this.choosing = false; this.jform = null;
    this.press = null; this.dragging = false; // a pressed issue row, and whether it's being dragged
    this.saving = false; this.formError = null; this.query = "";
    const input = (placeholder) => { const s = InputState.new({ placeholder }); s.on("submit", (_e, cx) => this.save(cx)); return s; };
    this.site = input("https://your-company.atlassian.net");
    this.project = input("Project key for the backlog, e.g. DA");
    this.email = input("Atlassian email");
    this.token = input("API token");
    this.token.set_masked(true);
    this.search = InputState.new({ placeholder: "Search by key or title" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    cx.spawn(async (cx) => { await this.migrate(); this.loc = null; this.follow(cx); });
    cx.timer.every(2000, (cx) => this.follow(cx)); // a `cd` in a terminal; render catches space switches
    cx.timer.every(2 * 60 * 1000, (cx) => {
      const src = this.source();
      if (src.kind === "trello") { if (src.board) this.trello.refresh(src.board.id, cx); } else if (src.kind === "jira") this.refresh(cx, src.account);
    });
  }

  // Where this project's tasks come from: { kind: "none" | "jira" | "trello", account, board? }.
  // Unknown projects, and ones whose account is gone, are "none" (the chooser).
  source() {
    const s = (this.repo && (shared("tasks.sources") ?? {})[this.repo]) || { kind: "none" };
    if (s.kind === "jira" && !jiraAccount(s.account)) return { kind: "none" };
    if (s.kind === "trello" && !trelloAccount(s.account)) return { kind: "none" };
    return s;
  }
  setSource(next, cx) {
    if (!this.repo) return;
    setShared("tasks.sources", { ...(shared("tasks.sources") ?? {}), [this.repo]: next });
    this.picking = false; this.choosing = false; this.jform = null; this.trelloForm = false;
    this.activate(cx);
  }

  // One Jira account's list state; its cached list (localStorage) shows at once.
  st(id) {
    const k = id ?? "-";
    if (!this.jst[k]) {
      const c = id ? store.get(`jira:cache:${id}`, null) : null;
      const st = { issues: c?.issues ?? [], backlog: c?.backlog ?? [], columns: c?.columns ?? {}, at: c?.at ?? 0, verified: false, error: null, loading: false };
      st.groups = this.group(st.issues, st.columns); st.count = st.issues.length;
      this.jst[k] = st;
    }
    return this.jst[k];
  }

  // The first builds had one Jira login (jira.settings + a Keychain item named by the email) and
  // Jira as every project's default: that login becomes an account, and every project already seen
  // stays on it. An old single Trello login becomes a Trello account the same way.
  async migrate() {
    const sources = { ...(shared("tasks.sources") ?? {}) };
    if (!jiraAccounts().length) {
      const s = shared(SETTINGS);
      const [item, token] = await Promise.all([exec("security", ["find-generic-password", "-s", SERVICE]), exec("security", ["find-generic-password", "-s", SERVICE, "-w"])]);
      const email = /"acct"<blob>="([^"]*)"/.exec(item.stdout)?.[1];
      if (s?.site && email && !email.includes("|") && token.code === 0) {
        const id = jiraId(s.site, email);
        const r = await exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", id, "-w", token.stdout.trim()]);
        if (r.code === 0) {
          upsertJira({ id, site: s.site, email, base: s.base ?? s.site, project: s.project ?? "" });
          const old = store.get("jira:cache", null);
          if (old) store.set(`jira:cache:${id}`, old);
          for (const [k, v] of Object.entries(sources)) if (v.kind === "jira" && !v.account) sources[k] = { kind: "jira", account: id };
          for (const repo of new Set(this.remotes.values())) if (!sources[repo]) sources[repo] = { kind: "jira", account: id };
        }
      }
    }
    const trelloId = await this.trello.migrate();
    if (trelloId) for (const [k, v] of Object.entries(sources)) if (v.kind === "trello" && !v.account) sources[k] = { ...v, account: trelloId };
    setShared("tasks.sources", sources);
  }

  // The focused place moved: find its repo (cached), then show its source at once.
  follow(cx) {
    const loc = location(), lk = `${loc.on}|${loc.cwd}`;
    if (lk === this.loc) return;
    this.loc = lk; this.choosing = false; this.picking = false;
    if (this.remotes.has(lk)) { this.repo = this.remotes.get(lk); this.activate(cx); return; }
    if (!loc.cwd) { this.repo = null; this.activate(cx); return; }
    cx.spawn(async (cx) => {
      const r = await exec("git", ["remote", "get-url", "origin"], { cwd: loc.cwd, on: loc.on }).catch(() => null);
      const repo = (r?.code === 0 && remoteKey(r.stdout.trim())) || lk;
      this.remotes.set(lk, repo); store.set("remotes", [...this.remotes]);
      if (this.loc === lk) { this.repo = repo; this.activate(cx); }
    });
  }

  activate(cx) {
    const src = this.source();
    if (src.kind === "trello") {
      this.trello.account = src.account;
      this.trello.ready().then(() => cx.notify());
      if (src.board) this.trello.show(src.board.id, cx);
      else this.trello.loadBoards(cx);
    } else if (src.kind === "jira") {
      const st = this.st(src.account);
      if (!st.loading && Date.now() - st.at > STALE) this.refresh(cx, src.account);
    }
    cx.notify();
  }

  overTarget(id, hovered, cx) {
    if (hovered) { if (this.over !== id) { this.over = id; if (this.dragging) cx.notify(); } }
    else if (this.over === id) { this.over = null; if (this.dragging) cx.notify(); }
  }
  openTrelloCard(id) { openOverlay({ mod: "jira", kind: "dialog", width: 760, height: 0.85, props: { trelloCard: id, account: this.trello.account } }); }

  // The Jira account form: "add" (empty) or "edit" the project's account (project key, a new token).
  openJiraForm(mode, cx) {
    const acc = mode === "edit" ? jiraAccount(this.source().account) : null;
    this.jform = { mode, id: acc?.id ?? null }; this.choosing = false; this.trelloForm = false;
    this.site.set_value(acc?.site ?? ""); this.project.set_value(acc?.project ?? ""); this.email.set_value(acc?.email ?? "");
    this.token.set_value(""); this.formError = null;
    cx.notify();
  }

  refresh(cx, id = this.source().account) {
    const acc = jiraAccount(id);
    if (!acc) return;
    const st = this.st(id);
    if (st.loading) return;
    st.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const creds = await credentials(acc);
        if (!creds) { st.error = "No token saved for this account · edit it (⚙) to paste one"; return; }
        // Once per session: a token that stopped working would otherwise look like "no issues".
        if (!st.verified) {
          const base = await findBase(acc.site, creds.auth); st.verified = true;
          if (base !== acc.base) upsertJira({ ...acc, base });
        }
        const base = jiraAccount(id)?.base ?? acc.site, project = acc.project;
        // ponytail: first 100 of mine and 50 of the backlog; page with nextPageToken if that's ever too few.
        const fields = ["summary", "status", "issuetype", "labels", "project"];
        const search = (jql, fields, maxResults) => jira(base, creds.auth, "/rest/api/3/search/jql", { jql, fields, maxResults });
        const [{ issues = [] }, { issues: backlog = [] }] = await Promise.all([
          search(MINE_JQL, fields, 100),
          project ? search(backlogJql(project), ["summary", "status", "issuetype", "labels"], 50) : { issues: [] },
        ]);
        for (const key of new Set(issues.map((i) => i.fields.project?.key).filter(Boolean))) {
          if (!(key in st.columns)) st.columns[key] = await boardColumns(base, creds.auth, key).catch(() => null);
        }
        st.issues = issues; st.groups = this.group(issues, st.columns);
        st.backlog = backlog; st.count = issues.length; st.error = null; st.at = Date.now();
        store.set(`jira:cache:${id}`, { issues, columns: st.columns, backlog, at: st.at });
      } catch (e) {
        if (e.status === 401) { st.verified = false; st.error = "Jira rejected this account's token · edit it (⚙) to paste a new one"; }
        else st.error = String(e.message ?? e);
      } finally { st.loading = false; cx.notify(); }
    });
  }

  // Checks the form against Jira, then saves the account (the same site + email updates it, never
  // a second login) and puts this project on it.
  save(cx) {
    if (this.saving) return;
    const site = normalizeSite(this.site.value()), project = this.project.value().trim().toUpperCase();
    const email = this.email.value().trim(), token = this.token.value().trim();
    const fail = (message) => { this.formError = message; cx.notify(); };
    if (!/^https:\/\/[^\s/]+$/.test(site)) return fail("Jira URL: https://<name>.atlassian.net");
    if (project && !/^[A-Z][A-Z0-9_]*$/.test(project)) return fail("Project key: letters, digits and _ (like DA)");
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail("Enter your Atlassian email");
    const id = jiraId(site, email), existing = jiraAccount(id);
    if (token ? /\s/.test(token) || token.length < 20 : !existing) return fail("Paste the API token (Open token page → Create API token → Copy)");
    this.saving = true; this.formError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const auth = token ? basic(email, token) : (await credentials(existing))?.auth;
        if (!auth) throw new Error("No saved token · paste one");
        const base = await findBase(site, auth);
        if (token) {
          // ponytail: -w puts the token in `security`'s argv for a moment (local ps only); its prompt can't be driven from a mod.
          const r = await exec("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", id, "-w", token]);
          if (r.code !== 0) throw new Error(`Keychain: ${(r.stderr || r.stdout).trim()}`);
          this.token.set_value("");
        }
        upsertJira({ id, site, email, base, project });
        delete this.jst[id];
        this.setSource({ kind: "jira", account: id }, cx);
        this.refresh(cx, id);
      } catch (e) {
        this.formError = e.status === 401 || e.status === 403
          ? `Jira rejected these credentials (${e.message}). Check the URL and email; a token with scopes needs read:jira-work and read:jira-user.`
          : String(e.message ?? e);
      } finally { this.saving = false; cx.notify(); }
    });
  }

  // Which account this project's tasks come from: the logins already saved, a new one, or none.
  chooserView(t, repoName, src) {
    const row = (id, icon, label, sub, on, act) => h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
      .when(on, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(act)
      .child(svg(icon).size(13).text_color(t.dim)).child(div().flex_1().min_w(0).truncate().child(label))
      .child(div().flex_none().max_w(160).truncate().text_size(10).text_color(t.dim).child(sub))
      .when(on, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("✓")));
    const add = (id, label, act) => h_flex().id(id).h(26).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(act).child(div().w(13).child("+")).child(label);
    const head = (text) => div().px(8).pt(10).pb(2).text_size(10).font_semibold().text_color(t.dim).child(text);
    const tAccounts = (shared(ACCOUNTS) ?? {}).trello ?? [];
    return v_flex().p(6).gap(1)
      .child(div().px(8).py(4).text_size(12).text_color(this.repo ? t.foreground : t.dim)
        .child(this.repo ? `Tasks for ${repoName}` : "Open a project folder to choose where its tasks come from"))
      .when(Boolean(this.repo), (e) => e
        .child(head("JIRA"))
        .children(jiraAccounts().map((a) => row(`ja-${a.id}`, "mods/jira/jira.svg", a.email, a.site.replace(/^https?:\/\//, ""),
          src.kind === "jira" && src.account === a.id, (_e, cx) => this.setSource({ kind: "jira", account: a.id }, cx))))
        .child(add("ja-add", "Add Jira account", (_e, cx) => this.openJiraForm("add", cx)))
        .child(head("TRELLO"))
        .children(tAccounts.map((a) => row(`ta-${a.id}`, "mods/jira/trello.svg", a.name, a.username ? `@${a.username}` : "",
          src.kind === "trello" && src.account === a.id,
          (_e, cx) => this.setSource({ kind: "trello", account: a.id, board: src.kind === "trello" && src.account === a.id ? src.board : null }, cx))))
        .child(add("ta-add", "Add Trello account", (_e, cx) => { this.trello.startAdd(); this.trelloForm = true; this.choosing = false; this.jform = null; cx.notify(); }))
        .child(head("OR"))
        .child(row("src-none", "mods/jira/settings.svg", "Not connected", "", src.kind === "none", (_e, cx) => this.setSource({ kind: "none" }, cx))));
  }

  // Board columns per project (projects with the most of my issues first). Issues keep Jira's rank
  // order inside a column. Every column is listed, even an empty one: it is somewhere to drop.
  // A status no column maps (a board without it) gets a group of its own at the end.
  group(issues, columns) {
    const byProject = new Map();
    for (const i of issues) { const k = i.fields.project?.key ?? "?"; if (!byProject.has(k)) byProject.set(k, []); byProject.get(k).push(i); }
    const many = byProject.size > 1, groups = [];
    for (const [project, list] of [...byProject].sort((a, b) => b[1].length - a[1].length)) {
      const cols = columns[project] ?? [];
      const mine = cols.map((c) => ({ id: `${project}:${c.name}`, project, name: many ? `${project} · ${c.name}` : c.name, statuses: c.statuses, issues: [] }));
      for (const i of list) {
        const sid = String(i.fields.status?.id ?? "");
        let g = mine.find((x) => x.statuses.includes(sid));
        if (!g) {
          const name = i.fields.status?.name ?? "No status";
          g = mine.find((x) => x.id === `${project}:?${name}`);
          if (!g) mine.push(g = { id: `${project}:?${name}`, project, name: many ? `${project} · ${name}` : name, statuses: [sid], issues: [] });
        }
        g.issues.push(i);
      }
      groups.push(...mine);
    }
    return groups;
  }

  // One issue, whole: fields, description and comments (ADF → markdown).
  loadDetail(cx) {
    this.detail = null; this.detailError = null;
    cx.spawn(async (cx) => {
      try {
        const acc = this.detailAcc, creds = await credentials(acc), base = acc?.base ?? acc?.site;
        if (!creds || !base) throw new Error("Jira isn't connected");
        const f = "summary,status,issuetype,priority,assignee,reporter,labels,description,comment,created,updated,parent,project";
        this.detail = await jira(base, creds.auth, `/rest/api/3/issue/${encodeURIComponent(this.detailKey)}?fields=${f}`);
      } catch (e) { this.detailError = String(e.message ?? e); }
      cx.notify();
    });
  }

  detailView(t) {
    const d = this.detail, f = d?.fields ?? {}, key = this.detailKey, url = `${this.detailAcc?.site}/browse/${key}`;
    const close = () => closeOverlay(props()?.overlay);
    const cat = f.status?.statusCategory?.key, tone = cat === "indeterminate" ? t.working : cat === "done" ? t.done : t.muted;
    const btn = (id, label, act) => div().id(id).h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(act).child(label);
    const meta = (label, value) => !value ? null : h_flex().gap(8).items_center().text_size(12)
      .child(div().w(72).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).truncate().child(value));
    const comments = (f.comment?.comments ?? []).slice(-30);
    return v_flex().id("jira-issue").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.dim).child(key))
        .when(Boolean(f.issuetype), (e) => e.child(div().text_size(11).text_color(t.dim).child(`· ${f.issuetype.name}`)))
        .when(Boolean(f.status), (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(tone).text_size(11).text_color(tone).child(f.status.name)))
        .child(div().flex_1())
        .child(btn("open-jira", "Open in Jira", () => exec("open", [url])))
        .child(btn("copy-key", `Copy ${key}`, (_e, cx) => cx.write_to_clipboard(key)))
        .child(div().id("close").size(26).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(close).child("✕")))
      .child(v_flex().id("issue-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(14)
        .when(!d, (e) => e.child(div().text_color(this.detailError ? t.ansi1 : t.dim).child(this.detailError ?? "Loading…")))
        .when(Boolean(d), (e) => e
          .child(div().text_size(17).font_semibold().child(f.summary ?? ""))
          .child(v_flex().gap(5)
            .children([meta("Assignee", f.assignee?.displayName ?? "Unassigned"), meta("Reporter", f.reporter?.displayName),
              meta("Priority", f.priority?.name), meta("Parent", f.parent ? `${f.parent.key} ${f.parent.fields?.summary ?? ""}` : null),
              meta("Labels", (f.labels ?? []).join(", ")), meta("Updated", when(f.updated))].filter(Boolean)))
          .child(div().h(1).bg(t.border))
          .child(f.description ? TextView.markdown(`desc-${key}`, adf(f.description)) : div().text_color(t.dim).child("No description"))
          .when(comments.length > 0, (e) => e
            .child(div().h(1).bg(t.border))
            .child(div().text_size(11).font_semibold().text_color(t.dim).child(`COMMENTS · ${f.comment.total ?? comments.length}`))
            .children(comments.map((c) => v_flex().gap(4).p(10).rounded(8).bg(t.raised)
              .child(h_flex().gap(8).text_size(11).child(div().font_semibold().child(c.author?.displayName ?? "")).child(div().text_color(t.dim).child(when(c.created))))
              .child(TextView.markdown(`c-${c.id}`, adf(c.body))))))));
  }

  // Moves an issue to a column: the transition that leads to one of the column's statuses.
  // Shown there at once; the next refresh shows what Jira did.
  transition(key, to, cx) {
    const id = this.source().account, acc = jiraAccount(id), st = this.st(id);
    const issue = st.issues.find((i) => i.key === key);
    if (!issue || to.statuses.includes(String(issue.fields.status?.id))) return;
    cx.spawn(async (cx) => {
      try {
        const creds = await credentials(acc), base = acc?.base ?? acc?.site;
        if (!creds) throw new Error("not connected");
        const { transitions = [] } = await jira(base, creds.auth, `/rest/api/3/issue/${key}/transitions`);
        const tr = transitions.find((x) => to.statuses.includes(String(x.to?.id)));
        if (!tr) throw new Error(`no transition from "${issue.fields.status?.name}" to "${to.name}" for ${key}`);
        await jira(base, creds.auth, `/rest/api/3/issue/${key}/transitions`, { transition: { id: tr.id } });
        issue.fields.status = tr.to;
        // Done-category statuses aren't in "my open issues": it leaves the list.
        if (tr.to?.statusCategory?.key === "done") st.issues = st.issues.filter((i) => i !== issue);
        st.groups = this.group(st.issues, st.columns); st.count = st.issues.length; st.error = null;
      } catch (e) { st.error = `Move ${key}: ${e.message ?? e}`; }
      cx.notify();
      this.refresh(cx, id);
    });
  }

  field(id, label, state, t) {
    return v_flex().gap(3)
      .child(div().text_size(10).text_color(t.dim).child(label))
      .child(div().id(id).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(state).h_full().text_size(12).text_color(t.foreground)));
  }

  formView(t) {
    const button = (id, label, primary, onClick) => div().id(id).h(28).px(12).flex().flex_1().items_center().justify_center().rounded(7).cursor_pointer().text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.9)).on_click(onClick).child(label);
    const edit = this.jform?.mode === "edit", keepToken = edit ? "API token (empty: keep the saved one)" : "API token";
    return v_flex().p(8).gap(8).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child(edit ? "Jira account" : "Add a Jira account"))
      .child(this.field("site", "Jira URL", this.site, t))
      .child(this.field("project", "Backlog project key (optional)", this.project, t))
      .child(this.field("email", "Atlassian email", this.email, t))
      .child(this.field("token", keepToken, this.token, t))
      .child(h_flex().gap(6)
        .child(button("open-token-page", "Open token page", false, () => exec("open", [TOKEN_PAGE])))
        .child(button("save", this.saving ? "Checking…" : "Save", true, (_e, cx) => this.save(cx))))
      .child(button("cancel", "Cancel", false, (_e, cx) => { this.jform = null; cx.notify(); }))
      .when(Boolean(this.formError), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.formError)))
      .child(div().text_size(10).text_color(t.dim).child("Checked against Jira before saving. The token goes to the macOS Keychain (herdr-jira); a token with scopes needs read:jira-work and read:jira-user."));
  }

  url(key) { return `${jiraAccount(this.source().account)?.site}/browse/${key}`; }

  menuView(t) {
    const { key, x, y } = this.menu, w = 200;
    const item = (id, label, action) => div().id(id).h(26).px(10).flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.menu = null; action(cx); cx.notify(); }).child(label);
    return v_flex().id("issue-menu").absolute().top(y).left(Math.max(4, Math.min(x, (this.width ?? w) - w - 4))).w(w).p(4).gap(1)
      .rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      .children(this.menuItems(key).map(([id, label, act]) => item(id, label, act)));
  }

  // A task's right-click items: Jira issues by key, Trello cards as "t:<card id>".
  menuItems(key) {
    if (key.startsWith("t:")) {
      const c = this.trello.findCard(key.slice(2));
      if (!c) return [];
      return [["menu-open", "Open in Trello", () => exec("open", [c.shortUrl])],
        ["menu-copy-link", "Copy link", (cx) => cx.write_to_clipboard(c.shortUrl)],
        ["menu-copy-key", `Copy #${c.idShort}`, (cx) => cx.write_to_clipboard(`#${c.idShort}`)]];
    }
    return [["menu-open", "Go to Jira", () => exec("open", [this.url(key)])],
      ["menu-copy-link", "Copy link", (cx) => cx.write_to_clipboard(this.url(key))],
      ["menu-copy-key", `Copy ${key}`, (cx) => cx.write_to_clipboard(key)]];
  }

  startDrag(cx) { this.dragging = true; this.dragged = true; cx.notify(); }
  maybeStartDrag(e, cx) {
    if (!this.press || this.dragging || !this.pressAt) return;
    if (Math.abs(e.position.x - this.pressAt.x) + Math.abs(e.position.y - this.pressAt.y) < 6) return;
    this.startDrag(cx);
  }

  groupHeader(name, count, t) {
    return h_flex().h(24).flex_none().px(8).pt(6).gap(6).items_center().text_size(10).text_color(count ? t.dim : t.muted).when(!count, (e) => e.opacity(0.6))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(name.toUpperCase()))
      .child(div().child(String(count)));
  }

  // `section` keeps ids unique: an issue of mine can also sit in the backlog.
  issueRow(issue, t, section) {
    const f = issue.fields, cat = f.status?.statusCategory?.key;
    const color = cat === "indeterminate" ? t.working : cat === "done" ? t.done : t.muted;
    const hotfix = (f.labels ?? []).some((l) => l.toLowerCase() === "hotfix");
    return h_flex().id(`issue-${section}-${issue.key}`).h(22).flex_none().px(8).gap(6).items_center().rounded(5).cursor_pointer().relative()
      // Label "hotfix": a red bar on the row's left edge.
      .when(hotfix, (e) => e.child(div().absolute().left(1).top(4).bottom(4).w(3).rounded(2).bg(t.ansi1)))
      .when(this.selected === issue.key || this.menu?.key === issue.key, (s) => s.bg(t.selected))
      .hover((s) => s.bg(t.hover)).tooltip(`${issue.key} · ${f.issuetype?.name ?? ""}\n${f.summary}`)
      // A click (not the end of a drag) opens the whole issue in a popup.
      .on_click((_e, cx) => {
        if (this.dragged) { this.dragged = false; return; }
        this.selected = issue.key; cx.notify();
        openOverlay({ mod: "jira", kind: "dialog", width: 760, height: 0.85, props: { issue: issue.key, account: this.source().account } });
      })
      // Press starts a possible drag (mine only: backlog issues aren't on my board's columns).
      .on_mouse_down("left", (e) => { if (section === "mine") { this.press = issue.key; this.pressAt = e.position; this.dragging = false; this.dragged = false; } })
      // Drag start, seen by the row itself too: the pointer moved off the pressed row, or travelled.
      .on_mouse_move((e, cx) => this.maybeStartDrag(e, cx))
      .on_hover((h, cx) => { if (!h && this.press === issue.key && !this.dragging) this.startDrag(cx); })
      // The root's own right-press handler (it runs next) places the menu.
      .on_mouse_down("right", () => { this.menuKey = issue.key; })
      .child(div().flex_none().text_size(11).text_color(t.dim).child(issue.key))
      .when(this.dragging && this.press === issue.key, (e) => e.opacity(0.45))
      .child(div().flex_none().size(6).rounded(3).bg(color))
      .child(div().flex_1().min_w(0).truncate().child(f.summary ?? ""));
  }

  render(cx) {
    const t = theme(), q = this.query;
    const match = (issue) => !q || issue.key.toLowerCase().includes(q) || (issue.fields.summary ?? "").toLowerCase().includes(q);
    if (this.detailKey) return this.detailView(t);
    if (this.cardPopup) return this.trello.cardView(t);
    // A space switch: follow it right after this frame (render itself mustn't notify).
    const loc = location();
    if (`${loc.on}|${loc.cwd}` !== this.loc && !this.followSoon) { this.followSoon = true; cx.spawn(async (cx) => { this.followSoon = false; this.follow(cx); }); }
    const src = this.source(), tr = src.kind === "trello", jr = src.kind === "jira", T = this.trello;
    const J = this.st(jr ? src.account : null), acc = jr ? jiraAccount(src.account) : tr ? trelloAccount(src.account) : null;
    const repoName = (this.repo ?? "").split("|").pop().split("/").pop() || "this project";
    // What the body shows: a form, the account chooser, the board picker, or the tasks.
    const mode = this.jform ? "jform" : this.trelloForm || (tr && T.creds === null) ? "tform"
      : src.kind === "none" || this.choosing ? "choose" : tr && (!src.board || this.picking) ? "pick" : tr ? "trello" : "jira";
    // Every board column shows, empty ones too (somewhere to drop); a search hides the empty ones.
    const groups = J.groups.map((g) => ({ ...g, issues: g.issues.filter(match) })).filter((g) => g.issues.length || !q || this.dragging);
    const backlog = J.backlog.filter(match), project = jr ? acc?.project : null;
    const empty = J.error || (J.loading && !J.groups.length ? "Loading…"
      : q && !groups.some((g) => g.issues.length) && !backlog.length ? "No matches" : !J.count && !J.loading ? "No open issues assigned to you" : null);
    const iconButton = (id, icon, tip, onClick, spin = false) => div().id(id).size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip(tip).on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); }).child(svg(icon).size(14).when(spin, (s) => s.spin(900)));
    const sec = S.sectionOf("jira"), ov = S.overlay(sec);
    return v_flex().id("jira").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      // A press on an issue becomes a drag once the pointer moves; the release (here, after a
      // column's own handler) ends it. Leaving the panel cancels.
      // A few px of travel first, so a click's jitter never turns into a drag (empty columns appear then).
      .on_mouse_move((e, cx) => this.maybeStartDrag(e, cx))
      // The release: drop on the column under the pointer (tracked by hover), then end the drag.
      .on_mouse_up("left", (_e, cx) => {
        if (this.dragging && this.press && this.over) {
          if (this.press.startsWith("t:")) { if (this.over.startsWith("tl:") && src.board) T.move(this.press.slice(2), this.over.slice(3), src.board.id, cx); }
          else { const g = J.groups.find((x) => x.id === this.over); if (g) this.transition(this.press, g, cx); }
        }
        if (this.press || this.dragging) { this.press = null; this.dragging = false; this.over = null; cx.notify(); }
      })
      .on_hover((h, cx) => { if (!h && this.press) { this.press = null; this.dragging = false; cx.notify(); } })
      .on_mouse_down("right", (e, cx) => {
        if (!this.menuKey) return;
        this.selected = this.menuKey;
        this.menu = { key: this.menuKey, x: e.local_position?.x ?? 8, y: e.local_position?.y ?? 8 }; this.menuKey = null;
        cx.stop_propagation(); cx.notify();
      })
      .child(S.header(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border), sec, 44)
        .child(S.mark(sec))
        // This project's source and account; click: choose another (saved logins, a new one, none).
        .child(h_flex().id("source").flex_none().max_w(190).h(24).px(7).gap(5).items_center().rounded(6).border_1().border_color(t.border).cursor_pointer()
          .bg(mode === "choose" ? t.selected : t.background).hover((s) => s.bg(t.hover)).text_size(11)
          .tooltip(this.repo ? `Where the tasks of ${repoName} come from` : "Open a project folder first")
          .on_click((_e, cx) => { cx.stop_propagation(); this.choosing = !this.choosing; this.jform = null; this.trelloForm = false; cx.notify(); })
          .child(svg(tr ? "mods/jira/trello.svg" : "mods/jira/jira.svg").size(13).text_color(src.kind === "none" ? t.dim : t.foreground))
          .child(div().min_w(0).truncate().font_semibold().text_color(src.kind === "none" ? t.muted : t.foreground)
            .child(jr ? acc.email.split("@")[0] : tr ? acc.name : "Connect…"))
          .child(div().text_size(9).text_color(t.dim).child("▾")))
        .when(tr && Boolean(src.board), (e) => e.child(h_flex().id("board").flex_1().min_w(0).h(22).px(6).gap(4).items_center().rounded(5).cursor_pointer()
          .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Change the board for this project")
          .on_click((_e, cx) => { cx.stop_propagation(); this.picking = !this.picking; if (this.picking) T.loadBoards(cx); cx.notify(); })
          .child(div().min_w(0).truncate().child(src.board.name)).child(div().text_size(9).child("▾"))))
        .when(!tr || !src.board, (e) => e.child(div().flex_1()))
        .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(tr ? `${src.board ? T.count(src.board.id) : 0}` : jr ? `${J.count} open` : "–"))
        .when(tr, (e) => e.child(h_flex().id("tr-scope").flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().text_size(10)
          .children([["all", "All", false], ["mine", "Mine", true]].map(([id, label, v]) => div().id(`tr-${id}`).h(20).px(6).flex().items_center().cursor_pointer()
            .bg(T.mine === v ? t.selected : t.background).text_color(T.mine === v ? t.foreground : t.muted)
            .on_click((_e, cx) => { cx.stop_propagation(); T.setMine(v, cx); }).child(label)))))
        .when(jr || tr, (e) => e.child(iconButton("settings", "mods/jira/settings.svg", tr ? "This Trello account: a new key / token" : "This Jira account: project key, token",
          (_e, cx) => { if (tr) { T.startAdd(); this.trelloForm = !this.trelloForm; this.jform = null; cx.notify(); } else if (this.jform) { this.jform = null; cx.notify(); } else this.openJiraForm("edit", cx); })))
        .child(iconButton("refresh", "mods/jira/refresh.svg", "Refresh", (_e, cx) => tr ? (src.board && T.refresh(src.board.id, cx)) : this.refresh(cx),
          tr ? Boolean(src.board && T.loading.has(src.board.id)) : J.loading)))
      .when(mode === "jira" || mode === "trello", (e) => e.child(div().flex_none().px(8).pt(8)
        .child(div().id("search").h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("jira-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(mode === "jform", (e) => e.child(this.formView(t)))
          .when(mode === "tform", (e) => e.child(T.formView(t)))
          .when(mode === "choose", (e) => e.child(this.chooserView(t, repoName, src)))
          .when(mode === "pick", (e) => e.child(T.pickerView(t, repoName, (board, cx) => this.setSource({ kind: "trello", account: src.account, board }, cx))))
          .when(mode === "trello", (e) => e.children(T.body(t, src.board.id, q)))
          .when(mode === "jira" && Boolean(empty), (e) => e.child(div().p(8).text_color(J.error ? t.ansi1 : t.dim).child(empty)))
          .when(mode === "jira", (e) => e
            // Each column is a drop target while an issue is dragged.
            .children(groups.map((g) => v_flex().id(`col-${g.id}`).flex_none().rounded(6).gap(1).border_1()
              .border_color(this.dragging && this.over === g.id ? t.accent : this.dragging ? t.border : t.background)
              .when(this.dragging && this.over === g.id, (e) => e.bg(t.accent + "22"))
              .on_hover((h, cx) => { if (h) { if (this.over !== g.id) { this.over = g.id; if (this.dragging) cx.notify(); } } else if (this.over === g.id) { this.over = null; if (this.dragging) cx.notify(); } })
              .on_mouse_move((e, cx) => { if (this.over !== g.id) { this.over = g.id; if (this.dragging) cx.notify(); } })
              .child(this.groupHeader(g.name, g.issues.length, t))
              .children(g.issues.map((issue) => this.issueRow(issue, t, "mine")))))
            // The project backlog, set apart from my issues by a rule.
            .when(backlog.length > 0, (e) => e
              .child(div().flex_none().mt(8).mx(8).h(1).bg(t.border))
              .child(this.groupHeader(`${project} backlog`, backlog.length, t))
              .children(backlog.map((issue) => this.issueRow(issue, t, "backlog"))))))
        .child(Scrollbar.vertical("jira-list").absolute().inset_0()))
      .when(Boolean(this.menu), (e) => e.child(this.menuView(t)))
      .when(Boolean(ov), (e) => e.child(ov));
  }
}
