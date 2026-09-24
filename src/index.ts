import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IdeClient } from "./client.ts";
import { detectCliFallback, diffInIde, openInIde, resolveEditorCli } from "./cli-fallback.ts";
import { loadConfig, saveConfig } from "./config.ts";
import {
	IDE_CONTEXT_SECTION,
	appendMentionToEditor,
	formatIdeContext,
	formatMention,
	formatMentions,
	formatSelectionStatus,
} from "./context.ts";
import { bestConnections, connectionLabel, listConnections } from "./discover.ts";
import { installBridge, isBridgeInstalled } from "./install.ts";
import type { CliFallback, IdeConfig, IdeConnection, IdeMention, IdeSelection } from "./types.ts";

const ALL_IDE_TOOLS = [
	"ide_open_file",
	"ide_open_diff",
	"ide_get_selection",
	"ide_get_diagnostics",
	"ide_get_open_editors",
	"ide_get_workspace_folders",
] as const;

const WS_TOOLS = [...ALL_IDE_TOOLS];
const CLI_TOOLS = ["ide_open_file", "ide_open_diff"] as const;

/**
 * The Claude IDE helper keeps exactly one MCP client per port: every new
 * connection closes the previous one (code 1005, no reason). A socket that dies
 * this fast means another client — usually a Claude Code CLI session on the same
 * window — took the slot, so retrying immediately just makes both sides flap.
 */
const CONTENDED_UPTIME_MS = 3_000;
const CONTENDED_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

type Runtime = {
	config: IdeConfig;
	cwd: string;
	ui?: ExtensionContext["ui"];
	hasUI: boolean;
	client?: IdeClient;
	cli?: CliFallback;
	selection?: IdeSelection;
	mentions: IdeMention[];
	poll?: ReturnType<typeof setInterval>;
	attaching: boolean;
	disposed: boolean;
	lastError?: string;
	installAttempted: boolean;
	contendedStreak: number;
	backoffUntil: number;
	contendedNotified: boolean;
	/** Port chosen explicitly with /ide attach; automatic reattach goes back to it. */
	pinnedPort?: number;
	/** Windows tied for the best workspace match, which automatic attach refuses to choose between. */
	ambiguous?: IdeConnection[];
};

