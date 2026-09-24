import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as vscode from "vscode";
import { WebSocket, WebSocketServer } from "ws";
import { AUTH_HEADER } from "../../src/protocol.ts";
import { removeLock, writeLock } from "./lockfile.ts";
import { getDiagnostics, getOpenEditors, serializeSelection } from "./tools.ts";

type Request = { id?: unknown; method?: unknown; params?: Record<string, unknown> };

/** Loopback JSON-RPC server for Pi sessions. Serves every authenticated client; connecting never evicts another. */
export class BridgeServer {
	private readonly httpServer: Server = createServer();
	private readonly token = randomUUID();
	private readonly clients = new Set<WebSocket>();
	private readonly disposables: vscode.Disposable[] = [];
	private port: number | undefined;

	constructor(private readonly log: vscode.LogOutputChannel) {}

	async start(): Promise<void> {
		// Checking the token before the upgrade means an unauthenticated peer never gets an open socket.
		const wss = new WebSocketServer({
			server: this.httpServer,
			verifyClient: ({ req }: { req: IncomingMessage }) => req.headers[AUTH_HEADER] === this.token,
		});
		wss.on("connection", (socket) => {
			this.clients.add(socket);
			socket.on("message", (data) => void this.handle(socket, String(data)));
			socket.on("close", () => this.clients.delete(socket));
			socket.on("error", (error) => this.log.warn(`Client socket error: ${error.message}`));
			const editor = vscode.window.activeTextEditor;
			if (editor?.document.uri.scheme === "file") this.pushSelection(editor, [socket]);
		});

		this.port = await new Promise<number>((resolve, reject) => {
			this.httpServer.once("error", reject);
			this.httpServer.listen(0, "127.0.0.1", () => resolve((this.httpServer.address() as AddressInfo).port));
		});
		this.publishLock();
		this.disposables.push(
			vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
				if (textEditor.document.uri.scheme === "file") this.pushSelection(textEditor, this.clients);
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor?.document.uri.scheme === "file") this.pushSelection(editor, this.clients);
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.publishLock()),
		);
		this.log.info(`Listening on 127.0.0.1:${this.port}`);
	}

	dispose(): void {
		for (const disposable of this.disposables) disposable.dispose();
		for (const client of this.clients) client.terminate();
		if (this.port !== undefined) removeLock(this.port);
		this.httpServer.close();
	}

	private publishLock(): void {
		if (this.port === undefined) return;
		writeLock({
			pid: process.pid,
			port: this.port,
			ideName: vscode.env.appName,
			workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
			authToken: this.token,
		});
	}

	private pushSelection(editor: vscode.TextEditor, sockets: Iterable<WebSocket>): void {
		const message = JSON.stringify({ jsonrpc: "2.0", method: "selection_changed", params: serializeSelection(editor) });
		for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message);
	}

	private async handle(socket: WebSocket, raw: string): Promise<void> {
		let request: Request;
		try {
			request = JSON.parse(raw) as Request;
		} catch {
			return;
		}
		if (typeof request.id !== "number") return;
		let reply: Record<string, unknown>;
		try {
			reply = { result: await this.dispatch(request) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log.error(`${String(request.method)} failed: ${message}`);
			reply = { error: { code: -32000, message } };
		}
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }));
	}

	private async dispatch(request: Request): Promise<unknown> {
		switch (request.method) {
			case "getDiagnostics": {
				const filePath = request.params?.filePath;
				return getDiagnostics(typeof filePath === "string" ? filePath : undefined);
			}
			case "getOpenEditors":
				return getOpenEditors();
			default:
				throw new Error(`Unknown method: ${String(request.method)}`);
		}
	}
}
