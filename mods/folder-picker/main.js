// Folder browser for the Remote projects "+" dialog: walks a machine's filesystem
// (over ssh too, via exec) and hands the choice back through shared("folder.pick").

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, exec, setShared } from "herdr";

export default class FolderPicker extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.machine = p.machine ?? null;
    this.path = p.start ?? "~";
    this.error = null; this.dirs = []; this.loading = false;
    this.input = InputState.new({ placeholder: "type a path and press ↵" });
    this.input.set_value(this.path);
    this.input.on("submit", (_e, cx) => this.go(this.input.value().trim(), cx));
    this.go(this.path, cx);
  }

  go(path, cx) {
    if (!path) return;
    this.loading = true; this.error = null;
    this.input.set_value(path);
    cx.spawn(async (cx) => {
      try {
        const q = path === "~" ? '"$HOME"'
          : path.startsWith("~/") ? `"$HOME"/'${path.slice(2).replace(/'/g, `'\\''`)}'`
          : `'${path.replace(/'/g, `'\\''`)}'`;
        const r = await exec("sh", ["-c", `cd ${q} && pwd && ls -1Ap`], { on: this.machine, timeout: 15000 });
        if (r.code !== 0) throw new Error((r.stderr || `cannot open ${path}`).trim().slice(0, 200));
        const [real, ...entries] = r.stdout.split("\n");
        this.path = real.trim();
        this.input.set_value(this.path);
        // -p marks directories with a trailing "/": those are the only walkable entries.
        this.dirs = entries.filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      } catch (e) { this.error = String(e); }
      this.loading = false; cx.notify();
    });
  }

  render() {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const row = (id, icon, label, act, dim = false) => h_flex().id(id).h(28).flex_none().px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .text_size(12.5).text_color(dim ? t.muted : t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click(act)
      .child(svg(icon).size(13).text_color(t.dim)).child(div().flex_1().truncate().child(label));
    const up = this.path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
    return v_flex().size_full().p(12).gap(8).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().font_semibold().child(`Choose a folder${this.machine ? ` on ${this.machine}` : ""}`))
        .child(div().id("fp-close").w(22).h(22).flex().items_center().justify_center().rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => closeOverlay(props()?.overlay)).child(svg("mods/remote-projects/x.svg").size(12))))
      .child(Input.new(this.input).h(28).w_full().px(10).rounded(7).border_1().border_color(t.border).bg(t.chrome).text_size(12).text_color(t.foreground))
      .child(v_flex().h(330).flex_none().overflow_y_scroll().gap(1)
        .when(this.path !== "/", (e) => e.child(row("fp-up", "mods/workspace-chrome/chevron-left", "../", (_e, cx) => this.go(up, cx), true)))
        .when(Boolean(this.error), (e) => e.child(div().px(10).py(6).text_size(11.5).text_color(t.ansi1).child(this.error)))
        .when(this.loading, (e) => e.child(div().px(10).py(6).text_size(11.5).text_color(t.dim).child("Loading…")))
        .children(this.dirs.map((d) => row(`fp-${d}`, "mods/remote-projects/folder.svg", d, (_e, cx) => this.go(this.path === "/" ? `/${d}` : `${this.path}/${d}`, cx)))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.path))
        .child(div().id("fp-cancel").h(30).px(14).flex().items_center().rounded(8).border_1().border_color(t.border).text_color(t.muted).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => closeOverlay(props()?.overlay)).child("Cancel"))
        .child(div().id("fp-choose").h(30).px(14).flex().items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer().on_mouse_down("left", stop).on_click(() => { setShared("folder.pick", { machine: this.machine, path: this.path, ts: Date.now() }); closeOverlay(props()?.overlay); }).child("Choose this folder")));
  }
}