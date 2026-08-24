import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOCK_DIR = join(homedir(), ".pi", "ide");

export type LockContents = {
	pid: number;
	port: number;
	workspaceFolders: string[];
	ideName: string;
	transport: "ws";
	authToken: string;
	extensionVersion: string;
};

export function lockPathFor(port: number): string {
	return join(LOCK_DIR, `${port}.lock`);
}

export function writeLock(contents: LockContents): string {
	mkdirSync(LOCK_DIR, { recursive: true });
	const path = lockPathFor(contents.port);
	// Mode 0600: the token in this file is the only thing gating socket access.
	writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}

export function removeLock(port: number): void {
	try {
		rmSync(lockPathFor(port), { force: true });
	} catch {
		// A missing lockfile is the desired end state anyway.
	}
}

/**
 * Delete lockfiles whose owning window is gone. Editors are killed rather than
 * closed often enough that without this the directory fills with dead ports.
 */
export function pruneStaleLocks(currentPid: number, dir: string = LOCK_DIR): number {
	let removed = 0;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".lock")) continue;
		const path = join(dir, entry);
		let pid: unknown;
		try {
			pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
		} catch {
			continue;
		}
		if (typeof pid !== "number" || pid === currentPid || alive(pid)) continue;
		try {
			rmSync(path, { force: true });
			removed += 1;
		} catch {
			// Another window may have pruned it first.
		}
	}
	return removed;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && typeof error === "object" && "code" in error ? String(error.code) === "EPERM" : false;
	}
}
