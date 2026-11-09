# Packaging: моди ізольовані й готові до шерінгу

Бриф для нової сесії. Мета: щоб наш набір модів можна було віддати іншим людям через
herdr.dev (див. розділ «Layouts and mods other people made» в `AGENTS.md`). Потрібні **один
пакет-лейаут** з усім разом і **кілька окремих модів**, які працюють у будь-якому лейауті.
Історія того, що й навіщо робилось, — у `HERDR-TASKS.md`.

## Як працювати

- **Моделі** (див. `~/.claude/CLAUDE.md`): основний потік на Sonnet (`/model sonnet`).
  - Haiku — пошук і аудит.
  - Sonnet — механічні правки, перейменування, `RECIPE.md`.
  - Opus — тільки кроки, позначені **[Opus]**, і одна фінальна перевірка всього диф.
- **Коміти:** після кожного кроку — коміт і push у `origin main`. Повідомлення англійською, із
  трейлером `Co-Authored-By`. `RECIPE.md`, README і текст у модах теж англійською.
- **Приватне не потрапляє в репо:** ніяких назв компаній, хостів, email, id спейсів чи
  дощок. `shared.json`, `remote-projects.json`, `keys.json`, `settings.json` у `.gitignore` —
  так і лишається.
- **Після кожної зміни:** `herdr-app check mods/<name>`, потім `herdr-app status` (у `errors`
  має бути `[]`). Якщо змінювався вигляд — `herdr-app shot <file>.png` і подивитись.
- **Новий мод:** спершу `mod.json` з `"place": "none"`, потім `main.js`. Якщо Herdr побачить
  папку без `mod.json`, він сам пристикує мод у лейаут. Саме так з'являлись «примари»
  `commit-settings` і `commit-gen`.
- **Не редагувати:** вбудовані моди Herdr (`spaces`, `agents`, `files`, `tabs`, `changes`,
  `pane`, `menu`, `workspace-chrome`…), `AGENTS.md`, `*.d.ts`, `layouts/.state/*`.

## Що є зараз

Лейаут `layouts/remote.json`. Ліворуч сайдбар: `spaces-copy`, `remote-projects`, `agents-copy`.
Зверху хедер `tabs-copy`. Права панель — стек `panel-body` з блоками:
- `files` (`files-copy`);
- `changes` (`changes-copy`);
- `jira` (мод `jira`: Tasks — Jira + Trello);
- `prs` (`prs`);
- `git` (`git-log`).

Ще є: `diff-view` (таб діфу), `commit-gen` (вікно AI models), `folder-picker`, `branch-picker`.

| Мод | Що робить |
|---|---|
| `tabs-copy` | хедер: таби, чип гілки, кнопки панелей (`PANELS`), Edit layout |
| `spaces-copy`, `agents-copy`, `files-copy` | клони вбудованих + згортання/перетягування (`section.js`); Files фарбується в колір проєкту |
| `changes-copy` | змінені файли, коміт, генерація коміт-меседжу (`ai.js`) |
| `diff-view` | side-by-side діф у головній області (робоче дерево або один коміт) |
| `commit-gen` | вікно AI models: моделі (`ai.js`), вибір для commit/review, шаблон коміту |
| `prs` | PR/MR: GitHub (`gh`) і GitLab (API + токен), апруви, меню, попап, AI review |
| `jira` (+ `trello.js`) | Tasks: акаунти Jira/Trello для кожного проєкту, колонки дошки, перетягування, попапи |
| `git-log` | лог комітів, fetch/pull/push, діф коміту |
| `remote-projects`, `folder-picker` | збережені проєкти на ssh-машинах, вибір папки |
| `branch-picker` | дропдаун гілок із хедера |

## Що заважає шерінгу (аудит)

Перевірити ще раз (Haiku) — команди наприкінці файлу.

1. **Чужі іконки.** Посилання на `mods/<інший мод>/…svg`:
   - на **наші** моди — найнебезпечніше, бо в чужому конфігу їх нема:
     - `commit-gen` → `remote-projects/x.svg`;
     - `folder-picker` → `remote-projects/folder.svg`, `x.svg`;
     - `diff-view` → `changes-copy/icons/diff.svg`;
     - `tabs-copy` → `jira/jira.svg`, `prs/pr.svg`;
   - на вбудовані: `workspace-chrome/*` (spinner, chevron-down/right, settings, layers,
     git-branch, square-pen, folder-plus, plus, branch, check, folder), `pane/close.svg`,
     `changes/changes.svg`, `files/file.svg`. Вони є в кожного, але можуть змінитись з
     версією Herdr.