export default function piIdeIntegration(pi: ExtensionAPI) {
	let runtime: Runtime | undefined;

	registerIdeTools(pi, () => runtime);

	pi.on("session_start", async (_event, ctx) => {
		disposeRuntime(runtime, pi);
		runtime = {
			config: loadConfig(),
			cwd: ctx.cwd,
			ui: ctx.ui,
			hasUI: ctx.hasUI,
			mentions: [],
			attaching: false,
			disposed: false,
			installAttempted: false,
			contendedStreak: 0,
			backoffUntil: 0,
			contendedNotified: false,
		};
		setIdeTools(pi, []);
		if (runtime.config.autoAttach) {
			await attachBest(pi, runtime, { quiet: true });
			if (runtime.hasUI) startPoll(pi, runtime);
		}
		refreshStatus(runtime);
	});

	pi.on("session_shutdown", () => {
		disposeRuntime(runtime, pi);
		runtime = undefined;
	});

	pi.on("before_agent_start", async (event) => {
		if (!runtime) return;
		const mentions = runtime.mentions;
		runtime.mentions = [];
		if (!runtime.config.injectSelection) return;

		// Sections are rebuilt every run, so leaving this unset tells Pi to remove it.
		const ideContext = runtime.client?.connected
			? formatIdeContext(runtime.selection, runtime.config.maxSelectionChars)
			: undefined;
		if (ideContext) event.systemPromptOptions.sections[IDE_CONTEXT_SECTION] = ideContext;

		// Mentions are one-shot, so they ride along as a message instead of churning the section.
		const unsent = formatMentions(mentions.filter((mention) => !event.prompt.includes(formatMention(mention))));
		if (!unsent) return;
		return { message: { customType: "ide-mentions", content: unsent, display: false } };
	});

	pi.registerCommand("ide", {
		description: "Attach this Pi session to a VS Code-family IDE (attach, detach, install, status, auto)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "attach", label: "attach — connect to a matching IDE lockfile" },
				{ value: "detach", label: "detach — drop the IDE connection" },
				{ value: "status", label: "status — show attach state" },
				{ value: "auto on", label: "auto on — attach on session start" },
				{ value: "auto off", label: "auto off — do not auto-attach" },
				{ value: "install", label: "install — install the Pi IDE Bridge extension into this editor" },
			];
			const trimmed = prefix.trim().toLowerCase();
			const filtered = items.filter((item) => item.value.startsWith(trimmed));
			return filtered.length > 0 ? filtered : items;
		},
		handler: async (args, ctx) => {
			if (!runtime || runtime.disposed) {
				ctx.ui.notify("IDE integration is not active in this session", "warning");
				return;
			}
			runtime.ui = ctx.ui;
			runtime.cwd = ctx.cwd;
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const verb = (tokens[0] ?? "").toLowerCase();

			if (verb === "install") {
				await installCommand(runtime, ctx.ui, { force: true });
				await attachBest(pi, runtime, { quiet: false });
				return;
			}

			// Status stays read-only; only an explicit attach may put a bridge in the editor.
			if (verb === "attach") await ensureBridge(runtime, ctx.ui);

			if (!verb || verb === "status") {
				ctx.ui.notify(statusText(runtime), runtime.client ? "info" : "warning");
				return;
			}

			if (verb === "detach") {
				await detach(pi, runtime);
				ctx.ui.notify("Detached from IDE", "info");
				return;
			}

			if (verb === "auto") {
				const value = (tokens[1] ?? "").toLowerCase();
				if (value !== "on" && value !== "off") {
					ctx.ui.notify("Usage: /ide auto on|off", "warning");
					return;
				}
				runtime.config.autoAttach = value === "on";
				saveConfig(runtime.config);
				if (runtime.config.autoAttach) {
					await attachBest(pi, runtime, { quiet: false });
					if (runtime.hasUI) startPoll(pi, runtime);
				} else {
					stopPoll(runtime);
				}
				ctx.ui.notify(`IDE auto-attach ${value}`, "info");
				return;
			}

			if (verb === "attach") {
				const query = tokens.slice(1).join(" ").trim().toLowerCase();
				const connections = listConnections(runtime.cwd, runtime.config.extraLockDirs);
				if (connections.length === 0) {
					const attached = await attachCli(pi, runtime, { requireIdeEnv: false });
					ctx.ui.notify(
						attached ? `No IDE lockfile. Using ${runtime.cli?.label} CLI.` : "No matching IDE lockfile or CLI found.",
						attached ? "warning" : "error",
					);
					return;
				}

				let chosen = connections[0];
				if (query) {
					const match = connections.find((connection) =>
						connectionLabel(connection).toLowerCase().includes(query) ||
						(connection.ideName ?? "").toLowerCase().includes(query) ||
						String(connection.port) === query,
					);
					if (!match) {
						ctx.ui.notify(`No IDE matched ${query}`, "warning");
						return;
					}
					chosen = match;
				} else if (connections.length > 1 && ctx.hasUI) {
					const labels = connections.map((connection) => connectionLabel(connection));
					const picked = await ctx.ui.select("Attach IDE", labels);
					if (!picked) return;
					chosen = connections[labels.indexOf(picked)] ?? chosen;
				}

				try {
					await attachConnection(pi, runtime, chosen);
					runtime.pinnedPort = chosen.port;
					runtime.ambiguous = undefined;
					ctx.ui.notify(`Attached to ${runtime.client?.connection.ideName ?? "IDE"}`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			ctx.ui.notify("Usage: /ide [attach|detach|install|status|auto on|auto off]", "warning");
		},
	});
}

function registerIdeTools(pi: ExtensionAPI, getRuntime: () => Runtime | undefined) {
	pi.registerTool({
		name: "ide_open_file",
		label: "IDE Open File",
		description: "Open a file in the attached VS Code-family IDE and optionally reveal a line.",
		promptSnippet: "Open a file in the attached IDE",
		promptGuidelines: ["Use ide_open_file when the user should jump to a file or line in the attached editor."],
		parameters: Type.Object({
			filePath: Type.String({ description: "Absolute path of the file to open" }),
			line: Type.Optional(Type.Number({ description: "1-based line number to reveal and select" })),
			endLine: Type.Optional(Type.Number({ description: "1-based last line of the selection" })),
			character: Type.Optional(Type.Number({ description: "0-based column on `line`" })),
			preview: Type.Optional(Type.Boolean({ description: "Open as a preview tab when the IDE supports it" })),
		}),
		async execute(_id, params) {
			const runtime = requireRuntime(getRuntime());
			if (runtime.client) {
				return textResult(
					await runtime.client.callTool("openFile", {
						filePath: params.filePath,
						line: params.line,
						endLine: params.endLine,
						character: params.character,
						preview: params.preview ?? false,
						makeFrontmost: true,
					}),
				);
			}
			if (runtime.cli) {
				return textResult(await openInIde(runtime.cli, params.filePath, params.line, params.character));
			}
			return textResult("No IDE attached. Run /ide attach.", true);
		},
	});

	pi.registerTool({
		name: "ide_open_diff",
		label: "IDE Open Diff",
		description: "Show a proposed file change as a diff tab in the attached IDE.",
		promptSnippet: "Open an IDE diff for a proposed edit",
		promptGuidelines: ["Use ide_open_diff to present a proposed file change in the attached editor."],
		parameters: Type.Object({
			oldFilePath: Type.String({ description: "Path of the original file" }),
			newFilePath: Type.String({ description: "Path of the new file" }),
			newFileContents: Type.Optional(Type.String({ description: "Proposed contents of the new file" })),
			tabName: Type.Optional(Type.String({ description: "Diff tab title" })),
		}),
		async execute(_id, params) {
			const runtime = requireRuntime(getRuntime());
			if (runtime.client) {
				return textResult(
					await runtime.client.callTool("openDiff", {
						oldFilePath: params.oldFilePath,
						newFilePath: params.newFilePath,
						newFileContents: params.newFileContents,
						tabName: params.tabName ?? "Proposed changes",
					}),
				);
			}
			if (runtime.cli) {
				return textResult(await diffInIde(runtime.cli, params.oldFilePath, params.newFilePath));
			}
			return textResult("No IDE attached. Run /ide attach.", true);
		},
	});

	pi.registerTool({
		name: "ide_get_selection",
		label: "IDE Selection",
		description: "Get the current or latest text selection from the attached IDE.",
		promptSnippet: "Read the current IDE selection",
		promptGuidelines: ["Use ide_get_selection to read highlighted editor text instead of asking the user to paste it."],
		parameters: Type.Object({}),
		async execute() {
			const runtime = requireRuntime(getRuntime());
			if (!runtime.client) return textResult("No IDE websocket attached.", true);
			for (const tool of ["getCurrentSelection", "getLatestSelection"]) {
				if (runtime.client.toolNames().length > 0 && !runtime.client.hasTool(tool)) continue;
				try {
					return textResult(await runtime.client.callTool(tool));
				} catch {
					// Fall through to the next tool, then to the cached selection.
				}
			}
			if (!runtime.selection) return textResult("No selection cached from the IDE.");
			return textResult(JSON.stringify(runtime.selection, null, 2));
		},
	});

	pi.registerTool({
		name: "ide_get_diagnostics",
		label: "IDE Diagnostics",
		description: "Get LSP / linter diagnostics from the attached IDE.",
		promptSnippet: "Read IDE diagnostics",
		promptGuidelines: ["Use ide_get_diagnostics after edits to see IDE-reported errors instead of guessing."],
		parameters: Type.Object({
			uri: Type.Optional(Type.String({ description: "Optional file URI or path to filter diagnostics" })),
		}),
		async execute(_id, params) {
			const runtime = requireRuntime(getRuntime());
			if (!runtime.client) return textResult("No IDE websocket attached.", true);
			const args = params.uri ? { uri: params.uri } : {};
			return textResult(await runtime.client.callTool("getDiagnostics", args));
		},
	});

	pi.registerTool({
		name: "ide_get_open_editors",
		label: "IDE Open Editors",
		description: "List files currently open in the attached IDE.",
		promptSnippet: "List open IDE editors",
		promptGuidelines: ["Use ide_get_open_editors to see which files the user currently has open."],
		parameters: Type.Object({}),
		async execute() {
			const runtime = requireRuntime(getRuntime());
			if (!runtime.client) return textResult("No IDE websocket attached.", true);
			return textResult(await runtime.client.callTool("getOpenEditors"));
		},
	});

	pi.registerTool({
		name: "ide_get_workspace_folders",
		label: "IDE Workspace Folders",
		description: "List workspace folders open in the attached IDE.",
		promptSnippet: "List IDE workspace folders",
		promptGuidelines: ["Use ide_get_workspace_folders to confirm which folders the attached IDE has open."],
		parameters: Type.Object({}),
		async execute() {
			const runtime = requireRuntime(getRuntime());
			if (!runtime.client) return textResult("No IDE websocket attached.", true);
			return textResult(await runtime.client.callTool("getWorkspaceFolders"));
		},
	});
}

/**
 * Put the Pi IDE Bridge in the editor if this workspace has no bridge yet. Runs
 * at most once per session so a window that simply is not a VS Code family
 * editor does not retry on every command.
 */
async function ensureBridge(runtime: Runtime, ui: ExtensionContext["ui"]): Promise<void> {
	if (!runtime.config.autoInstall || runtime.installAttempted) return;
	if (listConnections(runtime.cwd, runtime.config.extraLockDirs).length > 0) return;
	await installCommand(runtime, ui, { force: false });
}

async function installCommand(
	runtime: Runtime,
	ui: ExtensionContext["ui"],
	options: { force: boolean },
): Promise<boolean> {
	runtime.installAttempted = true;
	if (!options.force && listConnections(runtime.cwd, runtime.config.extraLockDirs).length > 0) return true;

	ui.notify("Installing the Pi IDE Bridge extension…", "info");
	const outcome = await installBridge(runtime.cwd, runtime.config.extraLockDirs, {
		editorCli: runtime.config.editorCli,
	});
	if (!outcome.installed) {
		runtime.lastError = outcome.message;
		ui.notify(outcome.message, "error");
		return false;
	}
	if (!outcome.serving) runtime.lastError = outcome.message;
	ui.notify(outcome.message, outcome.serving ? "info" : "warning");
	return outcome.serving;
}

async function attachBest(pi: ExtensionAPI, runtime: Runtime, options: { quiet: boolean }): Promise<boolean> {
	if (runtime.client?.connected) return true;
	const connections = listConnections(runtime.cwd, runtime.config.extraLockDirs);
	const pinned = connections.find((connection) => connection.port === runtime.pinnedPort);
	const candidates = pinned ? [pinned] : bestConnections(connections);
	if (candidates.length > 1) {
		const alreadyReported = runtime.ambiguous !== undefined;
		runtime.ambiguous = candidates;
		runtime.lastError = `${candidates.length} IDE windows match this folder equally (${candidates
			.map((connection) => connectionLabel(connection))
			.join("; ")}). Run /ide attach to pick one.`;
		if (!options.quiet || !alreadyReported) runtime.ui?.notify(runtime.lastError, "warning");
		refreshStatus(runtime);
		return false;
	}
	runtime.ambiguous = undefined;
	for (const connection of candidates) {
		try {
			await attachConnection(pi, runtime, connection);
			if (!options.quiet) runtime.ui?.notify(`Attached to ${connection.ideName ?? "IDE"}`, "info");
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/websocket closed/i.test(message)) {
				noteContended(runtime, connection, message);
			} else {
				runtime.lastError = message;
			}
		}
	}
	return attachCli(pi, runtime, { requireIdeEnv: true });
}

