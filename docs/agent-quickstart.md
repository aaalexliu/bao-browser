# Agent quickstart

The command table is the [Agent quickstart](../README.md#agent-quickstart) in the README. This page is the current desktop contract. Run `node scripts/check-node.mjs` from the repo root. It reads `.nvmrc` and exits 1 when the running Node is older. If `nvm use` still leaves an older `node` first on PATH, prepend the bin directory from `nvm which node`.

```sh
export PATH="$(dirname "$(nvm which node)"):$PATH"
```

## Desktop service

`npm run build:desktop` compiles `desktop/` to `desktop/dist`. `npm run bao` then runs `node desktop/dist/desktop/src/app/cli.js` and skips `tsc`. A second `npm run build:desktop` picks up TypeScript edits.

`bao serve` listens on port 4787 unless `BAO_PORT` is set. It prints `bao <port> home <path>`. `bao status` prints the same home as JSON and starts nothing. See [Library recovery](v1.md#install-and-run) for damaged files and [MCP](bao.md#mcp) for search results.

The CLI, `bao mcp`, and the installed Mac app pick the library with one resolver, `desktop/src/library-home.cjs`. `--home`, then `BAO_HOME`, is used as given, even when that directory is empty. Without either, the home is `~/Library/Application Support/bao` on macOS and `~/.local/share/bao` elsewhere. When that directory has no workflows or library data, Bao keeps an older library that has them: `~/.local/share/bao` on macOS, or `.bao-mcp` in the working directory. It names both directories on stderr when it does.

So `bao mcp` run from a checkout without `BAO_HOME` reads the library `bao serve` would pick from the same working directory, and a `.bao-mcp` library there can win. The `bao-mcp` launcher in the next section runs from inside the app, so it reads the app's library.

The Mac launcher runs `desktop/src/print-home.cjs` before the server starts. [Build Bao on a Mac](mac-build.md) has the installed app's paths.

`bao serve` writes `com.bao.desktop.json` under the real user home from `homedir()` in `defaultConfigHome`. On Linux that directory is `~/.config/google-chrome/NativeMessagingHosts`. `--home` does not move it.

## MCP

`bao mcp` is a stdio server. [MCP](bao.md#mcp) lists its tool routes. For direct native browser control, see [Direct MCP commands](agent-browser-engine.md#direct-mcp-commands).

Agents start it through `bao-mcp`, a launcher inside the Mac app: `/Applications/Bao.app/Contents/MacOS/bao-mcp`. It finds Node 24 or newer the way the app does ([Build Bao on a Mac](mac-build.md#launch)), then runs the app's own `bao mcp` from `Contents/Resources/bao`. So the agent config names no checkout, `node` need not be on PATH, and the agent's working directory does not pick the library. `bao-mcp` passes any arguments you add after it on to `bao mcp`. The source is `desktop/packaging/macos/bao-mcp.c`.

For Claude Desktop and ChatGPT, use the preview-and-confirm buttons in Bao Settings. [Add Bao to a desktop app](desktop-mcp-install.md) covers their config paths, backups, and the Claude Desktop `bao.mcpb` extension. Those paths do not grant broad tool approval.

One command sets up each CLI agent. `bao agent config claude` and `bao agent config codex` print the entry. `--write` puts it in that agent's own config and pre-approves Bao's tools there, so the agent runs them without asking first. Only the `bao` server is pre-approved. Other servers, the agent's global approval policy, and its permission mode stay as they were. Without `--write`, nothing is written.

`bao setup`, which the [installer](../README.md#install) runs, finds Claude Code, Codex and ChatGPT, Claude Desktop, and Cursor, and writes each picked entry through these same writers: the CLI writer for Claude Code and Codex, the Settings writer for Claude Desktop, and that writer's JSON edit for `~/.cursor/mcp.json`. `--yes`, `--agents`, and `--none` skip the picker. `bao doctor` checks each entry and makes one MCP handshake.

Pre-approval skips only the agent's own prompt. Without pre-approval, Codex asks before each Bao call, and `codex exec` with `approval_policy = "never"` refuses every Bao call with `MCP tool call requires approval, but approval policy is never`.

Agents drive Chrome through `agent_browser`. It accepts native commands and an argv array, launches a marked copy of the selected Chrome profile by default, and records commands and screenshots in Library Runs. See [Direct MCP commands](agent-browser-engine.md#direct-mcp-commands) for all browser choices. The default needs no running Bao app and no Screen Recording, Accessibility, or Automation grant. Explicit `browser: "current"` on the first `open` drives the owner's running Chrome through the Bao extension, in a folded Bao tab group. It needs the Bao app open and no Mac permission. Bao does not block final clicks. Raw command arguments, native results, and screenshots can contain credentials; this route does not redact them.

The older live tool surface and its workflow replay driver are retired. A saved file that is not [schema v4](workflow-schema.md) is not loaded. See [Workflow reuse](agent-browser-engine.md#workflow-reuse) for saving and replaying supported pass-through tasks.

```sh
npm run build:desktop
node desktop/dist/desktop/src/app/cli.js agent config claude --write
node desktop/dist/desktop/src/app/cli.js agent config codex --write
```

Claude Code: `--write` runs `claude mcp remove --scope user bao`, then the printed command. A failed remove only means there was no earlier entry.

```sh
claude mcp add --scope user bao -- /Applications/Bao.app/Contents/MacOS/bao-mcp
```

It then adds the rule `mcp__bao` to `permissions.allow` in Claude Code's user settings: `$CLAUDE_CONFIG_DIR/settings.json`, or `~/.claude/settings.json` when `CLAUDE_CONFIG_DIR` is unset. That rule matches every tool of the `bao` server and no other server. Without `--write`, the printed entry ends with a `#` line that names the rule and the file.

```json
{
  "permissions": {
    "allow": ["mcp__bao"]
  }
}
```

bao reads `settings.json` before it runs `claude`. Every other key and rule stays in its place, including your `deny` and `ask` rules, which still win over the allow rule. A file that already has the rule is left byte for byte, so `--write` again leaves it unchanged. A `settings.json` that is not plain JSON, such as one with comments, is refused before any `claude` command runs, and nothing is written. A linked `settings.json` keeps its link.

The Claude entry has no timeout. Claude Code 2.1.308 waits up to 100,000,000 ms for an MCP tool call, and 30 minutes for a stdio server that sends nothing. A per-server `timeout` would only shorten that.

Codex: `--write` puts this table in `$CODEX_HOME/config.toml`, or in `~/.codex/config.toml` when `CODEX_HOME` is unset.

```toml
[mcp_servers.bao]
command = "/Applications/Bao.app/Contents/MacOS/bao-mcp"
tool_timeout_sec = 180
default_tools_approval_mode = "approve"
```

Codex stops a tool call after 60 s by default. The 180-second server timeout gives a profile copy and Chrome startup more time. `default_tools_approval_mode = "approve"` pre-approves this server's tools and no other server's. `codex mcp add` cannot set either key, so bao writes the table itself. bao owns `command`, `args`, `env`, `tool_timeout_sec`, and `default_tools_approval_mode` in `[mcp_servers.bao]`, and an `[mcp_servers.bao.env]` sub-table. It replaces those in place and removes an old `args` or `env` that the new entry does not set. Every other line stays as it was, including your own keys in `[mcp_servers.bao]`, such as `enabled_tools` or `startup_timeout_sec`, and the tool approvals Codex saves in `[mcp_servers.bao.tools.<tool>]`. A per-tool `approval_mode` there still wins over the default. Running `--write` again on a current entry leaves the file unchanged. A bao entry in another form, such as an inline table, is refused, and nothing is written.

`--app` names another Bao.app. Without `--app`, the launcher is the one in `/Applications/Bao.app`. A missing launcher is named on stderr, and `--write` then writes nothing. A Bao.app built before the launcher has no `bao-mcp`; rebuild it from [Build Bao on a Mac](mac-build.md).

The catalog tools and `agent_browser` run in the MCP process. Open Bao.app to inspect their saved Library and Runs records.

The MCP process checks its loaded server entry file every two seconds and before tool lists and calls. A changed file identity must stay stable for at least two seconds before Bao treats it as an update. Missing files defer the check. Once no request is queued or running, no `agent_browser` session is open or starting, and no replay is held for a human step, the old process exits so the agent app can start the updated one. An eligible tool request instead receives a `Bao was updated` error before the process stops; `agent_browser close` stays available. Active sessions and held replays keep serving calls until those guards clear. This checks the installed MCP entry, not the running app's version, and cannot add update handling to an older process that lacks it. If tools do not return, restart the Bao connection in the agent app.

### MCP from a checkout

To try an MCP change before packaging, run the compiled file with `BAO_HOME` set to the home `bao serve` printed:

```sh
export BAO_HOME="/the/home/bao/serve/printed"
./scripts/bao-mcp.sh
```

`./scripts/bao-mcp.sh` execs `node desktop/dist/desktop/src/app/cli.js mcp`. If `desktop/dist` is missing it writes one line to stderr and exits 1. If `BAO_HOME` is unset it exits 1 before the CLI picks a library. `npm run bao -- mcp` writes npm's script header to stdout before the first JSON-RPC byte, and a client that parses stdout as the protocol fails on that header.

## Fixture MCP

`BAO_MCP_LIVE=1` selects `liveMcpMain` in `desktop/src/eval/live-mcp.ts`. The process requires `BAO_FIXTURE_URL`, creates a temporary profile, and launches the test browser (`BAO_TEST_BROWSER`, else Playwright's Chromium) with a mock keychain. That browser ends with the process. The evaluator's tools are `screenshot`, `snapshot`, `click`, `type`, `key`, `scroll`, and `upload`.

Leave `BAO_MCP_LIVE` unset for the [agent server](bao.md#mcp). The evaluator is described in [bao.md](bao.md#bao-mcp-drivers).

## Extension

`./install-extension.sh` builds `extension/dist` and copies it to `~/.bao-browser/extension`. The extension id is `jcjcpblcjaakcmbgljdjkfgmmdfdbnfj`. Reload, the native-host manifest, and the popup check are in [extension.md](extension.md).

## Retired workflows

The `cdp-live` workflow driver no longer runs. See [retirement behavior](cdp-live.md). For current Chrome commands, profile copies, recording, and cleanup, see [agent-browser pass-through](agent-browser-engine.md).

## Checks

`npm run typecheck` runs three passes: desktop (including `shared/`), extension, and web. `npm run check` runs that typecheck and the desktop unit suite. `npm run test:v1` runs the desktop unit suite alone. Run `npm install` and `npm --prefix web install` before `npx playwright install chromium`. Install that browser before running desktop tests. For desktop live files, run `npm run build:desktop && node desktop/test/run-live.mjs`. `npm --prefix web test` runs the registry tests in `web/src/lib`. See [Testing](TESTING.md) for focused checks and isolation rules.

`npm --prefix web run dev` rewrites the two import lines in `web/next-env.d.ts` so they point at `web/.next/dev/types/`. The committed file points at `web/.next/types/`. Leave that rewrite uncommitted.
