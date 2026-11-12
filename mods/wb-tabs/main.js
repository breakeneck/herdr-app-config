import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, exec, appHome, readTextFile } from "herdr";
// Soft dependency: is mods/<name>/ installed? Cached per name, re-read at most once a minute (assumed present until the first read answers).
const _soft = {};
function installed(name, fresh) {
  const c = (_soft[name] ??= { ok: true, at: 0 });
  if (!fresh && Date.now() - c.at < 60000) return c.ok;
  c.at = Date.now();
  const p = readTextFile(`${appHome()}/mods/${name}/main.js`).then((r) => (c.ok = r != null), () => (c.ok = false));
  return fresh ? p : c.ok; // stale: answer from the cache now, the next call sees the re-read
}


// The first node (depth first) that passes `pred`, with the chain of its ancestors (root first).
function find(node, pred, up = []) {
  if (!node) return null;
  if (pred(node)) return { node, up };
  for (const child of node.children ?? []) {
    const found = find(child, pred, [...up, node]);
    if (found) return found;
  }
  return null;
}
const blocks = (node) => node.type === "block" ? [node] : (node.children ?? []).flatMap(blocks);
const isTab = (n) => n.type === "block" && n.content?.tab !== undefined;

// Where a space works now: its focused terminal's folder, else the first known one,
// else where the space was made (the same rule the spaces list uses).
function place(sp, ps) {
  const tabs = new Set((sp?.tabs ?? []).map(c => c.id));
  return ps.find(p => p.focused && tabs.has(p.tab))?.cwd
    ?? ps.find(p => tabs.has(p.tab) && p.cwd)?.cwd ?? sp?.folder ?? null;
}
// Right-panel mods that get a header button while their block sits in the panel's stack: [mod, label, icon].
const PANELS = [["wb-files", "Files", "mods/wb-tabs/icons/file.svg"], ["wb-changes", "Changes", "mods/wb-tabs/icons/changes.svg"]];
const PANEL_MODS = new Set(PANELS.map(([mod]) => mod));
const isPanelBlock = (n) => n.type === "block" && PANEL_MODS.has(n.content?.mod);

