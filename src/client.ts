import { WebSocket } from "ws";
import { parseSelection } from "./context.ts";
import type { IdeWindow } from "./discover.ts";
import { AUTH_HEADER, type SelectionParams } from "./protocol.ts";

const CONNECT_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Handlers receive the client because the bridge pushes a selection as soon as the socket
 * opens, which `ws` delivers before the caller's `await IdeClient.connect(...)` resumes.
 */
export type IdeClientHandlers = {
	onSelection: (client: IdeClient) => void;
	onClose: (client: IdeClient, code: number) => void;
};

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type Message = {
	id?: unknown;
	method?: unknown;
	params?: unknown;
	result?: unknown;
	error?: { message?: unknown };
};

const ignore = () => {};

/**
 * Detach every listener and drop the socket. `ws` emits an error when a socket is
 * closed mid-handshake, so an error listener must stay attached or the process crashes.
 */
function discard(socket: WebSocket): void {
	socket.removeAllListeners();
	socket.on("error", ignore);
	socket.terminate();
}

/** JSON-RPC client for the VS Code bridge. The bridge checks the token before upgrading, so an open socket is authenticated. */
export class IdeClient {
	/** The latest selection VS Code pushed on this connection. */
	selection?: SelectionParams;
	private readonly pending = new Map<number, Pending>();
	private nextId = 0;
	private disposed = false;

	private constructor(
		readonly window: IdeWindow,
		private readonly socket: WebSocket,
		private readonly handlers: IdeClientHandlers,
	) {
		socket.on("message", (data) => this.handleMessage(String(data)));
		socket.on("error", ignore);
		socket.on("close", (code) => {
			this.rejectAll(new Error("VS Code closed the connection"));
			if (!this.disposed) handlers.onClose(this, code);
		});
	}

	static connect(window: IdeWindow, handlers: IdeClientHandlers, timeoutMs = CONNECT_TIMEOUT_MS): Promise<IdeClient> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(`ws://127.0.0.1:${window.port}`, { headers: { [AUTH_HEADER]: window.authToken } });
			const fail = (error: Error) => {
				clearTimeout(timer);
				discard(socket);
				reject(error);
			};
			const timer = setTimeout(() => fail(new Error(`Timed out connecting to ${window.ideName} on port ${window.port}`)), timeoutMs);
			socket.once("error", fail);
			socket.once("unexpected-response", (_request, response) => {
				fail(new Error(`${window.ideName} on port ${window.port} refused the connection (HTTP ${response.statusCode})`));
			});
			socket.once("open", () => {
				clearTimeout(timer);
				socket.removeAllListeners();
				resolve(new IdeClient(window, socket, handlers));
			});
		});
	}

	get connected(): boolean {
		return !this.disposed && this.socket.readyState === WebSocket.OPEN;
	}

	request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (!this.connected) return Promise.reject(new Error("VS Code is not connected"));
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`VS Code did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000}s`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	dispose(): void {
		this.disposed = true;
		this.rejectAll(new Error("Detached from VS Code"));
		discard(this.socket);
	}

	private handleMessage(raw: string): void {
		let message: Message;
		try {
			message = JSON.parse(raw) as Message;
		} catch {
			return;
		}
		if (message.method === "selection_changed") {
			this.selection = parseSelection(message.params) ?? this.selection;
			this.handlers.onSelection(this);
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error) pending.reject(new Error(String(message.error.message ?? "VS Code request failed")));
		else pending.resolve(message.result);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
