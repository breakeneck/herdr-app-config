// Sections: any sidebar/panel block whose mod uses this file can be collapsed by clicking
// its title, and moved anywhere while "Edit layout" (the header button) is on.
// SAME FILE in every mod that uses sections. The canonical copy is mods/wb-spaces/section.js:
// edit it there, then run `scripts/sync-helpers.sh --write` to copy it over the others.
//
// Shared state: "layout.edit" (bool), "layout.drag" ({ id } of the picked block),
// "sections.collapsed" ({ id: { size, min } } — what to restore on expand).
// Structure changes go through layout.set on the shown (personal) layout.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { layout, shared, setShared, run, theme } from "herdr";

// Containers the window is built on: never pruned when they empty out.
const KEEP = new Set(["root", "sidebar", "sidebar-lists", "work", "work-body"]);

function find(node, pred, parent = null) {
  if (!node) return null;
  if (pred(node)) return { node, parent };
  for (const c of node.children ?? []) {
    const r = find(c, pred, node);
    if (r) return r;
  }
  return null;
}
const tree = () => JSON.parse(JSON.stringify(layout()));
const collapsedMap = () => shared("sections.collapsed") ?? {};

export const editing = () => Boolean(shared("layout.edit"));

// This mod's block in the shown layout: { id, parent } or null (not in this layout).
export function sectionOf(mod) {
  const r = find(layout(), (n) => n.type === "block" && n.content?.mod === mod);
  return r ? { id: r.node.id, parent: r.parent } : null;
}

export const isCollapsed = (sec) => Boolean(sec && collapsedMap()[sec.id]);
// Collapsing only means something stacked in a column (a stack shows one child anyway).
export const canCollapse = (sec) => sec?.parent?.type === "column";

// Collapse to just the title (px high), or back to the size it had.
export function toggle(sec, px) {
  if (!canCollapse(sec)) return;
  const root = tree(), r = find(root, (n) => n.id === sec.id);
  if (!r) return;
  const map = { ...collapsedMap() };
  if (map[sec.id]) {
    r.node.size = map[sec.id].size ?? { weight: 1 };
    if (map[sec.id].min === undefined || map[sec.id].min === null) delete r.node.min; else r.node.min = map[sec.id].min;
    delete map[sec.id];
  } else {
    map[sec.id] = { size: r.node.size ?? null, min: r.node.min ?? null };
    r.node.size = { px };
    r.node.min = px;
  }
  setShared("sections.collapsed", map);
  run("layout.set", { layout: root });
}

// Drop containers a move left empty (a stack with no children, a column with nothing in it).
function prune(node) {
  if (!node.children) return;
  for (const c of node.children) prune(c);
  node.children = node.children.filter((c) => !c.children || c.children.length || KEEP.has(c.id));
  if (node.type === "stack" && node.children.length && !node.children.some((c) => c.id === node.active)) node.active = node.children[0].id;
}

// Put block `src` before/after `target` (a stack child: beside its stack).
export function move(src, target, where) {
  if (!src || src === target) return;
  const root = tree();
  const s = find(root, (n) => n.id === src);
  let t = find(root, (n) => n.id === target);
  if (!s?.parent || !t?.parent) return;
  if (t.parent.type === "stack") t = find(root, (n) => n.id === t.parent.id);
  if (!t?.parent || t.node === s.node) return;
  s.parent.children = s.parent.children.filter((c) => c !== s.node);
  // It lands expanded and sized like a section: a share of its new column.
  const map = { ...collapsedMap() };
  if (map[src]) { delete map[src]; setShared("sections.collapsed", map); }
  s.node.size = { weight: 1 };
  s.node.min = 90;
  delete s.node.hidden;
  const kids = t.parent.children;
  const i = kids.indexOf(t.node) + (where === "after" ? 1 : 0);
  kids.splice(i, 0, s.node);
  prune(root);
  run("layout.set", { layout: root });
}

// Wire a mod's title row: click collapses/expands; in edit mode a press picks the block up.
// Inner buttons of the title must stop their own clicks (cx.stop_propagation()).
export function header(el, sec, px) {
  if (!sec) return el;
  const t = theme(), edit = editing(), picked = shared("layout.drag")?.id === sec.id;
  const collapsible = canCollapse(sec);
  return el.id(`sec-${sec.id}`)
    .when(edit || collapsible, (e) => e.cursor_pointer())
    .when(edit, (e) => e.bg(picked ? t.selected : t.raised))
    .on_mouse_down("left", (_e, cx) => {
      if (!editing()) return;
      setShared("layout.drag", picked ? null : { id: sec.id });
      cx.stop_propagation();
    })
    .on_click((_e, cx) => { if (!editing()) { toggle(sec, px); cx.stop_propagation(); } })
    .tooltip(edit ? (picked ? "Picked: drop it on another block (click here to cancel)" : "Drag (or click) to move this block")
      : collapsible ? (isCollapsed(sec) ? "Expand" : "Collapse") : "");
}

// A small leading mark for the title: ⠿ while editing, ▸/▾ for collapsible sections.
export function mark(sec) {
  const t = theme();
  if (!sec) return div();
  if (editing()) return div().flex_none().text_size(11).text_color(t.accent).child("⠿");
  if (!canCollapse(sec)) return div();
  return div().flex_none().w(10).text_size(9).text_color(t.dim).child(isCollapsed(sec) ? "▸" : "▾");
}

// Over the whole block while editing: the picked one is outlined; every other one offers
// "above" / "below" halves. Drop by releasing over a half (drag) or clicking it (click-click).
// The root it goes on must be .relative().
export function overlay(sec) {
  if (!sec || !editing()) return null;
  const t = theme(), drag = shared("layout.drag");
  if (!drag) return div().absolute().inset_0().border_1().border_color(t.accent + "66").rounded(6);
  if (drag.id === sec.id) return div().absolute().inset_0().border_2().border_color(t.accent).rounded(6);
  // Released (drag) or clicked (click-click): whichever comes first moves it, the other finds no pick.
  const drop = (where, cx) => {
    cx.stop_propagation();
    const d = shared("layout.drag");
    if (!d) return;
    setShared("layout.drag", null);
    move(d.id, sec.id, where);
  };
  const half = (where, label) => h_flex().id(`drop-${sec.id}-${where}`).flex_1().min_h(0).w_full().items_center().justify_center()
    .text_size(11).text_color(t.muted).cursor_pointer()
    .hover((s) => s.bg(t.accent + "33").text_color(t.foreground))
    .on_mouse_up("left", (_e, cx) => drop(where, cx))
    .on_click((_e, cx) => drop(where, cx))
    .child(label);
  return v_flex().id(`drop-${sec.id}`).absolute().inset_0().rounded(6).border_2().border_color(t.accent + "aa").bg(t.background + "d0")
    .child(half("before", "↑ Put above"))
    .child(div().h(1).flex_none().bg(t.accent + "66"))
    .child(half("after", "↓ Put below"));
}
