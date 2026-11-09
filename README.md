# Herdr app config

My [Herdr](https://herdr.dev/app) layout (`my-layout`), the `changes-copy` mod and themes.

## Install

1. Run Herdr once (it creates `~/.config/herdr-app` and its shipped mods).
2. Put this repo there:

   ```sh
   cd ~/.config/herdr-app
   git init -b main
   git remote add origin https://github.com/gandriyko/herdr-app-config.git
   git fetch origin && git checkout -f main
   ```

3. Enable the layout (it loads `changes-copy`): `ctrl-shift-l`, or

   ```sh
   herdr-app do layout.switch --name my-layout
   ```

Nothing is needed in `settings.json`: mods are connected by the layout, not by settings.
