// A cache kept across a mod's copies. Each popup (Tasks, PRs) is a new copy whose localStorage starts
// empty, so a localStorage cache never showed there. This one lives in module scope (shared by every
// copy while the app runs) and in data/<mod>/cache.json (across restarts). A key not here yet falls
// back to this copy's localStorage (older builds).
// SAME FILE in every mod that uses it. The canonical copy is mods/wb-tasks/cache.js: edit it there,
// then run `scripts/sync-helpers.sh --write` to copy it over the others.
//
//   const cache = fileCache("wb-tasks");   // one per mod: every call with the name gets the same one
//   await cache.load();                     // before the first get (cache.ready() says if it's done)
//   cache.get(key, fallback); cache.set(key, value);

import * as fs from "fs/promises";
import { appHome, checking } from "herdr";

const caches = {};
export const fileCache = (name) => (caches[name] ??= make(name));

function make(name) {
  let mem = {}, loaded = false, loading = null, writing = false, again = false;
  const dir = () => `${appHome()}/data/${name}`;
  const load = () => loaded ? Promise.resolve() : (loading ??= fs.readFile(`${dir()}/cache.json`, "utf8")
    .then((t) => { const o = JSON.parse(t); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }, () => ({}))
    .then((o) => { mem = { ...o, ...mem }; loaded = true; }));
  // One write at a time; changes made meanwhile go out in one more.
  async function save() {
    if (checking()) return;
    if (writing) { again = true; return; }
    writing = true;
    try {
      do {
        again = false;
        await load();
        await fs.mkdir(dir(), { recursive: true }).catch(() => {});
        await fs.writeFile(`${dir()}/cache.json`, JSON.stringify(mem)).catch((e) => console.log(`${name} cache: ${e?.message ?? e}`));
      } while (again);
    } finally { writing = false; }
  }
  return {
    load, ready: () => loaded,
    get(k, d) {
      if (k in mem) return mem[k];
      try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) { mem[k] = v; save(); },
  };
}
