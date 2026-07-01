import {
	App,
	type ButtonComponent,
	FileSystemAdapter,
	FuzzySuggestModal,
	getIconIds,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
} from "obsidian";

/**
 * The plugin bundle's own ambient CommonJS require, captured once. Needed as a raw reference
 * (not just via nodeRequire below) so "js" script launchers can load a vault-relative user
 * script through THIS SAME already-correctly-scoped require, not an independently constructed
 * one. That distinction matters: a script's own `require('obsidian')` call only resolves
 * Obsidian's specially-registered virtual 'obsidian' module if it's loaded through the module
 * graph Obsidian itself set up when it loaded this plugin, which node:module's createRequire()
 * does not inherit, it builds an isolated loader from scratch.
 */
const ambientRequire: NodeJS.Require = require;

/**
 * Lazy, typed require() for Node built-ins. This is the single place in the
 * file where the `any` from CommonJS require() is cast to a real type, so it
 * doesn't leak across every call site. Never invoked until after a
 * Platform.isDesktopApp check (see runLauncher()), so it's never touched on mobile.
 */
function nodeRequire<T>(id: string): T {
	return ambientRequire(id) as T;
}

type LauncherType = "terminal" | "app" | "url" | "script" | "sequence";
type WorkingDirMode = "vault" | "active-file";
type WinTerminal = "wt" | "cmd" | "powershell";
type LinuxTerminal = "gnome-terminal" | "konsole" | "x-terminal-emulator";
/** "js" scripts run in-process via nodeRequire, same trick as Terminal/App.
 * "py" scripts are always spawned as a separate process (python3 <path> [args]) since
 * a Python interpreter can't run inside the Electron/Node process — no shared app access. */
type ScriptRuntime = "js" | "py";

/** Fallback icon shown in a launcher's avatar swatch when it hasn't been given a custom sidebar
 * icon, so every row has *some* visual identity instead of a blank/generic placeholder. */
const LAUNCHER_TYPE_ICON: Record<LauncherType, string> = {
	terminal: "square-terminal",
	app: "app-window",
	url: "globe",
	script: "file-code-2",
	sequence: "list-ordered",
};

/** Obsidian's standard tag/accent color set, one per launcher type, used to tint each row's
 * avatar swatch so the type reads at a glance without needing to look at the dropdown text. */
