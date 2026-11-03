# Workflow replay

A saved workflow runs again and leaves a receipt. Live-recorded workflows replay through the same isolated live target, not Bao's default Chrome.

## Sub-features

- `replay.mcp`: `run_workflow` returns the saved run ID and result.
- `replay.ui`: Library, workflow detail, and Replay lead to the same Run form.
- `replay.effects`: the fresh fixture cart contains one expected item after replay.
- `replay.receipt`: a stored run reports passed steps, zero model calls, and no heals.

## How to get to it (user POV)

- MCP: call `run_workflow` with the saved workflow ID.
- UI: click **Run** on its Library card, or open its workflow detail and click **Run**.
- UI: click sidebar **Replay**, then choose the workflow in **Workflow**.
- A `bao://workflow/<id>` link also opens the workflow path, but OS deep-link dispatch belongs to installed-app verification, not this temp server baseline.

## Driving it with MCP and chrome-devtools-axi

Preconditions: finish the mapped live recording, stop the session, and reset only the fixture cart. Keep the same throwaway target and Library home.

- **MCP replay (baseline):** `run_workflow` with `{id: workflow.id}`. Require `outcome === "ok"`. Read `run.json` from the Library, not just the tool reply: `status === "passed"`, `modelCalls === 0`, and `heals` is empty. Require one fresh `add` of `TARGET.id` at quantity 1 in `fixture-replayed.json`, and no trap hits.
- **UI entry points (when affected):** from a fresh `snapshot`, click the card's **Run**, detail's **Run**, or sidebar **Replay**. Check `#run-form` and `select#wf` identify the intended workflow. Click the primary **Run** (`button#run`), not the sidebar or card button with the same name. Resolve its handle from a new snapshot. Wait for a run receipt and confirm the same cart and saved-run invariants as the MCP path. Reset the fixture cart between entry points.
- **Evidence:** keep the tool/UI action, run ID, stored receipt, run step screenshots, and fixture writes. Capture the resulting Runs row and open the receipt when the task changes detail behavior.

## Gotchas

- The baseline exercises MCP replay, not all three UI entry points or OS deep links. Name the path actually tested.
- Replaying on an already-filled cart can correctly skip an Add as `already done`; that does not prove an empty-cart effect. Reset it first for this recipe.
- No replay may enter checkout, login, or account fixture traps.
- Do not change the workflow's driver to avoid a live-target failure. Do not enable a model to make replay pass.
