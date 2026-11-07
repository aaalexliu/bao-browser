# Agent recording

Connect an MCP client to `bao mcp` with a temp HOME and Bao Library, pinned test Chromium, and a synthetic `BAO_AGENT_BROWSER_PROFILE_ROOT`. Use a staged native executable for a native end-to-end check.

Call `agent_browser` with `open`, read the returned tab list, choose the task tab, and drive the local fixture with native command arguments. Read fresh snapshots before acting. Check command output and the fixture's durable effect, not only an acknowledgement. End with `close`.

Open the running app's Runs page and inspect the recorded command argv, native results, screenshots, and end status. A supported single-page pass-through task saves a replayable workflow when the session ends. Unsupported tasks stay capture-only with a reason in the closing tool result. It does not redact raw evidence or block final clicks. Verify close, disconnect, and owned-window close against their own lifecycle receipts when affected.

The former live-driver recording tools no longer exist. Tests must not attach to daily Chrome to replace them.
