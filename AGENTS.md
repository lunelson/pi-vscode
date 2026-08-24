# pi-ide-integration

Pi package that attaches a live Pi session to a VS Code-family IDE. It ships its own editor extension (`extension/`), installs it through the editor CLI, and connects to it over a loopback WebSocket.

## Development

```bash
npm install
npm test
npm run build
```

- Run `npm test` before committing.
- Run `npm pack --dry-run` before publishing.
- `npm run build` produces both `dist/index.js` (the Pi extension) and `dist/pi-ide.vsix` (the editor extension). Regenerate after source changes in either half.

## Architecture

- `extension/` — the Pi IDE Bridge editor extension: multi-client MCP server, lockfile publisher, selection/diagnostics push
- `src/discover.ts` — `PI_IDE_PORT` + `~/.pi/ide` lockfile scan
- `src/install.ts` — editor CLI detection and `--install-extension` of the bundled VSIX
- `src/client.ts` — localhost WebSocket MCP client
- `src/context.ts` — selection / @-mention formatting
- `src/cli-fallback.ts` — `cursor` / `code` / `windsurf` / `codium` open + diff
- `src/config.ts` — `~/.pi/agent/ide.json`
- `src/index.ts` — `/ide` command, tools, session lifecycle

## Constraints

- Bind and connect to loopback only.
- Never log auth tokens.
- Only the editor extension writes `~/.pi/ide/*.lock`. The Pi side reads them.
- The extension must serve every authenticated client. Never disconnect one client because another connected — that single-slot behaviour is the bug this package exists to avoid.
- Do not start sockets, polls, or watchers from the extension factory. Start on `session_start`, stop on `session_shutdown`.
- Never write a session file from a second `pi --mode rpc` process.
- Keep IDE tools inactive unless a session is attached.
- Installing into the editor is a side effect: it happens on an explicit `/ide` command, never at session start, and `autoInstall: false` must disable it.
- `extension/src` is authored as CommonJS because VS Code requires a CJS entry point; the root sources are ESM.
- Tests must not touch the real `~/.pi/agent` or `~/.pi/ide` directories.

## Releases

1. Update `package.json` version, `extension/package.json` version, and `CHANGELOG.md`.
2. Run `npm test` and verify the packed artifact imports from a clean temporary install.
3. Confirm `dist/pi-ide.vsix` is present in `npm pack --dry-run` output.
4. Commit, tag `v<version>`, and push `main` plus the tag.
