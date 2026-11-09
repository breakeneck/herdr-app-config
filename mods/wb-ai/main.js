// AI models window (opened from Changes → Generate ▾ → Settings…, and from a PR's AI review ▾):
// which model each use takes (commit messages, PR review), the shared list of models (add, edit,
// delete), and the commit message template. Models live in shared "wb.ai.models" / "wb.ai.use" (ai.js);
// the template in shared "wb.commit.gen" { template, noBlank }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared } from "herdr";
import { migrateAi, models, modelFor, setUse, saveModel, deleteModel, describe, localModels, USES, PROVIDERS, SUGGEST, DEFAULT_URL } from "./ai.js";

const DEFAULT_TEMPLATE = "A first line of up to 72 characters in imperative mood. Then, only when they add something, short bullet details (\"- ...\"), one per line, right under it. No blank lines anywhere.";
// Same default as in wb-changes/main.js (which builds the prompt).
const cfg = () => ({ template: "", noBlank: true, ...(shared("wb.commit.gen") ?? {}) });
const setCfg = (patch) => setShared("wb.commit.gen", { ...(shared("wb.commit.gen") ?? {}), ...patch });

export default class AiModels extends View {
  init(_props, cx) {
    migrateAi();
    this.edit = null; // the model being added / edited: { id?, provider }
    this.drop = null; // an open use dropdown: "commit" | "review"
    this.localModels = []; this.modelsError = null; this.modelsLoading = false;
    const input = (placeholder) => InputState.new({ placeholder });
    this.nameI = input("Name, e.g. Claude Opus"); this.cmdI = input("command"); this.argsI = input("args");
    this.modelI = input("model (empty: CLI default)"); this.urlI = input(DEFAULT_URL);
    this.urlI.on("submit", (_e, cx) => this.loadLocal(cx));
    // The message format the model is asked for; empty = the default (shown as the starting text).
    this.template = TextareaState.new({ placeholder: DEFAULT_TEMPLATE, rows: 4 });
    this.template.set_value(cfg().template || DEFAULT_TEMPLATE);
    const keepTemplate = () => { const v = this.template.value().trim(); setCfg({ template: v === DEFAULT_TEMPLATE ? "" : v }); };
    this.template.on("blur", (_e, cx) => { keepTemplate(); cx.notify(); });
    this.template.on("change", () => keepTemplate());
  }

  open(m, provider, cx) {
    const p = m?.provider ?? provider;
    this.edit = { id: m?.id ?? null, provider: p };
    this.nameI.set_value(m?.name ?? PROVIDERS[p].label);
    this.cmdI.set_value(m?.command ?? PROVIDERS[p].command ?? ""); this.argsI.set_value(m?.args ?? PROVIDERS[p].args ?? "");
    this.modelI.set_value(m?.model ?? ""); this.urlI.set_value(m?.url ?? DEFAULT_URL);
    this.drop = null; this.formError = null;
    if (p === "local") this.loadLocal(cx);
    cx.notify();
  }

  setProvider(p, cx) {
    const e = this.edit;
    // A name that was just the old provider's label follows the new one.
    if (this.nameI.value().trim() === PROVIDERS[e.provider].label) this.nameI.set_value(PROVIDERS[p].label);
    e.provider = p; this.cmdI.set_value(PROVIDERS[p].command ?? ""); this.argsI.set_value(PROVIDERS[p].args ?? ""); this.modelI.set_value("");
    if (p === "local") this.loadLocal(cx);
    cx.notify();
  }

  save(cx) {
    const e = this.edit, name = this.nameI.value().trim();
    if (!name) { this.formError = "Give it a name"; cx.notify(); return; }
    const m = { id: e.id ?? `m${Date.now().toString(36)}`, name, provider: e.provider, model: this.modelI.value().trim() };
    if (e.provider === "local") m.url = this.urlI.value().trim() || DEFAULT_URL;
    else { m.command = this.cmdI.value().trim() || PROVIDERS[e.provider].command; m.args = this.argsI.value().trim(); }
    saveModel(m);
    this.edit = null; cx.notify();
  }

  loadLocal(cx) {
    this.modelsLoading = true; this.modelsError = null; cx.notify();
    const url = this.urlI.value().trim() || DEFAULT_URL;
    cx.spawn(async (cx) => {
      try { this.localModels = await localModels(url); }
      catch (e) { this.localModels = []; this.modelsError = `can't reach ${url}: ${e.message ?? e}`; }
      this.modelsLoading = false; cx.notify();
    });
  }

