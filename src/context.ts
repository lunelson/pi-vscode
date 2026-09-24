import { basename } from "node:path";
import type { Position, SelectionParams } from "./protocol.ts";

/** System prompt section that carries live editor state. Pi wraps it in `<ide_context>` tags. */
export const IDE_CONTEXT_SECTION = "ide_context";

const isPosition = (value: unknown): value is Position =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as Position).line === "number" &&
	typeof (value as Position).character === "number";

export function parseSelection(params: unknown): SelectionParams | undefined {
	if (typeof params !== "object" || params === null) return undefined;
	const { filePath, start, end, text, textLength, extraSelections } = params as Record<string, unknown>;
	if (typeof filePath !== "string" || typeof text !== "string") return undefined;
	if (typeof textLength !== "number" || typeof extraSelections !== "number") return undefined;
	if (!isPosition(start) || !isPosition(end)) return undefined;
	return { filePath, start, end, text, textLength, extraSelections };
}

const lineSpan = (selection: SelectionParams): string => {
	const start = selection.start.line + 1;
	const end = selection.end.line + 1;
	return start === end ? `${start}` : `${start}-${end}`;
};

/** A fence longer than any backtick run in `text`, so the text cannot close it. */
const fenceFor = (text: string): string => {
	const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(3, longestRun + 1));
};

/**
 * Body of the `ide_context` prompt section. Pi appends a section patch only when this
 * text changes, so it must be a pure function of the selection. The body is escaped so
 * selected text cannot close the section and speak with system-prompt authority.
 */
export function formatIdeContext(selection: SelectionParams): string {
	const lines = [
		"Live state of the user's VS Code editor, not a project file dump. A later ide_context section replaces this one.",
	];
	const text = selection.text.trimEnd();
	if (text) {
		const fence = fenceFor(text);
		lines.push(`Active selection in ${selection.filePath} (L${lineSpan(selection)}):`, fence, text, fence);
		const cut = selection.textLength - selection.text.length;
		if (cut > 0) lines.push(`[selection truncated: ${cut} more characters]`);
	} else {
		lines.push(`Active cursor in ${selection.filePath} (L${lineSpan(selection)}).`);
	}
	if (selection.extraSelections > 0) lines.push(`Plus ${selection.extraSelections} more cursors or selections.`);
	return lines.join("\n").replace(/<\/(ide_context)/gi, "<\\/$1");
}

/** Footer label: the file name, plus lines only when text is actually highlighted. */
export function formatSelectionStatus(selection: SelectionParams): string {
	const name = basename(selection.filePath);
	return selection.text ? `${name}:${lineSpan(selection)}` : name;
}
