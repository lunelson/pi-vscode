import { WebSocket } from "ws";
import { normalizeMention, normalizeSelection } from "./context.ts";
import type { IdeConnection, IdeMention, IdeSelection, IdeServerInfo, JsonRpcMessage } from "./types.ts";

const PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 15_000;
const DIFF_TIMEOUT_MS = 15 * 60_000;

export type IdeClientHandlers = {
	onSelection?: (selection: IdeSelection) => void;
	onMention?: (mention: IdeMention) => void;
	onClose?: (code: number, reason: string) => void;
};

type Pending = {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export class IdeClient {
	private socket: WebSocket | undefined;
	private requestId = 0;
	private readonly pending = new Map<number, Pending>();
	private closed = false;
	private tools = new Map<string, string>();
	private openedAt: number | undefined;
	server: IdeServerInfo | undefined;

	constructor(
		readonly connection: IdeConnection,
		private readonly handlers: IdeClientHandlers = {},
	) {}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	/** Milliseconds the socket has been open, or undefined if it never opened. */
	get uptimeMs(): number | undefined {
		return this.openedAt === undefined ? undefined : Date.now() - this.openedAt;
	}

	static connect(connection: IdeConnection, handlers: IdeClientHandlers = {}, timeoutMs = 8_000): Promise<IdeClient> {
		const client = new IdeClient(connection, handlers);
		return client.open(timeoutMs);
	}

	private open(timeoutMs: number): Promise<IdeClient> {
		if (this.connection.host !== "127.0.0.1" && this.connection.host !== "localhost") {
			return Promise.reject(new Error("Refusing non-loopback IDE host"));
		}

		return new Promise((resolve, reject) => {
			let settled = false;
			const socket = new WebSocket(this.connection.url, {
				headers: this.connection.authToken ? { "x-pi-ide-authorization": this.connection.authToken } : undefined,
			});
			this.socket = socket;

			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.cleanup();
				reject(error);
			};

			const timer = setTimeout(() => {
				fail(new Error(`Timed out connecting to ${this.connection.source}`));
			}, timeoutMs);

			socket.once("error", (error) => {
				fail(error instanceof Error ? error : new Error(String(error)));
			});

			socket.once("open", () => {
				this.openedAt = Date.now();
				void this.initialize()
					.then(() => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve(this);
					})
					.catch(fail);
			});

			socket.on("message", (data) => {
				this.handleMessage(rawMessage(data));
			});

			socket.on("close", (code, reason) => {
				this.rejectAll(new Error("IDE websocket closed"));
				if (!settled) {
					fail(new Error(`IDE websocket closed (${code})`));
					return;
				}
				if (this.closed) return;
				this.handlers.onClose?.(code, reason.toString());
			});
		});
	}

	async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<string> {
		const toolName = this.tools.get(name) ?? name;
		const result = await this.request(
			"tools/call",
			{ name: toolName, arguments: args },
			timeoutMs ?? (name === "openDiff" ? DIFF_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
		);
		return formatToolResult(result);
	}

	hasTool(name: string): boolean {
		return this.tools.has(name);
	}

	toolNames(): string[] {
		return [...this.tools.keys()];
	}

	dispose(): void {
		this.closed = true;
		this.cleanup();
	}

	private async initialize(): Promise<void> {
		const result = await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "pi-vscode", version: "0.1.0" },
		});
		this.server = parseServerInfo(result);
		this.notify("notifications/initialized");
		await this.refreshTools();
	}

	private async refreshTools(): Promise<void> {
		try {
			const result = await this.request("tools/list", {});
			this.tools = parseToolMap(result);
		} catch {
			this.tools = new Map();
		}
	}

	private request(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("IDE is not connected"));
		}
		const id = ++this.requestId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`IDE request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { method, resolve, reject, timer });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params?: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	private send(message: JsonRpcMessage): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		this.socket.send(JSON.stringify(message));
	}

	private handleMessage(raw: string | undefined): void {
		if (!raw) return;
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(raw) as JsonRpcMessage;
		} catch {
			return;
		}

		if (message.method === "selection_changed") {
			const selection = normalizeSelection(message.params);
			if (selection) this.handlers.onSelection?.(selection);
			return;
		}

		if (message.method === "at_mentioned") {
			const mention = normalizeMention(message.params);
			if (mention) this.handlers.onMention?.(mention);
			return;
		}

		if (message.id === undefined || message.id === null) return;
		const id = typeof message.id === "number" ? message.id : Number.parseInt(String(message.id), 10);
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (message.error) {
			pending.reject(new Error(message.error.message || `IDE error ${message.error.code ?? ""}`.trim()));
			return;
		}
		pending.resolve(message.result);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private cleanup(): void {
		this.rejectAll(new Error("IDE client disposed"));
		const socket = this.socket;
		this.socket = undefined;
		if (!socket) return;
		socket.removeAllListeners();
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
			socket.close();
		}
	}
}

function rawMessage(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (Buffer.isBuffer(data)) return data.toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return undefined;
}

function parseServerInfo(result: unknown): IdeServerInfo | undefined {
	if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
	const record = result as Record<string, unknown>;
	const serverInfo = record.serverInfo && typeof record.serverInfo === "object" ? (record.serverInfo as Record<string, unknown>) : undefined;
	return {
		protocolVersion: typeof record.protocolVersion === "string" ? record.protocolVersion : undefined,
		name: typeof serverInfo?.name === "string" ? serverInfo.name : undefined,
		version: typeof serverInfo?.version === "string" ? serverInfo.version : undefined,
	};
}

function parseToolMap(result: unknown): Map<string, string> {
	const tools = new Map<string, string>();
	const list = Array.isArray(result)
		? result
		: result && typeof result === "object" && Array.isArray((result as { tools?: unknown }).tools)
			? (result as { tools: unknown[] }).tools
			: [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue;
		const name = (entry as { name?: unknown }).name;
		if (typeof name !== "string" || !name) continue;
		tools.set(name, name);
	}
	return tools;
}

export function formatToolResult(result: unknown): string {
	if (result === undefined || result === null) return "ok";
	if (typeof result === "string") return result;
	if (typeof result !== "object") return String(result);

	const record = result as { content?: unknown; message?: unknown };
	if (Array.isArray(record.content)) {
		const parts = record.content
			.map((part) => {
				if (!part || typeof part !== "object") return "";
				const item = part as { type?: unknown; text?: unknown };
				return typeof item.text === "string" ? item.text : "";
			})
			.filter(Boolean);
		if (parts.length > 0) return parts.join("\n");
	}
	if (typeof record.message === "string") return record.message;
	try {
		return JSON.stringify(result);
	} catch {
		return "ok";
	}
}
