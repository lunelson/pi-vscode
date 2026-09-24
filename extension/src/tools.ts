import { isAbsolute } from "node:path";
import * as vscode from "vscode";
import { MAX_SELECTION_CHARS, type SelectionParams } from "../../src/protocol.ts";

export function serializeSelection(editor: vscode.TextEditor): SelectionParams {
	const { document, selection, selections } = editor;
	const text = document.getText(selection);
	return {
		filePath: document.uri.fsPath,
		start: { line: selection.start.line, character: selection.start.character },
		end: { line: selection.end.line, character: selection.end.character },
		text: text.slice(0, MAX_SELECTION_CHARS),
		textLength: text.length,
		extraSelections: selections.length - 1,
	};
}

function fileDiagnostics(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]) {
	return {
		filePath: uri.fsPath,
		diagnostics: diagnostics
			.filter(
				(diagnostic) =>
					diagnostic.severity === vscode.DiagnosticSeverity.Error ||
					diagnostic.severity === vscode.DiagnosticSeverity.Warning,
			)
			.map((diagnostic) => ({
				severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
				line: diagnostic.range.start.line + 1,
				character: diagnostic.range.start.character + 1,
				message: diagnostic.message,
				source: diagnostic.source,
				code: typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code,
			})),
	};
}

export function getDiagnostics(filePath: string | undefined) {
	if (filePath !== undefined) {
		if (!isAbsolute(filePath)) throw new Error(`filePath must be absolute: ${filePath}`);
		const uri = vscode.Uri.file(filePath);
		return [fileDiagnostics(uri, vscode.languages.getDiagnostics(uri))];
	}
	return vscode.languages
		.getDiagnostics()
		.filter(([uri]) => uri.scheme === "file")
		.map(([uri, diagnostics]) => fileDiagnostics(uri, diagnostics))
		.filter((file) => file.diagnostics.length > 0);
}

export function getOpenEditors() {
	return vscode.window.tabGroups.all.flatMap((group) =>
		group.tabs.flatMap((tab) =>
			tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "file"
				? [{ filePath: tab.input.uri.fsPath, isActive: tab.isActive && group.isActive, isDirty: tab.isDirty }]
				: [],
		),
	);
}
