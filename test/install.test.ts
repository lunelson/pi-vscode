import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneStaleLocks } from "../extension/src/lockfile.ts";
import { vsixPath } from "../src/install.ts";

test("the bundled VSIX ships next to the built extension", () => {
	const path = vsixPath();
	assert.ok(path, "auto-install has nothing to install without dist/pi-ide.vsix — run npm run build");
	assert.equal(existsSync(path), true);
});

test("pruneStaleLocks drops lockfiles whose editor window is gone", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-locks-"));
	const dead = join(dir, "41000.lock");
	const live = join(dir, "41001.lock");
	// A pid this high is reliably absent, so it stands in for a killed editor.
	writeFileSync(dead, JSON.stringify({ pid: 2 ** 30, port: 41000, workspaceFolders: ["/repo"] }));
	writeFileSync(live, JSON.stringify({ pid: process.pid, port: 41001, workspaceFolders: ["/repo"] }));

	assert.equal(pruneStaleLocks(process.pid, dir), 1);
	assert.equal(existsSync(dead), false);
	assert.equal(existsSync(live), true);

	rmSync(dir, { recursive: true, force: true });
});
