import {
	App,
	type ButtonComponent,
	FileSystemAdapter,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
} from "obsidian";

/**
 * Lazy, typed require() for Node built-ins. This is the single place in the
 * file where the `any` from CommonJS require() is cast to a real type, so it
 * doesn't leak across every call site. Never invoked until after a
 * Platform.isDesktopApp check (see runLauncher()), so it's never touched on mobile.
 */
function nodeRequire<T>(id: string): T {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional, single, isolated CommonJS require for lazy-loading Node built-ins on desktop only
	return require(id) as T;
}

type LauncherType = "terminal" | "app" | "url" | "script" | "sequence";
type WorkingDirMode = "vault" | "active-file";
type WinTerminal = "wt" | "cmd" | "powershell";
type LinuxTerminal = "gnome-terminal" | "konsole" | "x-terminal-emulator";
/** "js" scripts run in-process via nodeRequire, same trick as Terminal/App.
 * "py" scripts are always spawned as a separate process (python3 <path> [args]) since
 * a Python interpreter can't run inside the Electron/Node process — no shared app access. */
type ScriptRuntime = "js" | "py";

interface Launcher {
	/** Stable id, generated once. Used to build the command id, so it must never change. */
	id: string;
	name: string;
	type: LauncherType;
	/** Shell command (terminal), binary name or path (app), URL (url), or vault-relative script path (script). Unused for sequence. */
	target: string;
	/**
	 * Obsidian icon id (see getIconIds()) shown as a ribbon button on the left sidebar.
	 * Empty means no ribbon icon for this launcher, which is the default for all of them.
	 */
	icon: string;
	/** Only used when type === "script". Ignored otherwise. */
	scriptRuntime?: ScriptRuntime;
	/** Space-separated extra arguments passed to the script. Only used when type === "script". */
	scriptArgs?: string;
	/**
	 * Only used when type === "sequence". IDs of other launchers to run in order.
	 * A launcher can't reference itself or another sequence, to avoid infinite loops.
	 */
	sequenceSteps?: string[];
	/** Only used when type === "sequence". If true, stop at the first step that fails; if false, run all steps regardless. */
	sequenceStopOnError?: boolean;
}

interface OpenAnythingSettings {
	launchers: Launcher[];
	/** Applies to "terminal", "app", and "script" launchers. Irrelevant for "url" and "sequence". */
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
	/** Command used to run "py" script launchers. Defaults to python3, but some setups only have python or py on PATH. */
	pythonCommand: string;
}

const DEFAULT_SETTINGS: OpenAnythingSettings = {
	launchers: [
		{
			id: "claude-code",
			name: "Claude Code",
			type: "terminal",
			target: "claude",
			icon: "",
		},
	],
	workingDirMode: "vault",
	macTerminalApp: "Terminal",
	winTerminalApp: "wt",
	linuxTerminal: "gnome-terminal",
	customLaunchTemplate: "",
	pythonCommand: "python3",
};

export default class OpenAnythingPlugin extends Plugin {
	settings: OpenAnythingSettings;
	/** Tracks currently-mounted ribbon icon elements per launcher id, so changing or clearing a launcher's icon can remove the stale one instead of stacking duplicates. */
	private ribbonIcons = new Map<string, HTMLElement>();

	async onload(): Promise<void> {
		await this.loadSettings();

		for (const launcher of this.settings.launchers) {
			this.registerLauncherCommand(launcher);
			this.registerLauncherRibbonIcon(launcher);
		}

		this.addSettingTab(new OpenAnythingSettingTab(this.app, this));
	}

	// ---------- Launcher CRUD ----------

