# pi-vscode

Connects a [Pi](https://pi.dev) session to the VS Code window that has the same folder open. Pi can run in any terminal. It sees:

- **Your selection**, as a live `ide_context` system prompt section. Pi appends a section patch only when the selection changes, so the cached prompt prefix is kept on providers that accept mid-conversation system messages.
- **Diagnostics**, through the `ide_get_diagnostics` tool (errors and warnings, for one file or all).
- **Open editors**, through the `ide_get_open_editors` tool (open text tabs, the active one, unsaved changes).

Fork of [Rahularya01/pi-ide-integration](https://github.com/Rahularya01/pi-ide-integration), cut down to this use case. Needs Pi 0.86 or later.

## Install

```bash
git clone https://github.com/lunelson/pi-vscode.git ~/Code/lunelson/pi-vscode
cd ~/Code/lunelson/pi-vscode
npm install
npm run install:vscode              # builds dist/pi-vscode-bridge.vsix and installs it with `code`
pi install ~/Code/lunelson/pi-vscode
```

Pi loads `src/index.ts` from the checkout, so a `git pull` takes effect in the next Pi session. Rerun `npm run install:vscode` after changes under `extension/` and reload the VS Code window.

## Use

Start Pi anywhere inside a folder that is open in VS Code. Pi attaches on its own and retries every few seconds, so the order you start things in doesn't matter. The footer shows `IDE Visual Studio Code · file.ts:12-20` while attached.

| Command | Effect |
|---|---|
| `/ide` | Show the connection and the current selection |
| `/ide attach` | Reconnect; if several windows match, pick one |
| `/ide detach` | Disconnect and stop reconnecting until `/ide attach` |

Pi attaches to the window whose workspace folder most specifically contains its working directory. If two windows tie, it waits for `/ide attach` rather than guess, and the footer says so. The choice holds for the rest of the session, including reconnects after that window restarts; a new or resumed session asks again.

## How it works

The VS Code extension listens on a random loopback port and writes `~/.pi/ide/<port>.lock` (mode `0600`, in a `0700` directory) with that port, its workspace folders, and a per-window token. Pi reads the lockfiles, connects with the token, and gets selection changes pushed to it; tool calls are JSON-RPC requests over the same socket. The token is checked before the WebSocket upgrade. Every authenticated client is served, so several Pi sessions can share one window.

The selection sent to Pi is the primary selection only, capped at 4,000 characters, from `file:` editors only. Selected text is fenced and escaped so it cannot close the `ide_context` section.

## Development

```bash
npm run check   # typecheck, build the VSIX, run the tests
```

## License

MIT
