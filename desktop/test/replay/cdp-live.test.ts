import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import test from "node:test";
import { workflowDriver } from "../../src/extension/protocol";
import { validateWorkflow, type WorkflowV2 } from "../../src/v1/schema";
import { CDP_LIVE_SERVER_REFUSAL, EXTENSION_NOT_CONNECTED, refusesOwnedBrowser, replayRefusal } from "../../src/cdp-live/launch-guard";

test("cdp-live is not a workflow driver", () => {
  const doc = testWorkflow({ id: "wf-cdp-live", name: "Live", startUrl: "https://books.toscrape.com/" });
  assert.ok(validateWorkflow({ ...doc, driver: "cdp-live" as unknown as WorkflowV2["driver"] }).includes("driver"));
  assert.ok(validateWorkflow({ ...doc, driver: "cdp" as unknown as WorkflowV2["driver"] }).includes("driver"));
  assert.equal(workflowDriver({ driver: "cdp-live" }), "playwright");
  assert.equal(workflowDriver({ driver: "cdp" }), "playwright");
  assert.equal(refusesOwnedBrowser("cdp-live"), true);
  assert.equal(refusesOwnedBrowser("playwright"), false);
  assert.equal(refusesOwnedBrowser("extension"), false);
  assert.equal(refusesOwnedBrowser("cdp"), false);
  assert.equal(CDP_LIVE_SERVER_REFUSAL, "this workflow used the retired live driver");
});

test("a replay refuses cdp-live, and refuses an extension workflow only without a linked extension", () => {
  assert.equal(replayRefusal("cdp-live", { extensionLinked: true }), CDP_LIVE_SERVER_REFUSAL);
  assert.equal(replayRefusal("extension", { extensionLinked: false }), EXTENSION_NOT_CONNECTED);
  assert.equal(replayRefusal("extension", { extensionLinked: true }), null);
  assert.equal(replayRefusal("playwright", { extensionLinked: false }), null);
  assert.equal(replayRefusal(undefined, { extensionLinked: false }), null);
});
