// AI models window (opened from Changes → Generate ▾, a PR's AI review ▾, ...): the shared list of
// models (add, edit, delete), in shared "wb.ai.models" (ai.js). With props {use, project, projectName}
// it is instead that use's settings for one project: model, language, template (shared "wb.ai.project").

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { props, closeOverlay, openOverlay, theme } from "herdr";
import { migrate, models, settingsFor, setSetting, setUse, saveModel, deleteModel, describe, localModels, DEFAULTS, LANGUAGES, PROVIDERS, SUGGEST, DEFAULT_URL } from "./ai.js";

const USE_TITLE = { commit: "Commit message", review: "AI review", mr: "MR description" };
const openModels = () => openOverlay({ mod: "wb-ai", kind: "window", key: "wb-ai", width: 580 });

// What the template is without this project's own text: the all-projects one, else the built-in.
const inherited = (use, project) => { const t = settingsFor(use, "*").template; return t || DEFAULTS[use]; };

export default class AiModels extends View {
  init(_props, cx) {
    migrate();
    this.edit = null; // the model being added / edited: { id?, provider }
    this.drop = false; // the model dropdown of the settings dialog is open
    this.localModels = []; this.modelsError = null; this.modelsLoading = false;
    const input = (placeholder) => InputState.new({ placeholder });
    this.nameI = input("Name, e.g. Claude Opus"); this.cmdI = input("command"); this.argsI = input("args");
    this.modelI = input("model (empty: CLI default)"); this.urlI = input(DEFAULT_URL);
    this.urlI.on("submit", (_e, cx) => this.loadLocal(cx));
    // Settings dialog (props.use): the template and language of one use in one project, saved as typed.
    const { use, project } = props() ?? {};
    if (use) {
      this.langI = InputState.new({ placeholder: "Another language…" });
      this.langI.on("change", () => { const v = this.langI.value().trim(); if (v) setSetting(use, project, { language: v }); });
      this.template = TextareaState.new({ placeholder: DEFAULTS[use], rows: 6 });
      this.template.set_value(settingsFor(use, project).template);
      const keep = () => { const v = this.template.value().trim(); setSetting(use, project, { template: v === inherited(use, project) ? "" : v }); };
      this.template.on("blur", (_e, cx) => { keep(); cx.notify(); });
      this.template.on("change", () => keep());
      const lang = settingsFor(use, project).language;
      if (!LANGUAGES.includes(lang)) this.langI.set_value(lang);
    }
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

  settingsView(cx) {
    const t = theme(), { use, project, projectName: pn } = props(), s = settingsFor(use, project), list = models();
    const stop = (_e, cx) => cx.stop_propagation();
    const label = (x) => div().w(80).flex_none().text_size(12).text_color(t.muted).child(x);
    const chip = (id, text, on, act) => div().id(id).h(22).px(8).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .bg(on ? t.selected : t.background).border_1().border_color(t.border).text_color(on ? t.foreground : t.muted)
      .hover((x) => x.bg(t.hover)).on_mouse_down("left", stop).on_click(act).child(text);
    const row = (id, selected, act, ...kids) => h_flex().id(id).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer()
      .when(selected, (x) => x.bg(t.selected)).hover((x) => x.bg(t.hover)).on_mouse_down("left", stop).on_click(act).children(kids);
    const custom = !LANGUAGES.includes(s.language);
    const name = pn || project;
    return v_flex().w_full().p(14).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(svg("mods/wb-ai/icons/settings.svg").size(14).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(`${USE_TITLE[use]} · ${name}`))
        .child(div().id("cg-close").w(22).h(22).flex().items_center().justify_center().rounded(5).text_color(t.dim)
          .hover((x) => x.bg(t.hover).text_color(t.foreground)).tooltip("Close").on_mouse_down("left", stop).on_click(() => closeOverlay(props()?.overlay))
          .child(svg("mods/wb-ai/icons/x.svg").size(12))))
      .child(v_flex().gap(4)
        .child(h_flex().gap(10).items_center().child(label("Model"))
          .child(h_flex().id("set-model").flex_1().min_w(0).h(28).px(10).items_center().justify_between().rounded(7).border_1().border_color(t.border)
            .bg(t.background).text_size(12).cursor_pointer().hover((x) => x.bg(t.hover)).on_mouse_down("left", stop)
            .on_click((_e, cx) => { this.drop = !this.drop; cx.notify(); })
            .child(h_flex().min_w(0).gap(6).child(div().truncate().child(s.model?.name ?? "no model")).child(div().text_size(11).text_color(t.dim).truncate().child(describe(s.model))))
            .child(svg("mods/wb-ai/icons/chevron-down.svg").size(11).text_color(t.dim))))
        .when(this.drop, (e) => e.child(h_flex().child(div().w(90).flex_none())
          .child(v_flex().flex_1().rounded(7).border_1().border_color(t.border).bg(t.background).p(4).gap(1)
            .children(list.map((m) => row(`pick-${m.id}`, m.id === s.model?.id, (_e, cx) => { setUse(use, m.id, project); this.drop = false; cx.notify(); },
              div().flex_1().truncate().text_size(12).child(m.name), div().text_size(11).text_color(t.dim).child(describe(m)))))
            .child(div().h(1).my(2).bg(t.border))
            .child(row("pick-models", false, () => { this.drop = false; openModels(); }, div().text_size(12).child("AI models…")))))))
      .child(h_flex().gap(10).items_start().child(label("Language").mt(3))
        .child(v_flex().flex_1().min_w(0).gap(6)
          .child(h_flex().flex_wrap().gap(4).children(LANGUAGES.map((l) => chip(`lang-${l}`, l, s.language === l, (_e, cx) => { this.langI.set_value(""); setSetting(use, project, { language: l }); cx.notify(); }))))
          .child(div().id("lang-input").on_mouse_down("left", stop)
            .child(Input.new(this.langI).w_full().h(28).px(10).rounded(7).border_1().border_color(custom ? t.accent : t.border).bg(t.background).text_size(12).text_color(t.foreground)))))
      .child(h_flex().gap(10).items_start().child(label("Template").mt(6))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().id("cg-template").h(130).px(10).py(6).rounded(7).border_1().border_color(t.border).bg(t.background).cursor_text()
            .on_mouse_down("left", stop).child(Textarea.new(this.template).w_full().h(116).text_size(12).text_color(t.foreground)))
          .child(h_flex().gap(8).items_center().text_size(11)
            .when(use === "commit", (e) => e.child(h_flex().id("cg-noblank").gap(6).items_center().cursor_pointer().on_mouse_down("left", stop)
              .on_click((_e, cx) => { setSetting(use, project, { noBlank: !s.noBlank }); cx.notify(); })
              .child(div().size(13).flex().items_center().justify_center().rounded(3).border_1().text_size(10)
                .border_color(s.noBlank ? t.accent : t.border).bg(s.noBlank ? t.accent : t.background)
                .text_color(t.accent_foreground).child(s.noBlank ? "✓" : ""))
              .child(div().text_color(t.muted).child("No blank lines"))))
            .child(div().flex_1())
            .child(div().id("cg-tpl-reset").text_color(t.dim).cursor_pointer().hover((x) => x.text_color(t.foreground)).on_mouse_down("left", stop)
              .on_click((_e, cx) => { setSetting(use, project, { template: "" }); this.template.set_value(inherited(use, project)); cx.notify(); }).child("Reset")))));
  }

  render(cx) {
    if (props()?.use) return this.settingsView(cx);
    const t = theme(), list = models();
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
      .child(head("MODELS"))
      .child(v_flex().gap(1).children(list.map((m) => h_flex().id(`model-${m.id}`).h(30).px(8).gap(8).items_center().rounded(6)
        .when(e?.id === m.id, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(m.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(describe(m)))
        .child(icon(`edit-${m.id}`, "✎", "Edit", (_e, cx) => this.open(m, null, cx)))
        .when(list.length > 1, (el) => el.child(icon(`del-${m.id}`, "✕", "Delete", (_e, cx) => { deleteModel(m.id); if (this.edit?.id === m.id) this.edit = null; cx.notify(); }, true))))))
      .when(!e, (el) => el.child(h_flex().id("add-model").h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click((_e, cx) => this.open(null, "claude", cx)).child("+").child("Add model")))
      .when(Boolean(form), (el) => el.child(form));
  }
}
