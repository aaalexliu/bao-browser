# Runs

Runs lists saved replay receipts with the workflow name, status, time, and run ID. Opening a row shows what happened during that run.

## Sub-features

- `runs.empty`: a new Library shows `No runs yet`.
- `runs.list`: replay produces a row with `passed` and `0 model calls`.
- `runs.detail`: the row opens the receipt for that exact run ID.

## How to get to it (user POV)

Click sidebar **Runs**. Click the workflow-name button in a row to open its receipt. That row button's accessible name is the run ID, not its visible workflow name.

## Driving it with chrome-devtools-axi

Preconditions: the isolated app is healthy. The baseline captures Runs before recording, then records and replays the local fixture through MCP.

- **Empty (baseline):** read `snapshot`, then send `await page.click('button[data-screen="runs"]');` to `chrome-devtools-axi run` on stdin. `wait "No runs yet"`, read another snapshot, then save `runs-before.png`. Return through sidebar **Library** before recording.
- **List (baseline):** after replay, read a fresh `snapshot` and click `button[data-screen="runs"]` through `chrome-devtools-axi run`. `wait passed`, then `snapshot`. Require `passed`, `0 model calls`, and the run ID from `run.json`. Read `document.querySelector("#runs").innerText` through `eval` to check the visible workflow name, which the row's accessible label hides. Save `runs-after.png`.
- **Detail (when affected):** locate the row button whose accessible name equals the saved run ID in `snapshot`, then `click @<uid>`. Require `#run-viewer[data-run="<runId>"]` with `data-status="passed"`. Inspect the visible step trail and the **Trail**, **Inputs**, **Console**, and **Network** tabs as the task needs. Save the action, a snapshot, and a screenshot. Compare the receipt's steps and shot refs with `run.json` and `run-shots/`.

## Gotchas

- Do not mistake a workflow's last status for a particular run receipt. Match the run ID.
- The baseline proves the list and empty state, not all receipt tabs, failure receipts, video, or past-input replay.
- CDP page pictures do not need Screen Recording. Do not enable native video or macOS privacy grants for missing pictures.
- Keep the stored receipt and copied step pictures before the temp Library is deleted. A screenshot alone does not prove zero model calls.