2. **Моди відкривають інші моди:**
   - `changes-copy` → `commit-gen`, `diff-view`;
   - `git-log` → `diff-view`;
   - `prs` → `commit-gen`;
   - `remote-projects` → `folder-picker`;
   - `tabs-copy` → `branch-picker` і вбудовані `menu`, `new-menu`.
3. **Прив'язка до id лейауту.**
   - `tabs-copy` шукає вузли `panel` і `panel-body`.
   - `section.js` тримає захищені id: `root`, `sidebar`, `sidebar-lists`, `work`, `work-body`.
   - Тому кнопки панелей і Edit layout працюють тільки в нашому лейауті.
4. **Загальні імена.**
   - Моди: `changes-copy`, `tabs-copy`, `files-copy`, `spaces-copy`, `agents-copy`.
   - Ключі shared-стану: `layout.drag`, `layout.edit`, `sections.collapsed`, `diff.request`,
     `branch.switched`, `folder.pick`, `prs.changed`, `commit.gen`, `ai.models`, `ai.use`,
     `ai.reviewDrafts`, `ai.localMigrated`, `tasks.accounts`, `tasks.sources`, `space.colors`
     (його пише `spaces-copy`, читає `files-copy`).
5. **Тільки macOS.** Токени живуть у Keychain через `security`: `jira/main.js`,
   `jira/trello.js`, `prs/main.js` (сервіси `herdr-jira`, `herdr-trello`, `herdr-gitlab`).
6. **Дублікати й сміття.**
   - `section.js` лежить у 8 модах, `ai.js` — у 3 (`commit-gen`, `changes-copy`, `prs`).
     Зараз копії однакові.
   - `mods/commit-settings` (заглушка) і `mods/changes-copy/highlight.js` більше не
     використовуються.
7. **Клони вбудованих модів** (`*-copy`) не оновлюються з Herdr. Їхні `mod.json` мають
   `cloned_from`, і це треба згадати в `RECIPE.md`.

## Цільова структура

- **Префікс `wb-`** (workbench) для всіх наших модів. Перейменування:
  - `tabs-copy` → `wb-tabs`
  - `spaces-copy` → `wb-spaces`
  - `agents-copy` → `wb-agents`
  - `files-copy` → `wb-files`
  - `changes-copy` → `wb-changes`
  - `commit-gen` → `wb-ai`
  - `diff-view` → `wb-diff`
  - `prs` → `wb-prs`
  - `jira` → `wb-tasks`
  - `git-log` → `wb-git`
  - `remote-projects` → `wb-projects`
  - `folder-picker` → `wb-folder-picker`
  - `branch-picker` → `wb-branch-picker`
- **Пакет-лейаут `workbench`:** `layouts/workbench.json` (з `remote.json`) і всі `wb-*`.
  Знайти на herdr.dev за топіком `herdr-layout`.
- **Окремі моди** (працюють у будь-якому лейауті, топік `herdr-mod`): `wb-tasks`, `wb-prs`,
  `wb-git`, `wb-diff`. Кожен самодостатній: свої іконки, а якщо потрібного мода нема —
  поводиться розумно.
- **Ключі shared-стану** з префіксом `wb.` (`wb.layout.drag`, `wb.ai.models`…). Одноразова
  міграція в коді: якщо нового ключа нема, а старий є — скопіювати. Інакше в мене пропадуть
  акаунти, моделі й прив'язки проєктів.
- **localStorage** мода живе в `data/<mod>/store.json`. Після перейменування папки він
  загубиться. Або один раз скопіювати `data/<old>/` → `data/<new>/`, або змиритися з втратою:
  там лише кеші й дрібні налаштування.

## Кроки

1. **[Haiku] Аудит.** Прогнати команди нижче й звірити з розділом «Аудит». Записати різницю,
   якщо вона є.
2. **[Sonnet] Прибирання.** Перевірити `grep`-ом і видалити `mods/commit-settings` та
   `mods/changes-copy/highlight.js`.
3. **[Sonnet] Свої іконки.** Кожен наш мод тримає копії svg, які використовує, у своїй папці
   (`mods/<mod>/icons/`), і посилається тільки на них. Вбудовані теж скопіювати, щоб не
   залежати від версії Herdr.
4. **[Sonnet] Скрипт синхронізації** `scripts/sync-helpers.sh`: копіює `section.js` з
   `wb-spaces` і `ai.js` з `wb-ai` у всі моди, які їх використовують, і показує розбіжності.
   Згадати його в коментарях-шапках обох файлів.
