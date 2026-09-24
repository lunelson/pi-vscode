import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { IdeConnection, IdeLockFile } from "./types.ts";

export const DEFAULT_LOCK_DIRS = [join(homedir(), ".pi", "ide")];

const ENV_PORT_VARS = ["PI_IDE_PORT"] as const;

export function parsePort(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value.trim(), 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return undefined;
	return parsed;
}

export function pathContainsLength(parent: string, child: string, caseInsensitive = process.platform !== "linux"): number {
	let resolvedParent = resolve(parent);
	let resolvedChild = resolve(child);
	if (caseInsensitive) {
		resolvedParent = resolvedParent.toLowerCase();
		resolvedChild = resolvedChild.toLowerCase();
	}
	const rel = relative(resolvedParent, resolvedChild);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? resolvedParent.length : 0;
}

export function defaultLockDirs(extraLockDirs: string[] = []): string[] {
	const dirs = [...DEFAULT_LOCK_DIRS, ...extraLockDirs];
	return [...new Set(dirs.map((dir) => resolve(dir)))];
}

export function readLockFile(filePath: string): IdeLockFile | undefined {
	const port = parsePort(basename(filePath, ".lock"));
	if (!port) return undefined;

	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.transport !== undefined && record.transport !== "ws") return undefined;

		const workspaceFolders = Array.isArray(record.workspaceFolders)
			? record.workspaceFolders.filter((value): value is string => typeof value === "string" && value.length > 0)
			: [];

		return {
			port,
			pid: typeof record.pid === "number" ? record.pid : undefined,
			authToken: typeof record.authToken === "string" ? record.authToken : undefined,
			transport: typeof record.transport === "string" ? record.transport : undefined,
			ideName: typeof record.ideName === "string" ? record.ideName : undefined,
			workspaceFolders,
			mtimeMs: statSync(filePath).mtimeMs,
			lockPath: filePath,
			dir: dirname(filePath),
		};
	} catch {
		return undefined;
	}
}

export function isProcessAlive(pid: number | undefined): boolean {
	if (pid === undefined || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
		return code === "EPERM";
	}
}

export function listLockFiles(dirs: string[]): IdeLockFile[] {
	const locks: IdeLockFile[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".lock")) continue;
			const lock = readLockFile(join(dir, entry));
			if (!lock) continue;
			if (!isProcessAlive(lock.pid)) continue;
			locks.push(lock);
		}
	}
	return locks;
}

export function rankLock(lock: IdeLockFile, cwd: string): number {
	if (lock.workspaceFolders.length === 0) return 0;
	return Math.max(0, ...lock.workspaceFolders.map((folder) => pathContainsLength(folder, cwd)));
}

export function listMatchingLocks(cwd: string, extraLockDirs: string[] = []): IdeLockFile[] {
	const locks = listLockFiles(defaultLockDirs(extraLockDirs))
		.map((lock) => ({ lock, rank: rankLock(lock, cwd) }))
		.filter((entry) => entry.rank > 0)
		.sort((left, right) => right.rank - left.rank || right.lock.mtimeMs - left.lock.mtimeMs);
	return locks.map((entry) => entry.lock);
}

export function findLockByPort(port: number, extraLockDirs: string[] = []): IdeLockFile | undefined {
	for (const dir of defaultLockDirs(extraLockDirs)) {
		const filePath = join(dir, `${port}.lock`);
		if (!existsSync(filePath)) continue;
		const lock = readLockFile(filePath);
		if (lock && isProcessAlive(lock.pid)) return lock;
	}
	return undefined;
}

export function envPort(env: NodeJS.ProcessEnv = process.env): number | undefined {
	for (const name of ENV_PORT_VARS) {
		const port = parsePort(env[name]);
		if (port) return port;
	}
	return undefined;
}

export function lockToConnection(lock: IdeLockFile, source: string): IdeConnection {
	return {
		url: `ws://127.0.0.1:${lock.port}`,
		host: "127.0.0.1",
		port: lock.port,
		authToken: lock.authToken,
		ideName: lock.ideName,
		workspaceFolders: lock.workspaceFolders,
		source,
		transport: "ws",
	};
}

export function listConnections(cwd: string, extraLockDirs: string[] = [], env: NodeJS.ProcessEnv = process.env): IdeConnection[] {
	const connections: IdeConnection[] = [];
	const seen = new Set<number>();
	const port = envPort(env);
	if (port) {
		const lock = findLockByPort(port, extraLockDirs);
		connections.push({
			url: `ws://127.0.0.1:${port}`,
			host: "127.0.0.1",
			port,
			authToken: lock?.authToken,
			ideName: lock?.ideName,
			workspaceFolders: lock?.workspaceFolders ?? [],
			source: `env:${port}`,
			transport: "ws",
		});
		seen.add(port);
	}

	for (const lock of listMatchingLocks(cwd, extraLockDirs)) {
		if (seen.has(lock.port)) continue;
		connections.push({ ...lockToConnection(lock, `lock:${lock.port}`), matchLength: rankLock(lock, cwd) });
		seen.add(lock.port);
	}
	return connections;
}

/**
 * The connections an automatic attach could justify: `PI_IDE_PORT` alone, or every
 * lockfile tied for the most specific workspace match. More than one means several
 * windows have this folder open, and choosing by recency would silently attach to
 * whichever editor was touched last.
 */
export function bestConnections(connections: IdeConnection[]): IdeConnection[] {
	const [first] = connections;
	if (!first) return [];
	if (first.matchLength === undefined) return [first];
	return connections.filter((connection) => connection.matchLength === first.matchLength);
}

export function connectionLabel(connection: IdeConnection): string {
	const name = connection.ideName?.trim() || "IDE";
	const folder = connection.workspaceFolders[0];
	return folder ? `${name} · ${folder} · :${connection.port}` : `${name} · :${connection.port}`;
}
