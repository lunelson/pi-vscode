import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bestWindows, matchingWindows, pathContainsLength, windowKey } from "../src/discover.ts";
import type { LockContents } from "../src/protocol.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-vscode-locks-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const lock = (overrides: Partial<LockContents> & { port: number }): LockContents => ({
	pid: process.pid,
	ideName: "Visual Studio Code",
	workspaceFolders: ["/repo"],
	authToken: "token",
	...overrides,
});

const write = (contents: unknown, name: string) => writeFileSync(join(dir, name), JSON.stringify(contents));

test("pathContainsLength matches containment, not string prefixes", () => {
	assert.equal(pathContainsLength("/repo", "/repo"), 5);
	assert.equal(pathContainsLength("/repo", "/repo/src/a"), 5);
	assert.equal(pathContainsLength("/repo", "/repo-other"), 0);
	assert.equal(pathContainsLength("/repo", "/"), 0);
	assert.equal(pathContainsLength("/repo", "/repo/..cache"), 5);
	assert.equal(pathContainsLength("/Repo", "/repo/src", true), 5);
	assert.equal(pathContainsLength("/Repo", "/repo/src", false), 0);
});

test("matchingWindows keeps live, valid, containing windows, most specific first", () => {
	write(lock({ port: 1, workspaceFolders: ["/repo"] }), "1.lock");
	write(lock({ port: 2, workspaceFolders: ["/elsewhere", "/repo/packages/app"] }), "2.lock");
	write(lock({ port: 3, workspaceFolders: ["/unrelated"] }), "3.lock");
	write(lock({ port: 4, pid: 2 ** 30 }), "4.lock");
	write({ port: 5, pid: process.pid }, "5.lock");
	writeFileSync(join(dir, "6.lock"), "not json");
	writeFileSync(join(dir, "7.lock"), "null");
	write(lock({ port: 8 }), "8.json");

	const windows = matchingWindows("/repo/packages/app/src", dir);
	assert.deepEqual(
		windows.map((window) => window.port),
		[2, 1],
	);
	assert.deepEqual(
		bestWindows(windows).map((window) => window.port),
		[2],
	);
	assert.deepEqual(matchingWindows("/repo", join(dir, "missing")), []);
});

test("bestWindows reports every window tied for the most specific folder", () => {
	const windows = [lock({ port: 1 }), lock({ port: 2 }), lock({ port: 3, workspaceFolders: ["/"] })].map((window, i) => ({
		...window,
		matchLength: i < 2 ? 5 : 1,
	}));
	assert.deepEqual(
		bestWindows(windows).map((window) => window.port),
		[1, 2],
	);
	assert.deepEqual(bestWindows([]), []);
});

test("windowKey ignores the port and token, which change on restart", () => {
	assert.equal(windowKey(lock({ port: 1, authToken: "a" })), windowKey(lock({ port: 2, authToken: "b" })));
	assert.notEqual(windowKey(lock({ port: 1 })), windowKey(lock({ port: 1, ideName: "Cursor" })));
});
