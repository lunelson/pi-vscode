#!/usr/bin/env node
/** Portable artifact smoke test. It never reads or writes the real Pi agent directory. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expectedVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const agentDir = mkdtempSync(join(tmpdir(), "pi-ide-smoke-agent-"));

try {
	const script = [
		`process.env.PI_CODING_AGENT_DIR=${JSON.stringify(agentDir)};`,
		`const mod=await import(${JSON.stringify(join(root, "dist/index.js"))});`,
		`if(typeof mod.default!=="function") throw new Error("default extension factory missing");`,
		`console.log("@lunelson/pi-vscode ${expectedVersion} artifact import OK");`,
	].join("");
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: root,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
