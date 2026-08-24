import { readFileSync } from "node:fs";
import * as vscode from "vscode";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export type ToolDefinition = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
};

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], isError });
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

function str(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function serializeSelection(editor: vscode.TextEditor) {
	const selections = editor.selections.length > 0 ? editor.selections : [editor.selection];
	return {
		filePath: editor.document.uri.fsPath,
		fileUrl: editor.document.uri.toString(),
		languageId: editor.document.languageId,
		ranges: selections.map((selection) => ({
			text: editor.document.getText(selection),
			isEmpty: selection.isEmpty,
			selection: {
				start: { line: selection.start.line, character: selection.start.character },
				end: { line: selection.end.line, character: selection.end.character },
			},
		})),
	};
}

function diagnosticPayload(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]) {
	return {
		uri: uri.toString(),
		filePath: uri.fsPath,
		diagnostics: diagnostics.map((diagnostic) => ({
			severity: vscode.DiagnosticSeverity[diagnostic.severity],
			message: diagnostic.message,
			source: diagnostic.source,
			code: typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code,
			range: {
				start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
				end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
			},
		})),
	};
}

export function buildTools(): ToolDefinition[] {
	return [
		{
			name: "openFile",
			description: "Open a file in the editor, optionally revealing a line or selecting a range.",
			inputSchema: {
				type: "object",
				properties: {
					filePath: { type: "string", description: "Absolute path, or a path relative to the first workspace folder" },
					line: { type: "number", description: "1-based line to reveal and select" },
					endLine: { type: "number", description: "1-based last line of the selection" },
					character: { type: "number", description: "0-based column on `line`" },
					preview: { type: "boolean", description: "Open as a preview tab", default: false },
					makeFrontmost: { type: "boolean", description: "Focus the tab", default: true },
				},
				required: ["filePath"],
			},
			async run(args) {
				const filePath = str(args, "filePath");
				if (!filePath) return text("filePath is required", true);
				const uri = resolveUri(filePath);
				const document = await vscode.workspace.openTextDocument(uri);
				const makeFrontmost = args.makeFrontmost !== false;
				const editor = await vscode.window.showTextDocument(document, {
					preview: args.preview === true,
					preserveFocus: !makeFrontmost,
				});

				// Line numbers are 1-based on the wire and 0-based in the API.
				if (typeof args.line === "number" && Number.isFinite(args.line)) {
					const startLine = clampLine(document, args.line - 1);
					const endLine = typeof args.endLine === "number" ? clampLine(document, args.endLine - 1) : startLine;
					const character = typeof args.character === "number" ? Math.max(0, args.character) : 0;
					const start = new vscode.Position(startLine, character);
					const end = document.lineAt(endLine).range.end;
					editor.selection = new vscode.Selection(start, end);
					editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
				}
				return json({ success: true, filePath: uri.fsPath, languageId: document.languageId });
			},
		},
		{
			name: "openDiff",
			description: "Show a diff between a file on disk and proposed contents.",
			inputSchema: {
				type: "object",
				properties: {
					oldFilePath: { type: "string" },
					newFilePath: { type: "string" },
					newFileContents: { type: "string", description: "Proposed contents; defaults to newFilePath on disk" },
					tabName: { type: "string" },
				},
				required: ["oldFilePath", "newFilePath"],
			},
			async run(args) {
				const oldFilePath = str(args, "oldFilePath");
				const newFilePath = str(args, "newFilePath");
				if (!oldFilePath || !newFilePath) return text("oldFilePath and newFilePath are required", true);

				const left = resolveUri(oldFilePath);
				const proposed = str(args, "newFileContents") ?? readOrEmpty(resolveUri(newFilePath).fsPath);
				// Untitled + an edit is the only way to show contents that are not on
				// disk yet without writing a temp file the user would have to clean up.
				const right = vscode.Uri.parse(`untitled:${resolveUri(newFilePath).fsPath}.pi-proposed`);
				const document = await vscode.workspace.openTextDocument(right);
				const edit = new vscode.WorkspaceEdit();
				edit.replace(right, new vscode.Range(0, 0, document.lineCount, 0), proposed);
				await vscode.workspace.applyEdit(edit);
				await vscode.commands.executeCommand("vscode.diff", left, right, str(args, "tabName") ?? "Proposed changes");
				return json({ success: true, oldFilePath: left.fsPath, newFilePath });
			},
		},
		{
			name: "getCurrentSelection",
			description: "Get the selection in the active editor.",
			inputSchema: { type: "object", properties: {} },
			run() {
				const editor = vscode.window.activeTextEditor;
				if (!editor) return text("No active editor.");
				return json(serializeSelection(editor));
			},
		},
		{
			name: "getDiagnostics",
			description: "Get diagnostics for one file or for the whole workspace.",
			inputSchema: {
				type: "object",
				properties: { uri: { type: "string", description: "File URI or path; omit for every file" } },
			},
			run(args) {
				const target = str(args, "uri");
				if (target) {
					const uri = target.includes("://") ? vscode.Uri.parse(target) : resolveUri(target);
					return json([diagnosticPayload(uri, vscode.languages.getDiagnostics(uri))]);
				}
				return json(
					vscode.languages
						.getDiagnostics()
						.filter(([, diagnostics]) => diagnostics.length > 0)
						.map(([uri, diagnostics]) => diagnosticPayload(uri, diagnostics)),
				);
			},
		},
		{
			name: "getOpenEditors",
			description: "List the tabs currently open.",
			inputSchema: { type: "object", properties: {} },
			run() {
				const tabs = vscode.window.tabGroups.all.flatMap((group) =>
					group.tabs.map((tab) => ({
						label: tab.label,
						isActive: tab.isActive,
						isDirty: tab.isDirty,
						filePath: tab.input instanceof vscode.TabInputText ? tab.input.uri.fsPath : undefined,
					})),
				);
				return json(tabs);
			},
		},
		{
			name: "getWorkspaceFolders",
			description: "List the workspace folders open in this window.",
			inputSchema: { type: "object", properties: {} },
			run() {
				return json((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath));
			},
		},
		{
			name: "saveDocument",
			description: "Save a file that is open in the editor.",
			inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] },
			async run(args) {
				const filePath = str(args, "filePath");
				if (!filePath) return text("filePath is required", true);
				const uri = resolveUri(filePath);
				const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.fsPath === uri.fsPath);
				if (!document) return text(`Not open in the editor: ${uri.fsPath}`, true);
				return json({ success: await document.save(), filePath: uri.fsPath });
			},
		},
	];
}

function resolveUri(filePath: string): vscode.Uri {
	if (filePath.includes("://")) return vscode.Uri.parse(filePath);
	if (filePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(filePath)) return vscode.Uri.file(filePath);
	const root = vscode.workspace.workspaceFolders?.[0];
	return root ? vscode.Uri.joinPath(root.uri, filePath) : vscode.Uri.file(filePath);
}

function clampLine(document: vscode.TextDocument, line: number): number {
	return Math.min(Math.max(0, line), Math.max(0, document.lineCount - 1));
}

function readOrEmpty(filePath: string): string {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return "";
	}
}
