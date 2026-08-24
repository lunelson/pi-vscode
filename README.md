# pi-ide-integration

[![npm version](https://img.shields.io/npm/v/pi-ide-integration?logo=npm)](https://www.npmjs.com/package/pi-ide-integration)
[![license](https://img.shields.io/npm/l/pi-ide-integration)](LICENSE)

**pi-ide-integration** attaches a live [Pi Coding Agent](https://pi.dev) session to VS Code, Cursor, Windsurf, or another VS Code-family editor. It ships its own editor extension — **Pi IDE Bridge** — and installs it for you the first time you run `/ide`, so there's no marketplace step and no separate extension to keep in sync.

The bridge serves **every** client that connects, so several Pi sessions (or a Pi session and another agent) can watch the same window at once. Nothing gets disconnected when someone else attaches.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [How attach works](#how-attach-works)
- [The Pi IDE Bridge extension](#the-pi-ide-bridge-extension)
- [Tools](#tools)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- Pi Coding Agent **0.81+**
- Node.js **20+**
- A VS Code-family editor with its CLI on `PATH` — that CLI is how the bridge gets installed. Covers Cursor, VS Code (and Insiders/Exploration/OSS), Windsurf (and Next), VSCodium (and Insiders), Trae, Kiro, Antigravity, Positron, PearAI, Void, and Theia Blueprint.

## Install

Install from npm:

```bash
pi install npm:pi-ide-integration
```

Or install a local checkout:

```bash
pi install /absolute/path/to/pi-ide-integration
```

Restart Pi (or run `/reload`) after installation. To update the npm package later, use `pi update npm:pi-ide-integration`. Keep this package always-on if you use `pi-lazy`.

## Quick start

1. Open the repo in Cursor / VS Code / Windsurf.
2. In that same folder, start Pi:

   ```bash
   pi
   ```

3. Run `/ide`. If the bridge is not installed yet, Pi installs it and attaches. The footer shows `IDE Cursor`.
4. Highlight code. The next prompt includes that range as live IDE context, and the footer becomes `IDE Cursor · file.ts:12-27`.

Manual control:

```text
/ide              # status
/ide install      # (re)install the Pi IDE Bridge extension
/ide attach       # picker if several windows match
/ide attach cursor
/ide detach
/ide auto on
/ide auto off
```

## How attach works

Priority:

1. `PI_IDE_PORT`
2. Lockfiles in `~/.pi/ide/` whose `workspaceFolders` contain the Pi cwd (longest folder match wins)
3. CLI fallback (`cursor` / `code` / `windsurf` / `codium` / …) for `open` and `diff` only

The WebSocket is `ws://127.0.0.1:<port>` with `x-pi-ide-authorization` from the lockfile. Non-loopback hosts are refused. Stale PIDs are ignored, and lockfiles from editor windows that are gone are pruned on activation.

## The Pi IDE Bridge extension

Source lives in [`extension/`](extension); `npm run build` bundles it and packages `dist/pi-ide.vsix`, which ships inside the npm tarball. Installing is `<editor-cli> --install-extension <path to that vsix> --force`, which is what `/ide install` runs. There is no marketplace step: the extension version always matches the package that installed it.

Inside the editor it:

- listens on loopback, on a random port, with a per-window token
- publishes `~/.pi/ide/<port>.lock` and rewrites it when workspace folders change
- pushes `selection_changed` and `diagnostics_changed` to every attached client
- serves `openFile`, `openDiff`, `getCurrentSelection`, `getDiagnostics`, `getOpenEditors`, `getWorkspaceFolders`, `saveDocument`

Editor commands: **Pi: Show IDE Bridge Status**, **Pi: Restart IDE Bridge**. Setting: `piIde.enabled`.

## Tools

These are registered but **inactive until attached**.

| Tool                        | When              |
| ---------------------------- | ----------------- |
| `ide_open_file`             | Websocket or CLI  |
| `ide_open_diff`             | Websocket or CLI  |
| `ide_get_selection`         | Websocket         |
| `ide_get_diagnostics`       | Websocket         |
| `ide_get_open_editors`      | Websocket         |
| `ide_get_workspace_folders` | Websocket         |

## Configuration

`~/.pi/agent/ide.json`:

```json
{
  "autoAttach": true,
  "autoInstall": true,
  "injectSelection": true,
  "maxSelectionChars": 4000,
  "extraLockDirs": [],
  "pollIntervalMs": 2500
}
```

| Field               | Purpose                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `autoAttach`        | Attach automatically on session start and keep polling for a match.      |
| `autoInstall`       | Let `/ide` install the bridge into your editor on demand. Set to `false` to keep `/ide` from touching your editor; `/ide install` still works. |
| `injectSelection`   | Include the live selection as context on the next model turn.            |
| `maxSelectionChars` | Truncate injected selection text beyond this length.                     |
| `extraLockDirs`     | Extra directories to scan for lockfiles, alongside `~/.pi/ide/`.          |
| `pollIntervalMs`    | How often to retry attaching when no IDE has matched yet.                |

If Pi starts before the editor, auto-attach keeps polling until a matching lockfile appears.

## Troubleshooting

- **Installed, but nothing serves.** Some editor builds do not activate a freshly installed extension in the window that is already open. Reload the window, then `/ide attach`. `/ide install` reports this instead of claiming success.
- **No editor CLI.** `/ide install` needs `cursor` / `code` / `windsurf` / `codium` (or another supported editor's CLI) on `PATH`. In VS Code: *Shell Command: Install 'code' command in PATH*.
- **No attach, no footer.** Confirm a lockfile exists: `ls ~/.pi/ide`. Its `workspaceFolders` entry must contain your Pi cwd. `/ide attach` prints the last error. Check the **Pi IDE Bridge** output channel in the editor.
- **Stale `PI_IDE_PORT`.** An old port in the environment wins over the lockfile scan. Unset it or restart the terminal.
- **WSL / SSH remote.** The lockfile and port live where `pi` runs. Open the repo in the remote window so the bridge writes `~/.pi/ide` on that machine.

## Development

```bash
npm install
npm test
npm run build     # bundles src/ and packages extension/ into dist/pi-ide.vsix
```

The package declares its Pi extension in `package.json` under `pi.extensions`. See the [Pi package documentation](https://pi.dev/docs/latest/packages) for package installation, manifest, and gallery conventions. See [AGENTS.md](AGENTS.md) for architecture, constraints, and the release checklist.

## License

[MIT](LICENSE)
