# herdr-app config (live)

The whole [herdr](https://github.com/herdr-app) UI as files — this repo IS the live config directory (`~/.config/herdr-app`), so every change here is instantly the running app, and `git push` backs it up.

Fork of [gandriyko/herdr-app-config](https://github.com/gandriyko/herdr-app-config).

## What's here

- `mods/` — our user-owned mods and clones:
  - `changes-copy` — Changes panel: file list/tree, PhpStorm-style workflow (file click opens the diff in the main space), commit textarea with drag-resize splitter, commit-message generation (Claude CLI or any OpenAI-compatible local model, model dropdown, inline settings block)
  - `diff-view` — side-by-side diff tab (old/new columns, per-side horizontal scroll, prev/next change navigation, `diff`/`file` whole-file modes)
  - `branch-picker` — branch dropdown anchored under the header chip (filter, grouped tree, recents, plain `git checkout`)
  - `remote-projects` — sidebar section of remote repos with show/hide toggle and a folder-picker dialog
  - `folder-picker` — "Choose a folder" dialog that browses the target machine
  - `tabs-copy` — header: space tabs, branch chip, Files/Changes/Projects toggles
  - plus other `*-copy` clones of shipped mods we customized
- `layouts/` — layouts (`remote` is the active one)
- `themes/` — custom gruvbox themes
- `remote-projects.json`, `shared.json` — project list and shared mod state
- `HERDR-TASKS.md` — changelog of features requested/built (UA)

## Not tracked (on purpose)

Runtime state (`data/`, `telemetry/`, `seen/view/window.json`, socket), vendor files the app ships and restores (`AGENTS.md`, `*.d.ts`, `frame/`, `icons/`, `installed.json`), and machine-local `keys.json` / `settings.json`. No credentials live in this directory.

## Workflow

Edits happen in the live directory; `git add -A && git commit && git push` saves them. When Herdr updates shipped mods, the diff shows up here — commit to accept ("pull the new ones").