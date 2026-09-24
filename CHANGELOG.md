# Changelog

## Unreleased

### Fixed

- Attaching to a VS Code window with a file open crashed Pi (`Cannot access 'client' before initialization`), because the bridge's initial selection push arrived before the connection was recorded.
- A connection that closed during the attach handshake left a dead client in place that blocked reconnecting.

## 0.4.0

Cut down to one use case: Pi in any terminal, attached to VS Code, installed from a local checkout.

### Fixed

- A connection attempt that timed out mid-handshake crashed Pi with an uncaught `ws` error.
- Ending or replacing a session while it was connecting leaked a socket into the dead session.
- IDE tool failures now throw, so Pi reports them as errors instead of as successful results.
- The bridge checks the token before the WebSocket upgrade instead of after, and refuses bad tokens with HTTP 401.
- The lockfile and its directory are forced to `0600` and `0700` even when they already existed.
- A workspace path containing a folder named like `..cache` no longer counts as outside the workspace.

### Changed

- Pi loads `src/index.ts` directly; there is no Pi-side bundle. The package is private and not published.
- The bridge speaks plain JSON-RPC (`getDiagnostics`, `getOpenEditors`, `selection_changed`) instead of an MCP subset.
- The selection is the primary selection only, capped at 4,000 characters, with a count of any extra cursors.
- `ide_get_diagnostics` and `ide_get_open_editors` are always registered instead of toggled on attach, which kept rewriting the tool list mid-conversation.
- `/ide` is now `status`, `attach`, and `detach`.

### Removed

- The editor CLI fallback, `/ide install`, `~/.pi/agent/ide.json` and every setting in it, @-mentions, `PI_IDE_PORT`, and support for editors other than VS Code.
- The `ide_open_file`, `ide_open_diff`, `ide_get_selection`, and `ide_get_workspace_folders` tools.
- The bridge's restart and status commands and its `piIde.enabled` setting.
- The npm release workflow.

## 0.3.0

First release of the `@lunelson/pi-vscode` fork.

### Changed

- **Editor context is a prompt section.** The live selection is sent as a named `ide_context` system prompt section instead of a forced whole-prompt replacement. Pi appends a section patch only when the selection changes, which keeps the cached prompt prefix on providers with mid-conversation system messages. One-off @-mentions missing from the submitted prompt go in a hidden message. Requires Pi 0.86+.
- **Installs target one editor.** New `editorCli` setting (default `code`) picks the editor for `/ide install` and for `/ide attach` without a lockfile, instead of the first VS Code-family CLI on `PATH`.
- **Installs are opt-in.** `autoInstall` defaults to `false`, and only `/ide attach` may install implicitly. `/ide status` is read-only.
- **Ties are not guessed.** When several windows match the working directory equally, auto-attach reports the tie in the footer and waits for `/ide attach`. An explicit choice is remembered for automatic reconnects.
- Renamed the package to `@lunelson/pi-vscode` and the bundled editor extension to `lunelson.pi-vscode-bridge`.

## 0.2.3

### Security

- Republish from restored `main` after an unauthorized force-push on 2026-08-27 rewrote this repository's default branch. npm `0.2.2` was published on 2026-08-25, before that rewrite. Install from npm or this tag, not from a clone taken during the incident.

### Changed

- Run GitHub Actions on Node 22 so CI/release can import `@earendil-works/pi-coding-agent` (`fs.globSync` is not available on Node 20).

## 0.2.2

### Fixed

- The footer status bar showed a line number (`IDE Cursor · file.ts:12`) on every bare cursor move, implying a selection was active when nothing was actually highlighted. It now shows just the filename until there is a real selection, matching the prompt-injected IDE context, which already made this distinction.

## 0.2.1

### Documentation

- **README polish:** Reorganized documentation with a table of contents, an npm version badge, an explicit `License` section, and a configuration reference table describing each `~/.pi/agent/ide.json` field.

## 0.2.0

### Changed

- **Pi now ships its own editor extension instead of borrowing Claude Code's.** `extension/` builds to `dist/pi-ide.vsix`, which travels inside the npm tarball and is installed with `<editor-cli> --install-extension <vsix> --force` on the first `/ide` command. The bridge serves every authenticated client, so attaching never disconnects anyone — the single-slot eviction that produced `IDE websocket closed (1005)` is gone at the source rather than worked around.
- Discovery now scans `~/.pi/ide` and honours `PI_IDE_PORT`. The `~/.claude/ide` and `~/.opencode/ide` client paths, the `CLAUDE_CODE_SSE_PORT` / `OPENCODE_EDITOR_SSE_PORT` variables, and the sharing broker are removed.
- The auth header is `x-pi-ide-authorization`.
- `~/.pi/agent/ide.json` gains `autoInstall` (default `true`) and drops `share`.

### Added

- CLI-fallback (`open` / `diff`) and install-target detection now cover Antigravity, Positron, PearAI, Void, Theia Blueprint, Windsurf Next, VSCodium Insiders, VS Code Exploration, and Code OSS, alongside the existing Cursor / VS Code / Windsurf / VSCodium / Trae / Kiro.
- `/ide install` — install or repair the bridge on demand. It waits for the extension to publish a lockfile and says so plainly when the editor needs a window reload instead of reporting success.
- The footer status shows the active selection as `IDE Cursor · file.ts:12-27`.
- `saveDocument` and workspace-wide `getDiagnostics` on the bridge.

### Fixed

- Editor-hint detection picked the wrong binary when one product's env hint was a substring of another's (e.g. `code` inside `code-oss`, `code-insiders`, `codium`). It now prefers the longest — most specific — matching hint.
- `ide_open_file` honours `line` / `endLine` over the WebSocket transport, selecting the range directly instead of matching text.
- `/ide attach` reported success when an attach was already in flight. It now raises a clear error.

## 0.1.0

First release. Attach a live Pi session to a VS Code-family IDE without shipping a VS Code extension.

- Discover Claude-compatible lockfiles under `~/.claude/ide` and `~/.opencode/ide`.
- Honor `PI_IDE_PORT`, `CLAUDE_CODE_SSE_PORT`, and `OPENCODE_EDITOR_SSE_PORT`.
- Connect over localhost WebSocket with the lockfile auth token.
- Inject live selection into the next model turn and append IDE `@file#L` mentions to the editor.
- Expose IDE tools only while attached (`ide_open_file`, `ide_open_diff`, diagnostics, open editors).
- Fall back to the `cursor` / `code` / `windsurf` / `codium` CLI when no lockfile matches.
- `/ide attach|detach|status|auto on|off`.
