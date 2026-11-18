// Folder browser for the Remote projects "+" dialog: walks a machine's filesystem
// (over ssh too, via exec) and hands the choice back through shared("wb.folder.pick").

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, exec, shared, setShared } from "herdr";

// Dot folders show only when this is on (the eye button); off by default, kept in shared.json.
const HIDDEN = "wb.folderPicker.showHidden";
const showHidden = () => Boolean(shared(HIDDEN));

// The path field is live: typing lists the folder up to the last "/" and narrows it to what follows
// ("~/dev/pro" lists ~/dev, filtered to "pro…"). A path without a leading "/" or "~" is relative to the
// folder shown when typing began. Enter goes into the one match (or the typed folder).
const quote = (path) => path === "~" ? '"$HOME"'
  : path.startsWith("~/") ? `"$HOME"/'${path.slice(2).replace(/'/g, `'\\''`)}'`
  : `'${path.replace(/'/g, `'\\''`)}'`;
const slash = (dir) => dir.endsWith("/") ? dir : dir + "/";

export default class FolderPicker extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.machine = p.machine ?? null;
    this.path = p.start ?? "~"; this.anchor = this.path; this.filter = "";
    this.error = null; this.dirs = []; this.loading = false; this.seq = 0; this.typed = 0;
    this.input = InputState.new({ placeholder: "a path, or one relative to this folder" });
    this.input.on("change", (_e, cx) => this.typing(cx));
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.go(this.path, cx);
  }

  // Lists dir; on success the shown folder becomes it. setInput: also the anchor and the field's text.
  list(dir, filter, setInput, cx) {
    const seq = ++this.seq;
    this.loading = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", `cd ${quote(dir)} && pwd && ls -1Ap`], { on: this.machine, timeout: 15000 });
        if (seq !== this.seq) return;
        if (r.code !== 0) throw new Error((r.stderr || `cannot open ${dir}`).trim().slice(0, 200));
        const [real, ...entries] = r.stdout.split("\n");
        this.path = real.trim(); this.filter = filter;
        // -p marks directories with a trailing "/": those are the only walkable entries.
        this.dirs = entries.filter((e) => e.endsWith("/")).map((e) => e.slice(0, -1)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (setInput) { this.anchor = this.path; this.shown = slash(this.path); this.input.set_value(this.shown); }
      } catch (e) { if (seq === this.seq) this.error = String(e.message ?? e); }
      if (seq === this.seq) { this.loading = false; cx.notify(); }
    });
  }

  go(path, cx) { if (path) this.list(path, "", true, cx); }

  // The field's text as { dir, filter }: absolute, ~, or relative to the anchor.
  parse(v) {
    if (!v.startsWith("/") && !v.startsWith("~")) v = slash(this.anchor) + v;
    if (v === "~") return { dir: "~", filter: "" };
    const i = v.lastIndexOf("/");
    return { dir: v.slice(0, i) || "/", filter: v.slice(i + 1) };
  }

  typing(cx) {
    const v = this.input.value();
    if (v === this.shown) return; // our own set_value
    const n = ++this.typed;
    cx.timer.after(200, (cx) => {
      if (n !== this.typed) return;
      const { dir, filter } = this.parse(this.input.value().trim());
      this.list(dir, filter, false, cx);
    });
  }

  matches() {
    const f = this.filter.toLowerCase(), all = showHidden() || f.startsWith(".");
    return this.dirs.filter((d) => (all || !d.startsWith(".")) && d.toLowerCase().startsWith(f));
  }

  // The folder "Choose" means: the typed one when it names a folder exactly, else the one listed.
  chosen() {
    const exact = this.filter && this.dirs.find((d) => d === this.filter);
    return exact ? this.join(exact) : this.path;
  }
  join(d) { return this.path === "/" ? `/${d}` : `${this.path}/${d}`; }

  submit(cx) {
    this.typed++; // a pending live listing is superseded
    const v = this.input.value().trim();
    if (!v) return;
    const { dir, filter } = this.parse(v);
    if (!filter) return this.go(dir, cx);
    if (filter !== this.filter) return this.go(slash(dir) + filter, cx); // typed faster than the listing
    const m = this.matches();
    const exact = this.dirs.find((d) => d === filter);
    if (exact || m.length === 1) return this.go(this.join(exact ?? m[0]), cx);
    this.go(slash(dir) + filter, cx);
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
        .child(div().id("fp-hidden").w(22).h(22).flex().items_center().justify_center().rounded(5).cursor_pointer()
          .text_color(showHidden() ? t.accent : t.dim).hover((s) => s.bg(t.hover)).tooltip(showHidden() ? "Hide hidden folders" : "Show hidden folders")
          .on_mouse_down("left", stop).on_click(() => setShared(HIDDEN, !showHidden()))
          .child(svg(`mods/wb-folder-picker/icons/${showHidden() ? "eye" : "eye-off"}.svg`).size(13)))
        .child(div().id("fp-close").w(22).h(22).flex().items_center().justify_center().rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => closeOverlay(props()?.overlay)).child(svg("mods/wb-folder-picker/icons/x.svg").size(12))))
      .child(Input.new(this.input).h(28).w_full().px(10).rounded(7).border_1().border_color(t.border).bg(t.chrome).text_size(12).text_color(t.foreground))
      .child(v_flex().h(330).flex_none().overflow_y_scroll().gap(1)
        .when(this.path !== "/", (e) => e.child(row("fp-up", "mods/wb-folder-picker/icons/chevron-left.svg", "../", (_e, cx) => this.go(up, cx), true)))
        .when(Boolean(this.error), (e) => e.child(div().px(10).py(6).text_size(11.5).text_color(t.ansi1).child(this.error)))
        .when(this.loading, (e) => e.child(div().px(10).py(6).text_size(11.5).text_color(t.dim).child("Loading…")))
        .children(this.matches().map((d) => row(`fp-${d}`, "mods/wb-folder-picker/icons/folder.svg", d, (_e, cx) => this.go(this.join(d), cx)))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.chosen()))
        .child(div().id("fp-cancel").h(30).px(14).flex().items_center().rounded(8).border_1().border_color(t.border).text_color(t.muted).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(() => closeOverlay(props()?.overlay)).child("Cancel"))
        .child(div().id("fp-choose").h(30).px(14).flex().items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer().on_mouse_down("left", stop).on_click(() => { setShared("wb.folder.pick", { machine: this.machine, for: props()?.for ?? null, path: this.chosen(), ts: Date.now() }); closeOverlay(props()?.overlay); }).child("Choose this folder")));
  }
}