import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { lockPath, pruneStaleLocks, removeLock, writeLock } from "../extension/src/lockfile.ts";
import type { LockContents } from "../src/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "pi-vscode-lockfile-"));
after(() => rmSync(root, { recursive: true, force: true }));

const contents = (port: number, pid = process.pid): LockContents => ({
	pid,
	port,
	ideName: "Visual Studio Code",
	workspaceFolders: ["/repo"],
	authToken: "token",
});

test("the lock and its directory are private to the user, even when they already existed", () => {
	const dir = join(root, "perms");
	writeLock(contents(1), dir);
	chmodSync(dir, 0o755);
	writeFileSync(lockPath(1, dir), "{}", { mode: 0o644 });

	writeLock(contents(1), dir);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.equal(statSync(lockPath(1, dir)).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(lockPath(1, dir), "utf8")), contents(1));

	removeLock(1, dir);
	removeLock(1, dir);
	assert.deepEqual(readdirSync(dir), []);
});

test("pruning removes only locks whose process is gone", () => {
	const dir = join(root, "prune");
	writeLock(contents(1), dir);
	writeLock(contents(2, 2 ** 30), dir);
	writeLock(contents(3, 4242), dir);
	writeFileSync(join(dir, "4.lock"), "not json");

	assert.equal(pruneStaleLocks(4242, dir), 1);
	assert.deepEqual(readdirSync(dir).sort(), ["1.lock", "3.lock", "4.lock"]);
	assert.equal(pruneStaleLocks(4242, join(root, "missing")), 0);
});
