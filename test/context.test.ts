import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IDE_CONTEXT_SECTION,
	appendMentionToEditor,
	formatIdeContext,
	formatMention,
	formatMentions,
	formatSelectionStatus,
	normalizeMention,
	normalizeSelection,
} from "../src/context.ts";

test("normalizeSelection accepts both single and ranges payloads", () => {
	const single = normalizeSelection({
		filePath: "/tmp/a.ts",
		text: "hello",
		selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
	});
	assert.equal(single?.ranges.length, 1);
	assert.equal(single?.ranges[0]?.text, "hello");

	const ranges = normalizeSelection({
		filePath: "/tmp/a.ts",
		ranges: [{ text: "hello", selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 1 } } }],
	});
	assert.equal(ranges?.ranges[0]?.selection.start.line, 1);
});

test("formatIdeContext renders the selection without dumping huge text", () => {
	const selection = {
		filePath: "/tmp/a.ts",
		ranges: [
			{
				text: "abc".repeat(100),
				selection: { start: { line: 3, character: 0 }, end: { line: 5, character: 0 } },
			},
		],
	};
	const text = formatIdeContext(selection, 20);
	assert.ok(text);
	assert.match(text, /\/tmp\/a\.ts \(L4-6\)/);
	assert.match(text, /truncated/);
	assert.doesNotMatch(text, /<\/?ide_context>/, "Pi adds the section tags itself");
	assert.equal(formatIdeContext(structuredClone(selection), 20), text, "unchanged editor state must not patch the prompt");
});

test("formatIdeContext is empty without a selection", () => {
	assert.equal(formatIdeContext(undefined, 20), undefined);
	assert.equal(formatIdeContext({ filePath: "/tmp/a.ts", ranges: [] }, 20), undefined);
});

test("formatIdeContext reports a bare cursor", () => {
	const text = formatIdeContext(
		{ filePath: "/tmp/a.ts", ranges: [{ text: "", selection: { start: { line: 8, character: 2 }, end: { line: 8, character: 2 } } }] },
		20,
	);
	assert.match(text ?? "", /Active cursor in \/tmp\/a\.ts \(L9\)\./);
});

test("IDE_CONTEXT_SECTION is a valid Pi section name", () => {
	assert.match(IDE_CONTEXT_SECTION, /^[a-z][a-z0-9_-]*$/);
	assert.notEqual(IDE_CONTEXT_SECTION, "preamble");
});

test("formatMentions lists one-shot mentions", () => {
	assert.equal(formatMentions([]), undefined);
	assert.equal(formatMentions([{ filePath: "/tmp/b.ts", lineStart: 10, lineEnd: 12 }]), "IDE @-mentions: @/tmp/b.ts#L10-12");
});

test("appendMentionToEditor is idempotent", () => {
	const mention = { filePath: "src/app.ts", lineStart: 4, lineEnd: 4 };
	assert.equal(formatMention(mention), "@src/app.ts#L4");
	const once = appendMentionToEditor("", mention);
	assert.equal(appendMentionToEditor(once, mention), once);
	assert.equal(appendMentionToEditor("please look", mention), "please look @src/app.ts#L4");
});

test("normalizeMention rejects incomplete payloads", () => {
	assert.equal(normalizeMention({ filePath: "a.ts" }), undefined);
	assert.deepEqual(normalizeMention({ filePath: "a.ts", lineStart: 1, lineEnd: 2 }), {
		filePath: "a.ts",
		lineStart: 1,
		lineEnd: 2,
	});
});

test("formatSelectionStatus renders a compact footer label", () => {
	assert.equal(formatSelectionStatus(undefined), undefined);
	assert.equal(
		formatSelectionStatus({
			filePath: "/repo/scripts/smoke.mjs",
			ranges: [{ text: "x", selection: { start: { line: 11, character: 0 }, end: { line: 26, character: 3 } } }],
		}),
		"smoke.mjs:12-27",
	);
	assert.equal(
		formatSelectionStatus({
			filePath: "/repo/a.ts",
			ranges: [
				{ text: "", selection: { start: { line: 4, character: 2 }, end: { line: 4, character: 2 } } },
				{ text: "", selection: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } } },
			],
		}),
		"a.ts",
	);
	assert.equal(
		formatSelectionStatus({
			filePath: "/repo/a.ts",
			ranges: [
				{ text: "", selection: { start: { line: 4, character: 2 }, end: { line: 4, character: 2 } } },
				{ text: "y", selection: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } } },
			],
		}),
		"a.ts:10",
	);
});
