// The commit behind a blamed line, like the IDE's popup from "Annotate with Git Blame": hash, author,
// date, the whole message and the files it changed. A file opens that commit's change to it in the diff tab.
// props: { root, on, path, hash }. Opened from the annotation gutter of wb-diff and the wb-files viewer.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, settings, exec, spaces, panes, run, setShared, notify } from "herdr";

const SEP = "\x1f";
const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

export default class BlameCommit extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.p = p; this.c = null; this.error = null;
    if (!p.hash) { this.error = "No commit"; return; }
    cx.spawn(async (cx) => {
      try {
        const g = (args) => exec("git", ["--no-optional-locks", ...args], { cwd: p.root, on: p.on ?? undefined });
        const [body, files] = await Promise.all([
          g(["show", "-s", `--format=%H${SEP}%an <%ae>${SEP}%ad${SEP}%cn${SEP}%D${SEP}%B`, "--date=format:%Y-%m-%d %H:%M", p.hash]),
          g(["show", "--format=", "--name-status", "-M", p.hash]),
        ]);
        if (body.code !== 0) throw new Error(body.stderr.trim() || "git show failed");
        const [hash, author, date, committer, refs, ...msg] = body.stdout.split(SEP);
        this.c = {
          hash, author, date, committer, refs: refs.trim(), message: msg.join(SEP).trim(),
          files: files.stdout.split("\n").filter(Boolean).map((l) => { const [st, ...q] = l.split("\t"); return { status: st[0], path: q[q.length - 1], from: q.length > 1 ? q[0] : null }; }),
        };
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  dismiss() { closeOverlay(props()?.overlay); }

  // That commit's change to one file, in the space's diff tab (as the Git log opens it).
  openFile(f) {
    const { root, on } = this.p, c = this.c;
    const space = spaces().find((s) => s.active);
    const req = { space: space?.id ?? null, root, on: on ?? null, path: f.path, commit: c.hash, status: f.status, fresh: false, ts: Date.now() };
    const ids = new Set((space?.tabs ?? []).map((t) => t.id));
    const existing = panes().find((p) => p.mod === "wb-diff" && ids.has(p.tab));
    setShared("wb.diff.request", req);
    const name = `${f.path.split("/").pop()} @ ${c.hash.slice(0, 7)}`;
    if (existing) { run("tab.select", { id: existing.tab }); run("tab.rename", { id: existing.tab, name }); }
    else run("tab.new", { name, mod: "wb-diff", props: req, space: space?.id ?? undefined });
    this.dismiss();
  }

  render() {
    const t = theme(), c = this.c, mono = settings().font_family ?? "JetBrains Mono";
    const btn = (id, label, act) => div().id(id).h(24).px(10).flex_none().flex().items_center().rounded(6).border_1().border_color(t.border)
      .text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => act(cx)).child(label);
    const head = h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().text_size(13).child("Commit"))
      .child(div().font_family(mono).text_size(12).text_color(t.accent).child(c ? c.hash.slice(0, 10) : (this.p.hash ?? "").slice(0, 10)))
      .child(div().flex_1())
      .when(Boolean(c), (e) => e.child(btn("copy-hash", "Copy hash", (cx) => { cx.write_to_clipboard(c.hash); notify({ title: "Copied", body: c.hash, level: "info", timeout: 1500 }); })))
      .child(div().id("close").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.dismiss()).child("✕"));
    const root = v_flex().id("blame-commit").size_full().bg(t.background).text_color(t.foreground).text_size(12.5).child(head);
    if (!c) return root.child(div().p(14).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? "Loading commit…"));
    const meta = (k, v) => h_flex().gap(8).child(div().w(70).flex_none().text_color(t.dim).child(k)).child(div().flex_1().min_w(0).truncate().child(v));
    return root.child(v_flex().id("blame-body").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(12)
      .child(v_flex().gap(3).text_size(12)
        .child(meta("Author", c.author))
        .child(meta("Date", c.date))
        .when(Boolean(c.committer) && !c.author.startsWith(c.committer + " <"), (e) => e.child(meta("Committer", c.committer)))
        .when(Boolean(c.refs), (e) => e.child(meta("Refs", c.refs))))
      .child(div().p(10).rounded(8).bg(t.surface).border_1().border_color(t.border).font_family(mono).text_size(12).whitespace_normal()
        .children((c.message || "(no message)").split("\n").map((l) => div().min_h(16).child(l || " "))))
      .child(v_flex().gap(1)
        .child(div().pb(4).text_size(11).text_color(t.dim).child(`${c.files.length} changed file${c.files.length === 1 ? "" : "s"}`))
        .children(c.files.map((f, i) => {
          const mine = f.path === this.p.path || f.from === this.p.path;
          const col = f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "R" ? t.ansi4 : t.ansi3;
          return h_flex().id(`f-${i}`).h(24).px(8).gap(8).flex_none().items_center().rounded(5).cursor_pointer()
            .when(mine, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).tooltip(`${STATUS[f.status] ?? f.status}${f.from ? ` from ${f.from}` : ""} · open this commit's change`)
            .on_click(() => this.openFile(f))
            .child(div().w(12).flex_none().font_semibold().text_size(11).text_color(col).child(f.status))
            .child(div().flex_none().child(f.path.split("/").pop()))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""));
        }))));
  }
}
