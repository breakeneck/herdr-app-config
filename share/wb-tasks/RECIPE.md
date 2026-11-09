# wb-tasks

A Tasks panel. For each project (the repository, found from its `origin`) you choose a source: a Jira board or a Trello board. Cards appear grouped by the board's columns and can be dragged between them.

Credit: derived from the Jira mod in https://github.com/gandriyko/herdr-app-config. That repository has no license file; this recipe carries the credit and makes no claim about reuse terms.

No preview image is published: the panel's account picker and lists show personal accounts and task titles.

## What you see

- Header: source chip (icon and account, a dropdown), minimize, refresh. Under it the project name.
- Jira: issues assigned to you grouped by board columns in board order, rank order inside, plus the backlog. A coloured dot shows status.
- Trello: the board's lists as columns, All / Mine, a chip with the board name.
- Without a connection: "Connect..." with saved accounts, "Add Jira account", "Add Trello account", "Not connected".
- Click an issue or card: a dialog (same mod, `props.issue`) with status, people, labels, description and comments (Jira's ADF rendered as markdown; Trello checklists). Right-click: Go to Jira / Open in Trello, Copy link, Copy key / `#id`.

## How it behaves

- Drag a Jira issue onto another column: a Jira transition into that column's status; if the workflow forbids it, a message explains. Trello: `PUT /cards/{id}` with the target list.
- Several Jira and Trello accounts; the same site and email (or the same Trello user) updates the existing account. Each project remembers its source and board.
- Lists are cached in `localStorage` and shown at once on switching project, refreshed in the background when older than 30 seconds.
- On systems without the macOS Keychain the token forms show an explanation instead of fields.

## Built from

- `mods/wb-tasks/`: `main.js`, `trello.js`, `secrets.js`, `section.js`, icons (`jira.svg`, `trello.svg`, `refresh.svg`, `settings.svg`).
- State: shared `wb.tasks.accounts` (no secrets: Jira `{ id: "<host>|<email>", site, email, base, project }`, Trello `{ id, name, username }`) and `wb.tasks.sources` (per repo `{ kind, account, board }`). Layout keys `wb.layout.*`, `wb.sections.collapsed`.
- Tokens: macOS Keychain via `security` (services `herdr-jira`, `herdr-trello`; account is the account id; Trello stores `key:token`). `secrets.js` is the canonical copy for `secrets.js` in `wb-prs`; `scripts/sync-helpers.sh --write` syncs helpers.
- Network: Jira Cloud REST and Agile API (`/rest/api`, `/rest/agile/1.0`, plus the site's `_edge/tenant_info`), Trello REST API, via `fetch`. Programs: `git` (origin), `security`, `open`.
- Jira uses an API token, not OAuth. Token page and Trello Power-Up admin open in the browser.

## Watch out

- Tokens: macOS Keychain only. A token is visible in `ps` on the local machine for the moment `security` runs.
- `exec("open")` (links, token pages) is macOS only.
- The project is derived from `git remote get-url origin`; a folder without origin shows no project.
- Needs network access to your Jira site or Trello.

## Done when

- `herdr-app check mods/wb-tasks` passes.
- In an empty `mods/` with only `wb-tasks` (and its own files), the panel shows "Connect..." without errors.
- After adding an account, cards appear in board columns; dragging a card changes its column.
