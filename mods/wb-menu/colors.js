// Project colors, shared by every wb- mod that draws a project's tile (Spaces,
// Remote projects, the Files header, the menu's swatches). Kept by project name
// (a space's name = its repo/folder unless renamed), so a space on a machine that
// is still connecting keeps its color and a reopened project gets the same one.
// shared "wb.colors": { [name]: "#rrggbb" } holds only picks made from the menu;
// any other name gets a color from a hash of the name: stable, nothing to store.
// Canonical copy: mods/wb-spaces/colors.js (scripts/sync-helpers.sh).
import { shared, setShared, spaces } from "herdr";

export const PALETTE = ["#22a99a", "#e3814f", "#5b8def", "#8b7cf6", "#3fae6a", "#d9649a", "#b8860b", "#2a9cae", "#c2508f", "#8a9a4a"];

// The old per-space-id colors (before wb.colors): theme names or #hex.
const OLD = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

function hashed(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Once: carry the colors the spaces wear now (shared "space.colors", by id) over to their names.
function picks() {
  const have = shared("wb.colors");
  if (have && typeof have === "object") return have;
  const old = shared("space.colors") ?? {}, seeded = {};
  for (const s of spaces()) {
    const c = old[s.id];
    if (c && s.name && s.name !== "~") seeded[s.name] = c.startsWith("#") ? c : (OLD[c] ?? hashed(s.name));
  }
  setShared("wb.colors", seeded);
  return seeded;
}

export function colorOf(name) {
  if (!name) return PALETTE[0];
  return picks()[name] ?? hashed(name);
}

export function isPicked(name) {
  return Boolean(name && picks()[name]);
}

// color: "#rrggbb", or null to go back to the hashed one.
export function setColor(name, color) {
  if (!name) return;
  const next = { ...picks() };
  if (color) next[name] = color;
  else delete next[name];
  setShared("wb.colors", next);
}
