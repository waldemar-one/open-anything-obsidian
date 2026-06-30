# Open Anything

An Obsidian plugin that launches terminal commands, applications, or websites. Every launcher you add gets its own command, so you can bind it to its own hotkey.

## Install

1. Copy `main.js` and `manifest.json` into `<your vault>/.obsidian/plugins/open-anything/` (or unzip the source package there).
2. If you still have the old `open-claude-code` folder, delete it. This one replaces it.
3. In Obsidian: Settings → Community plugins, make sure Restricted mode is off.
4. Enable "Open Anything" in the Installed plugins list.

## Usage

Open Settings → Open Anything. There are three launcher types:

- **Terminal**: runs a shell command in an interactive terminal window (this is what Claude Code uses: just `claude`).
- **App**: launches a GUI application directly, no terminal window. Desktop only.
- **Website**: opens a URL in your default browser. Works on desktop and mobile.

Add as many as you want with the "+ Terminal" / "+ App" / "+ Website" buttons. Each one gets a command named `Open: <name>`, searchable in the command palette (Ctrl/Cmd+P) and bindable to a hotkey under Settings → Hotkeys. No default hotkeys are set. With an arbitrary number of launchers there's no sane default to guess, so pick whatever fits you.

There's no ribbon icon by design. Everything goes through commands.

## Mobile

The plugin loads on mobile. Website launchers work there too. Terminal and App launchers need a real OS process, so on mobile they just show a notice instead of doing anything. They don't crash the plugin or Obsidian.

## Settings

"Terminal and app settings" applies to every Terminal/App launcher at once (not per-launcher, to keep each row simple):

- working directory: vault root, or the folder of whatever file is currently open
- which terminal to use per OS (macOS: app name, Windows: Windows Terminal/cmd/PowerShell, Linux: GNOME Terminal/Konsole/system default)
- a custom launch template for Terminal launchers if none of the above fits (kitty, alacritty, etc.), with `{cwd}` and `{cmd}` placeholders

## Why an external terminal, not an embedded one

A truly embedded interactive terminal needs node-pty, a native module that has to be rebuilt against the exact Electron ABI Obsidian ships, and that breaks on Obsidian updates. Spawning the system terminal is far more predictable and needs no compilation on your end. On macOS this goes through a temporary `.command` script opened via `open -a`, which avoids the Automation permission prompt that an AppleScript-based approach would trigger.

## Source

The TypeScript source (`src/main.ts`) and build config are included if you want to extend it. To rebuild: `npm install`, then `npm run build`.
