'use strict';
// Workbench settings and secrets for the mobile service, mirrored from the desktop app by sync-config.py:
//   workbench.json: { ai: { models, use, project }, tasks: { accounts, sources }, mr: { recent } }  (no secrets)
//   secrets.json (0600): { jira: { <account id>: token }, trello: { <member id>: "key:token" }, gitlab: { <host>: token } }
//   drafts.json: AI output kept until used: { review: { url: {...} }, mr: { key: {...} }, commit: { path: text } }
// Settings changed from the phone are written back here; the next sync merges the desktop's on top.
const fs = require('fs');
const path = require('path');

function make(dir) {
  const file = (n) => path.join(dir, n);
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
  const write = (n, v, mode) => {
    const tmp = file(n) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', mode ? { mode } : undefined);
    fs.renameSync(tmp, file(n));
  };
  const c = {
    wb: () => read('workbench.json', {}),
    setWb(patch) { const v = { ...c.wb(), ...patch }; write('workbench.json', v); return v; },
    secret(kind, id) { const s = read('secrets.json', {}); return (s[kind] || {})[id] || null; },
    drafts: () => read('drafts.json', { review: {}, mr: {}, commit: {} }),
    setDraft(kind, id, value) {
      const d = c.drafts(); d[kind] = d[kind] || {};
      if (value == null) delete d[kind][id]; else d[kind][id] = value;
      write('drafts.json', d);
    },
  };
  return c;
}
module.exports = { make };
