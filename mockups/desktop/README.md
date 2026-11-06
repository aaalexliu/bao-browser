# Bao desktop design archive

Three desktop redesign mocks, the shared brief, and screenshots from the November 5,
2026 review. These are design artifacts, not shipped product code.

## Directions

- **Inbox / Runs**: a native Mac three-pane layout that puts runs needing attention first.
- **Recipe**: a warm, single-column layout that presents each workflow as a recipe.
- **Console**: a dark, dense, keyboard-first layout for many workflows and detailed run evidence.

## Decision

The owner picked **Inbox**. On November 6, 2026, the owner confirmed the name **Runs**,
with Activity folded in. The mock has three places: Runs, Workflows, and Settings.
Runs pins a “Needs you” group above run history grouped by day. One Record button replaces
Capture and Teach. The Workflows list holds the damaged-workflow banner.

The file remains `variant-inbox.html` to preserve links. Building this direction into the
app, its order of work, and its delivery scope remain separate decisions.

## Open the mocks

Open [`mocks.html`](mocks.html) directly in a browser. No server, install, or build is
needed. The board offers **Current**, **Runs (was Inbox)**, **Recipe**, and **Console**
through relative paths. Keys 1-4 select a direction; left and right arrows select a screen.
“Open full size” opens the selected HTML or current-app image.

Each direction also opens on its own:

| File | Direction |
| --- | --- |
| [`variant-inbox.html`](variant-inbox.html) | Inbox / Runs |
| [`variant-recipe.html`](variant-recipe.html) | Recipe |
| [`variant-console.html`](variant-console.html) | Console |

Append `?screen=<id>` to any variant, or `?__variant=<direction>&screen=<id>` to the
board (`current`, `inbox`, `recipe`, or `console`). All seven screen IDs work in each
variant:

| Screen ID | View |
| --- | --- |
| `home` | Attention and overview |
| `workflow` | Workflow steps, inputs, and recent runs |
| `run-live` | A run paused on “Needs you” |
| `run-failed` | A failed run report |
| `heal` | A proposed target change to keep or revert |
| `capture` | A recording in progress |
| `settings` | Grouped settings and permissions |

Extra states match the screenshots in `shots/`:

| Variant | Query | Screenshot |
| --- | --- | --- |
| Inbox / Runs | `?screen=workflow&view=library` | `shots/inbox/workflows-library.png` |
| Inbox / Runs | `?screen=home&w=720` | `shots/inbox/home-720.png` |
| Inbox / Runs | `?screen=workflow&w=720` | `shots/inbox/workflow-720.png` |
| Inbox / Runs | `?screen=home&state=empty` | `shots/inbox/home-empty.png` |
| Inbox / Runs | `?screen=home`, browser prefers dark colors | `shots/inbox/home-dark.png` |
| Recipe | `?screen=home&w=720` | `shots/recipe/home-720.png` |
| Recipe | `?screen=home&state=new` | `shots/recipe/home-new.png` |
| Console | `?screen=home&w=720` | `shots/console/home-720.png` |
| Console | `?screen=home&empty=1` | `shots/console/home-empty.png` |

The 720 px query shrinks the mock window, not the outer browser viewport. Inbox / Runs
follows the browser's light/dark preference. Recipe is light-only and uses one Google
Fonts link for Fraunces, with a local serif fallback. Console is dark-only. CSS, scripts,
and SVG drawings are inline; there are no external images or JS frameworks.

The original board's “Queue this answer” form needs its original review host's
`window.lavish` integration. It sends nothing when opened locally.

## Files and privacy

[`brief.md`](brief.md) preserves the shared design brief as historical input, not current
product behavior or instructions to implement it. Its local paths use `/Users/owner` as a
placeholder. The repository's current docs remain the source for shipped behavior.

`shots/` contains 30 fresh captures of the placeholder HTML at a 1440 x 960 browser
viewport and device scale 1. All captures, including Inbox's former 2x images, now use
1x, 256-color indexed PNGs to keep the archive small.

