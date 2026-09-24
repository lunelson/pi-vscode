import { basename } from "node:path";
import type { IdeMention, IdeSelection } from "./types.ts";

export function normalizeSelection(params: unknown): IdeSelection | undefined {
	if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
	const record = params as Record<string, unknown>;
	const filePath = typeof record.filePath === "string" ? record.filePath : undefined;
	if (!filePath) return undefined;

	if (Array.isArray(record.ranges)) {
		const ranges = record.ranges
			.map((range) => normalizeRange(range))
			.filter((range): range is NonNullable<typeof range> => Boolean(range));
		if (ranges.length === 0) return undefined;
		return { filePath, source: "websocket", ranges };
	}

	const range = normalizeRange(record);
	if (!range) return undefined;
	return { filePath, source: "websocket", ranges: [range] };
}

function normalizeRange(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const selection = record.selection;
	if (!selection || typeof selection !== "object" || Array.isArray(selection)) return undefined;
	const sel = selection as Record<string, unknown>;
	const start = normalizePosition(sel.start);
	const end = normalizePosition(sel.end);
	if (!start || !end) return undefined;
	return {
		text: typeof record.text === "string" ? record.text : "",
		selection: { start, end },
	};
}

function normalizePosition(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.line !== "number" || typeof record.character !== "number") return undefined;
	if (!Number.isFinite(record.line) || !Number.isFinite(record.character)) return undefined;
	return { line: record.line, character: record.character };
}

export function normalizeMention(params: unknown): IdeMention | undefined {
	if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
	const record = params as Record<string, unknown>;
	if (typeof record.filePath !== "string" || record.filePath.length === 0) return undefined;
	if (typeof record.lineStart !== "number" || typeof record.lineEnd !== "number") return undefined;
	return {
		filePath: record.filePath,
		lineStart: record.lineStart,
		lineEnd: record.lineEnd,
	};
}

export function formatMention(mention: IdeMention): string {
	if (mention.lineStart === mention.lineEnd) return `@${mention.filePath}#L${mention.lineStart}`;
	return `@${mention.filePath}#L${mention.lineStart}-${mention.lineEnd}`;
}

export function appendMentionToEditor(current: string, mention: IdeMention): string {
	const token = formatMention(mention);
	if (current.includes(token)) return current;
	if (!current) return token;
	const needsSpace = !/\s$/.test(current);
	return `${current}${needsSpace ? " " : ""}${token}`;
}

/** System prompt section that carries live editor state. Pi wraps it in `<ide_context>` tags. */
export const IDE_CONTEXT_SECTION = "ide_context";

/**
 * Body of the `ide_context` prompt section. Pi appends a section patch only when this
 * text changes, so it must be a pure function of the selection: anything that varies per
 * turn without the editor changing would patch the transcript on every prompt.
 */
export function formatIdeContext(selection: IdeSelection | undefined, maxChars: number): string | undefined {
	if (!selection) return undefined;
	const lines: string[] = [];

	for (const range of selection.ranges) {
		const start = range.selection.start.line + 1;
		const end = range.selection.end.line + 1;
		const span = start === end ? `L${start}` : `L${start}-${end}`;
		const text = truncate(range.text.trimEnd(), maxChars);
		if (text) {
			lines.push(`Active selection in ${selection.filePath} (${span}):`);
			lines.push("```");
			lines.push(text);
			lines.push("```");
		} else {
			lines.push(`Active cursor in ${selection.filePath} (${span}).`);
		}
	}

	if (lines.length === 0) return undefined;
	return [
		"Live state of the user's attached VS Code-family editor, not a project file dump. A later ide_context section replaces this one.",
		...lines,
	].join("\n");
}

export function formatMentions(mentions: IdeMention[]): string | undefined {
	if (mentions.length === 0) return undefined;
	return `IDE @-mentions: ${mentions.map(formatMention).join(", ")}`;
}

/**
 * Compact footer label. A bare cursor (no highlighted text) gets just the
 * filename — `file.ts:12-27` only appears once there is an actual selection,
 * so the footer doesn't imply a range is active on every cursor move.
 */
export function formatSelectionStatus(selection: IdeSelection | undefined): string | undefined {
	if (!selection) return undefined;
	const fileName = basename(selection.filePath);
	const highlighted = selection.ranges.filter((range) => range.text.length > 0);
	const first = highlighted[0];
	if (!first) return fileName;
	const start = first.selection.start.line + 1;
	const end = first.selection.end.line + 1;
	const span = start === end ? `${start}` : `${start}-${end}`;
	const extra = highlighted.length > 1 ? ` +${highlighted.length - 1}` : "";
	return `${fileName}:${span}${extra}`;
}

export function selectionKey(selection: IdeSelection | undefined): string {
	if (!selection) return "";
	return [
		selection.filePath,
		...selection.ranges.flatMap((range) => [
			range.selection.start.line,
			range.selection.start.character,
			range.selection.end.line,
			range.selection.end.character,
			range.text,
		]),
	].join("\0");
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]`;
}