async function attachConnection(pi: ExtensionAPI, runtime: Runtime, connection: IdeConnection): Promise<void> {
	if (runtime.attaching) throw new Error("An IDE attach is already in progress");
	runtime.attaching = true;
	try {
		runtime.client?.dispose();
		runtime.client = await IdeClient.connect(connection, {
			onSelection: (selection) => {
				runtime.selection = selection;
				refreshStatus(runtime);
			},
			onMention: (mention) => {
				runtime.mentions.push(mention);
				if (runtime.ui) {
					try {
						runtime.ui.setEditorText(appendMentionToEditor(runtime.ui.getEditorText() ?? "", mention));
					} catch {
						// RPC / print modes may not support editor writes.
					}
					runtime.ui.notify(`IDE mentioned ${formatMention(mention)}`, "info");
				}
			},
			onClose: (code) => {
				if (runtime.disposed) return;
				const uptimeMs = runtime.client?.uptimeMs;
				runtime.client = undefined;
				noteClose(runtime, connection, code, uptimeMs);
				setIdeTools(pi, runtime.cli ? [...CLI_TOOLS] : []);
				refreshStatus(runtime);
			},
		});
		runtime.cli = undefined;
		runtime.lastError = undefined;
		runtime.backoffUntil = 0;
		setIdeTools(pi, [...WS_TOOLS]);
		refreshStatus(runtime);
	} finally {
		runtime.attaching = false;
	}
}

