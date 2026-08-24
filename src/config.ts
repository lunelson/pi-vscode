import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { IdeConfig } from "./types.ts";

export const DEFAULT_CONFIG: IdeConfig = {
	autoAttach: true,
	autoInstall: true,
	injectSelection: true,
	maxSelectionChars: 4000,
	extraLockDirs: [],
	pollIntervalMs: 2500,
};

export function getIdeConfigPath(): string {
	return join(getAgentDir(), "ide.json");
}

export function loadConfig(): IdeConfig {
	const path = getIdeConfigPath();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ...DEFAULT_CONFIG };
		}
		return normalizeConfig(parsed as Record<string, unknown>);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: IdeConfig): void {
	const path = getIdeConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function normalizeConfig(raw: Record<string, unknown>): IdeConfig {
	const extraLockDirs = Array.isArray(raw.extraLockDirs)
		? raw.extraLockDirs.filter((value): value is string => typeof value === "string" && value.length > 0)
		: DEFAULT_CONFIG.extraLockDirs;

	const maxSelectionChars =
		typeof raw.maxSelectionChars === "number" && Number.isFinite(raw.maxSelectionChars) && raw.maxSelectionChars > 0
			? Math.floor(raw.maxSelectionChars)
			: DEFAULT_CONFIG.maxSelectionChars;

	const pollIntervalMs =
		typeof raw.pollIntervalMs === "number" && Number.isFinite(raw.pollIntervalMs) && raw.pollIntervalMs >= 500
			? Math.floor(raw.pollIntervalMs)
			: DEFAULT_CONFIG.pollIntervalMs;

	return {
		autoAttach: raw.autoAttach !== false,
		autoInstall: raw.autoInstall !== false,
		injectSelection: raw.injectSelection !== false,
		maxSelectionChars,
		extraLockDirs,
		pollIntervalMs,
	};
}
