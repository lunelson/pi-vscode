# Changelog

## Unreleased

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