async function attachCli(
	pi: ExtensionAPI,
	runtime: Runtime,
	options: { requireIdeEnv: boolean },
): Promise<boolean> {
	// Automatic fallback trusts only the terminal's own editor; an explicit attach uses the configured one.
	const cli =
		!options.requireIdeEnv && runtime.config.editorCli
			? resolveEditorCli(runtime.config.editorCli, process.env)
			: detectCliFallback(process.env, options);
	if (!cli) {
		setIdeTools(pi, []);
		refreshStatus(runtime);
		return false;
	}
	runtime.cli = cli;
	setIdeTools(pi, [...CLI_TOOLS]);
	refreshStatus(runtime);
	return true;
}

async function detach(pi: ExtensionAPI, runtime: Runtime): Promise<void> {
	stopPoll(runtime);
	runtime.client?.dispose();
	runtime.client = undefined;
	runtime.cli = undefined;
	runtime.selection = undefined;
	runtime.mentions = [];
	runtime.pinnedPort = undefined;
	runtime.ambiguous = undefined;
	runtime.contendedStreak = 0;
	runtime.backoffUntil = 0;
	runtime.contendedNotified = false;
	setIdeTools(pi, []);
	refreshStatus(runtime);
}

function startPoll(pi: ExtensionAPI, runtime: Runtime): void {
	stopPoll(runtime);
	runtime.poll = setInterval(() => {
		if (runtime.disposed || runtime.client?.connected || runtime.attaching) return;
		if (!runtime.config.autoAttach) return;
		if (Date.now() < runtime.backoffUntil) return;
		void attachBest(pi, runtime, { quiet: true });
	}, runtime.config.pollIntervalMs);
	runtime.poll.unref?.();
}

