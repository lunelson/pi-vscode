import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { BeforeAgentStartEvent, ExtensionAPI, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { WebSocketServer, type WebSocket } from "ws";

// discover.ts resolves ~/.pi/ide when it loads and config.ts reads the agent dir, so both
// must point at a scratch home before the extension module is imported.
const home = mkdtempSync(join(tmpdir(), "pi-vscode-home-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
const lockDir = join(home, ".pi", "ide");
mkdirSync(lockDir, { recursive: true });
const { default: piVscode } = await import("../src/index.ts");

after(() => rmSync(home, { recursive: true, force: true }));

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

const fakePi = () => {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	let active: string[] = [];
	const api = {
		registerTool: () => {},
		registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options.handler),
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
	piVscode(api as unknown as ExtensionAPI);
	const emit = async (event: string, payload: unknown, ctx: unknown) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	};
	return { emit, commands, activeTools: () => active };
};

const fakeUi = () => {
	const statuses: Array<string | undefined> = [];
	const notices: string[] = [];
	let editorText = "";
	return {
		statuses,
		notices,
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
	};
};

const promptOptions = (cwd: string): NormalizedBuildSystemPromptOptions => ({
	cwd,
	selectedTools: [],
	toolSnippets: {},
	toolGuidelines: {},
	promptGuidelines: [],
	appendSystemPrompt: "",
	sections: {},
	contextFiles: [],
	skills: [],
});

const beforeAgentStart = async (pi: ReturnType<typeof fakePi>, cwd: string, prompt: string) => {
	const event: BeforeAgentStartEvent = {
		type: "before_agent_start",
		prompt,
		systemPrompt: "",
		systemPromptOptions: promptOptions(cwd),
	};
	const [result] = await pi.emit("before_agent_start", event, {});
	return { sections: event.systemPromptOptions.sections, result };
};

const startIde = async () => {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(wss, "listening");
	wss.on("connection", (socket: WebSocket) => {
		socket.on("message", (data) => {
			const message = JSON.parse(String(data)) as { id?: number; method?: string };
			if (message.method === "initialize") {
				socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "VS Code" } } }));
			} else if (message.method === "tools/list") {
				socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
			}
		});
	});
	const port = (wss.address() as AddressInfo).port;
	const push = (method: string, params: unknown) => {
		for (const socket of wss.clients) socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
		return new Promise((resolve) => setTimeout(resolve, 30));
	};
	const close = () => new Promise<void>((resolve, reject) => wss.close((error) => (error ? reject(error) : resolve())));
	return { port, push, close };
};

const writeLock = (port: number, folder: string, ideName: string) =>
	writeFileSync(
		join(lockDir, `${port}.lock`),
		JSON.stringify({ pid: process.pid, port, workspaceFolders: [folder], ideName, transport: "ws", authToken: "t" }),
	);

test("editor state reaches the model as a stable ide_context section", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-vscode-repo-"));
	const ide = await startIde();
	writeLock(ide.port, cwd, "Visual Studio Code");
	const pi = fakePi();
	const { ui } = fakeUi();

	await pi.emit("session_start", { type: "session_start" }, { cwd, ui, hasUI: false });
	assert.ok(pi.activeTools().includes("ide_get_diagnostics"), "tools activate once attached");

	const beforeSelection = await beforeAgentStart(pi, cwd, "hi");
	assert.equal(beforeSelection.sections.ide_context, undefined);

	await ide.push("selection_changed", {
		filePath: join(cwd, "a.ts"),
		text: "export const x = 1",
		selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 18 } },
	});
	const first = await beforeAgentStart(pi, cwd, "hi");
	assert.match(first.sections.ide_context ?? "", /Active selection in .*a\.ts \(L1\):\n```\nexport const x = 1\n```/);
	assert.equal(first.result, undefined, "the section path must not force a whole system prompt");

	const second = await beforeAgentStart(pi, cwd, "again");
	assert.equal(second.sections.ide_context, first.sections.ide_context, "unchanged editor state yields identical text");

	const mention = { filePath: join(cwd, "b.ts"), lineStart: 3, lineEnd: 4 };
	await ide.push("at_mentioned", mention);
	const typed = await beforeAgentStart(pi, cwd, `look at @${mention.filePath}#L3-4`);
	assert.equal(typed.result, undefined, "a mention already in the prompt is not repeated");

	await ide.push("at_mentioned", mention);
	const untyped = await beforeAgentStart(pi, cwd, "look at this");
	assert.deepEqual(untyped.result, {
		message: { customType: "ide-mentions", content: `IDE @-mentions: @${mention.filePath}#L3-4`, display: false },
	});

	await pi.commands.get("ide")?.("detach", { cwd, ui, hasUI: false });
	const detached = await beforeAgentStart(pi, cwd, "hi");
	assert.equal(detached.sections.ide_context, undefined, "detaching drops the section so Pi removes it");

	await pi.emit("session_shutdown", { type: "session_shutdown" }, {});
	await ide.close();
	rmSync(join(lockDir, `${ide.port}.lock`), { force: true });
});

test("auto-attach refuses to choose between equally matching windows", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-vscode-repo-"));
	const vscode = await startIde();
	const cursor = await startIde();
	writeLock(vscode.port, cwd, "Visual Studio Code");
	writeLock(cursor.port, cwd, "Cursor");
	const pi = fakePi();
	const { ui, statuses, notices } = fakeUi();

	await pi.emit("session_start", { type: "session_start" }, { cwd, ui, hasUI: false });
	assert.equal(pi.activeTools().includes("ide_get_diagnostics"), false);
	assert.equal(statuses.at(-1), "IDE ? 2 windows · /ide attach");
	assert.match(notices.at(-1) ?? "", /2 IDE windows match this folder equally/);

	await pi.commands.get("ide")?.(`attach ${cursor.port}`, { cwd, ui, hasUI: false });
	assert.ok(pi.activeTools().includes("ide_get_diagnostics"), "an explicit choice attaches");
	assert.match(statuses.at(-1) ?? "", /^IDE /);
	assert.doesNotMatch(statuses.at(-1) ?? "", /\?/);

	await pi.emit("session_shutdown", { type: "session_shutdown" }, {});
	await Promise.all([vscode.close(), cursor.close()]);
	rmSync(join(lockDir, `${vscode.port}.lock`), { force: true });
	rmSync(join(lockDir, `${cursor.port}.lock`), { force: true });
});
