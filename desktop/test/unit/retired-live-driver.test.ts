import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { RETIRED_LIVE_TOOL } from "../../src/mcp/version";
import { libraryTable, runDriverField, type WorkflowSummary } from "../../src/app/views";
import { Library } from "../../src/v1/store";
import type { WorkflowV2 } from "../../src/v1/schema";
import { applyHermeticApp } from "../runtime";
import { loadState, saveState } from "../../src/v1/sync";
import { draftVersion } from "../../src/v1/versions";
import { openProvisional } from "../../src/v1/promote";

const reason = "this workflow used the retired live driver";

test("Library and Replay explain retired workflows; replay and live API never open a browser", async () => {
  const dirs = applyHermeticApp("retired-live");
  const library = new Library(dirs.home);
  const workflow: WorkflowV2 = { schema: "bao.workflow/v2", version: 2, id: "retired", name: "Saved task", createdAt: 1, driver: "cdp-live", startUrl: "http://127.0.0.1/", inputs: [], steps: [] };
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
    for (const op of ["live_session_start", "live_snapshot", "live_stop", "__live_replay"]) {
      const retired = await fetch(`${origin}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, url: workflow.startUrl }) });
      assert.equal(retired.status, 410);
      assert.deepEqual(await retired.json(), RETIRED_LIVE_TOOL);
    }
    assert.deepEqual(library.listRuns(), []);
  } finally { await app.close(); for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP edits and replacement paths retain retirement and refuse browser launches", async () => {
  const dirs = applyHermeticApp("retired-mutations");
  let pageRequests = 0;
  let remote: WorkflowV2;
  const fixture = createServer((req, res) => {
    if (req.url === "/") {
      pageRequests += 1;
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<button data-testid="target">Target</button>');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url?.endsWith("/conflict")
      ? { version: 2, document: remote }
      : { devices: [], workflows: [], categories: [] }));
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const library = new Library(dirs.home);
  const ordinary: WorkflowV2 = {
    schema: "bao.workflow/v2", version: 2, id: "historical", name: "Before retirement", createdAt: 1,
    startUrl: `${fixtureOrigin}/`, inputs: [],
    steps: [{ id: "target", index: 0, action: "click", label: "Target", surface: "dom", timeoutMs: 1000, identity: { surface: "dom", role: "button", path: [], testId: "target" } }],
  };
  library.save(ordinary);
  const oldDraft = draftVersion(library, ordinary, "edit");
  library.save({ ...ordinary, driver: "cdp-live" });
  const provisional = { ...openProvisional({ workflowId: ordinary.id, healId: "heal", stepId: "target", before: ordinary.steps[0]!, patch: { identity: { surface: "dom", role: "button", path: [], testId: "target" } } }), version: oldDraft.n };
  library.savePromotion(provisional);
  const app = await startApp({ home: dirs.home, port: 0 });
  try {
    const origin = `http://127.0.0.1:${app.port}`;
    const send = (url: string, body: unknown, method = "POST") => fetch(`${origin}${url}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const refused = async () => {
      for (const [url, body] of [
        [`/api/workflows/${ordinary.id}/try`, { stepId: "target" }],
        ["/api/promotions/check", { id: ordinary.id }],
        ["/api/replay", { id: ordinary.id }],
      ] as const) {
        const response = await send(url, body);
        assert.equal(response.status, 409);
        assert.equal((await response.json() as { error: string }).error, reason);
      }
      assert.equal(existsSync(path.join(dirs.home, "chrome-profile")), false);
      assert.equal(pageRequests, 0);
      assert.deepEqual(library.listRuns(), []);
    };
    await refused();
    for (const driver of [null, "playwright", "extension"] as const) {
      const patched = await send(`/api/workflows/${ordinary.id}`, { driver }, "PATCH");
      assert.equal(patched.status, 409);
      assert.equal((await patched.json() as { error: string }).error, reason);
    }
    for (const driver of [undefined, "playwright", "extension"] as const) {
      const replacement = { ...ordinary, name: `Edited ${driver || "default"}`, driver };
      const patched = await send(`/api/workflows/${ordinary.id}`, { workflow: replacement }, "PATCH");
      assert.equal(patched.status, 200);
      assert.equal((await patched.json() as WorkflowV2).driver, "cdp-live");
      const versions = await fetch(`${origin}/api/workflows/${ordinary.id}/versions`).then((res) => res.json()) as { versions: { n: number }[] };
      const n = Math.max(...versions.versions.map((row) => row.n));
      const promoted = await send(`/api/workflows/${ordinary.id}/versions`, { action: "promote", n });
      assert.equal(promoted.status, 200);
      assert.equal((await promoted.json() as { document: WorkflowV2 }).document.driver, "cdp-live");
      assert.equal(library.read(ordinary.id).name, replacement.name);
      const imported = await send("/api/workflows/import", replacement);
      assert.equal(imported.status, 200);
      assert.equal((await imported.json() as WorkflowV2).driver, "cdp-live");
      assert.equal(library.read(ordinary.id).driver, "cdp-live");
      await refused();
    }
    const promoted = await send(`/api/workflows/${ordinary.id}/versions`, { action: "promote", n: oldDraft.n });
    assert.equal(promoted.status, 200);
    assert.equal((await promoted.json() as { document: WorkflowV2 }).document.driver, "cdp-live");
    const restored = await send(`/api/workflows/${ordinary.id}/versions`, { action: "restore", n: 1 });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json() as { document: WorkflowV2 }).document.driver, "cdp-live");
    for (const action of ["keep-theirs", "keep-both"] as const) {
      remote = { ...ordinary, name: action };
      const file = path.join(dirs.home, "conflicts", `${ordinary.id}.json`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(library.read(ordinary.id)));
      saveState(dirs.home, { ...loadState(dirs.home), server: fixtureOrigin, deviceToken: "fixture", deviceId: "fixture", backedUp: true,
        conflicts: [{ id: ordinary.id, remoteVersion: 2, at: 1, file }] });
      const resolved = await send("/api/sync/conflict", { id: ordinary.id, action });
      assert.equal(resolved.status, 200);
      assert.equal(library.read(ordinary.id).name, action);
      assert.equal(library.read(ordinary.id).driver, "cdp-live");
      await refused();
    }
    const ordinaryDoc = { ...ordinary, id: "ordinary", name: "Ordinary" };
    assert.equal((await send("/api/workflows/import", ordinaryDoc)).status, 200);
    const patched = await send("/api/workflows/ordinary", { workflow: { ...ordinaryDoc, name: "Still editable", driver: "playwright" } }, "PATCH");
    assert.equal(patched.status, 200);
    assert.equal((await patched.json() as WorkflowV2).driver, "playwright");
    const ordinaryVersions = await fetch(`${origin}/api/workflows/ordinary/versions`).then((res) => res.json()) as { versions: { n: number }[] };
    const ordinaryPromoted = await send("/api/workflows/ordinary/versions", { action: "promote", n: Math.max(...ordinaryVersions.versions.map((row) => row.n)) });
    assert.equal(ordinaryPromoted.status, 200);
    assert.equal((await ordinaryPromoted.json() as { document: WorkflowV2 }).document.driver, "playwright");
    assert.equal(library.read("ordinary").name, "Still editable");
    const tried = await send("/api/workflows/ordinary/try", { stepId: "target" });
    assert.equal(tried.status, 200);
    assert.equal((await tried.json() as { matched: boolean }).matched, true);
    assert.ok(pageRequests > 0);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    for (const dir of Object.values(dirs)) rmSync(dir, { recursive: true, force: true });
  }
});
