#!/usr/bin/env bash
# Deploy herdr-mobile to the server and (re)start its systemd user service.
set -euo pipefail
HOST="${HOST:-server}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ_SRC="${PROJECTS_SRC:-$HERE/../remote-projects.json}"

rsync -a --delete --exclude node_modules --exclude .git "$HERE"/ "$HOST:herdr-mobile/"

# Remote projects for this machine -> ~/.config/herdr-mobile/projects.json: the desktop's list, plus
# projects added on the phone ("from": "mobile") that the desktop hasn't taken over yet.
if [ -f "$PROJ_SRC" ]; then
  CUR="${TMPDIR:-/tmp}/herdr-mobile-projects.$$"
  ssh "$HOST" 'mkdir -p ~/.config/herdr-mobile; cat ~/.config/herdr-mobile/projects.json 2>/dev/null || true' > "$CUR"
  python3 - "$PROJ_SRC" "$CUR" <<'PY' | ssh "$HOST" 'cat > ~/.config/herdr-mobile/projects.json.new && mv ~/.config/herdr-mobile/projects.json.new ~/.config/herdr-mobile/projects.json'
import json, sys
home = "/home/server"
raw = json.load(open(sys.argv[1]))
try: cur = json.load(open(sys.argv[2])).get("projects", [])
except Exception: cur = []
norm = lambda p: (home + p[1:] if p == "~" or p.startswith("~/") else p).rstrip("/")
seen, out = set(), []
for p in raw.get("projects", raw if isinstance(raw, list) else []):
    if p.get("machine") != "server": continue
    path = norm(p["path"])
    if path in seen: continue
    seen.add(path); out.append({"machine": "server", "name": p.get("name") or path.split("/")[-1], "path": path})
for p in cur:
    if p.get("from") == "mobile" and norm(p["path"]) not in seen:
        seen.add(norm(p["path"])); out.append(p)
print(json.dumps({"projects": out}, indent=2))
PY
  rm -f "$CUR"
fi

# Workbench settings (AI models, task sources) and tokens from the Keychain (NO_SECRETS=1: settings only).
python3 "$HERE/sync-config.py" ${NO_SECRETS:+--no-secrets} "$HOST"

ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd ~/herdr-mobile
npm install --omit=dev --no-audit --no-fund
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/herdr-mobile.service <<UNIT
[Unit]
Description=Herdr mobile web service
After=network-online.target

[Service]
WorkingDirectory=%h/herdr-mobile
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=PORT=7681
ExecStart=%h/.local/bin/node server.js
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable herdr-mobile.service >/dev/null 2>&1
systemctl --user restart herdr-mobile.service
sleep 2
systemctl --user --no-pager status herdr-mobile.service | head -5
loginctl show-user "$USER" -p Linger
echo "--- URL:"
journalctl --user -u herdr-mobile -n 20 --no-pager | grep -o 'open: .*' | tail -1
REMOTE
