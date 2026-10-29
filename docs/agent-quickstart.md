# Agent quickstart

The command table is the [Agent quickstart](../README.md#agent-quickstart) in the README. This page is the current desktop contract. Run `node scripts/check-node.mjs` from the repo root. It reads `.nvmrc` and exits 1 when the running Node is older. If `nvm use` still leaves an older `node` first on PATH, prepend the bin directory from `nvm which node`.

```sh
export PATH="$(dirname "$(nvm which node)"):$PATH"
```

## Desktop service

`npm run build:desktop` compiles `desktop/` to `desktop/dist`. `npm run bao` then runs `node desktop/dist/desktop/src/app/cli.js` and skips `tsc`. A second `npm run build:desktop` picks up TypeScript edits.

`bao serve` listens on port 4787 unless `BAO_PORT` is set. Set `BAO_HOME` to the directory `bao serve` printed. In this checkout, `bao serve` defaults to `~/.local/share/bao` and `bao mcp` does not. `bao mcp` uses `BAO_HOME` when it is set, and otherwise creates `.bao-mcp` in the current directory. Those two homes disagree until pull request 133 lands. After that pull request, the shared default is `~/Library/Application Support/bao` on macOS and `~/.local/share/bao` on Linux.

`bao serve` writes `com.bao.desktop.json` under the real user home from `homedir()` in `defaultConfigHome`. On Linux that directory is `~/.config/google-chrome/NativeMessagingHosts`. `--home` does not move it.

## MCP

`bao mcp` is a stdio server. The tools are `search_workflows`, `describe_workflow`, `run_workflow`, and `get_run`.

Point the client at the compiled file, with `BAO_HOME` set to the serve home. Two forms, both after `npm run build:desktop`:

```sh
export BAO_HOME="$HOME/.local/share/bao"
node desktop/dist/desktop/src/app/cli.js mcp
./scripts/bao-mcp.sh
```

On macOS, after pull request 133, set `BAO_HOME` to the path `bao serve` printed. That default is `~/Library/Application Support/bao`, not the Linux path above.

`./scripts/bao-mcp.sh` execs that file. If `desktop/dist` is missing it writes one line to stderr and exits 1. If `BAO_HOME` is unset it exits 1 before the CLI creates `.bao-mcp`.

`npm run bao -- mcp` still starts the same CLI, and npm writes its script header to stdout before the first JSON-RPC byte. A client that parses stdout as the protocol will fail on that header. The header also used to wait on a full `tsc` run. The compile is gone. The header remains. Use the compiled file or `./scripts/bao-mcp.sh`.

Example client config, with the repo path and the serve home filled in:

```json
{
  "mcpServers": {
    "bao": {
      "command": "node",
      "args": ["/ABS/desktop/dist/desktop/src/app/cli.js", "mcp"],
      "env": { "BAO_HOME": "/ABS/to/the/serve/home" }
    }
  }
}
```

## Fixture MCP

`BAO_MCP_LIVE=1` selects `liveMcpMain` in `desktop/src/eval/live-mcp.ts`. The process requires `BAO_FIXTURE_URL`, creates a temporary profile, and launches an owned browser. That browser ends with the process. The evaluator's tools are `screenshot`, `snapshot`, `click`, `type`, `key`, `scroll`, and `upload`.

Leave `BAO_MCP_LIVE` unset for the four workflow tools. The history of the evaluator and the old stub is in [bao.md](bao.md).

## Extension

`./install-extension.sh` builds `extension/dist` and copies it to `~/.bao-browser/extension`. The extension id is `jcjcpblcjaakcmbgljdjkfgmmdfdbnfj`. Reload, the native-host manifest, and the popup check are in [extension.md](extension.md).

`./install-dev-legacy.sh` stages the root extension, including every file the manifest and its HTML reference. `./install-dev.sh` only prints those two names and exits 2.

## CDP live

`cdp-live` is a workflow driver. The contract and the 10-line start are in [cdp-live.md](cdp-live.md). The measured Chrome session is in [cdp-live-chrome.md](cdp-live-chrome.md).

## Checks

`npm run typecheck` checks `src`, `desktop`, `extension`, and `web`. `npm run check` runs that typecheck and `npm run test:desktop:unit`. `npm test` remains the root extension suites. Install Playwright's Chromium with `npx playwright install chromium` before `npm test` or the desktop unit suite. `npm --prefix web test` runs the registry tests in `web/src/lib`.

`npm --prefix web run dev` rewrites the two import lines in `web/next-env.d.ts` so they point at `web/.next/dev/types/`. The committed file points at `web/.next/types/`. Leave that rewrite uncommitted.
