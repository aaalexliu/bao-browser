# Live session and recording

An agent drives a browser through Bao's live MCP tools. Ending the session saves a workflow the user can find in Library. Here, the site is the local Instacart fixture, not production.

## Sub-features

- `live.start`: start a careful session on the fixture storefront.
- `live.snapshot`: read the current controls and their short-lived refs.
- `live.act`: record search text, Enter, and an Add click.
- `live.stop`: save the workflow and release the private live lock.

## How to get to it (user POV)

An MCP client connects to `bao mcp` while `bao serve` is running with the same Library home. The client calls `live_session_start`, then `live_snapshot` and action tools, then `live_stop`. Bao's **Live** sidebar shows the session; the MCP baseline does not test that monitor's controls.

## Driving it with MCP and chrome-devtools-axi

Preconditions: the skill's isolated Launch setup; the fixture cart starts empty. The bundled helper runs these calls and preserves all arguments and replies in `actions.json`.

- **Start:** `live_session_start` with `{careful: true, intent: "put costco blueberries into the cart at instacart", url: fixture.url("/store/costco/storefront")}`. Require `outcome.kind === "applied"` and a session ID.
- **Read:** `live_snapshot` with `{}`. Require the `Search Costco` control. Use its returned ref, not a hard-coded `e1.c2`.
- **Search:** `live_type` with `{ref, text: "blueberries"}`, then `live_key` with the refreshed search ref and `key: "Enter"`. Require the search result view before selecting an Add.
- **Add:** `live_click` with the ref whose label is `Add 1 ct ${TARGET.name}`. `TARGET` comes from `desktop/test/instacart/fixture.ts`, so a catalog change fails visibly rather than selecting the first Add button.
- **Stop:** `live_stop` with `{}`. Require `outcome.kind === "stopped"`. Verify the saved workflow has `type`, `key`, `click` steps; the fixture log has one `add` for `TARGET.id`, quantity 1; and the private lock is absent. Reload Library and save its screenshot and snapshot.

## Gotchas

- `applied` acknowledges an action, not its durable result. Inspect `fixture-recorded.json` and `workflow.json` too.
- Fixture host names look like Instacart but resolve to loopback in this browser. Label all evidence **local fixture**.
- Search text replays as recorded text, not an input placeholder.
- Do not test disconnect-save by just replacing `live_stop` in this recipe. That is a separate path with its own expected receipt and lock cleanup.
- Never enable browser debugging on everyday Chrome to make this recipe work.
