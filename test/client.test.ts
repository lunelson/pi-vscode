import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { IdeClient, type IdeClientHandlers } from "../src/client.ts";
import type { IdeWindow } from "../src/discover.ts";
import { AUTH_HEADER } from "../src/protocol.ts";

const window = (port: number, authToken = "secret"): IdeWindow => ({
	pid: process.pid,
	port,
	ideName: "Visual Studio Code",
	workspaceFolders: ["/repo"],
	authToken,
	matchLength: 5,
});

const noHandlers: IdeClientHandlers = { onSelection: () => {}, onClose: () => {} };

/** A bridge double that authenticates like the real one: before the upgrade. */
const startBridge = async (respond: (method: string, params: unknown) => { result?: unknown; error?: unknown } | undefined) => {
	const wss = new WebSocketServer({
		host: "127.0.0.1",
		port: 0,
		verifyClient: ({ req }: { req: IncomingMessage }) => req.headers[AUTH_HEADER] === "secret",
	});
	await once(wss, "listening");
	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			const { id, method, params } = JSON.parse(String(data)) as { id: number; method: string; params: unknown };
			const reply = respond(method, params);
			if (reply) socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
		});
	});
	const close = () =>
		new Promise<void>((resolve) => {
			for (const client of wss.clients) client.terminate();
			wss.close(() => resolve());
		});
	return { wss, port: (wss.address() as AddressInfo).port, close };
};

test("requests round-trip and selection notifications reach the handler", async () => {
	const bridge = await startBridge((method, params) => ({ result: { method, params } }));
	const selections: unknown[] = [];
	const client = await IdeClient.connect(window(bridge.port), { ...noHandlers, onSelection: (params) => selections.push(params) });
	assert.equal(client.connected, true);
	assert.deepEqual(await client.request("getDiagnostics", { filePath: "/repo/a.ts" }), {
		method: "getDiagnostics",
		params: { filePath: "/repo/a.ts" },
	});

	for (const socket of bridge.wss.clients) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "selection_changed", params: { x: 1 } }));
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(selections, [{ x: 1 }]);

	client.dispose();
	assert.equal(client.connected, false);
	await assert.rejects(client.request("getOpenEditors"), /not connected/);
	await bridge.close();
});

test("a JSON-RPC error rejects the request", async () => {
	const bridge = await startBridge(() => ({ error: { code: -32000, message: "filePath must be absolute: a.ts" } }));
	const client = await IdeClient.connect(window(bridge.port), noHandlers);
	await assert.rejects(client.request("getDiagnostics", { filePath: "a.ts" }), /filePath must be absolute/);
	client.dispose();
	await bridge.close();
});

test("a wrong token is refused before the upgrade", async () => {
	const bridge = await startBridge(() => ({ result: null }));
	await assert.rejects(IdeClient.connect(window(bridge.port, "wrong"), noHandlers), /refused the connection \(HTTP 401\)/);
	await bridge.close();
});

test("a handshake that never completes times out without crashing the process", async () => {
	const sockets: Socket[] = [];
	const server = createServer();
	server.on("upgrade", (_request, socket: Socket) => sockets.push(socket));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;

	await assert.rejects(IdeClient.connect(window(port), noHandlers, 100), /Timed out connecting/);
	await new Promise((resolve) => setTimeout(resolve, 50));

	for (const socket of sockets) socket.destroy();
	server.close();
});

test("onClose fires when the bridge goes away, but not after dispose", async () => {
	const bridge = await startBridge(() => undefined);
	const closes: number[] = [];
	const handlers = { ...noHandlers, onClose: (code: number) => closes.push(code) };
	const first = await IdeClient.connect(window(bridge.port), handlers);
	const second = await IdeClient.connect(window(bridge.port), handlers);
	second.dispose();
	const pending = first.request("getOpenEditors");
	await bridge.close();
	await assert.rejects(pending);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(closes.length, 1);
	assert.equal(first.connected, false);
});