`current/` contains 12 historical app screenshots at 1280 x 860 from `v1/desktop`
(`798e40e`). Every image was opened for review. Solid opaque boxes cover the email
labels and embedded account screenshots in `current/run.png` and
`current/workflow.png`, including the run filmstrip. No current-app image was dropped.
These pixels are redacted, not blurred.

Email values use `owner@example.com`; home folders use `/Users/owner`. Account/card
suffixes use `XXXX`, vehicle plates use `SAMPLE1`, and the sample VIN suffix uses
`00000`. The greeting uses “Owner” and application URLs use `example.com`. Real workflow
names remain, including Costco, Kirkland, and the 五秒 Google OAuth workflows.

The board's Current views show the closest available historical screen, not seven
matching live states: `live.png` has no active session, `heals.png` is empty, and the
failed-run comparison uses the saved passed-run report in `run.png`.

## Ranked review of the app at the time

The review ran on the app at 1280 px on `v1/desktop` (`798e40e`), with the owner's library
copied to a scratch home. Findings below come from that review, ranked by user impact.
Focus rings, keyboard paths, and 200% zoom were **not verified**. File and line references
refer to that branch; abbreviated app paths are under `desktop/src/app/`.

| Severity | Finding | Where on `v1/desktop` |
| --- | --- | --- |
| HIGH | One invalid workflow blanks the whole Library: “No workflows yet” for a library of 7, with no error or recovery. The Costco workflow fails schema validation (`when wf-...-3`). | `client.ts:150`, `views.ts:1124`, `desktop/src/v1/store.ts:140` |
| HIGH | Runs without a saved workflow never open. All 5 `agent-browser` runs stay on “Loading run...” because `/api/workflows/agent-browser` returns 500 and `showRun` has no error path. | `client.ts:925-937` |
| HIGH | Workflow titles truncate with an ellipsis and no way to read the full name. | `public/index.html:343`, `views.ts:1111` |
| MEDIUM | Runs are not sorted by time; raw run IDs take a column; “0 model calls” appears on every row; wrapped names center-align. | `views.ts:1638-1645` |
| MEDIUM | Run buttons use the run ID as the accessible name, not the workflow name. | `views.ts:1643` |
| MEDIUM | Navigation has nine flat items; Capture and Teach overlap; Replay opens a page titled Run; Runs and Live share an icon. | `views.ts:278-288` |
| MEDIUM | Developer copy reaches non-technical users: bundle IDs, `bao mcp`, AT-SPI, `BAO_REMOTE_MCP=1`, raw selectors, `{{text}}` through `{{text11}}`, “expect”, and the start URL `/fixture`. | `client.ts:283`, `client.ts:295`, `views.ts:311` |
| MEDIUM | Settings is one long ungrouped form; the remote-agent checkbox sits far from its label. | Settings screen |
| MEDIUM | Library thumbnails are gray placeholders; cards carry up to 13 input chips. | Library screen |
| LOW | Each step repeats “If this step misses / Try / Run from step N”; “Guide me” wraps. | Workflow screen |
| LOW | Heals draws an empty bordered box; filter buttons show no selected state. | Heals screen |
| LOW | Footer labels “helper off”, “no model”, and “cursor account” give no meaning or next step. | `views.ts:289-293` |

### Status on main at the handoff

The handoff compared source on `main` at **`620addc`**, not a running app. These notes do
not claim to describe the latest main branch:

- **Stuck runs: fixed.** `showRun` (`client.ts:1011`) falls back when the workflow request fails.
- **Invalid library: changed, not re-verified.** `client.ts:168` throws instead of rendering an empty library. The store still rejects the whole library for one bad file (`store.ts:140`). The review did not check what the user sees on main.
- **Run accessible names: unchanged.** `views.ts:1715` still uses the run ID.
- **Title truncation: unchanged.** `public/index.html:354` still uses the ellipsis.

The handoff did not recheck the remaining findings against main.
