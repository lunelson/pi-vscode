import * as vscode from "vscode";
import { pruneStaleLocks } from "./lockfile.ts";
import { PiIdeServer } from "./server.ts";

let server: PiIdeServer | undefined;
let log: vscode.LogOutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	log = vscode.window.createOutputChannel("Pi IDE Bridge", { log: true });
	context.subscriptions.push(log);

	context.subscriptions.push(
		vscode.commands.registerCommand("piIde.showStatus", () => {
			void vscode.window.showInformationMessage(
				server?.port === undefined
					? "Pi IDE Bridge is not serving. Check the Pi IDE Bridge output channel."
					: `Pi IDE Bridge on 127.0.0.1:${server.port} — ${server.clientCount} client(s).`,
			);
		}),
		vscode.commands.registerCommand("piIde.restart", async () => {
			await restart(context);
			void vscode.window.showInformationMessage("Pi IDE Bridge restarted.");
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("piIde.enabled")) void restart(context);
		}),
		{ dispose: () => stop() },
	);

	await restart(context);
}

export function deactivate(): void {
	stop();
}

async function restart(context: vscode.ExtensionContext): Promise<void> {
	stop();
	if (vscode.workspace.getConfiguration("piIde").get<boolean>("enabled") === false) {
		log?.info("Disabled by piIde.enabled");
		return;
	}
	pruneStaleLocks(process.pid);
	const version = (context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
	const next = new PiIdeServer(version, log ?? vscode.window.createOutputChannel("Pi IDE Bridge", { log: true }));
	try {
		await next.start();
		server = next;
	} catch (error) {
		next.dispose();
		const message = error instanceof Error ? error.message : String(error);
		log?.error(`Failed to start: ${message}`);
		void vscode.window.showErrorMessage(`Pi IDE Bridge failed to start: ${message}`);
	}
}

function stop(): void {
	server?.dispose();
	server = undefined;
}
