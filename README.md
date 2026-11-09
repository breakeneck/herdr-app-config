# herdr-app config (live)

The whole [herdr](https://github.com/herdr-app) UI as files — this repo IS the live config directory (`~/.config/herdr-app`), so every change here is instantly the running app, and `git push` backs it up.

Fork of [gandriyko/herdr-app-config](https://github.com/gandriyko/herdr-app-config).

## Packages

Shareable things live under `share/`: a `RECIPE.md` and `preview.png` each. The files themselves stay in `layouts/` and `mods/` because this repo is the live config; to publish one, copy the folders named below into its own repo (plus the `RECIPE.md` and `preview.png`, as described under "Layouts and mods other people made" in `AGENTS.md`).

| Package | Files it consists of | Recipe |
|---|---|---|
| `workbench` (layout) | `layouts/workbench.json` and every `mods/wb-*` | `share/workbench/` |
| `wb-tasks` (mod) | `mods/wb-tasks/` | `share/wb-tasks/` |
| `wb-prs` (mod) | `mods/wb-prs/` | `share/wb-prs/` |
| `wb-git` (mod) | `mods/wb-git/` | `share/wb-git/` |
| `wb-diff` (mod) | `mods/wb-diff/` | `share/wb-diff/` |

`wb-spaces`, `wb-agents`, `wb-files`, `wb-tabs` and `wb-changes` are clones of Herdr's own mods (their `mod.json` has `cloned_from`); they do not follow Herdr updates. `wb-tasks` and `wb-prs` derive from [gandriyko/herdr-app-config](https://github.com/gandriyko/herdr-app-config); that repository has no license file, so this is a credit only.

Previews of `wb-tasks` and `wb-prs` are not published because their live panels show personal accounts and task or PR titles.

## Install

1. Copy `layouts/workbench.json` to `~/.config/herdr-app/layouts/` and each `mods/wb-*` folder you want to `~/.config/herdr-app/mods/`. Never overwrite an existing name; rename it instead.
2. Check each mod: `herdr-app check ~/.config/herdr-app/mods/wb-git`, then `herdr-app status` (`errors` must be `[]`).
3. Show the layout: `herdr-app do layout.switch --name workbench` (`ctrl-shift-l` switches back).

A single mod: copy its folder, check it, then add a block `{ "type": "block", "content": { "mod": "wb-git" } }` to a layout (or as a child of a stack). Mods are soft about each other: without `wb-diff` the Changes and Git panels show a toast or open the commit on the web; without `wb-ai` the AI models entry is hidden and the Claude CLI is the default; without `wb-branch-picker` the branch chip is not clickable.

Keep the shared helpers identical after editing: `scripts/sync-helpers.sh` reports differing copies of `section.js` (canonical in `wb-spaces`), `ai.js` (`wb-ai`) and `secrets.js` (`wb-tasks`); `--write` copies them over.

## Programs the mods run

- `git`: Changes, Git, Diff, Files, Tabs, Spaces, Branch picker, Tasks and PR (origin lookup).
- `gh`: PR panel (list, approve, comment, view, diff).
- `claude`, `codex`: AI models for commit messages and PR reviews (the command is configurable in the AI models window).
- `security`: Keychain access for tokens (macOS).
- `open`: opens links in the browser (macOS).
- `sh`, `rm`, `powershell` (Files on Windows): listing folders and removing a temporary file on the target machine.

## Network

- GitHub, through `gh`.
- GitLab REST API (`https://<host>/api/v4`), host taken from the repo's origin.
- Jira Cloud REST and Agile API on your site.
- Trello REST API.
- A local OpenAI-compatible server (default `http://localhost:11434/v1`, `/models` and `/chat/completions`), only if you configure a local AI model.
- Terminal and git traffic use your own remotes and ssh machines.

## Tokens

Saved only in the macOS Keychain through `security`, as generic passwords: service `herdr-jira`, `herdr-trello` or `herdr-gitlab`. Mod state (`shared.json`) holds accounts without secrets. On other systems the token forms explain that saving is not supported yet. A token is visible in `ps` on the local machine for the instant `security` runs.

## What's here

- `mods/` — our user-owned mods and clones (older notes below use pre-rename names: `tabs-copy` is now `wb-tabs`, `changes-copy` `wb-changes`, `diff-view` `wb-diff`, `jira` `wb-tasks`, `prs` `wb-prs`, `git-log` `wb-git`, `commit-gen` `wb-ai`, and so on):
  - `changes-copy` — Changes panel: file list/tree, PhpStorm-style workflow (file click opens the diff in the main space), commit textarea with drag-resize splitter, commit-message generation (Claude CLI or any OpenAI-compatible local model, model dropdown, inline settings block)
  - `diff-view` — side-by-side diff tab (old/new columns, per-side horizontal scroll, prev/next change navigation, `diff`/`file` whole-file modes)
  - `branch-picker` — branch dropdown anchored under the header chip (filter, grouped tree, recents, plain `git checkout`)
  - `remote-projects` — sidebar section of remote repos with show/hide toggle and a folder-picker dialog
  - `folder-picker` — "Choose a folder" dialog that browses the target machine
  - `tabs-copy` — header: space tabs, branch chip, Files/Changes/Projects toggles
  - plus other `*-copy` clones of shipped mods we customized
- `layouts/` — layouts (`workbench` is the packaged one, `remote` its predecessor)
- `themes/` — custom gruvbox themes
- `remote-projects.json`, `shared.json` — project list and shared mod state
- `HERDR-TASKS.md` — changelog of features requested/built (UA)

## Not tracked (on purpose)

Runtime state (`data/`, `telemetry/`, `seen/view/window.json`, socket), vendor files the app ships and restores (`AGENTS.md`, `*.d.ts`, `frame/`, `icons/`, `installed.json`), and machine-local `keys.json` / `settings.json`. No credentials live in this directory.

## Workflow

Edits happen in the live directory; `git add -A && git commit && git push` saves them. When Herdr updates shipped mods, the diff shows up here — commit to accept ("pull the new ones").