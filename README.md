# herdr-chat

Claude Code as a chat pane in the Herdr app, run by an engine on each machine through the Agent SDK. Tool calls fold into one line, edits show as diffs, images can be pasted, and the side panel shows context use, files changed and MCP servers.

![herdr-chat](mod/screenshot.png)

- `engine/`: the Bun server that runs Claude sessions and keeps them going while no pane is open.
- `mod/`: the Herdr mod, linked as `~/.config/herdr-app/mods/herdr-chat`.
- `scripts/install.sh`: installs the engine as a launchd or systemd service on a machine.
