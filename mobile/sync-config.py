#!/usr/bin/env python3
"""Desktop workbench settings -> herdr-mobile on the server.

Reads ~/.config/herdr-app/shared.json (AI models and per-project picks, task sources and accounts,
recent MR targets) and the tokens the desktop mods keep in the macOS Keychain (herdr-jira,
herdr-trello, herdr-gitlab), merges them into the server's ~/.config/herdr-mobile/workbench.json
(desktop values win, keys set only on the phone stay) and writes secrets.json there with mode 0600.
Secrets go over ssh stdin, never argv or a local file.

Usage: sync-config.py [--no-secrets] [host]   (default: server)
"""
import json, os, re, subprocess, sys

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
NO_SECRETS = "--no-secrets" in sys.argv
HOST = ARGS[0] if ARGS else os.environ.get("HOST", "server")
HOME_APP = os.path.expanduser("~/.config/herdr-app")
shared = json.load(open(os.path.join(HOME_APP, "shared.json")))
g = lambda k, d=None: shared.get("wb." + k, shared.get(k, d))


def ssh(cmd, data=None):
    return subprocess.run(["ssh", HOST, cmd], input=data, capture_output=True, text=True, check=False)


def secret(service, account):
    r = subprocess.run(["security", "find-generic-password", "-s", service, "-a", account, "-w"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def accounts_of(service):
    dump = subprocess.run(["security", "dump-keychain"], capture_output=True, text=True).stdout
    out = []
    for block in dump.split("keychain: ")[1:]:
        if f'"svce"<blob>="{service}"' in block:
            m = re.search(r'"acct"<blob>="([^"]*)"', block)
            if m: out.append(m.group(1))
    return out


accounts = g("tasks.accounts", {}) or {}
desk = {
    "ai": {"models": g("ai.models", []), "use": g("ai.use", {}), "project": g("ai.project", {})},
    "tasks": {"accounts": accounts, "sources": g("tasks.sources", {})},
    "mr": {"recent": g("mr.recent", {})},
    "colors": g("colors", {}),
}

secrets = {"jira": {}, "trello": {}, "gitlab": {}}
for a in [] if NO_SECRETS else accounts.get("jira", []):
    t = secret("herdr-jira", a["id"]) or secret("herdr-jira", a.get("email", ""))
    if t: secrets["jira"][a["id"]] = t
trello_accts = [] if NO_SECRETS else accounts_of("herdr-trello")
for a in [] if NO_SECRETS else accounts.get("trello", []):
    v = secret("herdr-trello", a["id"])
    if not v:  # the first build: account = the API key, secret = the token
        for k in trello_accts:
            if re.fullmatch(r"[0-9a-f]{32}", k, re.I):
                tok = secret("herdr-trello", k)
                if tok: v = f"{k}:{tok}"; break
    if v and ":" in v: secrets["trello"][a["id"]] = v
for host in [] if NO_SECRETS else accounts_of("herdr-gitlab"):
    t = secret("herdr-gitlab", host)
    if t: secrets["gitlab"][host] = t

cur = ssh("cat ~/.config/herdr-mobile/workbench.json 2>/dev/null").stdout
try: cur = json.loads(cur or "{}")
except ValueError: cur = {}


def merge(a, b):  # b wins; nested dicts merged
    if isinstance(a, dict) and isinstance(b, dict):
        o = dict(a)
        for k, v in b.items(): o[k] = merge(a.get(k), v)
        return o
    return b if b is not None else a


wb = merge(cur, desk)
ssh("mkdir -p ~/.config/herdr-mobile")
r1 = ssh("cat > ~/.config/herdr-mobile/workbench.json.new && mv ~/.config/herdr-mobile/workbench.json.new ~/.config/herdr-mobile/workbench.json", json.dumps(wb, indent=2) + "\n")
r2 = subprocess.CompletedProcess([], 0, "", "") if NO_SECRETS else ssh("umask 077 && cat > ~/.config/herdr-mobile/secrets.json.new && chmod 600 ~/.config/herdr-mobile/secrets.json.new && mv ~/.config/herdr-mobile/secrets.json.new ~/.config/herdr-mobile/secrets.json", json.dumps(secrets) + "\n")
if r1.returncode or r2.returncode:
    sys.exit("sync failed: " + (r1.stderr + r2.stderr).strip())
print(f"workbench: {len(wb['ai'].get('models', []))} AI models, {len(wb['tasks'].get('sources', {}))} task sources; "
      + ("secrets: skipped" if NO_SECRETS else f"secrets: jira {len(secrets['jira'])}, trello {len(secrets['trello'])}, gitlab {len(secrets['gitlab'])}") + f" -> {HOST}")
