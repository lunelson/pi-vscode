# Pi VS Code Bridge

Serves this window's selection, diagnostics, and open editors to [Pi](https://pi.dev) sessions.

It listens on a random loopback port and advertises it in `~/.pi/ide/<port>.lock` with a per-window token, readable only by you. Connections without the token are refused before the WebSocket upgrade. Every authenticated client is served, so several Pi sessions can share one window.

Built and installed from the [pi-vscode](https://github.com/lunelson/pi-vscode) checkout with `npm run install:vscode`. It has no commands or settings.
