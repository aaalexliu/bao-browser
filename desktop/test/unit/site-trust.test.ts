import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";

function ident(text: string): Identity {
  return { surface: "dom", role: "button", text, path: [] };
}

function doc(steps: WorkflowStep[]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id: "requested", name: "Requested actions",
    startUrl: "http://127.0.0.1:9/fixture", createdAt: 1, inputs: [],
    steps: steps.map((step, index) => ({ ...step, index })),
  };
}

function counting(): Driver & { clicks: string[] } {
  const clicks: string[] = [];
  const tree: LiveTree = { nodes: ["Apply", "Send", "Place Order", "Pay"].map(ident), texts: [], values: [] };
  return {
    clicks,
    tree: async () => tree,
    snapshot: async () => ({ dom: "fixture" }),
    click: async (node) => { clicks.push(node.text || ""); },
    fill: async () => {}, key: async () => {}, upload: async () => {}, drop: async () => {},
    digits: async () => {}, check: async () => {}, notify: async () => {}, sleep: async () => {},
  };
}

function click(label: string, index: number): WorkflowStep {
  return { id: `step-${index}`, index, action: "click", label, surface: "dom", timeoutMs: 0, identity: ident(label) };
}

test("old site and remote approvals do not survive the Settings read", () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-retired-trust-")));
  writeFileSync(path.join(library.root, "settings.json"), JSON.stringify({
    siteTrust: { "http://127.0.0.1:9": "ask" }, remotePermission: "deny", heal: "approve",
  }));
  const settings = library.settings();
  assert.equal("siteTrust" in settings, false);
  assert.equal("remotePermission" in settings, false);
  assert.equal(settings.heal, "approve");
});

test("requested Apply, Send, Place Order and Pay clicks run without a trust approval", async () => {
  const driver = counting();
  const result = await replay(doc(["Apply", "Send", "Place Order", "Pay"].map(click)), {}, driver);
  assert.equal(result.status, "passed");
  assert.deepEqual(driver.clicks, ["Apply", "Send", "Place Order", "Pay"]);
  assert.equal(result.modelCalls, 0);
});

for (const locatorOnly of [false, true]) {
  test(`heal cannot press the credit-freeze workflow's reserved Apply ${locatorOnly ? "locator" : "identity"}`, async () => {
    const workflow = JSON.parse(readFileSync(path.resolve("examples/workflows/credit-freeze.json"), "utf8")) as WorkflowV2;
    workflow.steps = workflow.steps.map((step) => ({ ...step, timeoutMs: 0 }));
    if (locatorOnly) {
      const confirm = workflow.steps.find((step) => step.action === "confirm")!;
      delete confirm.identity;
      confirm.locators = [{ kind: "role", role: "button", name: "Apply" }];
    }
    const driver = counting();
    driver.tree = async () => ({ url: workflow.startUrl, nodes: [ident("Apply")], texts: [], values: [] });
    let proposals = 0;
    const result = await replay(workflow, {}, driver, {
      yieldHuman: true,
      heal: {
        available: () => true,
        propose: async () => {
          proposals += 1;
          return { patch: { identity: ident("Apply") }, model: { provider: "fixture", name: "fixture" }, prompt: "", rawResponse: "" };
        },
      },
    });
    assert.equal(proposals, 1);
    assert.equal(result.status, "failed");
    assert.deepEqual(driver.clicks, []);
    assert.match(result.failure?.reason || "", /recorded human confirm/);
  });
}

test("a requested click does not consume an explicit human workflow pause", async () => {
  const driver = counting();
  const workflow = doc([
    click("Apply", 0),
    { ...click("Apply", 1), action: "confirm", human: true, label: "You press Apply" },
  ]);
  const result = await replay(workflow, {}, driver, { yieldHuman: true });
  assert.equal(result.status, "paused");
  assert.equal(result.pausedKind, "confirm");
  assert.equal(result.steps[0]?.status, "passed");
  assert.equal(result.steps[1]?.reason, "confirm");
  assert.deepEqual(driver.clicks, ["Apply"]);
  assert.equal(result.modelCalls, 0);
});