const LAUNCHER_TYPE_COLOR: Record<LauncherType, string> = {
	terminal: "var(--color-purple)",
	app: "var(--color-blue)",
	url: "var(--color-cyan)",
	script: "var(--color-orange)",
	sequence: "var(--color-green)",
};

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
		this.unregisterLauncherRibbonIcon(id);
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

	/** Removes a launcher's ribbon icon outright, used when the launcher itself is deleted (as opposed to registerLauncherRibbonIcon, which is for when just its icon setting changes). */
	private unregisterLauncherRibbonIcon(launcherId: string): void {
		const existing = this.ribbonIcons.get(launcherId);
		if (!existing) return;
		existing.remove();
		this.ribbonIcons.delete(launcherId);
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

		// "js": runs inside Obsidian's own process via the plugin's own require (ambientRequire),
		// not an independently constructed one, so that a script's own `require('obsidian')`
		// call correctly resolves Obsidian's virtual module. The cache entry is deleted first so
		// edits to the script are picked up on the next run instead of being cached forever
		// after the first call.
		//
		// The scripting API is intentionally minimal for now (just `app` and `args`) — a richer,
		// QuickAdd-style API (prompts, suggesters, declarative per-script settings) is planned
		// separately rather than bolted on here.
		try {
			delete ambientRequire.cache[absolutePath];
			const mod: unknown = ambientRequire(absolutePath);
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
	/** The floating card the pointer moves, physically relocated out of `list` for the duration of the drag. */
	rowEl: HTMLElement;
	/** Sits inside `list` at whatever position the dragged row would land at. Its DOM index at
	 * drop time is the actual, ground-truth target index, no coordinate math involved. */
	placeholder: HTMLElement;
	/** The container all launcher rows (and, while dragging, the placeholder) live in. */
	list: HTMLElement;
	startIndex: number;
	pointerOffsetY: number;
	/** Vertical bounds (viewport coordinates) the floating card's top is clamped to, so it can
	 * never fly up over Obsidian's own settings modal header or down past the visible pane. */
	minTop: number;
	maxTop: number;
	/** The nearest scrollable ancestor of the settings pane. Auto-scrolled while the pointer sits
	 * near the top or bottom edge, so long launcher lists can still be reordered past whatever's
	 * currently visible instead of the drag just going dead at the edge of the viewport. */
	scrollParent: HTMLElement;
	/** Updated on every pointermove; read by the auto-scroll loop, which runs independently on
	 * rAF and needs the latest pointer position even between actual move events. */
	lastPointerY: number;
}

class OpenAnythingSettingTab extends PluginSettingTab {
	plugin: OpenAnythingPlugin;
	/** Live state of an in-progress pointer-driven drag, null when nothing is being dragged. */
	private dragState: LauncherDragState | null = null;
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
		const addAndEdit = (type: LauncherType) => async () => {
			const launcher = await this.plugin.addLauncher(type);
			this.build();
			new LauncherEditModal(this.plugin.app, this.plugin, launcher, () => this.build()).open();
		};
		addRow.addButton((button: ButtonComponent) => button.setButtonText("+ terminal").onClick(addAndEdit("terminal")));
		addRow.addButton((button: ButtonComponent) => button.setButtonText("+ app").onClick(addAndEdit("app")));
		addRow.addButton((button: ButtonComponent) => button.setButtonText("+ website").onClick(addAndEdit("url")));
		addRow.addButton((button: ButtonComponent) => button.setButtonText("+ script").onClick(addAndEdit("script")));
		addRow.addButton((button: ButtonComponent) => button.setButtonText("+ sequence").onClick(addAndEdit("sequence")));

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
			.setDesc('Where terminal, app, and script launchers start from by default. "vault root" means every launcher opens right where your notes live. Each launcher can override this individually under its own advanced options.')
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
		heading.settingEl.classList.add("open-anything-section-heading", "open-anything-collapsible-heading");
		heading.settingEl.setAttribute("tabindex", "0");
		heading.settingEl.setAttribute("role", "button");
		heading.settingEl.setAttribute("aria-expanded", String(expanded));
		heading.settingEl.setAttribute("aria-label", `${name}, ${expanded ? "expanded" : "collapsed"}. Click to ${expanded ? "collapse" : "expand"}.`);
		heading.addExtraButton((button) => {
			button.setIcon(expanded ? "chevron-down" : "chevron-right").setTooltip(expanded ? "Collapse" : "Expand");
			// No .onClick() here on purpose: a click on the chevron already bubbles up to the
			// row-level listener below, since the chevron is a normal DOM child of settingEl.
			// Attaching a handler here too would fire onToggle twice per click. Likewise pulled
			// out of tab order, so Tab lands on the row once, not the row and then the icon.
			button.extraSettingsEl.setAttribute("tabindex", "-1");
		});
		// The whole row toggles, not just the small chevron button: clicking anywhere on the
		// heading or its description does the same thing the chevron does.
		heading.settingEl.addEventListener("click", onToggle);
		heading.settingEl.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			onToggle();
		});
		return section;
	}

	private renderLauncherRow(containerEl: HTMLElement, launcher: Launcher): void {
		// Deliberately just a display row now, nothing here is directly editable. Editing lives
		// in LauncherEditModal, which has a whole dialog's worth of room instead of a cramped
		// inline strip of fields. Grip, swatch, and the info block are all my own plain elements
		// for the same reason as before: full control over alignment, not fighting Setting's
		// internal layout.
		const rowWrapper = containerEl.createDiv({ cls: "open-anything-row" });
		rowWrapper.setAttribute("data-launcher-id", launcher.id);
		rowWrapper.setCssProps({ "--oa-type-color": LAUNCHER_TYPE_COLOR[launcher.type] });
		this.attachDragHandle(rowWrapper, launcher);
		this.attachIconSwatch(rowWrapper, launcher);

		const info = rowWrapper.createDiv({ cls: "open-anything-row-info" });
		info.setAttribute("tabindex", "0");
		info.setAttribute("role", "button");
		info.setAttribute("aria-label", `Edit launcher: ${launcher.name || "Untitled"}`);
		info.createDiv({ cls: "open-anything-row-name", text: launcher.name || "Untitled" });
		const meta = info.createDiv({ cls: "open-anything-row-meta" });
		meta.createSpan({ cls: "open-anything-row-type-badge", text: launcher.type === "url" ? "website" : launcher.type });

		const target = meta.createSpan({ cls: "open-anything-row-target", text: this.targetPreview(launcher) });
		target.setAttribute("tabindex", "0");
		target.setAttribute("role", "button");
		target.setAttribute("aria-label", `Test run: ${launcher.name || "Untitled"}`);
		const testRun = (evt: Event) => {
			// Stops here on purpose: without this, the click would also bubble up to the info
			// block's own "open the edit modal" handler, firing both at once on the same click.
			evt.stopPropagation();
			void this.plugin.runLauncher(launcher.id);
		};
		target.addEventListener("click", testRun);
		target.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			testRun(evt);
		});

		const openEdit = () => new LauncherEditModal(this.plugin.app, this.plugin, launcher, () => this.build()).open();
		info.addEventListener("click", openEdit);
		info.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			openEdit();
		});

		const deleteBtn = rowWrapper.createDiv({ cls: "open-anything-row-delete" });
		deleteBtn.setAttribute("tabindex", "0");
		deleteBtn.setAttribute("role", "button");
		deleteBtn.setAttribute("aria-label", `Delete launcher: ${launcher.name || "Untitled"}`);
		setIcon(deleteBtn, "trash");
		const doDelete = () => {
			void (async () => {
				await this.plugin.removeLauncher(launcher.id);
				this.build();
			})();
		};
		deleteBtn.addEventListener("click", doDelete);
		deleteBtn.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			doDelete();
		});
	}

	/** One-line summary of a launcher's target shown in the compact list row: the command/path/URL for most types, or a step count for sequences (which don't have a single target). */
	private targetPreview(launcher: Launcher): string {
		if (launcher.type === "sequence") {
			const count = launcher.sequenceSteps?.length ?? 0;
			return `${count} step${count === 1 ? "" : "s"}`;
		}
		return launcher.target.trim() || "Not set yet, click to configure";
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
	 * A colored avatar swatch, tinted per launcher type (see LAUNCHER_TYPE_COLOR), showing the
	 * launcher's chosen sidebar icon or a sensible type-appropriate default if none is set.
	 * Click to open the icon picker. Built as my own plain element for the same reason the grip
	 * and chevron are: full control over sizing/alignment rather than fighting the constrained
	 * styling of an addExtraButton, which is meant for small inline icons, not an avatar.
	 */
	private attachIconSwatch(rowEl: HTMLElement, launcher: Launcher): void {
		const swatch = rowEl.createDiv({ cls: "open-anything-icon-swatch" });
		swatch.setAttribute("tabindex", "0");
		swatch.setAttribute("role", "button");
		swatch.setAttribute(
			"aria-label",
			launcher.icon ? `Sidebar icon: ${launcher.icon}. Click to change.` : "No sidebar icon set. Click to choose one."
		);
		setIcon(swatch, launcher.icon || LAUNCHER_TYPE_ICON[launcher.type]);

		const grip = rowEl.querySelector(".open-anything-drag-handle");
		if (grip) grip.after(swatch);
		else rowEl.prepend(swatch);

		const openPicker = () => {
			new IconPickerModal(this.plugin.app, async (iconId) => {
				launcher.icon = iconId ?? "";
				await this.plugin.saveSettings();
				this.plugin.registerLauncherRibbonIcon(launcher);
				this.build();
			}).open();
		};
		swatch.addEventListener("click", openPicker);
		swatch.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			openPicker();
		});
	}

	/**
	 * Begins a pointer-driven drag. A same-height placeholder takes the dragged row's spot in
	 * `list` so the browser's own layout naturally reflows everything else; the dragged row
	 * itself is relocated out of `list` entirely and turned into a `position: fixed` card that
	 * follows the cursor. As the placeholder moves during the drag (see updateDragTarget), its
	 * final position in the DOM directly is the target index, no coordinate math involved.
	 */
	private startDrag(evt: PointerEvent, rowEl: HTMLElement, launcherId: string): void {
		evt.preventDefault();
		const list = rowEl.parentElement;
		if (!list) return;

		const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > .open-anything-row"));
		const startIndex = rows.indexOf(rowEl);
		if (startIndex === -1) return;

		const rowRect = rowEl.getBoundingClientRect();

		const placeholder = activeDocument.createElement("div");
		placeholder.classList.add("open-anything-row-placeholder");
		placeholder.setCssProps({ height: `${rowRect.height}px` });
		rowEl.before(placeholder);

		// Moved to the settings pane's own root, well outside `list`, so `list`'s children stay
		// a clean 1:1 match with settings.launchers (plus exactly one placeholder) for the whole
		// drag. Fixed positioning is relative to the viewport regardless of DOM parent, so this
		// doesn't affect where the floating card visually renders.
		this.containerEl.appendChild(rowEl);

		rowEl.classList.add("open-anything-dragging");
		rowEl.setCssProps({ width: `${rowRect.width}px`, left: `${rowRect.left}px`, top: `${rowRect.top}px` });

		const scrollParent = this.findScrollParent(this.containerEl);
		// Clamp to the actual scrollable viewport, not the full (possibly much taller) content
		// height, so the floating card can't rise above Obsidian's modal header or drop below
		// the visible pane. The auto-scroll loop below is what lets you still reach rows that
		// are currently off-screen, rather than the drag just going dead at this boundary.
		const bounds = scrollParent.getBoundingClientRect();

		this.dragState = {
			launcherId,
			rowEl,
			placeholder,
			list,
			startIndex,
			pointerOffsetY: evt.clientY - rowRect.top,
			minTop: bounds.top,
			maxTop: bounds.bottom - rowRect.height,
			scrollParent,
			lastPointerY: evt.clientY,
		};

		activeDocument.body.classList.add("open-anything-is-dragging");
		activeDocument.addEventListener("pointermove", this.onDragPointerMove);
		activeDocument.addEventListener("pointerup", this.onDragPointerUp, { once: true });
		activeDocument.addEventListener("keydown", this.onDragKeyDown);
		window.requestAnimationFrame(this.dragTick);
	}

	/** Walks up from `el` to find the nearest ancestor that actually scrolls, falling back to the settings pane's own root if nothing more specific scrolls. */
	private findScrollParent(el: HTMLElement): HTMLElement {
		let node: HTMLElement | null = el;
		while (node) {
			const style = window.getComputedStyle(node);
			if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
			node = node.parentElement;
		}
		return this.containerEl;
	}

	private static readonly AUTO_SCROLL_ZONE_PX = 56;
	private static readonly AUTO_SCROLL_MAX_SPEED_PX = 16;

	/**
	 * Runs every frame for the whole duration of a drag, not just when the pointer actually
	 * moves. This is what makes auto-scroll continuous while the pointer sits parked near the
	 * top or bottom edge: without a self-driving loop, nothing would happen between pointermove
	 * events once the cursor itself stops moving, and the list would just stay stuck exactly
	 * where it was, unreachable rows and all.
	 */
	private readonly dragTick = (): void => {
		const state = this.dragState;
		if (!state) return;

		const bounds = state.scrollParent.getBoundingClientRect();
		const zone = OpenAnythingSettingTab.AUTO_SCROLL_ZONE_PX;
		const maxSpeed = OpenAnythingSettingTab.AUTO_SCROLL_MAX_SPEED_PX;

		let scrollBy = 0;
		if (state.lastPointerY < bounds.top + zone) {
			scrollBy = -maxSpeed * (1 - Math.max(0, state.lastPointerY - bounds.top) / zone);
		} else if (state.lastPointerY > bounds.bottom - zone) {
			scrollBy = maxSpeed * (1 - Math.max(0, bounds.bottom - state.lastPointerY) / zone);
		}
		if (scrollBy !== 0) state.scrollParent.scrollBy(0, scrollBy);

		const clampedTop = Math.min(Math.max(state.lastPointerY - state.pointerOffsetY, state.minTop), state.maxTop);
		state.rowEl.setCssProps({ top: `${clampedTop}px` });

		this.updateDragTarget(state);
		window.requestAnimationFrame(this.dragTick);
	};

	/**
	 * Bound once as a class field (not a method) so the same function reference can be passed to
	 * both addEventListener and removeEventListener; an inline arrow function on every drag start
	 * would be a fresh reference each time and couldn't be unregistered correctly.
	 */
	private readonly onDragPointerMove = (evt: PointerEvent): void => {
		const state = this.dragState;
		if (!state) return;
		evt.preventDefault();
		state.lastPointerY = evt.clientY;
	};

	/**
	 * Figures out which row the pointer is currently above and, if that's changed, moves the
	 * placeholder there. Called continuously from dragTick (not just from actual pointer moves),
	 * so this also fires purely as a result of auto-scroll shifting rows under a stationary cursor.
	 */
	private updateDragTarget(state: LauncherDragState): void {
		const siblings = Array.from(state.list.querySelectorAll<HTMLElement>(":scope > .open-anything-row"));
		let target: HTMLElement | null = null;
		for (const sib of siblings) {
			const rect = sib.getBoundingClientRect();
			if (state.lastPointerY < rect.top + rect.height / 2) {
				target = sib;
				break;
			}
		}

		const alreadyInPlace = target ? state.placeholder.nextElementSibling === target : state.placeholder === state.list.lastElementChild;
		if (alreadyInPlace) return;

		// FLIP (First, Last, Invert, Play): measure every remaining row's position before moving
		// the placeholder, let the browser actually reflow them by moving it, measure again, then
		// animate each row from where it visually was to where it now is. This is correct by
		// construction, driven by real measured positions rather than a hand-derived shift
		// formula, since a formula is exactly what kept producing subtly wrong edge cases before.
		const before = new Map(siblings.map((el) => [el, el.getBoundingClientRect()]));

		if (target) target.before(state.placeholder);
		else state.list.appendChild(state.placeholder);

		for (const [el, oldRect] of before) {
			const newRect = el.getBoundingClientRect();
			const dy = oldRect.top - newRect.top;
			if (dy === 0) continue;
			el.setCssProps({ transition: "none", transform: `translateY(${dy}px)` });
			// Two rAFs, not one: the browser needs to actually paint the "snapped to old
			// position" frame before the transition is restored, or the two style writes get
			// batched into a single paint and nothing visibly animates.
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(() => {
					el.setCssProps({ transition: "", transform: "" });
				});
			});
		}
	}

	private readonly onDragPointerUp = (): void => {
		const state = this.dragState;
		if (!state) return;
		this.dragState = null;
		activeDocument.removeEventListener("pointermove", this.onDragPointerMove);
		activeDocument.removeEventListener("keydown", this.onDragKeyDown);
		activeDocument.body.classList.remove("open-anything-is-dragging");

		// The placeholder's own position among the real rows in `list` IS the target index,
		// ground truth from the DOM itself rather than anything computed separately that could
		// drift out of sync with what's actually on screen.
		const finalIndex = Array.from(state.list.children).indexOf(state.placeholder);
		void this.commitReorder(state.launcherId, state.startIndex, finalIndex);
	};

	/** Escape cancels an in-progress drag. Nothing was ever committed to settings.launchers during the drag, only the placeholder moved and rows visually animated, so canceling is just discarding all of that via a full rebuild. */
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

	/** Applies the final reorder to settings, then rebuilds. Rebuilding always happens, even when the index didn't change, so the relocated row, the placeholder, and any leftover animation styles all reset to a clean DOM state. */
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
}