  render(cx) {
    const t = theme(), list = models(), c = cfg();
    const stop = (_e, cx) => cx.stop_propagation();
    const close = () => closeOverlay(props()?.overlay);
    const head = (text) => div().pt(4).text_size(10).font_semibold().text_color(t.dim).child(text);
    const label = (s) => div().w(110).flex_none().text_size(12).text_color(t.muted).child(s);
    const icon = (id, glyph, tip, act, danger = false) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5)
      .text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(danger ? t.ansi1 : t.foreground))
      .tooltip(tip).on_mouse_down("left", stop).on_click(act).child(glyph);
    const input = (id, state) => div().id(id).flex_1().min_w(0).on_mouse_down("left", stop)
      .child(Input.new(state).w_full().h(28).px(10).rounded(7).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground));
    const chip = (id, text, on, act) => div().id(id).h(22).px(8).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .bg(on ? t.selected : t.background).border_1().border_color(t.border).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(act).child(text);
    const button = (id, text, primary, act) => div().id(id).h(28).px(14).flex().items_center().rounded(7).text_size(12).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.9))
      .on_mouse_down("left", stop).on_click(act).child(text);

    // Which model each use takes: a dropdown of the shared models.
    const useRow = (use, name) => {
      const cur = modelFor(use), open = this.drop === use;
      return v_flex().gap(4)
        .child(h_flex().gap(10).items_center().child(label(name))
          .child(h_flex().id(`use-${use}`).flex_1().min_w(0).h(28).px(10).items_center().justify_between().rounded(7).border_1().border_color(t.border)
            .bg(t.background).text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
            .on_click((_e, cx) => { this.drop = open ? null : use; cx.notify(); })
            .child(h_flex().min_w(0).gap(6).child(div().truncate().child(cur?.name ?? "no model")).child(div().text_size(11).text_color(t.dim).truncate().child(describe(cur))))
            .child(svg("mods/wb-ai/icons/chevron-down.svg").size(11).text_color(t.dim))))
        .when(open, (e) => e.child(h_flex().child(div().w(120).flex_none())
          .child(v_flex().flex_1().rounded(7).border_1().border_color(t.border).bg(t.background).p(4).gap(1)
            .children(list.map((m) => h_flex().id(`pick-${use}-${m.id}`).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer()
              .when(m.id === cur?.id, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
              .on_click((_e, cx) => { setUse(use, m.id); this.drop = null; cx.notify(); })
              .child(div().flex_1().truncate().text_size(12).child(m.name)).child(div().text_size(11).text_color(t.dim).child(describe(m))))))));
    };

    const e = this.edit;
    const form = !e ? null : (() => {
      const p = e.provider, suggest = p === "local" ? this.localModels.map((x) => [x, x]) : SUGGEST[p] ?? [];
      const typed = this.modelI.value().trim();
      return v_flex().gap(8).p(10).rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(div().text_size(12).font_semibold().child(e.id ? "Edit model" : "Add a model"))
        .child(h_flex().gap(10).items_center().child(label("Name")).child(input("f-name", this.nameI)))
        .child(h_flex().gap(10).items_center().child(label("Provider"))
          .child(h_flex().gap(4).children(Object.entries(PROVIDERS).map(([k, v]) => chip(`f-p-${k}`, v.label, p === k, (_e, cx) => this.setProvider(k, cx))))))
        .when(p === "local", (el) => el.child(h_flex().gap(10).items_center().child(label("Server")).child(input("f-url", this.urlI))
          .child(icon("f-reload", "↻", "Load its models", (_e, cx) => this.loadLocal(cx)))))
        .when(p !== "local", (el) => el.child(h_flex().gap(10).items_center().child(label("Command")).child(input("f-cmd", this.cmdI))
          .child(div().w(90).flex_none().child(input("f-args", this.argsI)))))
        .child(h_flex().gap(10).items_center().child(label("Model")).child(input("f-model", this.modelI)))
        .when(suggest.length > 0, (el) => el.child(h_flex().gap(10).child(div().w(110).flex_none())
          .child(h_flex().flex_1().flex_wrap().gap(4).children(suggest.slice(0, 24).map(([v, l]) => chip(`f-s-${v || "default"}`, l, typed === v, (_e, cx) => { this.modelI.set_value(v); cx.notify(); }))))))
        .when(p === "local" && (this.modelsLoading || Boolean(this.modelsError)), (el) => el.child(div().pl(120).text_size(11)
          .text_color(this.modelsError ? t.ansi1 : t.dim).child(this.modelsError ?? "Loading models…")))
        .child(div().pl(120).text_size(11).text_color(t.dim).child(PROVIDERS[p].hint))
        .when(Boolean(this.formError), (el) => el.child(div().pl(120).text_size(11).text_color(t.ansi1).child(this.formError)))
        .child(h_flex().gap(6).justify_end()
          .child(button("f-cancel", "Cancel", false, (_e, cx) => { this.edit = null; cx.notify(); }))
          .child(button("f-save", "Save", true, (_e, cx) => this.save(cx))));
    })();

    return v_flex().w_full().p(14).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(svg("mods/wb-ai/icons/settings.svg").size(14).text_color(t.muted))
        .child(div().flex_1().font_semibold().child("AI models"))
        .child(div().id("cg-close").w(22).h(22).flex().items_center().justify_center().rounded(5).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close").on_mouse_down("left", stop).on_click(close)
          .child(svg("mods/wb-ai/icons/x.svg").size(12))))
      .child(head("USE FOR"))
      .children(USES.map(([use, name]) => useRow(use, name)))
      .child(head("MODELS"))
      .child(v_flex().gap(1).children(list.map((m) => h_flex().id(`model-${m.id}`).h(30).px(8).gap(8).items_center().rounded(6)
        .when(e?.id === m.id, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(m.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(describe(m)))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(USES.filter(([u]) => modelFor(u)?.id === m.id).map(([, n]) => n.split(" ")[0].toLowerCase()).join(", ")))
        .child(icon(`edit-${m.id}`, "✎", "Edit", (_e, cx) => this.open(m, null, cx)))
        .when(list.length > 1, (el) => el.child(icon(`del-${m.id}`, "✕", "Delete", (_e, cx) => { deleteModel(m.id); if (this.edit?.id === m.id) this.edit = null; cx.notify(); }, true))))))
      .when(!e, (el) => el.child(h_flex().id("add-model").h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => this.open(null, "claude", cx)).child("+").child("Add model")))
      .when(Boolean(form), (el) => el.child(form))
      .child(head("COMMIT MESSAGE"))
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
              .on_click((_e, cx) => { this.template.set_value(DEFAULT_TEMPLATE); setCfg({ template: "" }); cx.notify(); }).child("Reset")))));
  }
}