function stopPoll(runtime: Runtime): void {
	if (!runtime.poll) return;
	clearInterval(runtime.poll);
	runtime.poll = undefined;
}

function disposeRuntime(runtime: Runtime | undefined, pi: ExtensionAPI): void {
	if (!runtime) return;
	runtime.disposed = true;
	stopPoll(runtime);
	runtime.client?.dispose();
	runtime.client = undefined;
	setIdeTools(pi, []);
}

function setIdeTools(pi: ExtensionAPI, enabled: string[]): void {
	const hide = new Set<string>(ALL_IDE_TOOLS);
	const kept = pi.getActiveTools().filter((name) => !hide.has(name));
	pi.setActiveTools([...kept, ...enabled]);
}

function refreshStatus(runtime: Runtime): void {
	if (!runtime.ui) return;
	if (runtime.client?.connected) {
		const name = runtime.client.connection.ideName ?? runtime.client.server?.name ?? "IDE";
		const selection = formatSelectionStatus(runtime.selection);
		runtime.ui.setStatus("ide", selection ? `IDE ${name} · ${selection}` : `IDE ${name}`);
		return;
	}
	if (runtime.cli) {
		runtime.ui.setStatus("ide", `IDE ${runtime.cli.label} (cli)`);
		return;
	}
	if (runtime.ambiguous) {
		runtime.ui.setStatus("ide", `IDE ? ${runtime.ambiguous.length} windows · /ide attach`);
		return;
	}
	runtime.ui.setStatus("ide", undefined);
}

