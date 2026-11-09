// Commit message generation settings, as a window of their own (opened from the Changes
// panel's Generate ▾ → Settings…). Everything lives in shared("commit.gen"), which the
// Changes panel reads when it generates: { provider, command, args, model, url }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared } from "herdr";

const DEFAULT_TEMPLATE = "A first line of up to 72 characters in imperative mood. Then, only when they add something, short bullet details (\"- ...\"), one per line, right under it. No blank lines anywhere.";
// Same default as in changes-copy/main.js (which builds the prompt).
const DEFAULTS = { provider: "claude", command: "claude", args: "-p", model: "", url: "http://localhost:11434/v1", template: "", noBlank: true };
const cfg = () => ({ ...DEFAULTS, ...(shared("commit.gen") ?? {}) });
const setCfg = (patch) => setShared("commit.gen", { ...cfg(), ...patch });

// Claude CLI model aliases, newest family first; empty: whatever the CLI itself defaults to.
const CLAUDE_MODELS = [["", "CLI default"], ["fable", "fable — the newest"], ["opus", "opus"], ["sonnet", "sonnet"], ["haiku", "haiku"]];

export default class CommitGen extends View {
  init(_props, cx) {
    const c = cfg();
    this.localModels = []; this.modelsError = null; this.modelsLoading = false; this.dropOpen = false;
    const field = (placeholder, value, apply) => {
      const s = InputState.new({ placeholder });
      s.set_value(value);
      s.on("submit", (_e, cx) => { apply(s.value().trim(), cx); cx.notify(); });
      s.on("blur", (_e, cx) => { apply(s.value().trim(), cx); cx.notify(); });
      return s;
    };
    this.url = field(DEFAULTS.url, c.url, (v, cx) => { if (v !== cfg().url) { setCfg({ url: v, model: "" }); this.loadModels(cx); } });
    this.command = field("claude", c.command, (v) => { if (v !== cfg().command) setCfg({ command: v || "claude" }); });
    this.args = field("-p", c.args, (v) => { if (v !== cfg().args) setCfg({ args: v }); });
    // The message format the model is asked for; empty = the default (shown as the starting text).
    this.template = TextareaState.new({ placeholder: DEFAULT_TEMPLATE, rows: 4 });
    this.template.set_value(c.template || DEFAULT_TEMPLATE);
    const keepTemplate = () => { const v = this.template.value().trim(); setCfg({ template: v === DEFAULT_TEMPLATE ? "" : v }); };
    this.template.on("blur", (_e, cx) => { keepTemplate(); cx.notify(); });
    this.template.on("change", () => keepTemplate());
    if (c.provider === "local") this.loadModels(cx);
  }

