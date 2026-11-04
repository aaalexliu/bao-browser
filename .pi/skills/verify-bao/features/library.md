# Library

Library lists workflows in the current Bao home. A saved recording becomes a named card with its run status and a Run action.

## Sub-features

- `library.empty`: a new Library shows `No workflows yet`.
- `library.saved`: stopping a live recording creates a named card.
- `library.search`: `Search workflows` narrows cards and can be cleared.
- `library.detail`: opening a card shows the saved workflow's steps.

## How to get to it (user POV)

Open the served Bao URL or click sidebar **Library**. Use **Search workflows** to filter. Click the workflow's named button to open detail; click its separate **Run** button to open replay.

## Driving it with chrome-devtools-axi

Preconditions: use only the helper-owned UI Chromium, CDP URL, driver session, and temp home. The baseline starts with no workflows and later records the fixture workflow.

- **Empty state (baseline):** `open <instance.url>`, `resize 1440 1000`, then `snapshot`. Require the Library heading, temp Library path, and `No workflows yet`. Save `library-before.png`.
- **Saved state (baseline):** after `live_stop` and replay, `reload`, then `wait "put costco blueberries into the cart at instacart"`. Read `snapshot` and require the workflow card with `passed`. Save `library-after.png`. Compare the card name with `workflow.json`, not a manually inserted workflow.
- **Search (when affected):** resolve the `Search workflows` searchbox from `snapshot`, then `fill @<uid> blueberries`. Require the fixture card. Fill a nonmatching term such as `no-such-bao-workflow` and require no matching card. Clear with `fill @<fresh-uid> ""`; require the original card again. Save each state.
- **Detail (when affected):** click the button named `put costco blueberries into the cart at instacart` from a fresh snapshot. Require `#workflow-detail` and the recorded search/Enter/Add steps. Capture detail, then use its **Library** breadcrumb to return. Treat the detail **Run** as a separate replay entry point.

## Gotchas

- A permission banner and `helper off` are expected here. Do not grant a permission to hide them.
- Library's visible temp path distinguishes this app from the owner's installed Library. Stop if it shows the owner's home.
- The baseline proves empty/saved states, not search, editing, import, or deletion.
- A screenshot of a component preview is not Library proof. Capture the running `bao serve` UI.