function statusText(runtime: Runtime): string {
	if (runtime.client?.connected) {
		const connection = runtime.client.connection;
		const tools = runtime.client.toolNames();
		const selection = runtime.selection
			? `${runtime.selection.filePath} ${runtime.selection.ranges
					.map((range) => `L${range.selection.start.line + 1}-${range.selection.end.line + 1}`)
					.join(",")}`
			: "none";
		return [
			`Attached to ${connection.ideName ?? "IDE"} via ${connection.source}`,
			`workspace: ${connection.workspaceFolders.join(", ") || "(unknown)"}`,
			`tools: ${tools.length > 0 ? tools.join(", ") : "(none advertised)"}`,
			`selection: ${selection}`,
		].join("\n");
	}
	if (runtime.cli) {
		return `No IDE lockfile matched this cwd. CLI fallback: ${runtime.cli.label} (${runtime.cli.bin})`;
	}
	return runtime.lastError
		? `Not attached. Last error: ${runtime.lastError}`
		: "Not attached. Open a VS Code-family IDE on this folder, or run /ide attach.";
}

/**
 * Classify a websocket close. Anything shorter than CONTENDED_UPTIME_MS means the
 * IDE handed its single client slot to somebody else, so back off instead of
 * reconnecting into a flap.
 */
function noteClose(runtime: Runtime, connection: IdeConnection, code: number, uptimeMs: number | undefined): void {
	const detail = `IDE websocket closed (${code})`;
	if (uptimeMs !== undefined && uptimeMs >= CONTENDED_UPTIME_MS) {
		runtime.contendedStreak = 0;
		runtime.contendedNotified = false;
		runtime.backoffUntil = 0;
		runtime.lastError = detail;
		return;
	}
	noteContended(runtime, connection, detail);
}

function noteContended(runtime: Runtime, connection: IdeConnection, detail: string): void {
	runtime.contendedStreak += 1;
	const index = Math.min(runtime.contendedStreak - 1, CONTENDED_BACKOFF_MS.length - 1);
	runtime.backoffUntil = Date.now() + CONTENDED_BACKOFF_MS[index];
	runtime.lastError = `${detail}. ${contendedHint(connection)}`;
	if (runtime.contendedStreak >= 3 && !runtime.contendedNotified) {
		runtime.contendedNotified = true;
		runtime.ui?.notify(runtime.lastError, "warning");
	}
}

function contendedHint(connection: IdeConnection): string {
	const name = connection.ideName ?? "The IDE";
	return `${name} on port ${connection.port} dropped the connection immediately. Check the Pi IDE Bridge output channel in the editor, or run "Pi: Restart IDE Bridge" from its command palette.`;
}

function requireRuntime(runtime: Runtime | undefined): Runtime {
	if (!runtime || runtime.disposed) throw new Error("IDE integration is not active in this session");
	return runtime;
}

function textResult(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: { isError },
	};
}