  // Models of a local OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp server...).
  loadModels(cx) {
    const url = String(cfg().url || "").replace(/\/+$/, "");
    if (!url) return;
    this.modelsLoading = true; this.modelsError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await fetch(`${url}/models`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        // Newest first: names carry versions/dates, so a reverse sort puts the newest on top.
        this.localModels = (j.data ?? j.models ?? []).map((m) => m.id ?? m.name).filter(Boolean).sort().reverse();
      } catch (e) { this.localModels = []; this.modelsError = `can't reach ${url}: ${e}`; }
      this.modelsLoading = false; cx.notify();
    });
  }

  render(cx) {
    const t = theme(), c = cfg();
    const stop = (_e, cx) => cx.stop_propagation();
    const close = () => closeOverlay(props()?.overlay);
    const label = (s) => div().w(64).flex_none().text_size(11.5).text_color(t.dim).child(s);
    const line = (name, ...kids) => h_flex().gap(10).items_center().child(label(name)).children(kids);
    const seg = (id, text, on, act) => div().id(id).h(26).px(12).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click(act).child(text);
    const input = (state) => div().flex_1().min_w(0).on_mouse_down("left", stop)
      .child(Input.new(state).w_full().h(28).px(10).rounded(7).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground));
    const local = c.provider === "local";
    const options = local ? this.localModels.map((m) => [m, m]) : CLAUDE_MODELS;
    const shownModel = c.model || (local ? (this.modelsLoading ? "loading…" : this.localModels.length ? "pick a model" : "no models found") : "CLI default");

    return v_flex().w_full().p(14).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(svg("mods/workspace-chrome/settings.svg").size(14).text_color(t.muted))
        .child(div().flex_1().font_semibold().child("Commit message generation"))
        .child(div().id("cg-close").w(22).h(22).flex().items_center().justify_center().rounded(5).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close").on_mouse_down("left", stop).on_click(close)
          .child(svg("mods/remote-projects/x.svg").size(12))))
      .child(line("Source",
        seg("prov-claude", "Claude (subscription)", !local, (_e, cx) => { setCfg({ provider: "claude", model: "" }); this.dropOpen = false; cx.notify(); }),
        seg("prov-local", "Local model", local, (_e, cx) => { setCfg({ provider: "local", model: "" }); this.dropOpen = false; this.loadModels(cx); })))
      .when(local, (e) => e.child(line("Server", input(this.url),
        div().id("cg-reload").w(28).h(28).flex_none().flex().items_center().justify_center().rounded(7).border_1().border_color(t.border)
          .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Reload models").on_mouse_down("left", stop)
          .on_click((_e, cx) => this.loadModels(cx)).child("↻"))))
      .when(!local, (e) => e.child(line("Command", input(this.command), div().w(70).flex_none().child(input(this.args)))))
      .child(h_flex().gap(10).items_start().child(label("Template").mt(6))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().id("cg-template").h(86).px(10).py(6).rounded(7).border_1().border_color(t.border).bg(t.background).cursor_text()
            .on_mouse_down("left", stop).child(Textarea.new(this.template).w_full().h(72).text_size(12).text_color(t.foreground)))
          .child(h_flex().gap(8).items_center().text_size(11)
            .child(h_flex().id("cg-noblank").gap(6).items_center().cursor_pointer().on_mouse_down("left", stop)
              .on_click((_e, cx) => { setCfg({ noBlank: !(c.noBlank !== false) }); cx.notify(); })
              .child(div().size(13).flex().items_center().justify_center().rounded(3).border_1().text_size(10)
                .border_color(c.noBlank !== false ? t.accent : t.border).bg(c.noBlank !== false ? t.accent : t.background)
                .text_color(t.accent_foreground).child(c.noBlank !== false ? "✓" : ""))
              .child(div().text_color(t.muted).child("No blank lines")))
            .child(div().flex_1())
            .child(div().id("cg-tpl-reset").text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop)
              .on_click((_e, cx) => { this.template.set_value(DEFAULT_TEMPLATE); setCfg({ template: "" }); cx.notify(); }).child("Reset")))))
      .child(line("Model",
        h_flex().id("cg-model").flex_1().min_w(0).h(28).px(10).items_center().justify_between().rounded(7).border_1().border_color(t.border)
          .bg(t.background).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
          .on_click((_e, cx) => { this.dropOpen = !this.dropOpen; if (local && !this.localModels.length && !this.modelsLoading) this.loadModels(cx); cx.notify(); })
          .child(div().truncate().child(shownModel))
          .child(svg("mods/workspace-chrome/chevron-down.svg").size(11).text_color(t.dim))))
      .when(this.dropOpen, (e) => e.child(h_flex().child(div().w(74).flex_none())
        .child(v_flex().id("cg-models").flex_1().max_h(200).overflow_y_scroll().rounded(7).border_1().border_color(t.border).bg(t.background).p(4).gap(1)
          .children(options.length ? options.map(([v, l]) => h_flex().id(`opt-${v}`).h(26).flex_none().px(8).items_center().gap(6).rounded(5).cursor_pointer()
            .text_size(12).when(v === c.model, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
            .on_click((_e, cx) => { setCfg({ model: v }); this.dropOpen = false; cx.notify(); })
            .child(div().flex_1().truncate().child(l))
            .when(v === c.model, (el) => el.child(div().text_size(10).text_color(t.dim).child("✓"))))
            : [div().p(8).text_size(11).text_color(t.dim).child(this.modelsLoading ? "Loading models…" : "No models: check the server URL")]))))
      .when(Boolean(local && this.modelsError), (e) => e.child(div().pl(74).text_size(11).text_color(t.ansi1).child(this.modelsError)))
      .child(div().pl(74).text_size(11).text_color(t.dim).child(local
        ? "Sends the diff to the server's /chat/completions (OpenAI-compatible: Ollama, LM Studio, llama.cpp)."
        : `Runs \`${c.command} ${c.args}${c.model ? ` --model ${c.model}` : ""}\` inside the repo folder, on the repo's machine.`));
  }
}
