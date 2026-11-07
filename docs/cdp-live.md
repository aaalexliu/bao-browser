# Retired live driver

The older live-driver tools, their CLI verbs, and their workflow replay driver have been removed. Use [`agent_browser`](agent-browser-engine.md#direct-mcp-commands) through `bao mcp` to drive Chrome.

For older MCP clients, `POST /api/live` returns HTTP 410 with an `error` that says the `live_*` tools were retired and points to `agent_browser` with `command=open` and `args=["<url>"]`. It does not start a live session.

Saved workflows with `driver: "cdp-live"` stay readable in Library. Library and Replay explain that the workflow used the retired live driver. Replay fails before opening a browser with `this workflow used the retired live driver`. Pass-through workflow replay is a later layer.

The pass-through records commands and screenshots in Runs, not replayable workflows. Bao does not block final clicks. [Agent quickstart](agent-quickstart.md) covers setup and [permissions](permissions.md) covers local evidence and profile isolation.
