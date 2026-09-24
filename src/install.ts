import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCliFallback, resolveEditorCli, which } from "./cli-fallback.ts";
import { listMatchingLocks } from "./discover.ts";
import type { CliFallback } from "./types.ts";

const VSIX_NAME = "pi-ide.vsix";
const EXTENSION_ID = "lunelson.pi-vscode-bridge";
const INSTALL_TIMEOUT_MS = 120_000;

export type InstallOutcome = {
	installed: boolean;
	/** True once the extension published a lockfile for `cwd`. */
	serving: boolean;
	editor: CliFallback | undefined;
	message: string;
};

/** The VSIX shipped alongside the built extension entry point. */
export function vsixPath(): string | undefined {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const candidate of [join(here, VSIX_NAME), resolve(here, "..", "dist", VSIX_NAME)]) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function isBridgeInstalled(editor: CliFallback): Promise<boolean> {
	return run(editor.bin, ["--list-extensions"])
		.then((output) => output.split(/\r?\n/).some((line) => line.trim().toLowerCase() === EXTENSION_ID))
		.catch(() => false);
}

/**
 * Install the bridge into the configured editor (or, without one, the editor
 * this Pi session was launched from), then wait for it to publish a lockfile.
 * The extension activates in the running window on most builds; when it does
 * not, the caller tells the user to reload rather than reporting a success
 * that is not there yet.
 */
export async function installBridge(
	cwd: string,
	extraLockDirs: string[] = [],
	options: { waitMs?: number; editorCli?: string } = {},
): Promise<InstallOutcome> {
	const editor = options.editorCli
		? resolveEditorCli(options.editorCli, process.env)
		: detectCliFallback(process.env, { requireIdeEnv: false });
	if (!editor) {
		return {
			installed: false,
			serving: false,
			editor: undefined,
			message: options.editorCli
				? `The configured editorCli "${options.editorCli}" is not on PATH, so the Pi IDE Bridge cannot be installed.`
				: "No cursor / code / windsurf / codium CLI on PATH, so the Pi IDE Bridge cannot be installed.",
		};
	}
	if (!which(editor.bin, process.env)) {
		return { installed: false, serving: false, editor, message: `${editor.label} CLI is not executable` };
	}

	const vsix = vsixPath();
	if (!vsix) {
		return { installed: false, serving: false, editor, message: "The bundled pi-ide.vsix is missing from this install." };
	}

	try {
		await run(editor.bin, ["--install-extension", vsix, "--force"], INSTALL_TIMEOUT_MS);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { installed: false, serving: false, editor, message: `${editor.label} refused the extension: ${message}` };
	}

	const serving = await waitForLock(cwd, extraLockDirs, options.waitMs ?? 12_000);
	return {
		installed: true,
		serving,
		editor,
		message: serving
			? `Installed the Pi IDE Bridge into ${editor.label}.`
			: `Installed the Pi IDE Bridge into ${editor.label}, but it has not started serving yet. Reload the editor window, then run /ide attach.`,
	};
}

export async function waitForLock(cwd: string, extraLockDirs: string[], waitMs: number): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	do {
		if (listMatchingLocks(cwd, extraLockDirs).length > 0) return true;
		await sleep(400);
	} while (Date.now() < deadline);
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(bin: string, args: string[], timeoutMs = 30_000): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`${bin} ${args[0]} timed out`));
		}, timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise(stdout);
			else reject(new Error(stderr.trim() || stdout.trim() || `exit code ${code}`));
		});
	});
}