	async addLauncher(type: LauncherType): Promise<Launcher> {
		const names: Record<LauncherType, string> = {
			url: "New website",
			app: "New app",
			terminal: "New terminal command",
			script: "New script",
			sequence: "New sequence",
		};
		const launcher: Launcher = {
			id: `launcher-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			name: names[type],
			type,
			target: "",
			icon: "",
			...(type === "script" ? { scriptRuntime: "js", scriptArgs: "" } : {}),
			...(type === "sequence" ? { sequenceSteps: [], sequenceStopOnError: true } : {}),
		};
		this.settings.launchers.push(launcher);
		await this.saveSettings();
		this.registerLauncherCommand(launcher);
		return launcher;
	}

	async removeLauncher(id: string): Promise<void> {
		const index = this.settings.launchers.findIndex((l) => l.id === id);
		if (index === -1) return;
		this.settings.launchers.splice(index, 1);
		await this.saveSettings();
		this.removeCommand(`${this.manifest.id}:run-${id}`);
	}

	/** Re-registers a launcher's command, used both for the initial setup and to refresh its name in the palette. */
	registerLauncherCommand(launcher: Launcher): void {
		this.addCommand({
			id: `run-${launcher.id}`,
			name: `Open: ${launcher.name || "Untitled"}`,
			callback: () => void this.runLauncher(launcher.id),
		});
	}

	/** Mounts (or re-mounts, if the icon changed) a ribbon button for this launcher. Removes it entirely if the icon field is empty. */
	registerLauncherRibbonIcon(launcher: Launcher): void {
		const existing = this.ribbonIcons.get(launcher.id);
		if (existing) {
			existing.remove();
			this.ribbonIcons.delete(launcher.id);
		}
		if (!launcher.icon.trim()) return;

		const el = this.addRibbonIcon(launcher.icon, launcher.name || "Untitled", () => void this.runLauncher(launcher.id));
		this.ribbonIcons.set(launcher.id, el);
	}

	// ---------- Running ----------

	/**
	 * visitedSequences guards against sequence cycles at runtime (the settings UI already
	 * prevents a sequence from listing another sequence as a step, but this is the last line
	 * of defense in case settings.json was hand-edited).
	 */
	async runLauncher(id: string, visitedSequences: Set<string> = new Set()): Promise<void> {
		const launcher = this.settings.launchers.find((l) => l.id === id);
		if (!launcher) {
			new Notice("This launcher no longer exists.");
			return;
		}

		if (launcher.type === "sequence") {
			await this.runSequence(launcher, visitedSequences);
			return;
		}

		if (!launcher.target.trim()) {
			new Notice(`"${launcher.name}" has no target set yet. Fill it in under settings.`);
			return;
		}

		try {
			if (launcher.type === "url") {
				this.launchUrl(launcher.target);
				return;
			}

			// Every remaining type needs a real OS process (or, for "script"/"js", at least Node access).
			if (!Platform.isDesktopApp) {
				new Notice(`"${launcher.name}" only works on desktop.`);
				return;
			}

			const cwd = this.getWorkingDirectory();
			if (!cwd) {
				new Notice("Couldn't resolve the vault path.");
				return;
			}

			if (launcher.type === "terminal") {
				this.launchTerminal(cwd, launcher.target);
				new Notice(`Opening: ${launcher.name}`);
			} else if (launcher.type === "app") {
				this.launchApp(cwd, launcher.target);
				new Notice(`Opening: ${launcher.name}`);
			} else {
				// launchScript reports its own success/failure, since (unlike terminal/app,
				// which are fire-and-forget spawns) it's actually awaited to completion.
				await this.launchScript(cwd, launcher);
			}
		} catch (err) {
			console.error("Open Anything:", err);
			new Notice("Something went wrong, check the developer console (Ctrl+Shift+I).");
		}
	}

	private async runSequence(launcher: Launcher, visitedSequences: Set<string>): Promise<void> {
		if (visitedSequences.has(launcher.id)) {
			new Notice(`"${launcher.name}" is part of a sequence cycle, refusing to run it.`);
			return;
		}
		const steps = launcher.sequenceSteps ?? [];
		if (steps.length === 0) {
			new Notice(`"${launcher.name}" has no steps yet. Add some under settings.`);
			return;
		}

		visitedSequences.add(launcher.id);
		new Notice(`Running sequence: ${launcher.name}`);

		for (const stepId of steps) {
			const step = this.settings.launchers.find((l) => l.id === stepId);
			if (!step) {
				new Notice(`Sequence "${launcher.name}": a step was deleted, skipping it.`);
				continue;
			}
			try {
				await this.runLauncher(stepId, visitedSequences);
			} catch (err) {
				console.error("Open Anything: sequence step failed", err);
				if (launcher.sequenceStopOnError ?? true) {
					new Notice(`Sequence "${launcher.name}" stopped: "${step.name}" failed.`);
					return;
				}
			}
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
				const path = nodeRequire<typeof import("path")>("path");
				const fileDir = path.dirname(activeFile.path);
				return fileDir === "." ? vaultPath : path.join(vaultPath, fileDir);
			}
		}
		return vaultPath;
	}

	/** Resolves a vault-relative path (as typed into a Script launcher's target field) to an absolute filesystem path. Returns null if the vault isn't on local disk. */
	private resolveVaultPath(relativePath: string): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		const path = nodeRequire<typeof import("path")>("path");
		return path.join(adapter.getBasePath(), relativePath);
	}

	private notifySpawnError(err: NodeJS.ErrnoException): void {
		console.error("Open Anything: spawn error", err);
		if (err.code === "ENOENT") {
			new Notice(`Couldn't find "${err.path ?? "the program"}". Check that it's installed and on PATH, or fix it in the plugin settings.`);
		} else {
			new Notice("Couldn't launch that. Check the developer console (Ctrl+Shift+I) for details.");
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
		const { spawn } = nodeRequire<typeof import("child_process")>("child_process");

		if (Platform.isMacOS) {
			const child = spawn("open", ["-a", target], { detached: true, stdio: "ignore" });
			child.on("error", (err) => this.notifySpawnError(err));
			child.unref();
			return;
		}

		const child = spawn(target, [], { cwd, detached: true, stdio: "ignore", windowsHide: false });
		child.on("error", (err) => this.notifySpawnError(err));
		child.unref();
	}

	// ---------- Type: script (desktop only; "js" runs in-process, "py" is spawned) ----------

	private async launchScript(cwd: string, launcher: Launcher): Promise<void> {
		const runtime = launcher.scriptRuntime ?? "js";
		const absolutePath = this.resolveVaultPath(launcher.target);
		if (!absolutePath) {
			new Notice("Couldn't resolve the script's path.");
			return;
		}
		const args = (launcher.scriptArgs ?? "").trim().length > 0 ? launcher.scriptArgs!.trim().split(/\s+/) : [];

		if (runtime === "py") {
			const { spawn } = nodeRequire<typeof import("child_process")>("child_process");
			const child = spawn(this.settings.pythonCommand.trim() || "python3", [absolutePath, ...args], {
				cwd,
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.on("error", (err) => this.notifySpawnError(err));
			child.unref();
			new Notice(`Opening: ${launcher.name}`);
			return;
		}

		// "js": runs inside Obsidian's own process via a fresh require(), the same lazy-loading
		// trick nodeRequire() uses for Node built-ins. A per-call createRequire() clears the
		// module cache first, so edits to the script are picked up on the next run instead of
		// being cached forever after the first call.
		//
		// The scripting API is intentionally minimal for now (just `app` and `args`) — a richer,
		// QuickAdd-style API (prompts, suggesters, declarative per-script settings) is planned
		// separately rather than bolted on here.
		try {
			const { createRequire } = nodeRequire<typeof import("module")>("module");
			const scriptRequire = createRequire(absolutePath);
			delete scriptRequire.cache[absolutePath];
			const mod: unknown = scriptRequire(absolutePath);
			const exported = (mod as { default?: unknown }).default ?? mod;
			if (typeof exported !== "function") {
				new Notice(`"${launcher.name}": the script must export a function (module.exports = ... or export default ...).`);
				return;
			}
			await (exported as (ctx: { app: App; args: string[] }) => unknown)({ app: this.app, args });
			new Notice(`Ran: ${launcher.name}`);
		} catch (err) {
			console.error(`Open Anything: script "${launcher.name}" threw`, err);
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`"${launcher.name}" script error: ${message}`);
		}
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
		const { spawn } = nodeRequire<typeof import("child_process")>("child_process");
		const path = nodeRequire<typeof import("path")>("path");
		const os = nodeRequire<typeof import("os")>("os");
		const fs = nodeRequire<typeof import("fs")>("fs");

		const scriptPath = path.join(os.tmpdir(), `open-anything-${Date.now()}.command`);
		const escapedCwd = cwd.replace(/"/g, '\\"');
		const scriptContent = `#!/bin/bash\ncd "${escapedCwd}"\n${command}\n`;
		fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

		const appName = this.settings.macTerminalApp.trim();
		const args = appName ? ["-a", appName, scriptPath] : [scriptPath];

		const child = spawn("open", args, { detached: true, stdio: "ignore" });
		child.on("error", (err) => this.notifySpawnError(err));
		child.unref();

		// Best-effort cleanup once the terminal has had time to read the script.
		window.setTimeout(() => {
			fs.unlink(scriptPath, () => { /* may already be gone, that's fine */ });
		}, 15000);
	}

	private launchWindows(cwd: string, command: string): void {
		const { spawn } = nodeRequire<typeof import("child_process")>("child_process");
		const mode = this.settings.winTerminalApp;

		const spawnCmd = () => {
			const child = spawn("cmd.exe", ["/K", command], {
				cwd,
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.on("error", (err) => this.notifySpawnError(err));
			child.unref();
		};

		if (mode === "wt") {
			const child = spawn("wt.exe", ["-d", cwd, "cmd", "/k", command], {
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "ENOENT") {
					new Notice("Windows Terminal not found, opening cmd.exe instead.");
					spawnCmd();
				} else {
					this.notifySpawnError(err);
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
			child.on("error", (err) => this.notifySpawnError(err));
			child.unref();
			return;
		}

		spawnCmd();
	}

	private launchLinux(cwd: string, command: string): void {
		const { spawn } = nodeRequire<typeof import("child_process")>("child_process");
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
		child.on("error", (err) => this.notifySpawnError(err));
		child.unref();
	}

	private launchCustom(cwd: string, command: string, template: string): void {
		const { spawn } = nodeRequire<typeof import("child_process")>("child_process");
		const filled = template.replace(/\{cwd\}/g, cwd).replace(/\{cmd\}/g, command);

		const shellBin = Platform.isWin ? "cmd.exe" : "/bin/sh";
		const shellArgs = Platform.isWin ? ["/c", filled] : ["-c", filled];

		const child = spawn(shellBin, shellArgs, { detached: true, stdio: "ignore", windowsHide: false });
		child.on("error", (err) => this.notifySpawnError(err));
		child.unref();
	}

	// ---------- Settings persistence ----------

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as OpenAnythingSettings;
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
		this.build();
	}

	private build(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Launchers")
			.setDesc("Each row below gets its own command, so you can bind it to a hotkey in the hotkeys settings.")
			.setHeading();

		const list = containerEl.createDiv();
		this.plugin.settings.launchers.forEach((launcher) => this.renderLauncherRow(list, launcher));

		const addRow = new Setting(containerEl).setName("Add launcher");
		addRow.addButton((button: ButtonComponent) =>
			button.setButtonText("+ terminal").onClick(async () => {
				await this.plugin.addLauncher("terminal");
				this.build();
			})
		);
		addRow.addButton((button: ButtonComponent) =>
			button.setButtonText("+ app").onClick(async () => {
				await this.plugin.addLauncher("app");
				this.build();
			})
		);
		addRow.addButton((button: ButtonComponent) =>
			button.setButtonText("+ website").onClick(async () => {
				await this.plugin.addLauncher("url");
				this.build();
			})
		);

		new Setting(containerEl)
			.setName("Terminal and app")
			.setDesc('Applies to every "terminal" and "app" launcher above. Websites don\'t need any of this.')
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
		row.settingEl.classList.add("open-anything-row");

		row.addText((text) => {
			text
				.setPlaceholder("Name")
				.setValue(launcher.name)
				.onChange(async (value) => {
					launcher.name = value;
					await this.plugin.saveSettings();
					this.plugin.registerLauncherCommand(launcher);
				});
			text.inputEl.classList.add("open-anything-name-input");
		});

		row.addDropdown((dropdown) =>
			dropdown
				.addOptions({ terminal: "terminal", app: "app", url: "website" })
				.setValue(launcher.type)
				.onChange(async (value) => {
					launcher.type = value as LauncherType;
					await this.plugin.saveSettings();
						this.build();
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
			text.inputEl.classList.add("open-anything-target-input");
		});

		row.addButton((button: ButtonComponent) =>
			button
				.setIcon("trash")
				.setTooltip("Remove")
					.onClick(async () => {
					await this.plugin.removeLauncher(launcher.id);
						this.build();
				})
		);
	}
}