// The right panel, found by what it holds rather than by ids: `body` is the first stack with a
// PANELS block in it; `panel` is what hides and shows it: the stack's highest ancestor that holds
// nothing but PANELS blocks (the column around the stack), else the stack itself. Never the root.
function findPanel(root) {
  const r = find(root, (n) => n.type === "stack" && (n.children ?? []).some(isPanelBlock));
  if (!r) return { panel: null, body: null };
  let panel = r.node;
  for (let i = r.up.length - 1; i > 0 && blocks(r.up[i]).every(isPanelBlock); i--) panel = r.up[i];
  return { panel, body: r.node };
}
const keyOf = (sp, ps) => JSON.stringify([sp?.machine ?? null, place(sp, ps)]);

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.git = {}; // keyOf -> { branch, ahead, behind }, null: not a repo
    this.checked = {}; // keyOf -> when it was last asked
    this.whereAt = {}; // space id -> its keyOf at the last look
    // A checkout in another terminal or app: the chip re-asks on a slow watch.
    cx.timer.every(60000, (cx) => {
      const sp = spaces().find(p => p.active);
      const key = keyOf(sp, panes());
      if (sp && key && Date.now() - (this.checked[key] ?? 0) > 30000) this.ask(key, cx);
    });
  }

  // One place's branch and ahead/behind, read-only (no index writes, no locks:
  // the same shape the spaces list uses). A machine away keeps the last answer.
  ask(key, cx) {
    this.checked[key] = Date.now();
    cx.spawn(async (cx) => {
      const [on, cwd] = JSON.parse(key);
      try {
        const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
        if (r.code !== 0) this.git[key] = null;
        else {
          const info = { branch: null, ahead: 0, behind: 0 };
          for (const line of r.stdout.split("\n")) {
            if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
            else if (line.startsWith("# branch.ab ")) {
              const [a, b] = line.slice(12).split(" ");
              info.ahead = Math.abs(parseInt(a, 10)) || 0;
              info.behind = Math.abs(parseInt(b, 10)) || 0;
            }
          }
          this.git[key] = info;
        }
      } catch { /* couldn't ask: keep what it showed, the timer asks again */ }
      cx.notify();
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: body.id, child: want }); run("layout.show", { id: panel.id }); }
          else run("layout.hide", { id: panel.id });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render(cx) {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    // The branch of the place the active space works in: asked when the space
    // or its folder moves, and on the slow watch in init.
    const key = keyOf(space, panes());
    const sid = space?.id;
    if (sid && JSON.parse(key)[1]) {
      if (this.whereAt[sid] !== key) { this.whereAt[sid] = key; this.ask(key, cx); }
      else if (Date.now() - (this.checked[key] ?? 0) > 30000) this.ask(key, cx);
    }
    const g = this.git[key];
    const branch = g?.branch ?? "";
    // A checkout done in the branch picker (or anywhere else) re-asks at once.
    const switched = Number(shared("wb.branch.switched") ?? 0);
    if (sid && JSON.parse(key)[1] && switched > (this.checked[key] ?? 0)) this.ask(key, cx);
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/wb-tabs/icons/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/wb-tabs/icons/close.svg").size(12))));
    };
    const root = layout(), w = window();
    // What sits left of the bar: the root row's children before the one holding the tab view (the sidebar).
    const at = root?.type === "row" ? root.children.findIndex((c) => find(c, isTab)) : -1;
    const left = (at > 0 ? root.children.slice(0, at) : []).reduce((sum, c) => sum + (c.hidden ? 0 : c.size?.px ?? 0), 0);
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - left)
      : 10;
    const { panel, body } = findPanel(root);
    // The right panel's buttons: whatever blocks sit in its stack now (blocks moved out of it
    // with Edit layout are sections elsewhere and collapse by their own title instead).
    const enabled = (body?.children ?? []).map(c => c.id);
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: panel.id });
          else { run("layout.select", { stack: body.id, child: id }); run("layout.show", { id: panel.id }); }
        }).child(svg(icon).size(14)).child(label);
    };
    // layout.toggle didn't take on this weighted sidebar block; explicit hide/show (the panel-button way).
    // Edit layout: while on, every section's title picks it up and the others offer drop halves (section.js).
    const editing = Boolean(shared("wb.layout.edit"));
    const editButton = h_flex().id("edit-layout").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .bg(editing ? t.accent : t.chrome).text_color(editing ? t.accent_foreground : t.muted)
      .hover(s => s.bg(editing ? t.accent : t.hover)).on_mouse_down("left", stop)
      .tooltip(editing ? "Done: stop moving blocks" : "Edit layout: drag blocks by their title to move them")
      .on_click(() => { setShared("wb.layout.drag", null); setShared("wb.layout.edit", !editing); })
      .child(svg("mods/wb-tabs/icons/square-pen.svg").size(14)).child(editing ? "Done" : "Edit layout");
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next") })
            .when(Boolean(branch), el => el.child(
              h_flex().id("tab-branch").h(26).px(8).gap(6).flex_none().items_center().rounded(7)
                .border(1).border_color(t.border).bg(t.raised).text_size(12).text_color(t.muted)
                .hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
                .on_mouse_down("left", stop)
                .tooltip(`Branch ${branch}${g.ahead || g.behind ? ` · ↑${g.ahead} ↓${g.behind}` : ""}${installed("wb-branch-picker") ? " — click to switch" : ""}`)
                .on_click(() => { if (installed("wb-branch-picker")) openOverlay({ mod: "wb-branch-picker", kind: "popup", width: 460, height: 560, props: { space: sid } }); })
                .child(svg("mods/wb-tabs/icons/git-branch.svg").size(13).text_color(t.muted))
                .child(div().max_w(180).truncate().text_color(t.foreground).child(branch))
                .when(Boolean(g.ahead || g.behind), el => el.child(
                  div().text_size(11).text_color(t.dim).child(`${g.ahead ? `↑${g.ahead}` : ""}${g.behind ? ` ↓${g.behind}` : ""}`))),
            ))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .children(PANELS.flatMap(([mod, label, icon]) => {
        const block = body?.children?.find((c) => c.content?.mod === mod);
        return block ? [panelButton(block.id, label, icon)] : [];
      }))
      .child(div().w(1).h(16).mx(4).flex_none().bg(t.border))
      .child(editButton)
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/wb-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/wb-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/wb-tabs/win-close.svg").size(16) : svg("mods/wb-tabs/icons/close.svg").size(13), () => run("window.close"))));
  }
}
