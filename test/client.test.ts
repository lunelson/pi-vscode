import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { formatToolResult, IdeClient } from "../src/client.ts";
import type { IdeConnection, IdeSelection } from "../src/types.ts";

test("formatToolResult unwraps MCP content arrays", () => {
	assert.equal(formatToolResult({ content: [{ type: "text", text: "FILE_SAVED" }] }), "FILE_SAVED");
	assert.equal(formatToolResult("ok"), "ok");
});

test("IdeClient handshakes, receives selection, and calls tools", async () => {
	const token = "test-token";
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(wss, "listening");
	const port = (wss.address() as AddressInfo).port;

	wss.on("connection", (socket: WebSocket, request) => {
		assert.equal(request.headers["x-pi-ide-authorization"], token);
		socket.on("message", (data) => {
			const message = JSON.parse(String(data)) as {
				id?: number;
				method?: string;
				params?: { name?: string };
			};
			if (message.method === "initialize") {
				socket.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: "2025-11-25",
							serverInfo: { name: "Cursor", version: "test" },
						},
					}),
				);
				return;
			}
			if (message.method === "tools/list") {
				socket.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						result: { tools: [{ name: "openFile" }, { name: "getCurrentSelection" }] },
					}),
				);
				return;
			}
			if (message.method === "tools/call" && message.params?.name === "openFile") {
				socket.send(
					JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						result: { content: [{ type: "text", text: "Opened file: /tmp/a.ts" }] },
					}),
				);
			}
		});
	});

	const connection: IdeConnection = {
		url: `ws://127.0.0.1:${port}`,
		host: "127.0.0.1",
		port,
		authToken: token,
		ideName: "Cursor",
		workspaceFolders: ["/tmp"],
		source: `test:${port}`,
		transport: "ws",
	};

	const selections: IdeSelection[] = [];
	const client = await IdeClient.connect(connection, {
		onSelection: (selection) => selections.push(selection),
	});

	assert.equal(client.connected, true);
	assert.equal(client.server?.name, "Cursor");
	assert.equal(client.hasTool("openFile"), true);
	assert.equal(await client.callTool("openFile", { filePath: "/tmp/a.ts" }), "Opened file: /tmp/a.ts");

	const sockets = [...wss.clients];
	sockets[0]?.send(
		JSON.stringify({
			jsonrpc: "2.0",
			method: "selection_changed",
			params: {
				filePath: "/tmp/a.ts",
				text: "export const x = 1",
				selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 18 } },
			},
		}),
	);

	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(selections[0]?.filePath, "/tmp/a.ts");

	client.dispose();
	await new Promise<void>((resolve, reject) => {
		wss.close((error) => (error ? reject(error) : resolve()));
	});
});

test("IdeClient refuses a non-loopback host", async () => {
	await assert.rejects(
		() =>
			IdeClient.connect({
				url: "ws://192.168.1.4:9",
				host: "192.168.1.4",
				port: 9,
				source: "test",
				workspaceFolders: [],
				transport: "ws",
			}),
		/loopback/,
	);
});

test("IdeClient reports a tiny uptime when the IDE hands its single slot to another client", async () => {
	const token = "test-token";
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(wss, "listening");
	const port = (wss.address() as AddressInfo).port;

	// Mirrors the Claude IDE helper: one client at a time, and the loser is closed
	// with no status code, which surfaces to the peer as 1005.
	let current: WebSocket | undefined;
	wss.on("connection", (socket: WebSocket) => {
		current?.close();
		current = socket;
		socket.on("message", (data) => {
			const message = JSON.parse(String(data)) as { id?: number; method?: string };
			if (message.method === "initialize") {
				socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } }));
				return;
			}
			if (message.method === "tools/list") {
				socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
			}
		});
	});

	const connection: IdeConnection = {
		url: `ws://127.0.0.1:${port}`,
		host: "127.0.0.1",
		port,
		authToken: token,
		ideName: "Cursor",
		workspaceFolders: ["/tmp"],
		source: `test:${port}`,
		transport: "ws",
	};

	const closes: Array<{ code: number; uptimeMs: number | undefined }> = [];
	const first = await IdeClient.connect(connection, {
		onClose: (code) => closes.push({ code, uptimeMs: first.uptimeMs }),
	});
	assert.equal(first.connected, true);

	const second = await IdeClient.connect(connection);
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(closes.length, 1);
	assert.equal(closes[0]?.code, 1005);
	assert.ok((closes[0]?.uptimeMs ?? Number.MAX_SAFE_INTEGER) < 3_000);

	second.dispose();
	first.dispose();
	await new Promise<void>((resolve, reject) => {
		wss.close((error) => (error ? reject(error) : resolve()));
	});
});
