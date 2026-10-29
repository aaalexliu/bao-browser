# Agent quickstart

The command table is the [Agent quickstart](../README.md#agent-quickstart) in the README. This page is the current desktop contract. Node is 24 or newer.

## Desktop service

`npm run build:desktop` compiles `desktop/` to `desktop/dist`. `npm run bao` then runs `node desktop/dist/desktop/src/app/cli.js` and skips `tsc`. A second `npm run build:desktop` picks up TypeScript edits.

`bao serve` listens on port 4787 unless `BAO_PORT` is set. The CLI home default is `~/.local/share/bao`.

## MCP

`bao mcp` is a stdio server. The tools are `search_workflows`, `describe_workflow`, `run_workflow`, and `get_run`.

Point the client at the compiled file. Two forms, both after `npm run build:desktop`:

```sh
node desktop/dist/desktop/src/app/cli.js mcp
./scripts/bao-mcp.sh
```

`./scripts/bao-mcp.sh` execs that file. If `desktop/dist` is missing it writes one line to stderr and exits 1.

`npm run bao -- mcp` still starts the same CLI, and npm writes its script header to stdout before the first JSON-RPC byte. A client that parses stdout as the protocol will fail on that header. The header also used to wait on a full `tsc` run. The compile is gone. The header remains. Use the compiled file or `./scripts/bao-mcp.sh`.

Example client config, with the repo path filled in:

```json
{
  "mcpServers": {
    "bao": {
      "command": "node",
      "args": ["/ABS/desktop/dist/desktop/src/app/cli.js", "mcp"]
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

`npm run typecheck` checks `src`, `desktop`, `extension`, and `web`. `npm run check` runs that typecheck and `npm run test:desktop:unit`. `npm test` remains the root extension suites. `npm --prefix web test` runs the registry tests in `web/src/lib`.
