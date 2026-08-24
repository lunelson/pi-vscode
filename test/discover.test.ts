import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	findLockByPort,
	listMatchingLocks,
	parsePort,
	pathContainsLength,
	readLockFile,
} from "../src/discover.ts";

test("parsePort accepts a valid TCP port", () => {
	assert.equal(parsePort("55398"), 55398);
	assert.equal(parsePort("0"), undefined);
	assert.equal(parsePort("nope"), undefined);
});

test("pathContainsLength ranks nested workspace folders", () => {
	const parent = "/Users/rahul/Projects/tools";
	assert.ok(pathContainsLength(parent, "/Users/rahul/Projects/tools/pi-ide-integration", false) > 0);
	assert.equal(pathContainsLength(parent, "/Users/rahul/Projects/job", false), 0);
	assert.ok(
		pathContainsLength("/Users/rahul/Projects/tools", "/Users/rahul/Projects/tools/pi-ide-integration", false) >
			pathContainsLength("/Users/rahul/Projects", "/Users/rahul/Projects/tools/pi-ide-integration", false),
	);
});

test("pathContainsLength is case-insensitive when asked", () => {
	assert.ok(pathContainsLength("/Users/Rahul/Projects", "/users/rahul/projects/tools", true) > 0);
});

test("readLockFile parses a bridge lockfile", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-lock-"));
	const file = join(dir, "43123.lock");
	writeFileSync(
		file,
		JSON.stringify({
			pid: process.pid,
			workspaceFolders: ["/tmp/project"],
			ideName: "Cursor",
			transport: "ws",
			authToken: "test-token",
		}),
	);
	const lock = readLockFile(file);
	assert.ok(lock);
	assert.equal(lock.port, 43123);
	assert.equal(lock.ideName, "Cursor");
	assert.equal(lock.authToken, "test-token");
	assert.deepEqual(lock.workspaceFolders, ["/tmp/project"]);
});

test("listMatchingLocks prefers the longest workspace match", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-locks-"));
	writeFileSync(
		join(dir, "10001.lock"),
		JSON.stringify({
			pid: process.pid,
			workspaceFolders: ["/tmp/work"],
			ideName: "VS Code",
			transport: "ws",
			authToken: "a",
		}),
	);
	writeFileSync(
		join(dir, "10002.lock"),
		JSON.stringify({
			pid: process.pid,
			workspaceFolders: ["/tmp/work/repo"],
			ideName: "Cursor",
			transport: "ws",
			authToken: "b",
		}),
	);
	const matches = listMatchingLocks("/tmp/work/repo/src", [dir]);
	assert.equal(matches[0]?.port, 10002);
	assert.equal(findLockByPort(10001, [dir])?.ideName, "VS Code");
});
