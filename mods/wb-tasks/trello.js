// Trello inside the Tasks (jira) panel: a project whose source is Trello shows its board here,
// the board's lists as columns (board order, card order), All / Mine, drag a card onto another
// list to move it, click a card for the whole card in a popup.
// Accounts: shared "wb.tasks.accounts".trello = [{ id (Trello member id), name, username }] (no secrets);
// each one's "key:token" in the macOS Keychain (service herdr-trello, account = member id).
// Which account and board a project uses is in shared "wb.tasks.sources" (see main.js).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { exec, props, closeOverlay, shared, setShared } from "herdr";
import { getSecret, findSecret, setSecret, supported as secretsSupported, UNSUPPORTED } from "./secrets.js";

const SERVICE = "herdr-trello";
const API = "https://api.trello.com/1";
const STALE = 30000; // a board's cached lists are shown at once, refreshed when older than this
// Trello's label colors (the base names; _dark/_light variants map to the same hue).
const LABEL = { green: "#4bce97", yellow: "#e2b203", orange: "#faa53d", red: "#f87462", purple: "#9f8fef",
  blue: "#579dff", sky: "#6cc3e0", lime: "#94c748", pink: "#e774bb", black: "#8590a2" };
const labelColor = (c) => LABEL[String(c ?? "").replace(/_(dark|light)$/, "")] ?? "#8590a2";

const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

const ACCOUNTS = "wb.tasks.accounts";
export const trelloAccounts = () => (shared(ACCOUNTS) ?? {}).trello ?? [];
export const trelloAccount = (id) => trelloAccounts().find((a) => a.id === id) ?? null;
function upsertAccount(acc) {
  const all = shared(ACCOUNTS) ?? {}, list = all.trello ?? [];
  setShared(ACCOUNTS, { ...all, trello: list.some((a) => a.id === acc.id) ? list.map((a) => (a.id === acc.id ? acc : a)) : [...list, acc] });
}
async function credentials(id) {
  const v = (await getSecret(SERVICE, id)) ?? "", at = v.indexOf(":");
  return at > 0 ? { key: v.slice(0, at), token: v.slice(at + 1) } : null;
}
const keep = (id, key, token) => setSecret(SERVICE, id, `${key}:${token}`);

async function call(creds, path, query = {}, method = "GET") {
  const r = await fetch(`${API}${path}?${qs({ ...query, key: creds.key, token: creds.token })}`, { method, headers: { Accept: "application/json" } });
  if (!r.ok) throw Object.assign(new Error(`Trello ${r.status}: ${(await r.text()).slice(0, 160)}`), { status: r.status });
  return r.json();
}

