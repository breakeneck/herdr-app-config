# herdr-mobile

A small web service + PWA to watch and drive **Herdr** terminals and coding agents from a phone
or a desktop browser. It runs on the Linux box `server` (user `server`, systemd user service
`herdr-mobile`, port 7681) and talks to that machine's **herdr-core** (`hc`).

Phone: a stacked layout (projects → project page → full-screen terminal).
Desktop browser (≥1000px): a layout shaped like the Herdr desktop app's window.

## Where the code lives (read this first)

- **Source of truth: the git repo on the Mac**, `~/.config/herdr-app` (GitHub
  `breakeneck/herdr-app-config`), folder `mobile/`. That repo is also the whole config of the
  Herdr desktop app (layouts, keys, mods).
- `~/herdr-mobile` on `server` is a **deployed copy** (no git). `mobile/deploy.sh` (run on the Mac)
  rsyncs `mobile/` there with `--delete`, runs `npm install`, rewrites the systemd unit and restarts.
- If you are an agent working **on the server** in `~/herdr-mobile`: your edits go live after
  `systemctl --user restart herdr-mobile`, but `~/herdr-mobile` is not a git checkout. Commit from the
  server yourself: clone `https://github.com/breakeneck/herdr-app-config.git` (https: git's credential store has a token that
  can push; the server's SSH key is a deploy key of another repo, read-only here)
  into your scratch dir, `rsync -a --exclude node_modules --exclude .git --exclude package-lock.json
  --exclude .deployed --exclude AGENTS.md ~/herdr-mobile/ mobile/`, commit, push. Then refresh the
  server's `.deployed` (`cd ~/herdr-mobile && find . -path ./node_modules -prune -o -type f ! -name .deployed
  ! -name package-lock.json -print | sort | xargs sha256sum > .deployed`) so `deploy.sh` doesn't see drift.
  Tell the person to `git pull` on the Mac. (`mobile/pull-from-server.sh` on the Mac is the other way.)
  `deploy.sh` refuses to run while the server has changes the repo lacks, so nothing is lost silently.
- On the Mac there is no `node`; check syntax on the server: `~/.local/bin/node --check <file>`.
  On the server `node`/`hc` are in `~/.local/bin` (not on a non-login ssh PATH).

## The desktop app it mirrors

Herdr (`herdr-app`) is a desktop app for terminals and coding agents; herdr-core (`hc`) runs every
terminal and keeps it alive. The full manual is `~/.config/herdr-app/AGENTS.md` on the Mac
(`herdr-app --skill`, `hc --skill`). **On the server, a read-only copy of that manual and of the
`wb-*` mods is in `~/herdr-desktop-ref/`** (refreshed by every deploy). `hc --skill` works on the server too.
What matters here:

- **Spaces → tabs → panes/terminals.** The window's structure per machine is the JSON document
  `herdr-app` in that machine's core: `doc.get {name:"herdr-app"}` → `{ value: { spaces: [ { id, name,
  folder, tabs: [ { id, name, root } ] } ] }, version }`. `root` is a tree: `{type:"row"|"column",
  children, size:{weight}}` with leaves `{type:"block", content:{terminal:"t7"} | {mod:"..."}}`.
- A terminal started with labels `herdr.space=<id>` and `herdr.tab=<id>` belongs there. The desktop app
  adopts such terminals into the doc **only while it runs**, so this service writes the tab into the doc
  itself (`adopt()` in server.js: `doc.set` with the version, retried on `conflict`).
- Agents report a status (OSC 7501): `working`, `blocked`, `done`, `idle`; `terminal.list` gives it.
- The desktop's workbench is a set of the person's own mods in `~/.config/herdr-app/mods/wb-*`:
  `wb-projects` (Remote projects list: `remote-projects.json`), `wb-changes` (Changes + commit +
  AI generate), `wb-tasks` (Jira/Trello), `wb-prs` (gh / GitLab, AI review, create MR), `wb-ai`
  (AI models and per-project settings, `ai.js`), `wb-folder-picker`. The mobile features are ports of
  these; when in doubt about behavior, read the mod (`~/herdr-desktop-ref/mods/wb-*` on the server).

## Architecture

- `server.js`: HTTP + WebSockets. Two `hc connect` JSON-RPC children (one streams `events.subscribe`,
  one answers requests). Builds the state pushed to `/events` (projects with git info, spaces, tabs with
  their `root` split tree, agent statuses, desktop colors). `/attach?t=` runs `hc attach` in a pty per
  viewer. Auth: token in `~/.config/herdr-mobile/token` (cookie `hm`, or `?token=` once).
- `lib/conf.js`: `~/.config/herdr-mobile/{workbench.json, secrets.json (0600), drafts.json}`.
- `lib/ai.js`: models and prompts as wb-ai; `claude`/`codex` run through the interactive shell with the
  prompt on stdin, `local` = OpenAI-compatible URL.
- `lib/tasks.js` (Jira, Trello), `lib/prs.js` (GitHub via `gh`, GitLab REST with token; create MR).
- AI work runs as server jobs (`startJob`, poll `/api/job?id=`), results also saved as drafts.
- `public/app.js`: routing (`#/`, `#/p/<idx>`, `#/o/<space>`, `#/t/<addr>`, `#/add`), phone views,
  Changes/branches, the phone terminal screen. `public/wb.js`: tasks, PRs, MR create, AI, sheets
  (popups), markdown, folder browser. `public/wide.js`: the desktop-browser layout (sidebar, tab pills,
  `TermView` live xterm cards per split, Changes panel with Tasks/PR/AI popups, column splitters).
  Scripts load in that order and share top-level names: **no duplicate top-level identifiers**.
- Projects: `~/.config/herdr-mobile/projects.json`. deploy.sh writes the desktop's server projects there
  and keeps entries added from the phone (`"from": "mobile"`) until the desktop's wb-projects imports them.
- `sync-config.py` (run on the Mac; part of deploy): desktop shared.json settings (AI models and picks,
  task sources and accounts, MR recent targets, project colors) → workbench.json, and Keychain tokens
  (herdr-jira / herdr-trello / herdr-gitlab) → secrets.json. `--no-secrets` / `NO_SECRETS=1` skips tokens.

## Testing

- Never test on the live port first: run a copy on 7699 with its own home
  (`PORT=7699 HERDR_MOBILE_HOME=~/.config/herdr-mobile-test node server.js`; copy token, projects.json,
  workbench.json, secrets.json into it). Start it from a script file: `pkill -f <pattern>` inside an
  `ssh '...'` command matches the ssh command itself and kills it.
- Look at it with headless Chrome on the Mac (`--screenshot`, `--dump-dom`, `--window-size`). Headless
  windows are at least 500px wide, so a "cut off" 390px shot is an artifact. Load once with `?token=` to
  set the cookie, then screenshot without it. Open a project with only shells (attaching resizes the real
  terminal, which disturbs a running Claude session).
- curl the API with `-H "cookie: hm=$(cat ~/.config/herdr-mobile/token)"`.

## Gotchas already hit

- `git.allmylinks.com` answers Node's default User-Agent with a 403 HTML page: send `User-Agent`.
- CSS class names from the phone layout (`.row`, `.card`) leak into new layouts; wide.js uses `.split`
  with `hsplit`/`vsplit` and `.tcard`.
- `gh` on the server is not logged in: GitHub PRs fail until `gh auth login` there.
- `/api/folders` lists any folder on the server (the service is the person's own, token-protected).
- Static files are served `no-cache`: a public/ change needs no restart; server.js and lib/ do.

## Conventions

- One commit per task in the Mac repo, then push (the person's rule). End commit messages with the
  Co-Authored-By line the session gives.
- Keep the phone layout working whenever the wide one changes, and the other way round.
