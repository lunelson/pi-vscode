import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, mock, test } from "node:test";
import type { BeforeAgentStartEvent, ExtensionAPI, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";
import type { LockContents, SelectionParams } from "../src/protocol.ts";

// protocol.ts resolves ~/.pi/ide when it loads, so HOME must point at a scratch dir before the import.
const home = mkdtempSync(join(tmpdir(), "pi-vscode-home-"));
process.env.HOME = home;
const lockDir = join(home, ".pi", "ide");
mkdirSync(lockDir, { recursive: true });
const { default: piVscode } = await import("../src/index.ts");
const { AUTH_HEADER } = await import("../src/protocol.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/** Teardown that must run even when an assertion fails, or a live socket keeps the runner from exiting. */
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	mock.timers.reset();
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const fakePi = () => {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const tools = new Map<string, Tool>();
	const api = {
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options.handler),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	};
	piVscode(api as unknown as ExtensionAPI);
	const emit = async (event: string, payload: unknown, ctx: unknown = {}) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	};
	cleanups.push(() => emit("session_shutdown", { type: "session_shutdown" }));
	const command = (args: string, ctx: unknown) => {
		const handler = commands.get("ide");
		assert.ok(handler);
		return handler(args, ctx);
	};
	const tool = (name: string) => {
		const found = tools.get(name);
		assert.ok(found);
		return found;
	};
	return { emit, command, tool };
};

const fakeUi = (pick?: (options: string[]) => string | undefined) => {
	const statuses: Array<string | undefined> = [];
	const notices: string[] = [];
	return {
		statuses,
		notices,
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			select: async (_title: string, options: string[]) => pick?.(options),
		},
	};
};

const beforeAgentStart = async (pi: ReturnType<typeof fakePi>, cwd: string) => {
	const systemPromptOptions: NormalizedBuildSystemPromptOptions = {
		cwd,
		selectedTools: [],
		toolSnippets: {},
		toolGuidelines: {},
		promptGuidelines: [],
		appendSystemPrompt: "",
		sections: {},
		contextFiles: [],
		skills: [],
	};
	const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt: "hi", systemPrompt: "", systemPromptOptions };
	const [result] = await pi.emit("before_agent_start", event);
	return { section: systemPromptOptions.sections.ide_context, result };
};

/** A bridge double that authenticates like the real one, answers both methods, and pushes the active selection to each new connection. */
const startBridge = async (folder: string, { ideName = "Visual Studio Code", handshakeDelayMs = 0 } = {}) => {
	const token = `token-${Math.random()}`;
	let active: string | undefined;
	const wss = new WebSocketServer({
		host: "127.0.0.1",
		port: 0,
		verifyClient: ({ req }: { req: IncomingMessage }, done: (ok: boolean) => void) => {
			setTimeout(() => done(req.headers[AUTH_HEADER] === token), handshakeDelayMs);
		},
	});
	await once(wss, "listening");
	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			const { id, method } = JSON.parse(String(data)) as { id: number; method: string };
			socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: { method, ideName } }));
		});
		if (active) socket.send(active);
	});
	const port = (wss.address() as AddressInfo).port;
	const lock: LockContents = { pid: process.pid, port, ideName, workspaceFolders: [folder], authToken: token };
	const lockFile = join(lockDir, `${port}.lock`);
	writeFileSync(lockFile, JSON.stringify(lock));
	const select = async (selection: Partial<SelectionParams> = {}) => {
		const text = selection.text ?? "export const x = 1";
		const params: SelectionParams = {
			filePath: join(folder, "a.ts"),
			start: { line: 0, character: 0 },
			end: { line: 0, character: text.length },
			text,
			textLength: text.length,
			extraSelections: 0,
			...selection,
		};
		active = JSON.stringify({ jsonrpc: "2.0", method: "selection_changed", params });
		for (const socket of wss.clients) socket.send(active);
		await settle();
	};
	const close = async () => {
		rmSync(lockFile, { force: true });
		for (const client of wss.clients) client.terminate();
		await new Promise<void>((resolve) => wss.close(() => resolve()));
		await settle();
	};
	cleanups.push(close);
	return { wss, select, close, connections: () => wss.clients.size };
};

