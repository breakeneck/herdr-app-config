# wb-prs

A pull request panel for the active space's repository. GitHub repositories use the `gh` CLI; any other host is treated as GitLab and uses the merge request REST API with a personal token. It can draft an AI review of a PR.

Credit: derived from the prs mod in https://github.com/gandriyko/herdr-app-config. That repository has no license file; this recipe carries the credit and makes no claim about reuse terms.

No preview image is published: the header shows the repository owner and, for real projects, PR titles and authors.

## What you see

- Header: "Pull requests", count, repository chip, All / Mine switch, an Auto checkbox (poll every minute), refresh.
- Rows: title, author (in All mode), approvals (check and count, filled when you approved), pipeline dot, merge status label for GitLab (ready, review, threads, conflict...).
- Click: popup with description, comments, reviews and approvers, plus an AI review button with a model dropdown.
- Right-click: Open in browser, Copy link, Approve / Remove approval.

## How it behaves

- Switching space (or `cd` in a terminal, checked every 2 s) shows that repo's cached list at once and refreshes only that repo when the cache is older than 30 s.
- GitHub: approve with `gh pr review --approve`; comments with `gh pr comment`. GitLab: approve and remove approval and notes through the API (token scope `api`; reading needs `read_api`).
- AI review appears as an editable draft (shared `wb.ai.reviewDrafts`, by PR url): Post as comment, Regenerate or Discard.
- Without `wb-ai`, the model settings entry is hidden and Claude CLI is the default model.
- Without the GitLab token the panel shows a token form with a link to the token page; on systems other than macOS it shows an explanation instead.

## Built from

- `mods/wb-prs/`: `main.js`, `ai.js`, `secrets.js`, `section.js`, icons. Optional partner: `wb-ai` (model list window).
- Programs: `gh`, `git`, `claude`, `codex` (through `ai.js`), `security`, `open`, `rm`. Network: GitHub through `gh`; `https://<host>/api/v4` for GitLab; an optional local OpenAI-compatible server (`/models`, `/chat/completions`) for AI models.
- Token: Keychain service `herdr-gitlab`, account is the host.
- State: `localStorage` (`cache:all`, `cache:mine`, `remotes`, `mine`, `auto`); shared `wb.prs.changed`, `wb.ai.models`, `wb.ai.use`, `wb.ai.reviewDrafts`, `wb.commit.gen`, `wb.layout.*`, `wb.sections.collapsed`.
- `ai.js`, `secrets.js` and `section.js` are synced copies (`scripts/sync-helpers.sh`).

## Watch out

- Tokens: macOS Keychain only. `exec("open")` is macOS only.
- Needs `gh` logged in for GitHub. GitLab hosts behind some CDNs reject unusual user agents; `fetch` from the mod works.
- AI review sends the PR diff to the chosen model.
- GitHub supports approve only (no remove) through `gh`.

## Done when

- `herdr-app check mods/wb-prs` passes.
- On a GitHub repo with `gh` authenticated the list loads; on a GitLab repo a token form appears, and after saving a token merge requests load.
- Right-click Approve toggles the approval mark.
