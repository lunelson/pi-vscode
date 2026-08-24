import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { CliFallback, IdeFamily } from "./types.ts";

const CANDIDATES: Array<{ family: IdeFamily; bin: string; label: string; hints: string[] }> = [
	{ family: "cursor", bin: "cursor", label: "Cursor", hints: ["cursor"] },
	{ family: "windsurf", bin: "windsurf", label: "Windsurf", hints: ["windsurf"] },
	{ family: "windsurf", bin: "windsurf-next", label: "Windsurf Next", hints: ["windsurf-next"] },
	{ family: "trae", bin: "trae", label: "Trae", hints: ["trae"] },
	{ family: "kiro", bin: "kiro", label: "Kiro", hints: ["kiro"] },
	{ family: "antigravity", bin: "antigravity", label: "Antigravity", hints: ["antigravity"] },
	{ family: "positron", bin: "positron", label: "Positron", hints: ["positron"] },
	{ family: "pearai", bin: "pearai", label: "PearAI", hints: ["pearai"] },
	{ family: "void", bin: "void", label: "Void", hints: ["void"] },
	{ family: "theia", bin: "theia", label: "Theia Blueprint", hints: ["theia"] },
	{ family: "vscodium", bin: "codium", label: "VSCodium", hints: ["vscodium", "codium"] },
	{ family: "vscodium", bin: "vscodium", label: "VSCodium", hints: ["vscodium"] },
	{ family: "vscodium", bin: "codium-insiders", label: "VSCodium Insiders", hints: ["codium-insiders"] },
	{ family: "vscode", bin: "code", label: "VS Code", hints: ["code", "vscode"] },
	{ family: "vscode", bin: "code-insiders", label: "VS Code Insiders", hints: ["code-insiders"] },
	{ family: "vscode", bin: "code-exploration", label: "VS Code Exploration", hints: ["code-exploration"] },
	{ family: "vscode", bin: "code-oss", label: "Code OSS", hints: ["code-oss"] },
];

export function ideEnvHaystack(env: NodeJS.ProcessEnv = process.env): string {
	return [
		env.TERM_PROGRAM,
		env.TERM_PROGRAM_VERSION,
		env.VSCODE_IPC_HOOK_CLI,
		env.VSCODE_GIT_IPC_HANDLE,
		env.VSCODE_GIT_ASKPASS,
		env.VSCODE_CWD,
		env.CURSOR_TRACE_ID,
		env.CURSOR_AGENT,
	]
		.filter((value): value is string => typeof value === "string")
		.join("\n")
		.toLowerCase();
}

export function looksLikeIdeTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
	const haystack = ideEnvHaystack(env);
	return CANDIDATES.some((candidate) => candidate.hints.some((hint) => haystack.includes(hint)));
}

export function detectCliFallback(
	env: NodeJS.ProcessEnv = process.env,
	options: { requireIdeEnv?: boolean } = {},
): CliFallback | undefined {
	const haystack = ideEnvHaystack(env);
	// Substring hints collide: "code" is contained in "code-oss", "code-insiders",
	// "codium", etc. Prefer the longest (most specific) matching hint over
	// whichever candidate happens to come first in the array.
	const hinted = CANDIDATES.reduce<{ family: IdeFamily; bin: string; label: string; hints: string[] } | undefined>(
		(best, candidate) => {
			const hintLength = Math.max(0, ...candidate.hints.filter((hint) => haystack.includes(hint)).map((hint) => hint.length));
			if (hintLength === 0) return best;
			const bestLength = best ? Math.max(...best.hints.filter((hint) => haystack.includes(hint)).map((hint) => hint.length)) : -1;
			return hintLength > bestLength ? candidate : best;
		},
		undefined,
	);
	if (options.requireIdeEnv && !hinted) return undefined;
	const ordered = hinted ? [hinted, ...CANDIDATES.filter((candidate) => candidate.bin !== hinted.bin)] : CANDIDATES;

	for (const candidate of ordered) {
		const resolved = which(candidate.bin, env);
		if (!resolved) continue;
		return { family: candidate.family, bin: resolved, label: candidate.label };
	}
	return undefined;
}

export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (bin.includes("/") && existsSync(bin)) return bin;
	const pathValue = env.PATH ?? env.Path;
	if (!pathValue) return undefined;
	for (const dir of pathValue.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, bin);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export async function openInIde(cli: CliFallback, filePath: string, line?: number, character?: number): Promise<string> {
	const target = line !== undefined ? `${filePath}:${line}${character !== undefined ? `:${character}` : ""}` : filePath;
	await runCli(cli.bin, ["-r", "-g", target]);
	return `Opened ${target} in ${cli.label}`;
}

export async function diffInIde(cli: CliFallback, oldPath: string, newPath: string): Promise<string> {
	await runCli(cli.bin, ["-r", "--diff", oldPath, newPath]);
	return `Opened diff in ${cli.label}: ${oldPath} → ${newPath}`;
}

function runCli(bin: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, {
			stdio: "ignore",
			detached: true,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
