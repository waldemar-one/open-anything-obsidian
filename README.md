# Open Anything

I needed a way to launch a Claude Code terminal with a single keystroke, without leaving Obsidian. Once it worked, an obvious question arose: why limit yourself to a single command to launch Claude Code?

So, it's no longer just a Claude Code launcher; it's a launcher, full stop. Terminal commands, apps, websites — anything you can access with a single keystroke.

## Install

1. Grab `main.js` and `manifest.json` (or the whole source zip) and drop them into `<your vault>/.obsidian/plugins/open-anything/`.
2. Settings → Community plugins, Restricted mode off.
3. Turn on "Open Anything" in Installed plugins.

## What it does

There are currently three launcher types, pick whichever fits:

- **Terminal** runs a shell command in an interactive terminal window. The default launcher that ships out of the box is just `claude` (you can delete this if you wish).
- **App** launches a GUI application directly. No terminal window involved. Desktop only.
- **Website** opens a URL in your default browser. This one works on mobile too.

Add as many launchers as you want with the "+ terminal" / "+ app" / "+ website" buttons in settings. Each one becomes its own command, `Open: <name>`, searchable in Ctrl/Cmd+P and bindable to a hotkey under Settings → Hotkeys. I didn't set any default hotkeys: with an arbitrary number of launchers there's no sane default to guess for you, so it's yours to assign.

## Mobile

The plugin loads on mobile, it's not desktop-only. Website launchers genuinely work there. Terminal and App launchers obviously need a real OS process, which mobile doesn't have, so on mobile they just say so with a notice instead of pretending to work or crashing anything.

## Settings

Terminal and App launchers share one block of settings, kept separate from the per-launcher rows so each row stays a simple name/type/target line:

- working directory: vault root, or the folder of whatever file is currently open
- terminal choice per OS (macOS app name, Windows Terminal/cmd/PowerShell, GNOME Terminal/Konsole/system default on Linux)
- a custom launch template for anything that doesn't fit the above (kitty, alacritty, whatever), using `{cwd}` and `{cmd}` placeholders

## Why an external terminal, not an embedded one

A real embedded interactive terminal needs node-pty, a native module that has to be rebuilt against whatever Electron ABI Obsidian currently ships, and that breaks on every Obsidian update. Spawning the system terminal instead is predictable and needs zero compilation on your end. On macOS it goes through a temporary `.command` script opened via `open -a`, which sidesteps the Automation permission prompt an AppleScript approach would trigger.

## Support for other third-party plugins

Since this plugin works simply by adding commands, it shouldn't conflict with any other plugins.

## Source

`src/main.ts` and the build config are in the repo if you want to dig in or extend it. `npm install`, then `npm run build` to rebuild, `npm run lint` to run the same Obsidian-flavored ESLint checks the review process uses.

## Roadmap

- [x] Three launcher types: terminal, app, website
- [x] One command and one hotkey per launcher
- [x] Mobile support that fails gracefully instead of crashing
- [x] Per-OS terminal picker for macOS, Windows, and Linux
- [x] Custom launch template override
- [x] Automated release pipeline with build provenance attestation
- [ ] Drag-to-reorder launchers
- [ ] Four launcher types: terminal, app, website, _scripts_
- [ ] Launch optimization: less delay between hotkey and the terminal actually opening, skip recreating the macOS .command script on every launch, cache the working-directory resolution instead of recomputing it each time
- [ ] Plugin startup optimization: faster onload, lighter footprint when Obsidian loads the plugin
- [ ] Specifying the work folder for `terminal` and `app` (optional)
- [ ] Icon picker per launcher
- [ ] Adding a command with an icon to the sidebar