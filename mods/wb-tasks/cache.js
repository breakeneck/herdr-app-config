// The Tasks cache (lists, boards, repo lookups), kept across copies: each Tasks popup is a new
// copy whose localStorage starts empty, so a localStorage cache never showed. It lives here, in
// module scope (shared by every copy while the app runs), and in data/wb-tasks/cache.json
// (across restarts). A key not here yet falls back to this copy's localStorage (older builds).

import * as fs from "fs/promises";
import { appHome, checking } from "herdr";

let mem = {}, loaded = false, loading = null, writing = false, again = false;
const dir = () => `${appHome()}/data/wb-tasks`;

// Resolves once the file is read (the first copy reads it; later ones get it at once).
export function loadCache() {
  if (loaded) return Promise.resolve();
  return (loading ??= fs.readFile(`${dir()}/cache.json`, "utf8")
    .then((t) => { const o = JSON.parse(t); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }, () => ({}))
    .then((o) => { mem = { ...o, ...mem }; loaded = true; }));
}
export const cacheReady = () => loaded;

export const cache = {
  get(k, d) {
    if (k in mem) return mem[k];
    try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { mem[k] = v; save(); },
};

// One write at a time; changes made meanwhile go out in one more.
async function save() {
  if (checking()) return;
  if (writing) { again = true; return; }
  writing = true;
  try {
    do {
      again = false;
      await loadCache();
      await fs.mkdir(dir(), { recursive: true }).catch(() => {});
      await fs.writeFile(`${dir()}/cache.json`, JSON.stringify(mem)).catch((e) => console.log(`wb-tasks cache: ${e?.message ?? e}`));
    } while (again);
  } finally { writing = false; }
}
