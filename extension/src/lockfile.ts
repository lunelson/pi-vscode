import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK_DIR, isProcessAlive, type LockContents } from "../../src/protocol.ts";

export function lockPath(port: number, dir: string = LOCK_DIR): string {
	return join(dir, `${port}.lock`);
}

/** The token in the lockfile is the only thing gating the socket, so only this user may read it. */
export function writeLock(contents: LockContents, dir: string = LOCK_DIR): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdir's mode applies only when it creates the directory.
	chmodSync(dir, 0o700);
	const path = lockPath(contents.port, dir);
	// writeFile's mode applies only on creation, so never write into an existing file.
	rmSync(path, { force: true });
	writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function removeLock(port: number, dir: string = LOCK_DIR): void {
	rmSync(lockPath(port, dir), { force: true });
}

/** Delete lockfiles whose editor process is gone. Editors are killed rather than closed often enough to matter. */
export function pruneStaleLocks(currentPid: number, dir: string = LOCK_DIR): number {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.endsWith(".lock")) continue;
		const path = join(dir, entry);
		let pid: unknown;
		try {
			pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
		} catch {
			continue;
		}
		if (typeof pid !== "number" || pid === currentPid || isProcessAlive(pid)) continue;
		rmSync(path, { force: true });
		removed += 1;
	}
	return removed;
}
