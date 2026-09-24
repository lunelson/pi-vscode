# pi-vscode

Fork of `pi-ide-integration` (upstream remote: `Rahularya01/pi-ide-integration`), cut down to one use case: Pi running in any terminal, attached to VS Code, both halves installed from this checkout. Keep it that narrow; don't add features for other editors, publishing, or configuration without being asked.

## Development

```bash
npm install
npm run check   # typecheck, build dist/pi-vscode-bridge.vsix, test
```

Run `npm run check` before committing. `npm run install:vscode` installs the built VSIX into VS Code.

## Architecture

- `src/protocol.ts` — lockfile location and shape, auth header, selection payload. Shared by both halves, so it may import only Node built-ins.
- `src/discover.ts` — reads `~/.pi/ide/*.lock` and ranks windows by how specifically their folders contain the cwd.
- `src/client.ts` — authenticated JSON-RPC WebSocket client.
- `src/context.ts` — renders the `ide_context` section and the footer label.
- `src/index.ts` — Pi extension: attach poll, `/ide`, the two tools, the section.
- `extension/src/` — the VS Code bridge: server, lockfile, diagnostics and open-editor queries.

Pi loads `src/index.ts` through jiti; there is no Pi-side build. `extension/src` is bundled to CommonJS by esbuild because VS Code needs a CJS entry point.

## Constraints

- Bind and connect to loopback only. Never log auth tokens.
- Only the bridge writes `~/.pi/ide/*.lock`; Pi only reads them.
- The bridge serves every authenticated client. Never disconnect one client because another connected.
- Start sockets and polls on `session_start` and stop them on `session_shutdown`, never in the extension factory. A disposed session's runtime must not touch its `ui`.
- Editor state reaches the model only as the `ide_context` section on `systemPromptOptions.sections`. Never return `systemPrompt` from `before_agent_start`: it replaces the whole prompt and defeats prefix caching. Section text must depend only on editor state, or every prompt appends a patch.
- Tools stay registered and active; they throw when detached. Toggling them rewrites the tool list mid-conversation.
- Automatic attach must not choose between windows tied for the most specific workspace folder.
- Tests must not touch the real `~/.pi` directories.
