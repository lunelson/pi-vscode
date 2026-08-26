# pi-ide-integration

[![npm version](https://img.shields.io/npm/v/pi-ide-integration?logo=npm)](https://www.npmjs.com/package/pi-ide-integration)
[![license](https://img.shields.io/npm/l/pi-ide-integration)](LICENSE)

**pi-ide-integration** attaches a live [Pi Coding Agent](https://pi.dev) session to VS Code, Cursor, Windsurf, or any other VS Code-family editor, giving Pi visibility into what you're actually looking at — the open files, the current selection, live diagnostics — instead of working blind. It ships its own editor extension, **Pi IDE Bridge**, and installs it for you the first time you run `/ide`. There's no marketplace listing to find and no separate extension to keep in sync with the package version.

The bridge serves **every** client that connects, so several Pi sessions — or a Pi session alongside another agent — can watch the same window at once. Attaching a second client never disconnects the first.

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
- [License](#license)

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

Attaching means finding the right editor window and opening a websocket to it. The bridge tries three things, in order, and stops at the first that works:

1. **`PI_IDE_PORT`** — if set, connect there directly.
2. **Lockfile scan** — look through `~/.pi/ide/` for a lockfile whose `workspaceFolders` contain the Pi session's cwd. If several match, the longest (most specific) folder path wins.
3. **CLI fallback** — if nothing matches, fall back to the editor's CLI (`cursor` / `code` / `windsurf` / `codium` / …). This only covers `open` and `diff`; everything else needs a real attach.

Once a lockfile is found, the bridge connects to `ws://127.0.0.1:<port>` and authenticates with the `x-pi-ide-authorization` token stored in that lockfile. Connections to any host other than loopback are refused outright. On activation, the bridge also cleans house: lockfiles left behind by a process whose PID is no longer running, or by an editor window that has since closed, are pruned before the scan runs.

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

| Tool                         | Description                                                    | When              |
| ---------------------------- | ---------------------------------------------------------------- | ----------------- |
| `ide_open_file`              | Open a file in the attached IDE, optionally revealing a line.  | Websocket or CLI  |
| `ide_open_diff`              | Show a proposed file change as a diff tab in the attached IDE. | Websocket or CLI  |
| `ide_get_selection`          | Get the current or latest text selection from the attached IDE.| Websocket         |
| `ide_get_diagnostics`        | Get LSP / linter diagnostics from the attached IDE.             | Websocket         |
| `ide_get_open_editors`       | List files currently open in the attached IDE.                 | Websocket         |
| `ide_get_workspace_folders`  | List workspace folders open in the attached IDE.                | Websocket         |

"CLI" means these fall back to the editor CLI (`open` / `diff`) when no websocket is attached; the rest need an active attach.

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
