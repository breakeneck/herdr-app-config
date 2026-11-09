// Remote projects: a saved list of folders per ssh machine (like JetBrains
// Toolbox's Projects tab). Click opens the project as a space on that machine,
// or goes to the space already open there (green dot). The list lives in
// ~/.config/herdr-app/remote-projects.json: { "projects": [{ machine, name, path }] }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, run, exec, hc, theme, appHome, readTextFile, writeTextFile, notify, shared, openOverlay } from "herdr";
import * as S from "./section.js";

const FILE = () => `${appHome()}/remote-projects.json`;
const ICON = (n) => `mods/remote-projects/${n}.svg`;
const TILES = ["#22a99a", "#5b6cf0", "#8a9a4a", "#9b5de5", "#c2508f", "#b8860b", "#5b8def", "#2a9cae", "#d9649a", "#3fae6a"];

const base = (p) => p.replace(/\/+$/, "").split("/").pop();
const initials = (name) => {
  const parts = name.split(/[-_ .]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0]?.[0] ?? "?").toUpperCase();
};
const tile = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TILES[h % TILES.length];
};

export default class RemoteProjects extends View {
  init(_props, cx) {
    this.projects = [];
    this.raw = null; // file text as last read, for writeTextFile's stale check
    this.machines = []; // [{ name, state }]
    this.machine = localStorage.getItem("machine");
    this.homes = {}; // machine -> its $HOME
    this.over = null;
    this.pickTs = 0;
    this.input = InputState.new({ placeholder: "~/dev/project  ↵ to add" });
    this.input.on("submit", (_e, cx) => this.add(cx));
    cx.spawn(async (cx) => { await this.load(); cx.notify(); });
    this.refreshMachines(cx);
    cx.timer.every(20000, (cx) => this.refreshMachines(cx));
  }

  async load() {
    try {
      this.raw = await readTextFile(FILE());
      this.projects = this.raw ? JSON.parse(this.raw).projects ?? [] : [];
    } catch (e) {
      notify({ title: "Remote projects", body: `Can't read remote-projects.json: ${e}`, level: "error" });
    }
  }

