# Add Bao to a desktop app

Use Bao Settings on this Mac to connect Claude Desktop or ChatGPT to Bao's local MCP server. Install Bao.app first. These buttons do not install the desktop clients.

## Review and confirm the config change

1. Open **Settings → Technical details** in Bao.
2. Select **Add to Claude** or **Add to ChatGPT** under **Connect desktop apps**.
3. Read the file path and exact config diff. Nothing changes during preview.
4. Select **Add Bao** or **Update Bao** to apply that diff. To keep an existing entry, select **Leave unchanged** or press Escape.
5. Restart the desktop client to load the config.

Claude Desktop uses `~/Library/Application Support/Claude/claude_desktop_config.json`. ChatGPT uses `~/.codex/config.toml` on this Mac, shared with the Codex CLI and IDE extension. The ChatGPT button changes that shared file, not a separate ChatGPT file. The desktop buttons use these fixed paths under HOME, not the CLI's `CODEX_HOME` override.

Bao updates the existing `bao` entry instead of adding another one. It owns `command`, `args`, and `env` in both clients' entries. It sets the local launcher command and empty args, and removes stale Bao `env` settings. In the shared Codex config it also sets `tool_timeout_sec = 180` and `default_tools_approval_mode = "approve"`. That pre-approves only Bao's tools, the same way [one-command setup](agent-quickstart.md#mcp) does. Other keys, comments, explicit per-tool rules, and line endings keep their original bytes. A per-tool approval still wins. The Claude Desktop button does not set a tool approval.

Before replacing an existing file, Bao saves its exact bytes beside it as `<filename>.bao-backup-<UTC timestamp>-<unique suffix>`. The preview shows that backup path. Bao writes a temporary file, preserves the existing file mode, and atomically replaces the config. A new config gets mode `0600`. If the entry already matches, Bao writes no file or backup.

## Recover from an error

If another app edits the config after preview, close the dialog and select **Add** again. Bao requires a fresh preview rather than overwriting the new contents. A preview expires after ten minutes and works once.

If Bao reports malformed JSON or TOML, duplicate keys, a link, or an unsupported entry, edit the file manually and preview again. Bao refuses symbolic links, hard-linked files, files over 2 MiB, and an existing Bao entry that uses a remote URL. To switch a remote entry to Bao's local launcher, change it manually first. Check the file and directory permissions if Bao cannot read or write them.

To undo an update, quit the desktop client and restore the backup shown in Settings over the config file. Restart the client after the restore. A newly created config has no earlier file to back up.

## Build the Claude Desktop extension

Run `npm ci` first, then build a local bundle:

```sh
npm run package:mcpb -- /tmp/bao.mcpb
```

The build runs the official `mcpb validate`, `mcpb pack`, and `mcpb info` commands. See Anthropic's [MCPB CLI docs](https://github.com/anthropics/mcpb/blob/main/CLI.md) and [manifest specification](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md).

`npm run package:mac` also writes `bao.mcpb` beside `Bao.dmg`. The extension starts the installed app's `Contents/MacOS/bao-mcp` launcher. It relays stdio without a shell and gives the launcher Claude's Node executable through `BAO_NODE`.

The manifest requires macOS. Bao's native launcher finds an installed Node 24 or newer without relying on Claude's runtime.

Open the bundle in Claude Desktop only when you intend to install it. The extension uses `/Applications/Bao.app/Contents/MacOS/bao-mcp`. Use either the bundle or the Settings config entry for Claude, not both, to avoid two connections to Bao. This local build does not sign or notarize the extension and does not publish it to a directory.
