import { homedir } from "node:os";
import { join } from "node:path";

// Compiled into both the Pi extension and the VS Code bridge, so this file may import only Node built-ins.

export const AUTH_HEADER = "x-pi-ide-authorization";
export const LOCK_DIR = join(homedir(), ".pi", "ide");
export const MAX_SELECTION_CHARS = 4_000;

export type LockContents = {
	pid: number;
	port: number;
	ideName: string;
	workspaceFolders: string[];
	authToken: string;
};

/** 0-based, as in the VS Code API. */
export type Position = { line: number; character: number };

/** Params of the `selection_changed` notification: the primary selection of the active file editor. */
export type SelectionParams = {
	filePath: string;
	start: Position;
	end: Position;
	/** Selected text cut to MAX_SELECTION_CHARS; empty for a bare cursor. */
	text: string;
	textLength: number;
	/** Cursors or selections beyond the primary one. */
	extraSelections: number;
};

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}
