# Herdr app config

Моя конфігурація десктопного застосунку [Herdr](https://herdr.dev/app): layout, клавіші, налаштування, теми та власний мод.
Herdr перемальовує вікно з цих файлів на льоту, тому після встановлення зміни видно за секунду.

## Що всередині

| Файл / папка | Що це |
|---|---|
| `layouts/my-layout.json` | мій layout (клон шипованого `main`), у ньому панель Changes — це `changes-copy` |
| `mods/changes-copy/` | мод Changes: списки List/Tree, режими Diff/File, підсвітка змінених рядків |
| `keys.json` | прив'язки клавіш (`global` і `terminal`) |
| `settings.json` | шрифт, звуки, зум, телеметрія вимкнена |
| `themes/` | `gruvbox-dark`, `gruvbox-light` |

У git потрапляє тільки це (див. `.gitignore`). Шиповані моди та layouts (`main`, `terminals`, `win98`, `agents`, `spaces`, `tabs` тощо), стан вікна (`view.json`, `window.json`, `shared.json`, `data/`) і файли `*.d.ts` Herdr створює і оновлює сам, їх у репозиторії немає.

## Куди ставити

У домашню папку Herdr-app:

```
~/.config/herdr-app
```

На macOS це саме вона. Якщо Herdr запускається з іншою папкою, її задає змінна `HERDR_APP_HOME`.

## Як встановити

1. Встановіть Herdr і **один раз запустіть його**. Він створить папку й запише шиповані моди та layouts, від яких залежить `my-layout` (`workspace-chrome`, `spaces`, `agents`, `tabs`, `pane`, `files`, `workspace-status`).
2. Покладіть конфіг у папку. Якщо там уже є ваші `keys.json` чи `settings.json`, зробіть їм копію: команда нижче їх перезапише.

   ```sh
   cd ~/.config/herdr-app
   git init -b main
   git remote add origin https://github.com/gandriyko/herdr-app-config.git
   git fetch origin
   git checkout -f main
   ```

   Файли, яких немає в репозиторії (стан, шиповані моди), `git checkout -f` не чіпає.

   Інший варіант без `git init` у цій папці:

   ```sh
   git clone https://github.com/gandriyko/herdr-app-config.git /tmp/herdr-app-config
   rsync -a --exclude .git /tmp/herdr-app-config/ ~/.config/herdr-app/
   ```

3. Увімкніть layout: `ctrl-shift-l` (`layout.switch`) або

   ```sh
   herdr-app do layout.switch --name my-layout
   ```

4. Перевірте:

   ```sh
   herdr-app status                              # "errors": []
   herdr-app check ~/.config/herdr-app/mods/changes-copy
   ```

Перезапуск не потрібен, зміни застосовуються наживо. Якщо щось зламалося, `ctrl-alt-shift-escape` повертає стандартний layout `main` і відкладає `keys.json` убік (`*.reset-<час>`).

## Оновлення Herdr

Клони (`my-layout`, `changes-copy`) не оновлюються самі: у `cloned_from` записана версія, з якої їх зроблено. Після оновлення Herdr порівняйте їх із шипованими `main` і `changes` і перенесіть потрібне вручну.

## Додати свою зміну

Правте файли в цій папці та комітьте. Нові файли треба додати у білий список `.gitignore` (там усе ігнорується за замовчуванням, `*`). Щоб змінити шипований layout чи мод, спочатку клонуйте його (`layout.clone`, `mod.clone`), шипованих файлів не редагуйте: Herdr перезапише їх при запуску.
