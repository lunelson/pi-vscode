import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectCliFallback, looksLikeIdeTerminal, resolveEditorCli } from "../src/cli-fallback.ts";

test("looksLikeIdeTerminal requires a VS Code-family env hint", () => {
	assert.equal(looksLikeIdeTerminal({ TERM_PROGRAM: "ghostty" }), false);
	assert.equal(looksLikeIdeTerminal({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "1" }), true);
});

test("detectCliFallback does not pick a random code binary unless asked", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-cli-"));
	const bin = join(dir, "code");
	writeFileSync(bin, "#!/bin/sh\n");
	chmodSync(bin, 0o755);
	const env = { PATH: dir, TERM_PROGRAM: "ghostty" };
	assert.equal(detectCliFallback(env, { requireIdeEnv: true }), undefined);
	const found = detectCliFallback(env, { requireIdeEnv: false });
	assert.equal(found?.label, "VS Code");
	assert.equal(found?.bin, bin);
});

test("resolveEditorCli uses only the named editor", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-cli-"));
	for (const bin of ["cursor", "code", "my-editor"]) {
		writeFileSync(join(dir, bin), "#!/bin/sh\n");
		chmodSync(join(dir, bin), 0o755);
	}
	const env = { PATH: dir, TERM_PROGRAM: "cursor" };
	assert.deepEqual(resolveEditorCli("code", env), { family: "vscode", bin: join(dir, "code"), label: "VS Code" });
	assert.deepEqual(resolveEditorCli("my-editor", env), { family: "unknown", bin: join(dir, "my-editor"), label: "my-editor" });
	assert.equal(resolveEditorCli("windsurf", env), undefined, "a missing editor must not fall back to another one");
});

test("detectCliFallback resolves newer editor forks by hint", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ide-cli-"));
	for (const bin of ["antigravity", "positron", "pearai", "void", "code-oss", "theia", "windsurf-next"]) {
		writeFileSync(join(dir, bin), "#!/bin/sh\n");
		chmodSync(join(dir, bin), 0o755);
	}

	for (const [hint, bin, label] of [
		["antigravity", "antigravity", "Antigravity"],
		["positron", "positron", "Positron"],
		["pearai", "pearai", "PearAI"],
		["void", "void", "Void"],
		["code-oss", "code-oss", "Code OSS"],
		["theia", "theia", "Theia Blueprint"],
		["windsurf-next", "windsurf-next", "Windsurf Next"],
	] as const) {
		const env = { PATH: dir, TERM_PROGRAM: hint };
		const found = detectCliFallback(env, { requireIdeEnv: true });
		assert.equal(found?.bin, join(dir, bin));
		assert.equal(found?.label, label);
	}
});