const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export class Trello {
  // `view` is the panel (main.js): drag state (press / dragging / over) and notify go through it.
  constructor(view) {
    this.view = view;
    this.account = null; // the Trello account (member id) shown now
    this.credsBy = {}; // member id -> { key, token } | null (no token saved); absent: not asked yet
    this.boards = null; this.boardsError = null;
    this.lists = {}; this.at = {}; this.loading = new Set(); this.error = null;
    this.mine = ls.get("trello:mine", false);
    this.formError = null; this.saving = false;
    this.keyInput = InputState.new({ placeholder: "API key" });
    this.tokenInput = InputState.new({ placeholder: "Token" });
    this.tokenInput.set_masked(true);
  }

  get creds() { return this.account ? this.credsBy[this.account] : null; }
  set creds(v) { if (this.account) this.credsBy[this.account] = v; }

  async ready() {
    const id = this.account;
    if (!id) return null;
    if (!(id in this.credsBy)) this.credsBy[id] = await credentials(id);
    return this.credsBy[id];
  }

  // The first build kept one key + token with the key as the Keychain account: make it an account.
  async migrate() {
    if (trelloAccounts().length) return null;
    const old = await findSecret(SERVICE), key = old?.account;
    if (!old || !/^[0-9a-f]{32}$/i.test(key ?? "")) return null;
    try {
      const me = await call({ key, token: old.secret }, "/members/me", { fields: "id,fullName,username" });
      await keep(me.id, key, old.secret);
      upsertAccount({ id: me.id, name: me.fullName || me.username, username: me.username });
      return me.id;
    } catch { return null; }
  }

  // The form for a new account (or a new token for one): empty fields.
  startAdd() { this.keyInput.set_value(""); this.tokenInput.set_value(""); this.formError = null; }

  // The board's lists with their cards: from the cache at once, from Trello when stale.
  show(boardId, cx, force = false) {
    if (!boardId) return;
    if (!this.lists[boardId]) { const c = ls.get(`trello:board:${boardId}`, null); if (c) { this.lists[boardId] = c.lists; this.at[boardId] = c.at; } }
    if (force || !this.lists[boardId] || Date.now() - (this.at[boardId] ?? 0) > STALE) this.refresh(boardId, cx);
  }

  refresh(boardId, cx) {
    if (this.loading.has(boardId)) return;
    this.loading.add(boardId); cx.notify();
    cx.spawn(async (cx) => {
      try {
        const creds = await this.ready();
        if (!creds) return;
        const lists = await call(creds, `/boards/${boardId}/lists`, { filter: "open", fields: "name,pos", cards: "open",
          card_fields: "name,idMembers,labels,pos,due,dueComplete,idShort,shortUrl" });
        this.lists[boardId] = lists; this.at[boardId] = Date.now(); this.error = null;
        ls.set(`trello:board:${boardId}`, { lists, at: this.at[boardId] });
      } catch (e) {
        if (e.status === 401) { this.creds = null; this.formError = "Trello rejected the saved token · connect again"; }
        else this.error = String(e.message ?? e);
      } finally { this.loading.delete(boardId); cx.notify(); }
    });
  }

  loadBoards(cx) {
    this.boards = null; this.boardsError = null;
    cx.spawn(async (cx) => {
      try {
        const creds = await this.ready();
        if (creds) this.boards = await call(creds, "/members/me/boards", { filter: "open", fields: "name,dateLastActivity" });
        this.boards?.sort((a, b) => String(b.dateLastActivity ?? "").localeCompare(String(a.dateLastActivity ?? "")));
      } catch (e) { this.boardsError = String(e.message ?? e); this.boards = []; }
      cx.notify();
    });
  }

  // Drops a card on a list: moved there at once (on top), then confirmed by Trello.
  move(cardId, listId, boardId, cx) {
    const lists = this.lists[boardId] ?? [];
    const from = lists.find((l) => l.cards.some((c) => c.id === cardId)), to = lists.find((l) => l.id === listId);
    if (!from || !to || from === to) return;
    const card = from.cards.find((c) => c.id === cardId);
    from.cards = from.cards.filter((c) => c !== card); to.cards = [card, ...to.cards];
    cx.notify();
    cx.spawn(async (cx) => {
      try { await call(await this.ready(), `/cards/${cardId}`, { idList: listId, pos: "top" }, "PUT"); }
      catch (e) { this.error = `Move: ${e.message ?? e}`; }
      this.refresh(boardId, cx);
    });
  }

  setMine(v, cx) { this.mine = v; ls.set("trello:mine", v); cx.notify(); }

  save(cx) {
    const key = this.keyInput.value().trim(), token = this.tokenInput.value().trim();
    if (!/^[0-9a-f]{32}$/i.test(key)) { this.formError = "The API key is 32 hex characters (Power-Up admin → API key)"; cx.notify(); return; }
    if (!token || /\s/.test(token)) { this.formError = "Paste the token (Get token → Allow → copy)"; cx.notify(); return; }
    this.saving = true; this.formError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        // The account is whoever the token belongs to: the same login twice updates one account.
        const me = await call({ key, token }, "/members/me", { fields: "id,fullName,username" });
        await keep(me.id, key, token);
        upsertAccount({ id: me.id, name: me.fullName || me.username, username: me.username });
        this.credsBy[me.id] = { key, token }; this.tokenInput.set_value("");
        this.view.trelloForm = false;
        const src = this.view.source();
        this.view.setSource({ kind: "trello", account: me.id, board: src.kind === "trello" && src.account === me.id ? src.board : null }, cx);
      } catch (e) { this.formError = e.status === 401 ? "Trello rejected this key + token" : String(e.message ?? e); }
      finally { this.saving = false; cx.notify(); }
    });
  }

  formView(t) {
    const key = this.keyInput.value().trim();
    const button = (id, label, primary, onClick) => div().id(id).h(28).px(12).flex().flex_1().items_center().justify_center().rounded(7).cursor_pointer().text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.9)).on_click(onClick).child(label);
    const field = (id, label, state) => v_flex().gap(3).child(div().text_size(10).text_color(t.dim).child(label))
      .child(div().id(id).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(state).h_full().w_full().text_size(12).text_color(t.foreground)));
    const head = v_flex().p(8).gap(8).text_color(t.muted)
      .child(h_flex().items_center().child(div().flex_1().text_color(t.foreground).font_semibold().child("Add a Trello account"))
        .child(div().id("tr-cancel").text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.view.trelloForm = false; cx.notify(); }).child("Cancel")));
    if (!secretsSupported()) return head.child(div().text_size(11).child(UNSUPPORTED));
    return head
      .child(div().text_size(11).child("1. Open the Power-Up admin, make (or open) a Power-Up and copy its API key. 2. Get token: Allow, then copy the token."))
      .child(field("tr-key", "API key", this.keyInput))
      .child(h_flex().gap(6)
        .child(button("tr-admin", "Power-Up admin", false, () => exec("open", ["https://trello.com/power-ups/admin"])))
        .child(button("tr-auth", "Get token", false, (_e, cx) => {
          if (!/^[0-9a-f]{32}$/i.test(key)) { this.formError = "Paste the API key first"; cx.notify(); return; }
          exec("open", [`https://trello.com/1/authorize?${qs({ expiration: "never", scope: "read,write", response_type: "token", name: "Herdr", key })}`]);
        })))
      .child(field("tr-token", "Token", this.tokenInput))
      .child(button("tr-save", this.saving ? "Checking…" : "Save", true, (_e, cx) => this.save(cx)))
      .when(Boolean(this.formError), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.formError)))
      .child(div().text_size(10).text_color(t.dim).child(`Checked against Trello before saving; kept in the macOS Keychain (${SERVICE}).`));
  }

  // Pick the board for this project; most recently active first.
  pickerView(t, name, onPick) {
    const rows = this.boards ?? [];
    return v_flex().p(6).gap(1)
      .child(div().px(8).py(6).text_size(11).text_color(t.dim).child(`Trello board for ${name}:`))
      .when(this.boards === null, (e) => e.child(div().px(8).text_color(t.dim).child("Loading boards…")))
      .when(Boolean(this.boardsError), (e) => e.child(div().px(8).text_color(t.ansi1).child(this.boardsError)))
      .children(rows.map((b) => h_flex().id(`board-${b.id}`).h(26).px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onPick({ id: b.id, name: b.name }, cx))
        .child(svg("mods/wb-tasks/trello.svg").size(13).text_color(t.dim)).child(div().flex_1().min_w(0).truncate().child(b.name))));
  }

  findCard(id) {
    for (const lists of Object.values(this.lists)) for (const l of lists) { const c = l.cards.find((x) => x.id === id); if (c) return c; }
    return null;
  }

  count(boardId) {
    return (this.lists[boardId] ?? []).reduce((n, l) => n + this.visible(l).length, 0);
  }
  visible(list, q = "") {
    // The account id is the Trello member id.
    return list.cards.filter((c) => (!this.mine || c.idMembers.includes(this.account))
      && (!q || c.name.toLowerCase().includes(q) || `#${c.idShort}` === q));
  }

  // The board's lists as drop targets (all of them, like the board; a search hides empty ones).
  body(t, boardId, q) {
    const v = this.view, lists = this.lists[boardId];
    if (!lists) return [div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? "Loading board…")];
    return [
      ...(this.error ? [div().p(8).text_size(11).text_color(t.ansi1).child(this.error)] : []),
      ...lists.map((l) => ({ l, cards: this.visible(l, q) })).filter(({ cards }) => cards.length || !q || v.dragging).map(({ l, cards }) => {
        const over = v.dragging && v.over === `tl:${l.id}`;
        return v_flex().id(`tl-${l.id}`).flex_none().rounded(6).gap(1).border_1()
          .border_color(over ? t.accent : v.dragging ? t.border : t.background).when(over, (e) => e.bg(t.accent + "22"))
          .on_hover((h, cx) => v.overTarget(`tl:${l.id}`, h, cx))
          .on_mouse_move((_e, cx) => v.overTarget(`tl:${l.id}`, true, cx))
          .child(v.groupHeader(l.name, cards.length, t))
          .children(cards.map((c) => this.cardRow(c, t)));
      }),
    ];
  }

  cardRow(c, t) {
    const v = this.view, key = `t:${c.id}`;
    const late = c.due && !c.dueComplete && new Date(c.due) < new Date();
    return h_flex().id(`card-${c.id}`).h(22).flex_none().px(8).gap(6).items_center().rounded(5).cursor_pointer().relative()
      .when(v.selected === key, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover)).tooltip(`#${c.idShort} ${c.name}`)
      .when(v.dragging && v.press === key, (e) => e.opacity(0.45))
      .on_click((_e, cx) => {
        if (v.dragged) { v.dragged = false; return; }
        v.selected = key; cx.notify();
        v.openTrelloCard(c.id);
      })
      .on_mouse_down("left", (e) => { v.press = key; v.pressAt = e.position; v.dragging = false; v.dragged = false; })
      // The panel's own right-press handler (it runs next) places the menu.
      .on_mouse_down("right", () => { v.menuKey = key; })
      .when(v.menu?.key === key, (s) => s.bg(t.selected))
      .on_mouse_move((e, cx) => v.maybeStartDrag(e, cx))
      .on_hover((h, cx) => { if (!h && v.press === key && !v.dragging) v.startDrag(cx); })
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${c.idShort}`))
      .child(h_flex().flex_none().gap(2).children((c.labels ?? []).slice(0, 4).map((lb) => div().w(10).h(6).rounded(3).bg(labelColor(lb.color)))))
      .child(div().flex_1().min_w(0).truncate().child(c.name))
      .when(Boolean(c.due), (e) => e.child(div().flex_none().text_size(10).text_color(c.dueComplete ? t.done : late ? t.ansi1 : t.dim)
        .child(new Date(c.due).toLocaleDateString(undefined, { day: "numeric", month: "short" }))));
  }

  // ── the card popup ──
  loadCard(id, cx) {
    this.card = null; this.cardError = null;
    cx.spawn(async (cx) => {
      try {
        const creds = await this.ready();
        if (!creds) throw new Error("Trello isn't connected");
        this.card = await call(creds, `/cards/${id}`, { fields: "name,desc,due,dueComplete,labels,shortUrl,idShort,dateLastActivity",
          members: "true", member_fields: "fullName", list: "true", list_fields: "name", board: "true", board_fields: "name",
          checklists: "all", actions: "commentCard", actions_limit: 30 });
      } catch (e) { this.cardError = String(e.message ?? e); }
      cx.notify();
    });
  }

  cardView(t) {
    const c = this.card, close = () => closeOverlay(props()?.overlay);
    const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    const btn = (id, label, act) => div().id(id).h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(act).child(label);
    const meta = (label, value) => !value ? null : h_flex().gap(8).items_center().text_size(12)
      .child(div().w(72).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).truncate().child(value));
    return v_flex().id("trello-card").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/wb-tasks/trello.svg").size(14).text_color(t.dim))
        .child(div().text_size(12).text_color(t.dim).child(c ? `#${c.idShort}` : ""))
        .when(Boolean(c?.list), (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.muted).child(c.list.name)))
        .child(div().flex_1())
        .when(Boolean(c), (e) => e.child(btn("open-trello", "Open in Trello", () => exec("open", [c.shortUrl])))
          .child(btn("copy-link", "Copy link", (_e, cx) => cx.write_to_clipboard(c.shortUrl)))
          .child(btn("copy-key", `Copy #${c.idShort}`, (_e, cx) => cx.write_to_clipboard(`#${c.idShort}`))))
        .child(div().id("close").size(26).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(close).child("✕")))
      .child(v_flex().id("card-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(14)
        .when(!c, (e) => e.child(div().text_color(this.cardError ? t.ansi1 : t.dim).child(this.cardError ?? "Loading…")))
        .when(Boolean(c), (e) => e
          .child(div().text_size(17).font_semibold().child(c.name))
          .when((c.labels ?? []).length > 0, (e) => e.child(h_flex().gap(4).flex_wrap().children(c.labels.map((lb) =>
            div().px(6).py(1).rounded(4).bg(labelColor(lb.color)).text_size(11).text_color("#1d2125").child(lb.name || lb.color)))))
          .child(v_flex().gap(5).children([meta("Board", c.board?.name), meta("Members", (c.members ?? []).map((m) => m.fullName).join(", ")),
            meta("Due", c.due ? `${when(c.due)}${c.dueComplete ? " · done" : ""}` : null), meta("Activity", when(c.dateLastActivity))].filter(Boolean)))
          .child(div().h(1).bg(t.border))
          // Trello descriptions are markdown already.
          .child(c.desc ? TextView.markdown(`desc-${c.id}`, c.desc) : div().text_color(t.dim).child("No description"))
          .children((c.checklists ?? []).map((cl) => v_flex().gap(3)
            .child(div().text_size(11).font_semibold().text_color(t.dim).child(`${cl.name.toUpperCase()} · ${cl.checkItems.filter((i) => i.state === "complete").length}/${cl.checkItems.length}`))
            .children([...cl.checkItems].sort((a, b) => a.pos - b.pos).map((i) => h_flex().gap(8).items_center().text_size(12)
              .child(div().flex_none().text_color(i.state === "complete" ? t.done : t.dim).child(i.state === "complete" ? "☑" : "☐"))
              .child(div().flex_1().min_w(0).when(i.state === "complete", (e) => e.text_color(t.dim)).child(i.name))))))
          .when((c.actions ?? []).length > 0, (e) => e
            .child(div().h(1).bg(t.border))
            .child(div().text_size(11).font_semibold().text_color(t.dim).child(`COMMENTS · ${c.actions.length}`))
            .children(c.actions.map((a) => v_flex().gap(4).p(10).rounded(8).bg(t.raised)
              .child(h_flex().gap(8).text_size(11).child(div().font_semibold().child(a.memberCreator?.fullName ?? "")).child(div().text_color(t.dim).child(when(a.date))))
              .child(TextView.markdown(`c-${a.id}`, a.data?.text ?? "")))))));
  }
}
