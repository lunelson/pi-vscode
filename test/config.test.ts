import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.ts";

test("normalizeConfig fills defaults and keeps safe values", () => {
	assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
	const parsed = normalizeConfig({
		autoAttach: false,
		injectSelection: false,
		maxSelectionChars: 12.8,
		pollIntervalMs: 100,
		extraLockDirs: ["/tmp/ide", 1, ""],
	});
	assert.equal(parsed.autoAttach, false);
	assert.equal(parsed.injectSelection, false);
	assert.equal(parsed.maxSelectionChars, 12);
	assert.equal(parsed.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs);
	assert.deepEqual(parsed.extraLockDirs, ["/tmp/ide"]);
});

test("normalizeConfig keeps installs opt-in and targets VS Code by default", () => {
	assert.equal(DEFAULT_CONFIG.autoInstall, false);
	assert.equal(normalizeConfig({ autoInstall: "yes" }).autoInstall, false);
	assert.equal(normalizeConfig({ autoInstall: true }).autoInstall, true);

	assert.equal(normalizeConfig({}).editorCli, "code");
	assert.equal(normalizeConfig({ editorCli: " cursor " }).editorCli, "cursor");
	assert.equal(normalizeConfig({ editorCli: "" }).editorCli, undefined, "empty string opts into env detection");
	assert.equal(normalizeConfig({ editorCli: 3 }).editorCli, "code");
});
