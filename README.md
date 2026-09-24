# pi-vscode

A fork of [pi-ide-integration](https://github.com/Rahularya01/pi-ide-integration) by Rahul Arya. It differs from upstream in four ways:

- **Cache-friendly editor context.** The live selection goes into a named `ide_context` system prompt section instead of replacing the whole system prompt. Pi appends a section patch only when the selection changes, so the cached prompt prefix survives. See [Editor context](#editor-context).
- **Installs target one editor.** `/ide install` uses the `editorCli` setting (default `code`) instead of the first VS Code-family CLI on `PATH`, and `autoInstall` is off by default. `/ide status` never installs anything.
- **No guessing between windows.** When two windows match the working directory equally well (for example, Cursor and VS Code on the same folder), auto-attach waits for `/ide attach` instead of picking the most recently touched one.
- **Own extension ID.** The bundled editor extension is `lunelson.pi-vscode-bridge`, not the official-looking `pi-coding-agent.pi-ide`.

**pi-vscode** attaches a live [Pi Coding Agent](https://pi.dev) session to VS Code, or any other VS Code-family editor, giving Pi visibility into what you're actually looking at — the open files, the current selection, live diagnostics — instead of working blind. It ships its own editor extension, **Pi IDE Bridge**, inside the package. There's no marketplace listing to find and no separate extension to keep in sync with the package version.

The bridge serves **every** client that connects, so several Pi sessions — or a Pi session alongside another agent — can watch the same window at once. Attaching a second client never disconnects the first.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [How attach works](#how-attach-works)
- [Editor context](#editor-context)
- [The Pi IDE Bridge extension](#the-pi-ide-bridge-extension)
- [Tools](#tools)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Requirements

- Pi Coding Agent **0.86+** (structured system prompt sections)
- Node.js **20+**
- A VS Code-family editor with its CLI on `PATH` — that CLI is how the bridge gets installed. `code` by default; set `editorCli` for Cursor, VS Code Insiders, Windsurf, VSCodium, Trae, Kiro, Antigravity, Positron, PearAI, Void, or Theia Blueprint.

## Install

This fork is not published to npm. `dist/` is not committed, so build a local checkout and install that:

```bash
git clone https://github.com/lunelson/pi-vscode.git
cd pi-vscode
npm ci --ignore-scripts
npm run build
pi install "$PWD"
```

Restart Pi (or run `/reload`) after installation. Rebuild after pulling changes. Keep this package always-on if you use `pi-lazy`.

## Quick start

1. Install the bridge into VS Code, then reload any open VS Code window:

   ```bash
   code --install-extension dist/pi-ide.vsix --force
   ```

   Or run `/ide install` from Pi, which does the same with the `editorCli` editor.
2. Open the repo in VS Code, and start Pi in that same folder (or a folder inside it).
3. The footer shows `IDE Visual Studio Code` once Pi attaches.
4. Highlight code. The next prompt includes that range as live IDE context, and the footer becomes `IDE Visual Studio Code · file.ts:12-27`.

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
2. **Lockfile scan** — look through `~/.pi/ide/` for a lockfile whose `workspaceFolders` contain the Pi session's cwd. If several match, the longest (most specific) folder path wins. If two or more windows tie for the most specific folder, auto-attach stops, the footer shows `IDE ? 2 windows · /ide attach`, and you choose with `/ide attach`. That choice is remembered for automatic reconnects until `/ide detach`.
3. **CLI fallback** — if nothing matches, fall back to an editor CLI. This only covers `open` and `diff`; everything else needs a real attach. Automatic fallback only happens inside an editor's own terminal, using that editor. An explicit `/ide attach` with no lockfile uses `editorCli`.

Once a lockfile is found, the bridge connects to `ws://127.0.0.1:<port>` and authenticates with the `x-pi-ide-authorization` token stored in that lockfile. Connections to any host other than loopback are refused outright. On activation, the bridge also cleans house: lockfiles left behind by a process whose PID is no longer running, or by an editor window that has since closed, are pruned before the scan runs.

## Editor context

While attached, the latest selection (or bare cursor position) is sent to the model as a system prompt section named `ide_context`:

```text
<ide_context>
Live state of the user's attached VS Code-family editor, not a project file dump. A later ide_context section replaces this one.
Active selection in /repo/src/app.ts (L12-27):
...
</ide_context>
```

Pi keeps the system prompt as structured sections and compares them before each run. When `ide_context` is unchanged, nothing is added. When it changes, Pi appends a small system-message patch to the transcript instead of rewriting the prompt at the head of the request, so providers can keep reusing the cached prefix. Providers that can't represent mid-conversation system messages get a full checkpoint instead, which does invalidate the cache. When the selection disappears or you detach, Pi appends a patch that removes the section.

Editor @-mentions are one-off, so they are not part of the section. Pi types them into your prompt; if one is missing from the submitted prompt, it is sent as a hidden message for that turn.

Set `"injectSelection": false` to turn all of this off and rely on the `ide_get_selection` tool.

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
  "autoInstall": false,
  "editorCli": "code",
  "injectSelection": true,
  "maxSelectionChars": 4000,
  "extraLockDirs": [],
  "pollIntervalMs": 2500
}
```

| Field               | Purpose                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `autoAttach`        | Attach automatically on session start and keep polling for a match.      |
| `autoInstall`       | Let `/ide attach` install the bridge when no window matches. Off by default; `/ide install` always works. |
| `editorCli`         | Editor CLI (name or path) used by `/ide install` and by `/ide attach` without a lockfile. `""` detects from the terminal environment, then `PATH` order. |
| `injectSelection`   | Send the live selection as the `ide_context` prompt section.             |
| `maxSelectionChars` | Truncate injected selection text beyond this length.                     |
| `extraLockDirs`     | Extra directories to scan for lockfiles, alongside `~/.pi/ide/`.          |
| `pollIntervalMs`    | How often to retry attaching when no IDE has matched yet.                |

If Pi starts before the editor, auto-attach keeps polling until a matching lockfile appears.

## Troubleshooting

- **Installed, but nothing serves.** Some editor builds do not activate a freshly installed extension in the window that is already open. Reload the window, then `/ide attach`. `/ide install` reports this instead of claiming success.
- **No editor CLI.** `/ide install` needs the `editorCli` binary on `PATH`. In VS Code: *Shell Command: Install 'code' command in PATH*.
- **Footer shows `IDE ? 2 windows`.** Two editor windows have this folder open. Run `/ide attach` and pick one, or close the other window.
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