/**
 * Full editor for one launcher: name, type, target, icon, and whatever fields its type needs
 * (working directory, arguments, runtime, sequence steps, run-at-startup). Everything a launcher
 * row used to cram inline gets a real, unhurried modal instead: this is the actual editing
 * surface now, the list row in settings is just a display summary of it.
 */
class LauncherEditModal extends Modal {
	private readonly plugin: OpenAnythingPlugin;
	private readonly launcher: Launcher;
	private readonly onSaved: () => void;

	constructor(app: App, plugin: OpenAnythingPlugin, launcher: Launcher, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.launcher = launcher;
		this.onSaved = onSaved;
		this.modalEl.addClass("open-anything-edit-modal");
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		this.onSaved();
	}

	private async persist(): Promise<void> {
		await this.plugin.saveSettings();
	}

	private render(): void {
		const { contentEl, launcher } = this;
		contentEl.empty();
		this.setTitle(launcher.name || "Untitled launcher");

		new Setting(contentEl).setName("Name").addText((text) =>
			text
				.setPlaceholder("Name")
				.setValue(launcher.name)
				.onChange(async (value) => {
					launcher.name = value;
					this.setTitle(value || "Untitled launcher");
					await this.persist();
					this.plugin.registerLauncherCommand(launcher);
				})
		);

		new Setting(contentEl)
			.setName("Type")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ terminal: "Terminal", app: "App", url: "Website", script: "Script", sequence: "Sequence" })
					.setValue(launcher.type)
					.onChange(async (value) => {
						launcher.type = value as LauncherType;
						if (value === "script" && !launcher.scriptRuntime) launcher.scriptRuntime = "js";
						if (value === "sequence" && !launcher.sequenceSteps) launcher.sequenceSteps = [];
						await this.persist();
						this.plugin.registerLauncherRibbonIcon(launcher);
						this.render();
					})
			);

		new Setting(contentEl)
			.setName("Sidebar icon")
			.setDesc(launcher.icon ? launcher.icon : "None set, the ribbon has no button for this launcher.")
			.addButton((button: ButtonComponent) =>
				button.setButtonText(launcher.icon ? "Change" : "Choose").onClick(() => {
					new IconPickerModal(this.app, async (iconId) => {
						launcher.icon = iconId ?? "";
						await this.persist();
						this.plugin.registerLauncherRibbonIcon(launcher);
						this.render();
					}).open();
				})
			);

		if (launcher.type !== "sequence") {
			const placeholder =
				launcher.type === "url"
					? "https://example.com"
					: launcher.type === "app"
						? "app name or path"
						: launcher.type === "script"
							? "path/to/script.js, relative to vault root"
							: "shell command";
			new Setting(contentEl)
				.setName(launcher.type === "url" ? "URL" : launcher.type === "script" ? "Script path" : "Target")
				.addText((text) =>
					text
						.setPlaceholder(placeholder)
						.setValue(launcher.target)
						.onChange(async (value) => {
							launcher.target = value;
							await this.persist();
						})
				);
		}

		new Setting(contentEl)
			.setName("Run at startup")
			.setDesc("Run this launcher once automatically after Obsidian finishes loading. If several launchers have this on, they all fire independently, there's no guaranteed order between them.")
			.addToggle((toggle) =>
				toggle.setValue(launcher.runOnStartup ?? false).onChange(async (value) => {
					launcher.runOnStartup = value;
					await this.persist();
				})
			);

		if (launcher.type === "terminal") {
			this.renderWorkingDirField("Optional, relative to the vault root. Overrides the global working directory setting for this launcher only.");
		}

		if (launcher.type === "app") {
			new Setting(contentEl)
				.setName("Arguments")
				.setDesc("Optional, space-separated. Passed to the target as-is; quoting isn't supported yet. On Windows, .bat and .cmd targets are supported too.")
				.addText((text) =>
					text
						.setPlaceholder("--flag value")
						.setValue(launcher.appArgs ?? "")
						.onChange(async (value) => {
							launcher.appArgs = value;
							await this.persist();
						})
				);
			this.renderWorkingDirField("Optional, relative to the vault root. Overrides the global working directory setting for this launcher only.");
		}

		if (launcher.type === "script") {
			new Setting(contentEl)
				.setName("Runtime")
				.setDesc('"js" runs in Obsidian\'s own process; "py" is spawned as a separate Python process and can\'t access the vault directly.')
				.addDropdown((dropdown) =>
					dropdown
						.addOptions({ js: "JavaScript (.js)", py: "Python (.py)" })
						.setValue(launcher.scriptRuntime ?? "js")
						.onChange(async (value) => {
							launcher.scriptRuntime = value as ScriptRuntime;
							await this.persist();
						})
				);
			new Setting(contentEl)
				.setName("Arguments")
				.setDesc("Optional, space-separated. Passed to the script as-is; quoting isn't supported yet.")
				.addText((text) =>
					text
						.setPlaceholder("--flag value")
						.setValue(launcher.scriptArgs ?? "")
						.onChange(async (value) => {
							launcher.scriptArgs = value;
							await this.persist();
						})
				);
			this.renderWorkingDirField(
				'Optional, relative to the vault root. Overrides the global working directory setting. Only affects "py" scripts; "js" scripts always resolve their own path from the vault root regardless.'
			);
		}

		if (launcher.type === "sequence") this.renderSequenceSteps();

		new Setting(contentEl).addButton((button: ButtonComponent) =>
			button
				.setButtonText("Delete this launcher")
				.setClass("open-anything-modal-delete")
				.onClick(async () => {
					await this.plugin.removeLauncher(launcher.id);
					this.close();
				})
		);
	}

	private renderWorkingDirField(desc: string): void {
		new Setting(this.contentEl)
			.setName("Working directory")
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder("(Uses the global setting)")
					.setValue(this.launcher.customWorkingDir ?? "")
					.onChange(async (value) => {
						this.launcher.customWorkingDir = value;
						await this.persist();
					})
			);
	}

	private renderSequenceSteps(): void {
		const { contentEl, launcher } = this;
		const steps = launcher.sequenceSteps ?? (launcher.sequenceSteps = []);

		new Setting(contentEl).setName("Steps").setDesc("Runs top to bottom. A sequence can't contain another sequence.").setHeading();

		if (steps.length === 0) {
			contentEl.createEl("p", { text: "No steps yet, add one below.", cls: "setting-item-description" });
		}

		steps.forEach((stepId, index) => {
			const step = this.plugin.settings.launchers.find((l) => l.id === stepId);
			const stepRow = new Setting(contentEl).setName(step ? step.name : "(deleted launcher)");
			stepRow.settingEl.classList.add("open-anything-sequence-step");

			stepRow.addButton((button: ButtonComponent) =>
				button
					.setIcon("arrow-up")
					.setTooltip("Move up")
					.setDisabled(index === 0)
					.onClick(async () => {
						[steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
						await this.persist();
						this.render();
					})
			);
			stepRow.addButton((button: ButtonComponent) =>
				button
					.setIcon("arrow-down")
					.setTooltip("Move down")
					.setDisabled(index === steps.length - 1)
					.onClick(async () => {
						[steps[index], steps[index + 1]] = [steps[index + 1], steps[index]];
						await this.persist();
						this.render();
					})
			);
			stepRow.addButton((button: ButtonComponent) =>
				button
					.setIcon("x")
					.setTooltip("Remove from sequence")
					.onClick(async () => {
						steps.splice(index, 1);
						await this.persist();
						this.render();
					})
			);
		});

		// Only non-sequence launchers not already in this sequence can be added, which rules
		// out both self-reference and nested sequences at the point of selection.
		const available = this.plugin.settings.launchers.filter(
			(l) => l.type !== "sequence" && l.id !== launcher.id && !steps.includes(l.id)
		);
		if (available.length > 0) {
			new Setting(contentEl).setName("Add step").addDropdown((dropdown) => {
				dropdown.addOption("", "Choose a launcher...");
				for (const candidate of available) dropdown.addOption(candidate.id, candidate.name || "Untitled");
				dropdown.setValue("").onChange(async (value) => {
					if (!value) return;
					steps.push(value);
					await this.persist();
					this.render();
				});
			});
		}

		new Setting(contentEl)
			.setName("Stop on error")
			.setDesc("If a step fails, stop the sequence right there instead of running the rest anyway. Off means every step gets a chance to run no matter what happened before it.")
			.addToggle((toggle) =>
				toggle.setValue(launcher.sequenceStopOnError ?? true).onChange(async (value) => {
					launcher.sequenceStopOnError = value;
					await this.persist();
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
