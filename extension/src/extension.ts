import * as vscode from "vscode";
import { pruneStaleLocks } from "./lockfile.ts";
import { BridgeServer } from "./server.ts";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const log = vscode.window.createOutputChannel("Pi Bridge", { log: true });
	context.subscriptions.push(log);
	pruneStaleLocks(process.pid);
	const server = new BridgeServer(log);
	context.subscriptions.push({ dispose: () => server.dispose() });
	try {
		await server.start();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error(`Failed to start: ${message}`);
		void vscode.window.showErrorMessage(`Pi Bridge failed to start: ${message}`);
	}
}

export function deactivate(): void {}
