import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { buildLocators } from "../../src/v1/locators";
import type { Identity, WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";

function ident(text: string): Identity {
  return { surface: "dom", role: "button", text, path: [] };
}

function doc(steps: WorkflowStep[]): WorkflowV2 {
  return {
    schema: "bao.workflow/v4", version: 2, id: "requested", name: "Requested actions",
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

for (const recovery of ["overlay-find", "overlay-expect", "reveal"] as const) {
  test(`reserved ${recovery} recovery returns a failed run without pressing the human target`, async () => {
    const driver = counting();
    const target = ident("Go");
    const allow = ident("Allow");
    driver.tree = async () => ({
      nodes: recovery === "reveal" ? [target, allow] : [{ surface: "dom", role: "dialog", path: [] }, allow, ...(recovery === "overlay-expect" ? [target] : [])],
      texts: [], values: [],
      ...(recovery === "reveal" ? { boxes: [{ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 20, h: 20 }], hidden: [true, false] } : {}),
    });
    const workflow = doc([
      { ...click("Go", 0), heal: "never", ...(recovery === "reveal" ? { reveal: { kind: "role" as const, role: "button", name: "Allow" } } : {}),
        ...(recovery === "overlay-expect" ? { postcondition: { kind: "text" as const, match: "Done", timeoutMs: 0 } } : {}) },
      { ...click("Allow", 1), action: "confirm", human: true },
    ]);
    const result = await replay(workflow, {}, driver);
    assert.equal(result.status, "failed");
    assert.ok(result.failure);
    assert.deepEqual(driver.clicks, recovery === "overlay-expect" ? ["Go"] : []);
    assert.equal(result.steps[0]?.status, "failed");
  });
}

test("a missing Continue cannot press Place order in its recorded DOM position", async () => {
  const heading: Identity = { surface: "dom", role: "heading", text: "Order summary", path: [] };
  const original: Identity = {
    ...ident("Continue"), name: "Continue", tag: "button",
    cssPath: "html:nth-of-type(1) > body:nth-of-type(1) > main:nth-of-type(1) > button:nth-of-type(1)",
    xpath: "/html[1]/body[1]/main[1]/button[1]",
    path: [{ role: "main", name: "Checkout" }], siblingIndex: 0,
  };
  const place: Identity = { ...original, text: "Place order", name: "Place order" };
  const boxes = [{ x: 20, y: 20, w: 200, h: 30 }, { x: 20, y: 100, w: 100, h: 30 }];
  const locators = buildLocators(original, [heading, original], boxes, 1);
  for (const identity of [original, undefined]) {
    const driver = counting();
    driver.tree = async () => ({ nodes: [heading, place], texts: ["Order summary"], values: [], boxes });
    const workflow = doc([
      { ...click("Continue", 0), identity, heal: "never", locators },
      { ...click("Place order", 1), identity: place, action: "confirm", human: true },
    ]);
    const result = await replay(workflow, {}, driver, { yieldHuman: true });
    assert.deepEqual(driver.clicks, []);
    assert.ok(result.locatorHits.some((hit) => hit.kind === "css" || hit.kind === "xpath"));
    assert.equal(result.status, "failed");
    assert.equal(result.steps[0]?.status, "failed");
    assert.equal(result.trail.some((event) => event.kind === "click" || event.kind === "human-confirm"), false);
  }
});

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
