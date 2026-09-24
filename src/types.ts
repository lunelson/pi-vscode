export type IdeFamily =
	| "cursor"
	| "vscode"
	| "windsurf"
	| "vscodium"
	| "trae"
	| "kiro"
	| "antigravity"
	| "positron"
	| "pearai"
	| "void"
	| "theia"
	| "unknown";

export type IdeTransport = "ws" | "cli";

export type IdePosition = {
	line: number;
	character: number;
};

export type IdeSelectionRange = {
	text: string;
	selection: {
		start: IdePosition;
		end: IdePosition;
	};
};

export type IdeSelection = {
	filePath: string;
	source?: "websocket" | "cli";
	ranges: IdeSelectionRange[];
};

export type IdeMention = {
	filePath: string;
	lineStart: number;
	lineEnd: number;
};

export type IdeLockFile = {
	port: number;
	pid?: number;
	authToken?: string;
	transport?: string;
	ideName?: string;
	workspaceFolders: string[];
	mtimeMs: number;
	lockPath: string;
	dir: string;
};

export type IdeConnection = {
	url: string;
	host: string;
	port: number;
	authToken?: string;
	ideName?: string;
	workspaceFolders: string[];
	source: string;
	transport: IdeTransport;
	/** Length of the workspace folder containing the cwd; undefined for `PI_IDE_PORT`. */
	matchLength?: number;
};

export type IdeServerInfo = {
	protocolVersion?: string;
	name?: string;
	version?: string;
};

export type JsonRpcMessage = {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: {
		code?: number;
		message?: string;
	};
};

export type IdeConfig = {
	autoAttach: boolean;
	/** Install the Pi IDE Bridge extension automatically when it is missing. */
	autoInstall: boolean;
	/**
	 * Editor CLI (name or path) that installs the bridge and opens files when no lockfile
	 * matched. Undefined means detect from the terminal environment, then PATH order.
	 */
	editorCli: string | undefined;
	injectSelection: boolean;
	maxSelectionChars: number;
	extraLockDirs: string[];
	pollIntervalMs: number;
};

export type CliFallback = {
	family: IdeFamily;
	bin: string;
	label: string;
};