test("editor selection reaches the model only as the ide_context section, and leaves on detach", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-vscode-repo-"));
	const bridge = await startBridge(cwd);
	const pi = fakePi();
	const { ui, statuses } = fakeUi();

	await pi.emit("session_start", { type: "session_start" }, { cwd, ui });
	assert.equal(bridge.connections(), 1);
	assert.equal((await beforeAgentStart(pi, cwd)).section, undefined, "no section before any selection");

	await bridge.select();
	const first = await beforeAgentStart(pi, cwd);
	assert.match(first.section ?? "", /Active selection in .*a\.ts \(L1\):\n```\nexport const x = 1\n```/);
	assert.equal(first.result, undefined, "must never return a whole systemPrompt");
	assert.equal(statuses.at(-1), "IDE Visual Studio Code · a.ts:1");
	assert.equal((await beforeAgentStart(pi, cwd)).section, first.section, "unchanged state gives identical text");

	await pi.command("detach", { ui });
	await settle();
	assert.equal(bridge.connections(), 0);
	assert.equal((await beforeAgentStart(pi, cwd)).section, undefined);
	assert.equal(statuses.at(-1), undefined);

	await bridge.select({ text: "export const y = 2" });
	await pi.command("attach", { ui });
	await settle();
	assert.equal(bridge.connections(), 1);
	const reattached = (await beforeAgentStart(pi, cwd)).section ?? "";
	assert.match(reattached, /export const y = 2/, "reattach takes the selection VS Code pushes on connect");
	assert.doesNotMatch(reattached, /export const x = 1/, "a stale selection does not survive reattach");
});

test("a selection VS Code pushes as the socket opens is picked up", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-vscode-repo-"));
	const bridge = await startBridge(cwd);
	await bridge.select();
	const pi = fakePi();
	const { ui, statuses } = fakeUi();

	await pi.emit("session_start", { type: "session_start" }, { cwd, ui });
	await settle();
	assert.equal(bridge.connections(), 1);
	assert.match((await beforeAgentStart(pi, cwd)).section ?? "", /export const x = 1/);
	assert.equal(statuses.at(-1), "IDE Visual Studio Code · a.ts:1");
});

test("tools answer through the attached window and throw when detached", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-vscode-repo-"));
	const pi = fakePi();
	const { ui } = fakeUi();

	await pi.emit("session_start", { type: "session_start" }, { cwd, ui });
	await assert.rejects(pi.tool("ide_get_diagnostics").execute("1", {}), /No VS Code window is attached/);

	const bridge = await startBridge(cwd);
	await pi.command("attach", { ui });
	const result = await pi.tool("ide_get_open_editors").execute("2", {});
	assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), { method: "getOpenEditors", ideName: "Visual Studio Code" });
	await bridge.select();
	assert.ok((await beforeAgentStart(pi, cwd)).section);

	await bridge.close();
	await assert.rejects(pi.tool("ide_get_diagnostics").execute("3", {}), /No VS Code window is attached/);
	assert.equal((await beforeAgentStart(pi, cwd)).section, undefined, "the section leaves when VS Code goes away");
});

test("tied windows wait for a choice, and the choice survives the window restarting", async () => {
	mock.timers.enable({ apis: ["setInterval"] });
	const cwd = mkdtempSync(join(tmpdir(), "pi-vscode-repo-"));
	const vscode = await startBridge(cwd);
	const insiders = await startBridge(cwd, { ideName: "Visual Studio Code - Insiders" });
	const pi = fakePi();
	const { ui, statuses, notices } = fakeUi((options) => options.find((option) => option.includes("Insiders")));

	await pi.emit("session_start", { type: "session_start" }, { cwd, ui });
	assert.equal(vscode.connections() + insiders.connections(), 0, "automatic attach never picks between tied windows");
	assert.equal(statuses.at(-1), "IDE ? 2 windows · /ide attach");
	mock.timers.tick(2_500);
	await settle();
	assert.equal(notices.filter((notice) => notice.includes("2 windows")).length, 1, "the same tie is reported once");

	await pi.command("attach", { ui });
	assert.equal(insiders.connections(), 1);
	assert.equal(vscode.connections(), 0);

	await insiders.close();
	const restarted = await startBridge(cwd, { ideName: "Visual Studio Code - Insiders" });
	mock.timers.tick(2_500);
	await settle();
	assert.equal(restarted.connections(), 1, "the poll returns to the pinned window on its new port");
	assert.equal(vscode.connections(), 0);
});

test("shutting down mid-handshake leaves no socket behind", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-vscode-repo-"));
	const bridge = await startBridge(cwd, { handshakeDelayMs: 50 });
	const pi = fakePi();
	const { ui, statuses } = fakeUi();

	const starting = pi.emit("session_start", { type: "session_start" }, { cwd, ui });
	await settle(10);
	await pi.emit("session_shutdown", { type: "session_shutdown" });
	const statusCount = statuses.length;
	await starting;
	await settle(100);
	assert.equal(bridge.connections(), 0);
	assert.equal(statuses.length, statusCount, "a disposed session does not touch the footer");
});
