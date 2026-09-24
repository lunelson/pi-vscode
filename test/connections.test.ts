import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bestConnections, listConnections } from "../src/discover.ts";

test("listConnections prefers PI_IDE_PORT and still records lock matches", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-conn-"));
	writeFileSync(
		join(dir, "22222.lock"),
		JSON.stringify({
			pid: process.pid,
			workspaceFolders: ["/tmp/repo"],
			ideName: "Cursor",
			transport: "ws",
			authToken: "token-env",
		}),
	);
	writeFileSync(
		join(dir, "33333.lock"),
		JSON.stringify({
			pid: process.pid,
			workspaceFolders: ["/tmp/repo"],
			ideName: "VS Code",
			transport: "ws",
			authToken: "token-lock",
		}),
	);

	const connections = listConnections("/tmp/repo", [dir], { PI_IDE_PORT: "22222" });
	assert.equal(connections[0]?.source, "env:22222");
	assert.equal(connections[0]?.authToken, "token-env");
	assert.equal(connections[1]?.source, "lock:33333");
	assert.equal(connections[1]?.ideName, "VS Code");
	assert.deepEqual(
		bestConnections(connections).map((connection) => connection.port),
		[22222],
		"PI_IDE_PORT is an explicit choice, never ambiguous",
	);
});

test("bestConnections reports windows tied for the most specific folder", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-conn-"));
	const lock = (port: number, folder: string, ideName: string) =>
		writeFileSync(
			join(dir, `${port}.lock`),
			JSON.stringify({ pid: process.pid, workspaceFolders: [folder], ideName, transport: "ws", authToken: "t" }),
		);
	lock(41001, "/tmp/work", "VS Code");
	lock(41002, "/tmp/work/repo", "VS Code");
	lock(41003, "/tmp/work/repo", "Cursor");

	const tied = bestConnections(listConnections("/tmp/work/repo/src", [dir], {}));
	assert.deepEqual(tied.map((connection) => connection.port).sort(), [41002, 41003]);

	lock(41004, "/tmp/work/repo/src", "VS Code");
	const unique = bestConnections(listConnections("/tmp/work/repo/src", [dir], {}));
	assert.deepEqual(unique.map((connection) => connection.port), [41004]);

	assert.deepEqual(bestConnections([]), []);
});
