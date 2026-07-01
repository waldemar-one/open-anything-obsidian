import {
	App,
	type ButtonComponent,
	FileSystemAdapter,
	FuzzySuggestModal,
	getIconIds,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
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
	/**
	 * Vault-relative folder override for "terminal", "app", and "script" launchers.
	 * Empty means fall back to the global Working directory setting. Ignored for
	 * "url" and "sequence" (a sequence's steps each resolve their own directory).
	 */
	customWorkingDir?: string;
	/** Space-separated extra arguments passed to the target executable. Only used when type === "app". */
	appArgs?: string;
	/** If true, this launcher runs once automatically after Obsidian finishes loading the workspace. */
	runOnStartup?: boolean;
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
	/**
	 * Whether to show a Notice on successful launch ("Opening: X", "Ran: X"). Errors and
	 * warnings always show regardless of this, since silencing those would hide real problems.
	 */
	showNotices: boolean;
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
	showNotices: true,
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

		// Deferred until the workspace is fully ready, not fired mid-onload, so
		// startup launchers don't race the vault index or open before Obsidian's own UI has settled.
		this.app.workspace.onLayoutReady(() => {
			for (const launcher of this.settings.launchers) {
				if (launcher.runOnStartup) void this.runLauncher(launcher.id);
			}
		});
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

			const cwd = this.getWorkingDirectory(launcher);
			if (!cwd) {
				new Notice("Couldn't resolve the vault path.");
				return;
			}

			if (launcher.type === "terminal") {
				this.launchTerminal(cwd, launcher.target);
				this.notifyStatus(`Opening: ${launcher.name}`);
			} else if (launcher.type === "app") {
				this.launchApp(cwd, launcher);
				this.notifyStatus(`Opening: ${launcher.name}`);
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
		this.notifyStatus(`Running sequence: ${launcher.name}`);

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

	private getWorkingDirectory(launcher: Launcher): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		const vaultPath = adapter.getBasePath();

		if (launcher.customWorkingDir?.trim()) {
			// Lazy require: only ever touched on desktop, after the Platform check above.
			const path = nodeRequire<typeof import("path")>("path");
			return path.join(vaultPath, launcher.customWorkingDir.trim());
		}

		if (this.settings.workingDirMode === "active-file") {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
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

	/** Success/status notices only, gated by the "Show notices" setting. Errors and warnings never go through this, they always show. */
	private notifyStatus(message: string): void {
		if (this.settings.showNotices) new Notice(message);
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

	private launchApp(cwd: string, launcher: Launcher): void {
		const { spawn } = nodeRequire<typeof import("child_process")>("child_process");
		const target = launcher.target;
		const args = (launcher.appArgs ?? "").trim().length > 0 ? launcher.appArgs!.trim().split(/\s+/) : [];

		if (Platform.isMacOS) {
			const child = spawn("open", ["-a", target, ...(args.length > 0 ? ["--args", ...args] : [])], {
				detached: true,
				stdio: "ignore",
			});
			child.on("error", (err) => this.notifySpawnError(err));
			child.unref();
			return;
		}

		// .bat and .cmd files can't be spawned directly on Windows without shell:true,
		// Node throws otherwise since they aren't real executables, cmd.exe has to run them.
		const isWindowsScript = Platform.isWin && /\.(bat|cmd)$/i.test(target);
		const child = spawn(target, args, {
			cwd,
			detached: true,
			stdio: "ignore",
			windowsHide: false,
			shell: isWindowsScript,
		});
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
			this.notifyStatus(`Opening: ${launcher.name}`);
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
			this.notifyStatus(`Ran: ${launcher.name}`);
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

interface LauncherDragState {
	launcherId: string;
	rowEl: HTMLElement;
	startIndex: number;
	currentIndex: number;
	pointerOffsetY: number;
	rowHeight: number;
	others: { el: HTMLElement; originalIndex: number; centerY: number }[];
	/** Vertical bounds (viewport coordinates) the floating card's top is clamped to, so it can
	 * never fly up over Obsidian's own settings modal header or down past the visible pane. */
	minTop: number;
	maxTop: number;
}

class OpenAnythingSettingTab extends PluginSettingTab {
	plugin: OpenAnythingPlugin;
	/** Live state of an in-progress pointer-driven drag, null when nothing is being dragged. */
	private dragState: LauncherDragState | null = null;
	/** UI-only, not persisted: which launchers currently have their advanced section expanded. Resets when the settings tab is reopened. */
	private expandedLauncherIds = new Set<string>();
	/** UI-only, not persisted: whether the platform-specific (macOS/Windows/Linux/custom template) section is expanded. Collapsed by default since these are rarely touched. */
	private platformSectionExpanded = false;

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

		// ---------- Launchers (primary section) ----------
		const launchersSection = this.renderSection(
			containerEl,
			"Launchers",
			"Each row gets its own command, so you can bind it to a hotkey in the hotkeys settings."
		);

		const list = launchersSection.createDiv();
		this.plugin.settings.launchers.forEach((launcher) => this.renderLauncherRow(list, launcher));

		const addRow = new Setting(launchersSection)
			.setName("Add launcher")
			.setDesc("Terminal and app run on desktop only. Website also works on mobile. Script runs JavaScript or Python. Sequence chains other launchers together.");
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
		addRow.addButton((button: ButtonComponent) =>
			button.setButtonText("+ script").onClick(async () => {
				await this.plugin.addLauncher("script");
				this.build();
			})
		);
		addRow.addButton((button: ButtonComponent) =>
			button.setButtonText("+ sequence").onClick(async () => {
				await this.plugin.addLauncher("sequence");
				this.build();
			})
		);

		// ---------- Behavior (global defaults every launcher shares unless overridden) ----------
		const behaviorSection = this.renderSection(
			containerEl,
			"Behavior",
			"Applies to every launcher by default. Terminal, app, and script launchers can override the working directory individually under their own advanced options."
		);

		new Setting(behaviorSection)
			.setName("Show notices")
			.setDesc('Show a confirmation notice on successful launch ("opening: X"). Errors and warnings always show regardless.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showNotices).onChange(async (value) => {
					this.plugin.settings.showNotices = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(behaviorSection)
			.setName("Working directory")
			.setDesc("Where terminal, app, and script launchers start from.")
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

		new Setting(behaviorSection)
			.setName("Python command")
			.setDesc('Used to run "script" launchers set to Python. Change this if the default doesn\'t work for your system.')
			.addText((text) =>
				text.setValue(this.plugin.settings.pythonCommand).onChange(async (value) => {
					this.plugin.settings.pythonCommand = value;
					await this.plugin.saveSettings();
				})
			);

		// ---------- Platform-specific (collapsed by default, rarely touched) ----------
		const platformSection = this.renderCollapsibleSection(
			containerEl,
			"Platform-specific",
			"Which terminal to use on each OS, and a custom launch template override. Only affects Terminal launchers.",
			this.platformSectionExpanded,
			() => {
				this.platformSectionExpanded = !this.platformSectionExpanded;
				this.build();
			}
		);

		if (this.platformSectionExpanded) {
			new Setting(platformSection).setName("macOS").setHeading();
			new Setting(platformSection)
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

			new Setting(platformSection).setName("Windows").setHeading();
			new Setting(platformSection)
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

			new Setting(platformSection).setName("Linux").setHeading();
			new Setting(platformSection)
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

			new Setting(platformSection).setName("Custom launch template").setHeading();
			new Setting(platformSection)
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

		const footer = containerEl.createDiv({ cls: "open-anything-footer" });
		footer.createSpan({ text: "Open Anything, by waldemar-one. " });
		footer.createEl("a", {
			text: "View on GitHub",
			href: "https://github.com/waldemar-one/open-anything-obsidian",
		});
	}

	/** Creates a visually distinct "card" section (heading + description inside a bordered, padded container) and returns it so callers append the section's actual settings into it, not into the raw settings pane. */
	private renderSection(containerEl: HTMLElement, name: string, desc: string): HTMLElement {
		const section = containerEl.createDiv({ cls: "open-anything-section" });
		const heading = new Setting(section).setName(name).setDesc(desc).setHeading();
		heading.settingEl.classList.add("open-anything-section-heading");
		return section;
	}

	/** Same "card" treatment as renderSection, plus a chevron in the heading row that expands or collapses the section. The caller is responsible for actually skipping its body content when collapsed. */
	private renderCollapsibleSection(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		expanded: boolean,
		onToggle: () => void
	): HTMLElement {
		const section = containerEl.createDiv({ cls: "open-anything-section" });
		const heading = new Setting(section).setName(name).setDesc(desc).setHeading();
		heading.settingEl.classList.add("open-anything-section-heading");
		heading.addExtraButton((button) =>
			button
				.setIcon(expanded ? "chevron-down" : "chevron-right")
				.setTooltip(expanded ? "Collapse" : "Expand")
				.onClick(onToggle)
		);
		return section;
	}

	private renderLauncherRow(containerEl: HTMLElement, launcher: Launcher): void {
		const row = new Setting(containerEl);
		row.settingEl.classList.add("open-anything-row");
		row.settingEl.setAttribute("data-launcher-id", launcher.id);
		this.attachDragHandle(row.settingEl, launcher);
		this.attachAdvancedToggle(row.settingEl, launcher);

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
				.addOptions({ terminal: "terminal", app: "app", url: "website", script: "script", sequence: "sequence" })
				.setValue(launcher.type)
				.onChange(async (value) => {
					launcher.type = value as LauncherType;
					if (value === "script" && !launcher.scriptRuntime) launcher.scriptRuntime = "js";
					if (value === "sequence" && !launcher.sequenceSteps) launcher.sequenceSteps = [];
					await this.plugin.saveSettings();
					this.build();
				})
		);

		// "sequence" launchers don't have a single target (their targets are the steps
		// below), so the shared target field only shows up for the other four types.
		if (launcher.type !== "sequence") {
			row.addText((text) => {
				const placeholder =
					launcher.type === "url"
						? "https://example.com"
						: launcher.type === "app"
							? "app name or path"
							: launcher.type === "script"
								? "path/to/script.js, relative to vault root"
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
		}

		// addExtraButton (not addButton) is Obsidian's own convention for lightweight, borderless
		// icon-only secondary actions in a settings row, the same visual weight core Obsidian
		// settings use for things like "reset to default". Matches the platform, not custom CSS.
		row.addExtraButton((button) => {
			button
				.setIcon(launcher.icon || "image")
				.setTooltip(launcher.icon ? `Sidebar icon: ${launcher.icon} (click to change)` : "No sidebar icon (click to add one)")
				.onClick(() => {
					new IconPickerModal(this.plugin.app, async (iconId) => {
						launcher.icon = iconId ?? "";
						await this.plugin.saveSettings();
						this.plugin.registerLauncherRibbonIcon(launcher);
						this.build();
					}).open();
				});
		});

		row.addExtraButton((button) =>
			button
				.setIcon("trash")
				.setTooltip("Remove")
				.onClick(async () => {
					await this.plugin.removeLauncher(launcher.id);
					this.build();
				})
		);

		if (this.expandedLauncherIds.has(launcher.id)) this.renderAdvancedSection(containerEl, launcher);
	}

	/**
	 * Single collapsible "advanced" section per launcher, toggled by the chevron button in the
	 * summary row. Always starts with the startup toggle (every type gets one), then the
	 * type-specific fields that used to live in four separate always-visible blocks.
	 */
	private renderAdvancedSection(containerEl: HTMLElement, launcher: Launcher): void {
		const details = containerEl.createDiv({ cls: "open-anything-launcher-details" });

		new Setting(details)
			.setName("Run at startup")
			.setDesc("Run this launcher once automatically after Obsidian finishes loading.")
			.addToggle((toggle) =>
				toggle.setValue(launcher.runOnStartup ?? false).onChange(async (value) => {
					launcher.runOnStartup = value;
					await this.plugin.saveSettings();
				})
			);

		if (launcher.type === "terminal") {
			this.renderWorkingDirField(details, launcher, "Optional, relative to the vault root. Overrides the global working directory setting for this launcher only.");
		}

		if (launcher.type === "app") {
			new Setting(details)
				.setName("Arguments")
				.setDesc("Optional, space-separated. Passed to the target as-is; quoting isn't supported yet. On Windows, .bat and .cmd targets are supported too.")
				.addText((text) =>
					text
						.setPlaceholder("--flag value")
						.setValue(launcher.appArgs ?? "")
						.onChange(async (value) => {
							launcher.appArgs = value;
							await this.plugin.saveSettings();
						})
				);
			this.renderWorkingDirField(details, launcher, "Optional, relative to the vault root. Overrides the global working directory setting for this launcher only.");
		}

		if (launcher.type === "script") {
			new Setting(details)
				.setName("Runtime")
				.setDesc('"js" runs in Obsidian\'s own process; "py" is spawned as a separate Python process and can\'t access the vault directly.')
				.addDropdown((dropdown) =>
					dropdown
						.addOptions({ js: "JavaScript (.js)", py: "Python (.py)" })
						.setValue(launcher.scriptRuntime ?? "js")
						.onChange(async (value) => {
							launcher.scriptRuntime = value as ScriptRuntime;
							await this.plugin.saveSettings();
						})
				);
			new Setting(details)
				.setName("Arguments")
				.setDesc("Optional, space-separated. Passed to the script as-is; quoting isn't supported yet.")
				.addText((text) =>
					text
						.setPlaceholder("--flag value")
						.setValue(launcher.scriptArgs ?? "")
						.onChange(async (value) => {
							launcher.scriptArgs = value;
							await this.plugin.saveSettings();
						})
				);
			this.renderWorkingDirField(
				details,
				launcher,
				'Optional, relative to the vault root. Overrides the global working directory setting. Only affects "py" scripts; "js" scripts always resolve their own path from the vault root regardless.'
			);
		}

		if (launcher.type === "sequence") this.renderSequenceSteps(details, launcher);
	}

	/** Shared "working directory" text field, reused by terminal, app, and script's advanced sections. Just the description text differs. */
	private renderWorkingDirField(containerEl: HTMLElement, launcher: Launcher, desc: string): void {
		new Setting(containerEl)
			.setName("Working directory")
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder("(Uses the global setting)")
					.setValue(launcher.customWorkingDir ?? "")
					.onChange(async (value) => {
						launcher.customWorkingDir = value;
						await this.plugin.saveSettings();
					})
			);
	}

	/**
	 * Six-dot grip handle at the start of a launcher row. Drag it with the mouse (or touch) for
	 * a real floating drag: the row detaches and follows the pointer, other rows slide out of
	 * the way with a CSS transition to open a gap. Focus it and use ArrowUp/ArrowDown for the
	 * same result from the keyboard.
	 */
	private attachDragHandle(rowEl: HTMLElement, launcher: Launcher): void {
		const grip = rowEl.createDiv({ cls: "open-anything-drag-handle" });
		grip.setAttribute("tabindex", "0");
		grip.setAttribute("role", "button");
		grip.setAttribute("aria-label", "Drag to reorder, or use arrow keys");
		setIcon(grip, "grip-vertical");
		rowEl.prepend(grip);

		grip.addEventListener("pointerdown", (evt: PointerEvent) => {
			if (evt.button !== 0) return; // primary mouse button / touch only, ignore right/middle click
			this.startDrag(evt, rowEl, launcher.id);
		});

		grip.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "ArrowUp" && evt.key !== "ArrowDown") return;
			evt.preventDefault();
			void this.moveLauncher(launcher.id, evt.key === "ArrowUp" ? -1 : 1);
		});
	}

	/**
	 * Small plain-icon toggle for the collapsible advanced section, sitting right next to the
	 * drag handle rather than as a full button on the far side of the row. Same minimal, no-chrome
	 * visual treatment as the grip handle itself, since neither is a "primary" action.
	 */
	private attachAdvancedToggle(rowEl: HTMLElement, launcher: Launcher): void {
		const expanded = this.expandedLauncherIds.has(launcher.id);
		const toggle = rowEl.createDiv({ cls: "open-anything-advanced-toggle" });
		toggle.setAttribute("tabindex", "0");
		toggle.setAttribute("role", "button");
		toggle.setAttribute("aria-label", expanded ? "Hide advanced options" : "Show advanced options");
		setIcon(toggle, expanded ? "chevron-down" : "chevron-right");

		const grip = rowEl.querySelector(".open-anything-drag-handle");
		if (grip) grip.after(toggle);
		else rowEl.prepend(toggle);

		const onToggle = () => {
			if (expanded) this.expandedLauncherIds.delete(launcher.id);
			else this.expandedLauncherIds.add(launcher.id);
			this.build();
		};
		toggle.addEventListener("click", onToggle);
		toggle.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			onToggle();
		});
	}

	/** Begins a pointer-driven drag: measures every row's original position once, then lifts the dragged row into `position: fixed` so it can follow the cursor freely. */
	private startDrag(evt: PointerEvent, rowEl: HTMLElement, launcherId: string): void {
		evt.preventDefault();
		const list = rowEl.parentElement;
		if (!list) return;

		const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > .open-anything-row"));
		const startIndex = rows.indexOf(rowEl);
		if (startIndex === -1) return;

		const rowRect = rowEl.getBoundingClientRect();
		const others = rows
			.map((el, originalIndex) => ({ el, originalIndex, rect: el.getBoundingClientRect() }))
			.filter((r) => r.originalIndex !== startIndex)
			.map((r) => ({ el: r.el, originalIndex: r.originalIndex, centerY: r.rect.top + r.rect.height / 2 }));

		// Clamp to the settings pane's own content area (this.containerEl), not the viewport, so
		// the floating card can't rise above Obsidian's modal header or drop below the visible pane.
		const bounds = this.containerEl.getBoundingClientRect();

		this.dragState = {
			launcherId,
			rowEl,
			startIndex,
			currentIndex: startIndex,
			pointerOffsetY: evt.clientY - rowRect.top,
			rowHeight: rowRect.height,
			others,
			minTop: bounds.top,
			maxTop: bounds.bottom - rowRect.height,
		};

		rowEl.classList.add("open-anything-dragging");
		rowEl.style.width = `${rowRect.width}px`;
		rowEl.style.left = `${rowRect.left}px`;
		rowEl.style.top = `${rowRect.top}px`;
		activeDocument.body.classList.add("open-anything-is-dragging");

		activeDocument.addEventListener("pointermove", this.onDragPointerMove);
		activeDocument.addEventListener("pointerup", this.onDragPointerUp, { once: true });
		activeDocument.addEventListener("keydown", this.onDragKeyDown);
	}

	/**
	 * Bound once as a class field (not a method) so the same function reference can be passed to
	 * both addEventListener and removeEventListener; an inline arrow function on every drag start
	 * would be a fresh reference each time and couldn't be unregistered correctly.
	 */
	private readonly onDragPointerMove = (evt: PointerEvent): void => {
		const state = this.dragState;
		if (!state) return;
		evt.preventDefault();

		const clampedTop = Math.min(Math.max(evt.clientY - state.pointerOffsetY, state.minTop), state.maxTop);
		state.rowEl.style.top = `${clampedTop}px`;

		// How many other rows now sit above the cursor is exactly the array index the dragged
		// launcher should land at, since removing it and reinserting there is what "above" means.
		const newIndex = state.others.filter((o) => o.centerY < evt.clientY).length;
		if (newIndex === state.currentIndex) return;
		state.currentIndex = newIndex;

		// For each other row, work out its final position in the reordered array (removing the
		// dragged row, then reinserting it at newIndex) and shift by exactly the difference
		// between that and its original slot. This always resolves to -1, 0, or +1 row-heights,
		// regardless of how far the drag travels, matching how a single-item move naturally
		// only displaces the rows strictly between the old and new position.
		for (const other of state.others) {
			const posAfterRemoval = other.originalIndex < state.startIndex ? other.originalIndex : other.originalIndex - 1;
			const finalPos = posAfterRemoval >= newIndex ? posAfterRemoval + 1 : posAfterRemoval;
			const shift = finalPos - other.originalIndex;
			other.el.style.transform = shift === 0 ? "" : `translateY(${shift * state.rowHeight}px)`;
		}
	};

	private readonly onDragPointerUp = (): void => {
		const state = this.dragState;
		if (!state) return;
		this.dragState = null;
		activeDocument.removeEventListener("pointermove", this.onDragPointerMove);
		activeDocument.removeEventListener("keydown", this.onDragKeyDown);
		activeDocument.body.classList.remove("open-anything-is-dragging");
		void this.commitReorder(state.launcherId, state.startIndex, state.currentIndex);
	};

	/** Escape cancels an in-progress drag without touching settings.launchers at all, since nothing was committed to it during the drag, only CSS transforms were applied. */
	private readonly onDragKeyDown = (evt: KeyboardEvent): void => {
		if (evt.key !== "Escape" || !this.dragState) return;
		evt.preventDefault();
		evt.stopPropagation();
		this.dragState = null;
		activeDocument.removeEventListener("pointermove", this.onDragPointerMove);
		activeDocument.removeEventListener("pointerup", this.onDragPointerUp);
		activeDocument.removeEventListener("keydown", this.onDragKeyDown);
		activeDocument.body.classList.remove("open-anything-is-dragging");
		this.build();
	};

	/** Applies the final reorder to settings, then rebuilds. Rebuilding always happens, even when the index didn't change, so the lifted row and any transformed siblings reset to a clean DOM state. */
	private async commitReorder(launcherId: string, fromIndex: number, toIndex: number): Promise<void> {
		if (fromIndex !== toIndex) {
			const launchers = this.plugin.settings.launchers;
			const [moved] = launchers.splice(fromIndex, 1);
			launchers.splice(toIndex, 0, moved);
			await this.plugin.saveSettings();
		}
		this.build();
		this.focusGripHandle(launcherId);
	}

	/** Moves a launcher up or down by one position (delta -1 or +1), then re-renders and restores keyboard focus to its grip handle. */
	private async moveLauncher(id: string, delta: -1 | 1): Promise<void> {
		const launchers = this.plugin.settings.launchers;
		const index = launchers.findIndex((l) => l.id === id);
		const target = index + delta;
		if (index === -1 || target < 0 || target >= launchers.length) return;

		[launchers[index], launchers[target]] = [launchers[target], launchers[index]];
		await this.plugin.saveSettings();
		this.build();
		this.focusGripHandle(id);
	}

	private focusGripHandle(launcherId: string): void {
		const row = this.containerEl.querySelector(`[data-launcher-id="${launcherId}"]`);
		row?.querySelector<HTMLElement>(".open-anything-drag-handle")?.focus();
	}

	/** Extra fields for "sequence" launchers: the ordered list of steps, add-step picker, and stop-on-error toggle. */
	private renderSequenceSteps(details: HTMLElement, launcher: Launcher): void {
		const steps = launcher.sequenceSteps ?? (launcher.sequenceSteps = []);

		new Setting(details).setName("Steps").setDesc("Runs top to bottom. A sequence can't contain another sequence.").setHeading();

		if (steps.length === 0) {
			details.createEl("p", { text: "No steps yet, add one below.", cls: "setting-item-description" });
		}

		steps.forEach((stepId, index) => {
			const step = this.plugin.settings.launchers.find((l) => l.id === stepId);
			const stepRow = new Setting(details).setName(step ? step.name : "(deleted launcher)");
			stepRow.settingEl.classList.add("open-anything-sequence-step");

			stepRow.addButton((button: ButtonComponent) =>
				button
					.setIcon("arrow-up")
					.setTooltip("Move up")
					.setDisabled(index === 0)
					.onClick(async () => {
						[steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
						await this.plugin.saveSettings();
						this.build();
					})
			);
			stepRow.addButton((button: ButtonComponent) =>
				button
					.setIcon("arrow-down")
					.setTooltip("Move down")
					.setDisabled(index === steps.length - 1)
					.onClick(async () => {
						[steps[index], steps[index + 1]] = [steps[index + 1], steps[index]];
						await this.plugin.saveSettings();
						this.build();
					})
			);
			stepRow.addButton((button: ButtonComponent) =>
				button
					.setIcon("x")
					.setTooltip("Remove from sequence")
					.onClick(async () => {
						steps.splice(index, 1);
						await this.plugin.saveSettings();
						this.build();
					})
			);
		});

		// Only non-sequence launchers not already in this sequence can be added, which rules
		// out both self-reference and nested sequences at the point of selection.
		const available = this.plugin.settings.launchers.filter(
			(l) => l.type !== "sequence" && l.id !== launcher.id && !steps.includes(l.id)
		);
		if (available.length > 0) {
			new Setting(details).setName("Add step").addDropdown((dropdown) => {
				dropdown.addOption("", "Choose a launcher...");
				for (const candidate of available) dropdown.addOption(candidate.id, candidate.name || "Untitled");
				dropdown.setValue("").onChange(async (value) => {
					if (!value) return;
					steps.push(value);
					await this.plugin.saveSettings();
					this.build();
				});
			});
		}

		new Setting(details)
			.setName("Stop on error")
			.setDesc("If a step fails, stop the sequence instead of continuing to the next one.")
			.addToggle((toggle) =>
				toggle.setValue(launcher.sequenceStopOnError ?? true).onChange(async (value) => {
					launcher.sequenceStopOnError = value;
					await this.plugin.saveSettings();
				})
			);
	}
}

/**
 * Fuzzy-searchable picker over every icon id Obsidian ships (getIconIds()).
 * A "No icon" entry sits first so clearing a launcher's ribbon icon doesn't
 * require a separate button.
 */
class IconPickerModal extends FuzzySuggestModal<string | null> {
	private readonly onPick: (iconId: string | null) => void | Promise<void>;

	constructor(app: App, onPick: (iconId: string | null) => void | Promise<void>) {
		super(app);
		this.onPick = onPick;
		this.setPlaceholder('Search icons, or pick "no icon" to clear...');
	}

	getItems(): (string | null)[] {
		return [null, ...getIconIds()];
	}

	getItemText(item: string | null): string {
		return item ?? "No icon";
	}

	renderSuggestion(match: { item: string | null }, el: HTMLElement): void {
		el.classList.add("open-anything-icon-suggestion");
		const iconEl = el.createSpan({ cls: "open-anything-icon-suggestion-icon" });
		if (match.item) setIcon(iconEl, match.item);
		el.createSpan({ text: this.getItemText(match.item) });
	}

	onChooseItem(item: string | null): void {
		void this.onPick(item);
	}
}
