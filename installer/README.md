# bao-browser

Install Bao on an Apple silicon Mac and add it to your coding agents with one command.

```sh
curl -fsSL https://raw.githubusercontent.com/aaalexliu/bao-browser/main/installer/install.sh | sh
```

That command reads `release.json` from the latest GitHub release, then runs the installer attached to that version. The package is not on npm. Do not run `npx` on the `releases/latest` tarball URL: npx caches that URL and keeps the first release it fetched.

The command downloads the prebuilt `Bao.app` this package version pins, checks its size and SHA-256, and puts it in `/Applications` (or `~/Applications` when `/Applications` is not writable). It links `~/.local/bin/bao`. Then it runs the app's own `bao setup`, which lists the agents and desktop apps it found on this Mac and lets you pick which ones start Bao.

You need no Xcode, Rust, Node 24, or signing certificate. `Bao.app` carries its own Node. The installer asks for no macOS permission. With no terminal and no flag, setup changes no agent and prints the commands to run.

## Options

Pass a flag after `sh -s --`, for example `curl -fsSL https://raw.githubusercontent.com/aaalexliu/bao-browser/main/installer/install.sh | sh -s -- --none`.

| Flag | What it does |
| --- | --- |
| `--yes` | Set up every agent found on this Mac without asking. |
| `--agents a,b` | Set up these: `claude-code`, `codex`, `claude-desktop`, `cursor`. |
| `--none` | Install the app and set up no agent. |
| `--dir DIR` | Use this Applications folder. |
| `--release FILE_OR_URL` | Use another `release.json`. |

Run it again to update. It prints the version it is about to install and the version already in `/Applications/Bao.app`, or in `~/Applications/Bao.app` when that is the only copy, even when this run has to write the other folder. It refuses a downgrade. It also refuses a same-version reinstall when a newer release exists or cannot be read. A run of the newest version reuses the checked download in `~/Library/Caches/bao/downloads`. That folder keeps only the current release; the installer deletes older downloads. Quit Bao and every agent app or session that uses it (Claude Desktop, Cursor, Claude Code, Codex) first; the installer will not replace a copy that is running and lists the processes that still use it. When the installed `Bao.app` is signed by a certificate and the release is signed another way (ad-hoc, or by a different certificate, even one with the same name), the installer asks before it replaces the app, because the swap drops the helper's Accessibility grant, which Running Chrome, the native Mac app driver, and `bao remote-debugging` use, and Bao's Files & Folders > Google Chrome switch. After an ad-hoc swap, agents answer to macOS as their own app again, and the grant does not survive the next update. A Developer ID release with the same team requirement replaces without asking: the grant follows the team across certificate renewal. It keeps the old app by default, and always keeps it with `--yes` or with no terminal to ask in.

[Release Bao](https://github.com/aaalexliu/bao-browser/blob/main/docs/release.md) covers how the app is built and signed.

## After install

```sh
~/.local/bin/bao setup    # pick agents again
~/.local/bin/bao doctor   # check the app, its signature, Node, agent configs, and one MCP handshake
```

A new Mac does not have `~/.local/bin` on PATH. To run plain `bao setup` and `bao doctor`, add `~/.local/bin` to your PATH.

These do the same without the link, for a `Bao.app` in `/Applications` or `~/Applications`:

```sh
curl -fsSL https://raw.githubusercontent.com/aaalexliu/bao-browser/main/installer/install.sh | sh -s -- setup
curl -fsSL https://raw.githubusercontent.com/aaalexliu/bao-browser/main/installer/install.sh | sh -s -- doctor
```

## What setup writes

| Pick | File | Writer |
| --- | --- | --- |
| Claude Code | `~/.claude.json`, `~/.claude/settings.json` | `claude mcp add --scope user`, then `mcp__bao` in `permissions.allow` |
| Codex CLI, Codex app, ChatGPT | `~/.codex/config.toml` | `[mcp_servers.bao]` with `default_tools_approval_mode = "approve"` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers.bao`, with a backup of the old file |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.bao`, with a backup of the old file |

Each entry starts `Bao.app/Contents/MacOS/bao-mcp`. Setup leaves every other server and key alone.
