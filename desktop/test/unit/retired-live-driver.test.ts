import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { libraryTable, runDriverField, type WorkflowSummary } from "../../src/app/views";
import { Library } from "../../src/v1/store";
import type { WorkflowV2 } from "../../src/v1/schema";
import { applyHermeticApp } from "../runtime";

const reason = "this workflow used the retired live driver";

test("Library and Replay explain retired workflows; replay and live API never open a browser", async () => {
  const dirs = applyHermeticApp("retired-live");
  const library = new Library(dirs.home);
  const workflow: WorkflowV2 = { schema: "bao.workflow/v2", version: 2, id: "retired", name: "Saved task", createdAt: 1, driver: "cdp-live", startUrl: "https://example.test/", inputs: [], steps: [] };
  library.save(workflow);
  writeFileSync(path.join(dirs.home, "settings.json"), JSON.stringify({ careful: true, liveChromeProfile: "Profile 2" }));
  const app = await startApp({ home: dirs.home, port: 0 });
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${origin}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: workflow.id }) });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: reason, modelCalls: 0 });
    const state = await fetch(`${origin}/api/state`).then((res) => res.json()) as { settings: Record<string, unknown>; workflows: WorkflowSummary[] };
    assert.equal(state.settings.careful, undefined);
    assert.equal(state.settings.liveChromeProfile, undefined);
    assert.match(libraryTable(state.workflows, []), /This workflow used the retired live driver/);
    assert.match(runDriverField(workflow.driver), /This workflow used the retired live driver/);
    assert.deepEqual(library.listRuns(), []);
    assert.equal((await fetch(`${origin}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "live_session_start", url: workflow.startUrl }) })).status, 404);
  } finally { await app.close(); for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true }); }
});
