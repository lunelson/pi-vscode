import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LOCK_DIR, isProcessAlive, type LockContents } from "./protocol.ts";

/** A live editor window whose workspace contains the cwd. */
export type IdeWindow = LockContents & {
	/** Length of the most specific workspace folder containing the cwd. */
	matchLength: number;
};

export function pathContainsLength(parent: string, child: string, caseInsensitive = process.platform !== "linux"): number {
	let resolvedParent = resolve(parent);
	let resolvedChild = resolve(child);
	if (caseInsensitive) {
		resolvedParent = resolvedParent.toLowerCase();
		resolvedChild = resolvedChild.toLowerCase();
	}
	const rel = relative(resolvedParent, resolvedChild);
	const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	return outside ? 0 : resolvedParent.length;
}

export function readLock(path: string): LockContents | undefined {
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const { pid, port, ideName, workspaceFolders, authToken } = record ?? {};
	if (typeof pid !== "number" || typeof port !== "number" || typeof authToken !== "string") return undefined;
	if (typeof ideName !== "string" || !Array.isArray(workspaceFolders)) return undefined;
	if (!workspaceFolders.every((folder) => typeof folder === "string")) return undefined;
	return { pid, port, ideName, workspaceFolders, authToken };
}

/** Live windows whose workspace contains `cwd`, most specific folder first. */
export function matchingWindows(cwd: string, dir: string = LOCK_DIR): IdeWindow[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const windows: IdeWindow[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".lock")) continue;
		const lock = readLock(join(dir, entry));
		if (!lock || !isProcessAlive(lock.pid)) continue;
		const matchLength = Math.max(0, ...lock.workspaceFolders.map((folder) => pathContainsLength(folder, cwd)));
		if (matchLength > 0) windows.push({ ...lock, matchLength });
	}
	return windows.sort((left, right) => right.matchLength - left.matchLength);
}

/** Every window tied for the most specific match. More than one is a choice automatic attach must not make. */
export function bestWindows(windows: IdeWindow[]): IdeWindow[] {
	const [first] = windows;
	return first ? windows.filter((window) => window.matchLength === first.matchLength) : [];
}

/** Identifies a window across restarts, which change its port and token. */
export function windowKey(window: LockContents): string {
	return [window.ideName, ...window.workspaceFolders].join("\0");
}

export function windowLabel(window: LockContents): string {
	return `${window.ideName} · ${window.workspaceFolders[0] ?? "(no folder)"} · :${window.port}`;
}