  async save() {
    const text = JSON.stringify({ projects: this.projects }, null, 2) + "\n";
    try {
      await writeTextFile(FILE(), text, this.raw);
      this.raw = text;
    } catch {
      // Changed on disk meanwhile: take the file's version and try once more.
      const keep = this.projects;
      await this.load();
      for (const p of keep) if (!this.projects.some((q) => q.machine === p.machine && q.path === p.path)) this.projects.push(p);
      await writeTextFile(FILE(), JSON.stringify({ projects: this.projects }, null, 2) + "\n", this.raw);
      await this.load();
    }
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        this.machines = (JSON.parse(r.stdout).machines ?? [])
          .filter((m) => !m.temporary)
          .map((m) => ({ name: m.name, state: m.state }));
      } catch { /* keep the last list */ }
      if (!this.machines.some((m) => m.name === this.machine)) this.machine = this.machines[0]?.name ?? null;
      for (const m of this.machines) if (!this.homes[m.name] && m.state === "connected") {
        try {
          const r = await exec("sh", ["-c", "printf %s \"$HOME\""], { on: m.name, timeout: 10000 });
          if (r.code === 0 && r.stdout) this.homes[m.name] = r.stdout.trim();
        } catch { /* unreachable: try again later */ }
      }
      cx.notify();
    });
  }

  abs(machine, path) {
    const home = this.homes[machine];
    if (path === "~") return home ?? path;
    if (path.startsWith("~/") && home) return home + path.slice(1);
    if (!path.startsWith("/") && !path.startsWith("~") && home) return `${home}/${path}`;
    return path.replace(/\/+$/, "");
  }

  // The open space for a project: its folder, or a terminal in it, is in that folder.
  spaceFor(p, ps) {
    const dir = this.abs(p.machine, p.path);
    const inside = (f) => f && (f === dir || f.startsWith(dir + "/"));
    return spaces().find((s) => {
      if ((s.machine ?? null) !== p.machine) return false;
      if (inside(s.folder)) return true;
      const tabs = new Set(s.tabs.map((t) => t.id));
      return ps.some((x) => tabs.has(x.tab) && inside(x.cwd));
    });
  }

  open(p) {
    const s = this.spaceFor(p, panes());
    if (s) return run("space.select", { id: s.id });
    const folder = this.abs(p.machine, p.path);
    if (folder.startsWith("~")) {
      return notify({ title: "Remote projects", body: `${p.machine} isn't reachable yet`, level: "warning" });
    }
    run("space.new", { name: p.name, folder, machine: p.machine });
  }

  add(cx) {
    const path = this.input.value().trim().replace(/\/+$/, "");
    if (!path || !this.machine) return;
    this.addPath(path, cx);
    this.input.set_value("");
  }

  addPath(path, cx) {
    if (!this.projects.some((p) => p.machine === this.machine && p.path === path)) {
      this.projects.push({ machine: this.machine, name: base(path), path });
      cx.spawn(async (cx) => { await this.save(); cx.notify(); });
    }
    cx.notify();
  }

  remove(p, cx) {
    this.projects = this.projects.filter((q) => q !== p);
    cx.spawn(async (cx) => { await this.save(); cx.notify(); });
    cx.notify();
  }

  pick(name, cx) {
    this.machine = name;
    localStorage.setItem("machine", name);
    cx.notify();
  }

  header(t, sec) {
    return v_flex().pb(6).gap(4)
      // Same look as the Spaces title; click collapses (section.js).
      .child(S.header(h_flex().h(31).flex_none().pl(16).pr(10).gap(6).items_center().text_size(11.5).text_color(t.dim), sec, 31)
        .child(S.mark(sec)).child("Remote projects"))
      .child(h_flex().px(10).gap(4).flex_wrap().children(this.machines.map((m) => {
        const on = m.name === this.machine;
        return h_flex().id(`m-${m.name}`).items_center().gap(5).h(24).px(8).rounded(6).cursor_pointer()
          .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).text_size(12)
          .hover((s) => s.bg(on ? t.selected : t.hover))
          .on_click((_e, cx) => this.pick(m.name, cx))
          .child(svg(ICON("server")).size(12))
          .child(m.name)
          .child(div().size(6).rounded(3).bg(m.state === "connected" ? t.ansi2 : t.dim));
      })));
  }

  row(p, t, ps) {
    const open = Boolean(this.spaceFor(p, ps));
    const id = `${p.machine}:${p.path}`;
    const over = this.over === id;
    return h_flex().id(`p-${id}`).items_center().gap(10).px(8).py(6).mx(6).rounded(8).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => { this.over = h ? id : this.over === id ? null : this.over; cx.notify(); })
      .on_click(() => this.open(p))
      .child(div().relative().flex_none().size(30).rounded(7).bg(tile(p.name))
        .flex().items_center().justify_center().text_size(12).font_bold().text_color("#ffffff")
        .child(initials(p.name))
        .when(open, (el) => el.child(div().absolute().right(-3).bottom(-3).size(10).rounded(5)
          .bg(t.ansi2).border_2().border_color(t.chrome))))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).truncate().child(p.name))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(p.path)))
      .child(div().id(`x-${id}`).flex_none().size(20).rounded(5).flex().items_center().justify_center()
        .text_color(t.dim).opacity(over ? 1 : 0)
        .hover((s) => s.bg(t.raised).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.remove(p, cx); })
        .child(svg(ICON("x")).size(12)));
  }

  render(cx) {
    const t = theme();
    const ps = panes();
    // A folder chosen in the picker dialog lands here through shared state.
    const pick = shared("folder.pick");
    if (pick && pick.ts !== this.pickTs) { this.pickTs = pick.ts; if (pick.machine === this.machine) this.addPath(pick.path, cx); }
    const list = this.projects.filter((p) => p.machine === this.machine);
    const sec = S.sectionOf("remote-projects"), ov = S.overlay(sec);
    return v_flex().id("root").size_full().relative().bg(t.chrome).text_color(t.foreground)
      .child(this.header(t, sec))
      .child(v_flex().id("list").flex_1().min_h(0).overflow_y_scrollbar().gap(2).pb(4)
        .when(!this.machine, (el) => el.child(div().px(12).py(8).text_size(12).text_color(t.dim)
          .child("No ssh machines. Add one in Settings → Machines.")))
        .when(this.machine && list.length === 0, (el) => el.child(div().px(12).py(8).text_size(12).text_color(t.dim)
          .child("No projects yet: add a folder below.")))
        .children(list.map((p) => this.row(p, t, ps))))
      .when(Boolean(this.machine), (el) => el.child(h_flex().px(10).py(8).gap(6).items_center()
        .child(div().id("rp-browse").size(28).flex_none().flex().items_center().justify_center().rounded(7).border_1().border_color(t.input).bg(t.background).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Browse folders on this machine…").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => openOverlay({ mod: "folder-picker", kind: "dialog", width: 520, height: 480, props: { machine: this.machine, start: this.homes[this.machine] ?? "~" } }))
          .child(svg("mods/remote-projects/icons/folder-plus.svg").size(14)))
        .child(Input.new(this.input).flex_1().h(28).px(8).rounded(7).border_1().border_color(t.input)
          .bg(t.background).text_size(12).text_color(t.foreground))))
      .when(Boolean(ov), (el) => el.child(ov));
  }
}
