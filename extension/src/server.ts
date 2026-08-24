import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as vscode from "vscode";
import { WebSocket, WebSocketServer } from "ws";
import { removeLock, writeLock } from "./lockfile.ts";
import { buildTools, serializeSelection, type ToolDefinition } from "./tools.ts";

export const AUTH_HEADER = "x-pi-ide-authorization";
const PROTOCOL_VERSION = "2025-06-18";

type Rpc = {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
};

/**
 * A loopback MCP server for Pi sessions. Unlike the editor bridge Pi used to
 * borrow, this one serves every client that authenticates: connecting never
 * evicts anyone, so several agents can watch the same window at once.
 */
export class PiIdeServer {
	private httpServer: Server | undefined;
	private wss: WebSocketServer | undefined;
	private readonly clients = new Set<WebSocket>();
	private readonly tools = new Map<string, ToolDefinition>();
	private readonly disposables: vscode.Disposable[] = [];

	readonly token = randomUUID();
	port: number | undefined;

	constructor(
		private readonly extensionVersion: string,
		private readonly log: vscode.LogOutputChannel,
	) {
		for (const tool of buildTools()) this.tools.set(tool.name, tool);
	}

	get clientCount(): number {
		return this.clients.size;
	}

	async start(): Promise<number> {
		const httpServer = createServer();
		this.httpServer = httpServer;
		const wss = new WebSocketServer({ server: httpServer });
		this.wss = wss;

		wss.on("connection", (socket, request) => {
			if (request.headers[AUTH_HEADER] !== this.token) {
				this.log.warn("Rejected an unauthorized connection");
				socket.close(1008, "Unauthorized");
				return;
			}
			this.clients.add(socket);
			this.log.info(`Client connected (${this.clients.size} total)`);
			socket.on("message", (data) => void this.handle(socket, data.toString()));
			socket.on("close", () => {
				this.clients.delete(socket);
				this.log.info(`Client disconnected (${this.clients.size} remaining)`);
			});
			socket.on("error", (error) => this.log.warn(`Client socket error: ${error.message}`));
			this.pushSelection(socket);
		});

		const port = await new Promise<number>((resolve, reject) => {
			httpServer.once("error", reject);
			httpServer.listen(0, "127.0.0.1", () => {
				const address = httpServer.address() as AddressInfo | null;
				if (!address) {
					reject(new Error("Could not determine the listening port"));
					return;
				}
				resolve(address.port);
			});
		});
		this.port = port;

		this.publishLock();
		this.watchEditor();
		this.log.info(`Listening on 127.0.0.1:${port}`);
		return port;
	}

	dispose(): void {
		for (const disposable of this.disposables) disposable.dispose();
		this.disposables.length = 0;
		for (const client of this.clients) {
			try {
				client.close(1001, "Editor shutting down");
			} catch {
				// The client may already be gone.
			}
		}
		this.clients.clear();
		if (this.port !== undefined) removeLock(this.port);
		this.wss?.close();
		this.wss = undefined;
		this.httpServer?.close();
		this.httpServer = undefined;
		this.port = undefined;
	}

	private publishLock(): void {
		if (this.port === undefined) return;
		writeLock({
			pid: process.pid,
			port: this.port,
			workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
			ideName: vscode.env.appName,
			transport: "ws",
			authToken: this.token,
			extensionVersion: this.extensionVersion,
		});
	}

	private watchEditor(): void {
		this.disposables.push(
			vscode.window.onDidChangeTextEditorSelection((event) => {
				if (event.textEditor.document.uri.scheme === "output") return;
				this.broadcast({ jsonrpc: "2.0", method: "selection_changed", params: serializeSelection(event.textEditor) });
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (!editor || editor.document.uri.scheme === "output") return;
				this.broadcast({ jsonrpc: "2.0", method: "selection_changed", params: serializeSelection(editor) });
			}),
			vscode.languages.onDidChangeDiagnostics((event) => {
				this.broadcast({
					jsonrpc: "2.0",
					method: "diagnostics_changed",
					params: { uris: event.uris.map((uri) => uri.toString()) },
				});
			}),
			// The lockfile advertises workspaceFolders, which is how a Pi session in
			// some subdirectory decides this window is the right one.
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.publishLock()),
		);
	}

	private pushSelection(socket: WebSocket): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return;
		send(socket, { jsonrpc: "2.0", method: "selection_changed", params: serializeSelection(editor) });
	}

	private broadcast(message: Record<string, unknown>): void {
		for (const client of this.clients) send(client, message);
	}

	private async handle(socket: WebSocket, raw: string): Promise<void> {
		let message: Rpc;
		try {
			message = JSON.parse(raw) as Rpc;
		} catch {
			return;
		}
		const id = message.id;
		if (id === undefined || id === null) return; // Notification: nothing to answer.

		try {
			send(socket, { jsonrpc: "2.0", id, result: await this.dispatch(message) });
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.log.error(`${message.method ?? "request"} failed: ${text}`);
			send(socket, { jsonrpc: "2.0", id, error: { code: -32000, message: text } });
		}
	}

	private async dispatch(message: Rpc): Promise<unknown> {
		switch (message.method) {
			case "initialize":
				return {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "Pi IDE Bridge", version: this.extensionVersion },
				};
			case "ping":
				return {};
			case "tools/list":
				return {
					tools: [...this.tools.values()].map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
					})),
				};
			case "tools/call": {
				const name = typeof message.params?.name === "string" ? message.params.name : "";
				const tool = this.tools.get(name);
				if (!tool) throw new Error(`Unknown tool: ${name || "(missing name)"}`);
				const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
				return await tool.run(args);
			}
			default:
				throw new Error(`Unsupported method: ${message.method ?? "(missing)"}`);
		}
	}
}

function send(socket: WebSocket, message: Record<string, unknown>): void {
	if (socket.readyState !== WebSocket.OPEN) return;
	socket.send(JSON.stringify(message));
}
