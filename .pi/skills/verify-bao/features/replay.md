# Workflow replay

The pass-through records commands and saves supported single-page tasks as current-engine workflows when the session ends. Verify that supported tasks appear in Workflows and replay; unsupported tasks must stay capture-only with a closing reason. A saved workflow whose driver is `cdp-live` must fail in app Replay and MCP `run_workflow` with `this workflow used the retired live driver`, before a browser opens. Its workflow row, detail, and saved run evidence must remain readable.

Use a schema-valid historical fixture in a temporary Library to check that refusal. Test the app API and MCP separately; neither proves the other. Capture Library and the Replay form on the running test-owned app, with a page snapshot before each screenshot.

Ordinary Playwright workflows keep their separate replay path. When that path changes, drive a local fixture and check its durable effect, saved run status, and screenshots. Do not claim a retired-workflow refusal proves ordinary replay success. Do not use a daily profile or model account.
