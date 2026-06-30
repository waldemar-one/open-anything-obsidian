import {
	App,
	FileSystemAdapter,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

type LauncherType = "terminal" | "app" | "url";
type WorkingDirMode = "vault" | "active-file";
type WinTerminal = "wt" | "cmd" | "powershell";
type LinuxTerminal = "gnome-terminal" | "konsole" | "x-terminal-emulator";

interface Launcher {
	/** Stable id, generated once. Used to build the command id, so it must never change. */
	id: string;
	name: string;
	type: LauncherType;
	/** Shell command (terminal), binary name or path (app), or URL (url). */
	target: string;
}

interface OpenAnythingSettings {
	launchers: Launcher[];
	/** Applies to "terminal" and "app" launchers. Irrelevant for "url". */
	workingDirMode: WorkingDirMode;
	macTerminalApp: string;
	winTerminalApp: WinTerminal;
	linuxTerminal: LinuxTerminal;
	/**
	 * Optional override for "terminal" launchers on any OS. If set, it replaces
	 * all the platform-specific logic below. Placeholders: {cwd} and {cmd}.
	 * Example for kitty: kitty --directory {cwd} {cmd}
	 */
	customLaunchTemplate: string;
}

const DEFAULT_SETTINGS: OpenAnythingSettings = {
	launchers: [
		{
			id: "claude-code",
			name: "Claude Code",
			type: "terminal",
			target: "claude",
		},
	],
	workingDirMode: "vault",
	macTerminalApp: "Terminal",
	winTerminalApp: "wt",
	linuxTerminal: "gnome-terminal",
	customLaunchTemplate: "",
};

export default class OpenAnythingPlugin extends Plugin {
	settings: OpenAnythingSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		for (const launcher of this.settings.launchers) {
			this.registerLauncherCommand(launcher);
		}

		this.addSettingTab(new OpenAnythingSettingTab(this.app, this));
	}

	// ---------- Launcher CRUD ----------

	addLauncher(type: LauncherType): Launcher {
		const launcher: Launcher = {
			id: `launcher-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			name: type === "url" ? "New website" : type === "app" ? "New app" : "New terminal command",
			type,
			target: "",
		};
		this.settings.launchers.push(launcher);
		this.saveSettings();
		this.registerLauncherCommand(launcher);
		return launcher;
	}

	removeLauncher(id: string): void {
		const index = this.settings.launchers.findIndex((l) => l.id === id);
		if (index === -1) return;
		this.settings.launchers.splice(index, 1);
		this.saveSettings();
		this.removeCommand(`${this.manifest.id}:run-${id}`);
	}

	/** Re-registers a launcher's command, used both for the initial setup and to refresh its name in the palette. */
	registerLauncherCommand(launcher: Launcher): void {
		this.addCommand({
			id: `run-${launcher.id}`,
			name: `Open: ${launcher.name || "Untitled"}`,
			callback: () => this.runLauncher(launcher.id),
		});
	}

	// ---------- Running ----------

	runLauncher(id: string): void {
		const launcher = this.settings.launchers.find((l) => l.id === id);
		if (!launcher) {
			new Notice("Open Anything: this launcher no longer exists.");
			return;
		}
		if (!launcher.target.trim()) {
			new Notice(`Open Anything: "${launcher.name}" has no target set yet. Fill it in under Settings.`);
			return;
		}

		try {
			if (launcher.type === "url") {
				this.launchUrl(launcher.target);
				return;
			}

			// "terminal" and "app" both need a real OS process.
			if (!Platform.isDesktopApp) {
				new Notice(`"${launcher.name}" only works on desktop.`);
				return;
			}

			const cwd = this.getWorkingDirectory();
			if (!cwd) {
				new Notice("Open Anything: couldn't resolve the vault path.");
				return;
			}

			if (launcher.type === "terminal") {
				this.launchTerminal(cwd, launcher.target);
			} else {
				this.launchApp(cwd, launcher.target);
			}
			new Notice(`Opening: ${launcher.name}`);
		} catch (err) {
			console.error("Open Anything:", err);
			new Notice("Open Anything: something went wrong, check the developer console (Ctrl+Shift+I).");
		}
	}

	private getWorkingDirectory(): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		const vaultPath = adapter.getBasePath();

		if (this.settings.workingDirMode === "active-file") {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
				// Lazy require: only ever touched on desktop, after the Platform check above.
				const path = require("path") as typeof import("path");
				const fileDir = path.dirname(activeFile.path);
				return fileDir === "." ? vaultPath : path.join(vaultPath, fileDir);
			}
		}
		return vaultPath;
	}

	private notifySpawnError(err: NodeJS.ErrnoException): void {
		console.error("Open Anything: spawn error", err);
		if (err.code === "ENOENT") {
			new Notice(`Open Anything: couldn't find "${err.path ?? "the program"}". Check that it's installed and on PATH, or fix it in the plugin settings.`);
		} else {
			new Notice("Open Anything: couldn't launch that. Check the developer console (Ctrl+Shift+I) for details.");
		}
	}

	// ---------- Type: url (works on desktop AND mobile) ----------

	private launchUrl(target: string): void {
		let url = target.trim();
		if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
			url = "https://" + url;
		}
		window.open(url, "_blank");
	}

	// ---------- Type: app (desktop only, launches the GUI app directly) ----------

	private launchApp(cwd: string, target: string): void {
		const { spawn } = require("child_process") as typeof import("child_process");

		if (Platform.isMacOS) {
			const child = spawn("open", ["-a", target], { detached: true, stdio: "ignore" });
			child.on("error", (err) => this.notifySpawnError(err as NodeJS.ErrnoException));
			child.unref();
			return;
		}

		const child = spawn(target, [], { cwd, detached: true, stdio: "ignore", windowsHide: false });
		child.on("error", (err) => this.notifySpawnError(err as NodeJS.ErrnoException));
		child.unref();
	}

	// ---------- Type: terminal (desktop only, runs a command in an interactive terminal) ----------

	private launchTerminal(cwd: string, command: string): void {
		if (this.settings.customLaunchTemplate.trim()) {
			this.launchCustom(cwd, command, this.settings.customLaunchTemplate);
		} else if (Platform.isMacOS) {
			this.launchMac(cwd, command);
		} else if (Platform.isWin) {
			this.launchWindows(cwd, command);
		} else {
			this.launchLinux(cwd, command);
		}
	}

	// macOS: a temporary .command script opened via `open -a`. This avoids the
	// Automation permission prompt that an AppleScript/osascript approach would need.
	private launchMac(cwd: string, command: string): void {
		const { spawn } = require("child_process") as typeof import("child_process");
		const path = require("path") as typeof import("path");
		const os = require("os") as typeof import("os");
		const fs = require("fs") as typeof import("fs");

		const scriptPath = path.join(os.tmpdir(), `open-anything-${Date.now()}.command`);
		const escapedCwd = cwd.replace(/"/g, '\\"');
		const scriptContent = `#!/bin/bash\ncd "${escapedCwd}"\n${command}\n`;
		fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

		const appName = this.settings.macTerminalApp.trim();
		const args = appName ? ["-a", appName, scriptPath] : [scriptPath];

		const child = spawn("open", args, { detached: true, stdio: "ignore" });
		child.on("error", (err) => this.notifySpawnError(err as NodeJS.ErrnoException));
		child.unref();

		// Best-effort cleanup once the terminal has had time to read the script.
		setTimeout(() => {
			fs.unlink(scriptPath, () => { /* may already be gone, that's fine */ });
		}, 15000);
	}

	private launchWindows(cwd: string, command: string): void {
		const { spawn } = require("child_process") as typeof import("child_process");
		const mode = this.settings.winTerminalApp;

		const spawnCmd = () => {
			const child = spawn("cmd.exe", ["/K", command], {
				cwd,
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.on("error", (err) => this.notifySpawnError(err as NodeJS.ErrnoException));
			child.unref();
		};

		if (mode === "wt") {
			const child = spawn("wt.exe", ["-d", cwd, "cmd", "/k", command], {
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.on("error", (err) => {
				const error = err as NodeJS.ErrnoException;
				if (error.code === "ENOENT") {
					new Notice("Windows Terminal not found, opening cmd.exe instead.");
					spawnCmd();
				} else {
					this.notifySpawnError(error);
				}
			});
			child.unref();
			return;
		}

		if (mode === "powershell") {
			const child = spawn("powershell.exe", ["-NoExit", "-Command", command], {
				cwd,
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.on("error", (err) => this.notifySpawnError(err as NodeJS.ErrnoException));
			child.unref();
			return;
		}

		spawnCmd();
	}

	private launchLinux(cwd: string, command: string): void {
		const { spawn } = require("child_process") as typeof import("child_process");
		const choice = this.settings.linuxTerminal;
		const shellCmd = `${command}; exec bash`;

		let bin: string;
		let args: string[];

		if (choice === "gnome-terminal") {
			bin = "gnome-terminal";
			args = [`--working-directory=${cwd}`, "--", "bash", "-lc", shellCmd];
		} else if (choice === "konsole") {
			bin = "konsole";
			args = ["--workdir", cwd, "-e", "bash", "-lc", shellCmd];
		} else {
			// x-terminal-emulator: the system default alias on Debian/Ubuntu and most derivatives.
			bin = "x-terminal-emulator";
			args = ["-e", "bash", "-lc", shellCmd];
		}

		const child = spawn(bin, args, { cwd, detached: true, stdio: "ignore" });
		child.on("error", (err) => this.notifySpawnError(err as NodeJS.ErrnoException));
		child.unref();
	}

	private launchCustom(cwd: string, command: string, template: string): void {
		const { spawn } = require("child_process") as typeof import("child_process");
		const filled = template.replace(/\{cwd\}/g, cwd).replace(/\{cmd\}/g, command);

		const shellBin = Platform.isWin ? "cmd.exe" : "/bin/sh";
		const shellArgs = Platform.isWin ? ["/c", filled] : ["-c", filled];

		const child = spawn(shellBin, shellArgs, { detached: true, stdio: "ignore", windowsHide: false });
		child.on("error", (err) => this.notifySpawnError(err as NodeJS.ErrnoException));
		child.unref();
	}

	// ---------- Settings persistence ----------

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class OpenAnythingSettingTab extends PluginSettingTab {
	plugin: OpenAnythingPlugin;

	constructor(app: App, plugin: OpenAnythingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Launchers")
			.setDesc("Each row below gets its own command, so you can bind it to a hotkey in the Hotkeys settings.")
			.setHeading();

		const list = containerEl.createDiv();
		this.plugin.settings.launchers.forEach((launcher) => this.renderLauncherRow(list, launcher));

		const addRow = new Setting(containerEl).setName("Add launcher");
		addRow.addButton((button) =>
			button.setButtonText("+ Terminal").onClick(() => {
				this.plugin.addLauncher("terminal");
				this.display();
			})
		);
		addRow.addButton((button) =>
			button.setButtonText("+ App").onClick(() => {
				this.plugin.addLauncher("app");
				this.display();
			})
		);
		addRow.addButton((button) =>
			button.setButtonText("+ Website").onClick(() => {
				this.plugin.addLauncher("url");
				this.display();
			})
		);

		new Setting(containerEl)
			.setName("Terminal and app")
			.setDesc('Applies to every "Terminal" and "App" launcher above. Websites don\'t need any of this.')
			.setHeading();

		new Setting(containerEl)
			.setName("Working directory")
			.setDesc("Where terminal and app launchers start from.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						vault: "Vault root",
						"active-file": "Currently open file's folder",
					})
					.setValue(this.plugin.settings.workingDirMode)
					.onChange(async (value) => {
						this.plugin.settings.workingDirMode = value as WorkingDirMode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("macOS").setHeading();
		new Setting(containerEl)
			.setName("Terminal app")
			.setDesc("As it appears in Spotlight: Terminal, iTerm, Warp, etc.")
			.addText((text) =>
				text
					.setPlaceholder("Terminal")
					.setValue(this.plugin.settings.macTerminalApp)
					.onChange(async (value) => {
						this.plugin.settings.macTerminalApp = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Windows").setHeading();
		new Setting(containerEl)
			.setName("Launch via")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ wt: "Windows Terminal (wt)", cmd: "cmd.exe", powershell: "PowerShell" })
					.setValue(this.plugin.settings.winTerminalApp)
					.onChange(async (value) => {
						this.plugin.settings.winTerminalApp = value as WinTerminal;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Linux").setHeading();
		new Setting(containerEl)
			.setName("Terminal")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"gnome-terminal": "GNOME Terminal",
						konsole: "Konsole",
						"x-terminal-emulator": "System default",
					})
					.setValue(this.plugin.settings.linuxTerminal)
					.onChange(async (value) => {
						this.plugin.settings.linuxTerminal = value as LinuxTerminal;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Custom launch template").setHeading();
		new Setting(containerEl)
			.setName("Override everything above")
			.setDesc("Optional. If set, it replaces all the platform auto-detection for Terminal launchers. Placeholders: {cwd} and {cmd}. Example for kitty: kitty --directory {cwd} {cmd}")
			.addText((text) =>
				text
					.setPlaceholder("kitty --directory {cwd} {cmd}")
					.setValue(this.plugin.settings.customLaunchTemplate)
					.onChange(async (value) => {
						this.plugin.settings.customLaunchTemplate = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderLauncherRow(containerEl: HTMLElement, launcher: Launcher): void {
		const row = new Setting(containerEl);
		row.settingEl.addClass("open-anything-row");

		row.addText((text) => {
			text
				.setPlaceholder("Name")
				.setValue(launcher.name)
				.onChange(async (value) => {
					launcher.name = value;
					await this.plugin.saveSettings();
					this.plugin.registerLauncherCommand(launcher);
				});
			text.inputEl.style.width = "10em";
		});

		row.addDropdown((dropdown) =>
			dropdown
				.addOptions({ terminal: "Terminal", app: "App", url: "Website" })
				.setValue(launcher.type)
				.onChange(async (value) => {
					launcher.type = value as LauncherType;
					await this.plugin.saveSettings();
					this.display();
				})
		);

		row.addText((text) => {
			const placeholder =
				launcher.type === "url"
					? "https://example.com"
					: launcher.type === "app"
						? "app name or path"
						: "shell command";
			text
				.setPlaceholder(placeholder)
				.setValue(launcher.target)
				.onChange(async (value) => {
					launcher.target = value;
					await this.plugin.saveSettings();
				});
			text.inputEl.style.width = "16em";
		});

		row.addButton((button) =>
			button
				.setIcon("trash")
				.setTooltip("Remove")
				.setWarning()
				.onClick(() => {
					this.plugin.removeLauncher(launcher.id);
					this.display();
				})
		);
	}
}
