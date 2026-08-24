import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listConnections } from "../src/discover.ts";

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
});
