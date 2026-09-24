import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IdeClient } from "./client.ts";
import { IDE_CONTEXT_SECTION, formatIdeContext, formatSelectionStatus } from "./context.ts";
import { bestWindows, matchingWindows, windowKey, windowLabel, type IdeWindow } from "./discover.ts";

const POLL_INTERVAL_MS = 2_500;
const NOT_ATTACHED = "No VS Code window is attached. Open this folder in VS Code with the Pi bridge installed, or run /ide attach.";

/** Per-session state. A disposed runtime belongs to a replaced session and must not touch its stale `ui`. */
type Runtime = {
	cwd: string;
	ui: ExtensionContext["ui"];
	poll: ReturnType<typeof setInterval>;
	/** The selection lives on the client, so dropping the client drops the selection. */
	client?: IdeClient;
	/** Set by /ide detach; automatic attach stays off until /ide attach. */
	detached: boolean;
	attaching: boolean;
	disposed: boolean;
	/** Windows tied for the most specific workspace match, which automatic attach will not choose between. */
	tied?: IdeWindow[];
	lastError?: string;
};

const jsonResult = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	details: undefined,
});

export default function piVscode(pi: ExtensionAPI) {
	let runtime: Runtime | undefined;
	/** The window chosen with /ide attach, so reconnects after it restarts return to it. Pi re-runs the factory per session, so this does not outlive one. */
	let pinnedKey: string | undefined;

	const requireClient = (): IdeClient => {
		const client = runtime?.disposed ? undefined : runtime?.client;
		if (!client?.connected) throw new Error(NOT_ATTACHED);
		return client;
	};

	const chooseWindow = (current: Runtime, windows: IdeWindow[]): IdeWindow | undefined => {
		const pinned = windows.find((window) => windowKey(window) === pinnedKey);
		if (pinned) return pinned;
		const best = bestWindows(windows);
		if (best.length <= 1) {
			current.tied = undefined;
			if (!best[0]) current.lastError = "No VS Code window has this folder open.";
			return best[0];
		}
		const alreadyReported = current.tied?.map(windowKey).join("\n") === best.map(windowKey).join("\n");
		current.tied = best;
		current.lastError = `${best.length} windows have this folder open equally (${best.map(windowLabel).join("; ")}). Run /ide attach to pick one.`;
		if (!alreadyReported) current.ui.notify(current.lastError, "warning");
		return undefined;
	};

	const attach = async (current: Runtime): Promise<void> => {
		if (current.disposed || current.detached || current.attaching || current.client) return;
		current.attaching = true;
		try {
			const target = chooseWindow(current, matchingWindows(current.cwd));
			if (!target) return;
			const client = await IdeClient.connect(target, {
				onSelection: (updated) => {
					if (!current.disposed && current.client === updated) refreshStatus(current);
				},
				onClose: (closed, code) => {
					if (current.disposed || current.client !== closed) return;
					current.client = undefined;
					current.lastError = `${windowLabel(target)} closed the connection (${code}).`;
					refreshStatus(current);
				},
			});
			if (current.disposed || current.detached || !client.connected) {
				if (!client.connected) current.lastError = `${windowLabel(target)} closed the connection.`;
				client.dispose();
				return;
			}
			current.client = client;
			current.tied = undefined;
			current.lastError = undefined;
		} catch (error) {
			current.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			current.attaching = false;
			refreshStatus(current);
		}
	};

	const dropClient = (current: Runtime): void => {
		current.client?.dispose();
		current.client = undefined;
	};

	const attachCommand = async (current: Runtime, ctx: ExtensionCommandContext): Promise<void> => {
		current.detached = false;
		const best = bestWindows(matchingWindows(current.cwd));
		if (best.length > 1) {
			const labels = best.map(windowLabel);
			const picked = await ctx.ui.select("Attach to which window?", labels);
			const chosen = best[labels.indexOf(picked ?? "")];
			if (!chosen) return;
			pinnedKey = windowKey(chosen);
			if (current.client && windowKey(current.client.window) !== pinnedKey) dropClient(current);
		}
		await attach(current);
		if (current.client) ctx.ui.notify(`Attached to ${windowLabel(current.client.window)}`, "info");
		else ctx.ui.notify(`Not attached. ${current.lastError ?? ""}`.trim(), "warning");
	};

	pi.registerTool({
		name: "ide_get_diagnostics",
		label: "VS Code Diagnostics",
		description: "Get the errors and warnings VS Code reports, for one file or for every file that has any.",
		promptSnippet: "Read VS Code errors and warnings",
		promptGuidelines: ["Use ide_get_diagnostics after edits to check VS Code's errors and warnings instead of guessing."],
		parameters: Type.Object({
			filePath: Type.Optional(Type.String({ description: "Absolute file path; omit for every file with diagnostics" })),
		}),
		async execute(_id, params) {
			return jsonResult(await requireClient().request("getDiagnostics", { filePath: params.filePath }));
		},
	});

	pi.registerTool({
		name: "ide_get_open_editors",
		label: "VS Code Open Editors",
		description: "List the files open in VS Code tabs, marking the active one and any with unsaved changes.",
		promptSnippet: "List files open in VS Code",
		promptGuidelines: ["Use ide_get_open_editors to see which files the user has open in VS Code."],
		parameters: Type.Object({}),
		async execute() {
			return jsonResult(await requireClient().request("getOpenEditors"));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (runtime) disposeRuntime(runtime);
		const current: Runtime = {
			cwd: ctx.cwd,
			ui: ctx.ui,
			poll: setInterval(() => void attach(current), POLL_INTERVAL_MS),
			detached: false,
			attaching: false,
			disposed: false,
		};
		current.poll.unref();
		runtime = current;
		await attach(current);
	});

	pi.on("session_shutdown", () => {
		if (runtime) disposeRuntime(runtime);
		runtime = undefined;
	});

	pi.on("before_agent_start", (event) => {
		const selection = runtime?.client?.selection;
		if (!selection) return;
		// Sections are rebuilt every run, so skipping this when detached is what makes Pi remove the section.
		event.systemPromptOptions.sections[IDE_CONTEXT_SECTION] = formatIdeContext(selection);
	});

	pi.registerCommand("ide", {
		description: "VS Code bridge: status, attach, detach",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status — show the connection" },
				{ value: "attach", label: "attach — connect, choosing between windows if several match" },
				{ value: "detach", label: "detach — disconnect and stop reconnecting" },
			];
			const matches = items.filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches : items;
		},
		handler: async (args, ctx) => {
			const current = runtime;
			if (!current || current.disposed) {
				ctx.ui.notify("The VS Code bridge is not active in this session.", "warning");
				return;
			}
			const verb = args.trim().toLowerCase();
			if (verb === "" || verb === "status") {
				ctx.ui.notify(statusText(current), current.client ? "info" : "warning");
			} else if (verb === "attach") {
				await attachCommand(current, ctx);
			} else if (verb === "detach") {
				current.detached = true;
				current.tied = undefined;
				current.lastError = undefined;
				dropClient(current);
				refreshStatus(current);
				ctx.ui.notify("Detached from VS Code. Run /ide attach to reconnect.", "info");
			} else {
				ctx.ui.notify("Usage: /ide [status|attach|detach]", "warning");
			}
		},
	});
}

function disposeRuntime(runtime: Runtime): void {
	runtime.disposed = true;
	clearInterval(runtime.poll);
	runtime.client?.dispose();
	runtime.client = undefined;
}

function refreshStatus(runtime: Runtime): void {
	if (runtime.disposed) return;
	if (runtime.client) {
		const selection = runtime.client.selection ? ` · ${formatSelectionStatus(runtime.client.selection)}` : "";
		runtime.ui.setStatus("ide", `IDE ${runtime.client.window.ideName}${selection}`);
	} else if (runtime.tied) {
		runtime.ui.setStatus("ide", `IDE ? ${runtime.tied.length} windows · /ide attach`);
	} else {
		runtime.ui.setStatus("ide", undefined);
	}
}

function statusText(runtime: Runtime): string {
	if (runtime.client) {
		const { selection } = runtime.client;
		const where = selection ? `${selection.filePath}:${selection.start.line + 1}` : "none";
		return `Attached to ${windowLabel(runtime.client.window)}\nselection: ${where}`;
	}
	if (runtime.detached) return "Detached. Run /ide attach to reconnect.";
	return `Not attached. ${runtime.lastError ?? "Waiting for a VS Code window with this folder open."}`;
}
