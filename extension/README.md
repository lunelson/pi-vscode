# Pi IDE Bridge

Serves editor context to [Pi Coding Agent](https://pi.dev) sessions: the live selection, diagnostics, open editors, and workspace folders, plus `openFile` / `openDiff` / `saveDocument` actions.

The bridge listens on loopback only, on a random port, and advertises itself in `~/.pi/ide/<port>.lock` with a per-window token. Every authenticated client is served — connecting never disconnects anyone else, so several agents can watch the same window at once.

Bundled with the `@lunelson/pi-vscode` package and installed by its `/ide install` command.

## Commands

- **Pi: Show IDE Bridge Status** — port and connected client count
- **Pi: Restart IDE Bridge**

## Settings

- `piIde.enabled` (default `true`) — serve editor context to Pi sessions
