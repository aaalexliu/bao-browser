# bao-browser

Install Bao on an Apple silicon Mac and add it to your coding agents with one command.

```sh
npx bao-browser
# or
bunx bao-browser
```

Until the package is on npm, run the copy attached to the latest GitHub release:

```sh
npx https://github.com/aaalexliu/bao-browser/releases/latest/download/bao-browser.tgz
```

The command downloads the prebuilt `Bao.app` this package version pins, checks its size and SHA-256, and puts it in `/Applications` (or `~/Applications` when `/Applications` is not writable). It links `~/.local/bin/bao`. Then it runs the app's own `bao setup`, which lists the agents and desktop apps it found on this Mac and lets you pick which ones start Bao.

You need no Xcode, Rust, Node 24, or signing certificate. `Bao.app` carries its own Node. The installer asks for no macOS permission. With no terminal and no flag, setup changes no agent and prints the commands to run.

## Options

| Flag | What it does |
| --- | --- |
| `--yes` | Set up every agent found on this Mac without asking. |
| `--agents a,b` | Set up these: `claude-code`, `codex`, `claude-desktop`, `cursor`. |
| `--none` | Install the app and set up no agent. |
| `--dir DIR` | Use this Applications folder. |
| `--release FILE_OR_URL` | Use another `release.json`. |

Run it again to update. A run with the same version reuses the checked download in `~/Library/Caches/bao/downloads`. That folder keeps only the current release; the installer deletes older downloads. Quit Bao and every agent app or session that uses it (Claude Desktop, Cursor, Claude Code, Codex) first; the installer will not replace a copy that is running and lists the processes that still use it. When the installed `Bao.app` is signed by a certificate and the release is signed another way (ad-hoc, or by a different certificate, even one with the same name), the installer asks before it replaces the app, because the swap drops the Accessibility grant running-Chrome mode uses. It keeps the old app by default, and always keeps it with `--yes` or with no terminal to ask in.

[Release Bao](https://github.com/aaalexliu/bao-browser/blob/main/docs/release.md) covers how the app is built and signed.

## After install

```sh
bao setup    # pick agents again
bao doctor   # check the app, its signature, Node, agent configs, and one MCP handshake
```

`npx bao-browser setup` and `npx bao-browser doctor` do the same without the link.

## What setup writes

| Pick | File | Writer |
| --- | --- | --- |
| Claude Code | `~/.claude.json`, `~/.claude/settings.json` | `claude mcp add --scope user`, then `mcp__bao` in `permissions.allow` |
| Codex CLI, Codex app, ChatGPT | `~/.codex/config.toml` | `[mcp_servers.bao]` with `default_tools_approval_mode = "approve"` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.bao`, with a backup of the old file |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.bao`, with a backup of the old file |

Each entry starts `Bao.app/Contents/MacOS/bao-mcp`. Setup leaves every other server and key alone.