5. **[Sonnet] Перейменування і префікси:**
   - нові папки за таблицею (спершу `mod.json`!);
   - замінити імена в `openOverlay({ mod })`, `S.sectionOf("…")`, шляхах `mods/<name>/…`,
     `layouts/*.json` (`content.mod`), `tabs-copy` `PANELS`;
   - ключі shared-стану з `wb.` і міграцією;
   - `data/<old>` → `data/<new>`;
   - `remote.json` → копія `workbench.json`; `remote.json` лишити працювати, поки не
     переконаємось, що все гаразд.

   Перевірити кожен мод і зробити скріни.
6. **[Opus] Відв'язка від id лейауту.**
   - `wb-tabs` знаходить стек правої панелі не за id `panel-body`, а як стек, у якому лежать
     блоки з модами з `PANELS`. Кнопки — тільки для модів, які там є.
   - `section.js` визначає захищені контейнери з дерева (корінь, предки блоку
     `{ "tab": "active" }`, колонки сайдбару), а не зі списку id.
   - Edit layout має працювати в будь-якому лейауті, де стоять `wb-*` блоки.
7. **[Sonnet] М'які залежності.** Якщо `wb-diff` не встановлений, `wb-changes` і `wb-git`
   показують тост або відкривають файл / коміт у браузері. Якщо нема `wb-ai`, пункт «AI
   models…» ховається, а генерація й AI review беруть дефолт (Claude CLI).
8. **[Opus] Сховище токенів.** Один модуль `secrets.js` (копія в `wb-tasks` і `wb-prs`):
   - на macOS — Keychain, як зараз;
   - деінде — або «не підтримується» з поясненням (v1), або файл у
     `~/.config/herdr-app/data/<mod>/secrets.json` з `chmod 600` і чесним попередженням.

   Вибір — за людиною (див. «Відкриті питання»).
9. **[Sonnet] Документація:**
   - `RECIPE.md` для пакета `workbench` і для кожного окремого мода, у форматі з `AGENTS.md`:
     What you see / How it behaves / Built from / Watch out / Done when;
   - `preview.png` через `herdr-app shot`;
   - README репо: як поставити пакет і окремі моди, що вони запускають (`gh`, `git`,
     `claude`, `codex`), куди ходять у мережу (GitHub/GitLab/Jira/Trello API) і де лежать
     токени.
10. **[Opus] Фінальна перевірка** всього диф від початку пакування:
    - приватні дані;
    - зламані посилання на моди та іконки;
    - міграція стану;
    - `check` усіх модів;
    - скріни лейауту.

## Готово, коли

- `grep -rn 'mods/[a-z-]*/' mods/wb-*/*.js` знаходить тільки власні шляхи кожного мода, або
  явно задокументовані вбудовані.
- Окремий мод, скопійований у чистий `~/.config/herdr-app/mods/`, проходить `herdr-app check`
  і показує себе без помилок.
- `layout.switch {name: "workbench"}` показує все як зараз у `remote`: акаунти, моделі,
  прив'язки проєктів на місці, Edit layout і згортання працюють.
- `git grep -i` за назвами компаній, хостами й email нічого не знаходить.
- Кожен пакет має `RECIPE.md` і `preview.png`, а README описує мережу, програми й токени.

## Відкриті питання (до людини)

- Токени поза macOS: v1 тільки macOS, чи файл із попередженням?
- Чи класти клони вбудованих модів (`wb-spaces`, `wb-agents`, `wb-files`, `wb-tabs`,
  `wb-changes`) у пакет, чи пакет спирається на вбудовані, а наші зміни йдуть окремими
  модами?
- Назва пакета: `workbench` чи інша.

## Команди аудиту

```bash
cd ~/.config/herdr-app/mods
bash -c '
OURS="agents-copy branch-picker changes-copy commit-gen diff-view files-copy folder-picker git-log jira prs remote-projects spaces-copy tabs-copy"
echo "== foreign assets"; for m in $OURS; do grep -ho "mods/[a-z0-9-]*/[a-zA-Z0-9/_.-]*\.svg" $m/*.js | sort -u | grep -v "^mods/$m/" | sed "s#^#$m -> #"; done
echo "== opens other mods"; for m in $OURS; do grep -ho "mod: \"[a-z0-9-]*\"" $m/*.js | sort -u | grep -v "\"$m\"" | sed "s#^#$m -> #"; done
echo "== shared keys"; for m in $OURS; do grep -ho "[sS]hared(\"[a-zA-Z.]*\"" $m/*.js; done | sed "s/.*(//" | sort | uniq -c | sort -rn
echo "== layout ids"; grep -n "\"panel-body\"\|\"panel\"\|KEEP" tabs-copy/main.js spaces-copy/section.js
echo "== macOS-only"; grep -l "\"security\"" */*.js
echo "== helper copies"; md5 -q */section.js | sort | uniq -c; md5 -q */ai.js | sort | uniq -c'
```
