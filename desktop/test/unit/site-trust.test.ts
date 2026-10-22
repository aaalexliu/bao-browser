// Allow runs an ordinary click. It never presses a confirm step.

import assert from "node:assert/strict";
import test from "node:test";
import { siteTrustPanel } from "../../src/app/views";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { consequential, sitesForTrust } from "../../src/v1/site-trust";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action">): WorkflowStep {
  return { index: 0, label: partial.label || partial.action, surface: "dom", timeoutMs: 0, ...partial };
}

function doc(steps: WorkflowStep[]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "Fixture",
    startUrl: "http://127.0.0.1:9/fixture",
    createdAt: 1,
    inputs: [],
    steps: steps.map((item, index) => ({ ...item, index })),
  };
}

function tree(nodes: Identity[]): LiveTree {
  return { nodes, texts: [], values: [] };
}

function counting(pages: LiveTree[]): Driver & { actions: number; clicks: string[] } {
  let n = 0;
  const clicks: string[] = [];
  const driver = {
    actions: 0,
    clicks,
    tree: async () => pages[Math.min(n, pages.length - 1)]!,
    snapshot: async () => ({ dom: "fixture" }),
    click: async (node: Identity) => {
      driver.actions += 1;
      clicks.push(node.testId || node.text || node.role);
      n += 1;
    },
    fill: async () => { driver.actions += 1; },
    key: async () => { driver.actions += 1; },
    upload: async () => { driver.actions += 1; },
    drop: async () => { driver.actions += 1; },
    digits: async () => { driver.actions += 1; },
    check: async () => { driver.actions += 1; },
    notify: async () => {},
    sleep: async () => {},
  };
  return driver;
}

test("allow never auto-presses a confirm step", async () => {
  const settings = { heal: "auto" as const, siteTrust: { "http://127.0.0.1:9": "allow" as const } };
  const driver = counting([
    tree([ident({ testId: "save-note", text: "Save note" })]),
    tree([ident({ testId: "apply", text: "Apply" })]),
  ]);
  const workflow = doc([
    step({ id: "save", action: "click", label: "Save note", identity: ident({ testId: "save-note", text: "Save note" }) }),
    step({ id: "apply", action: "confirm", human: true, label: 'you press "Apply"', identity: ident({ testId: "apply", text: "Apply" }) }),
  ]);
  assert.equal(consequential(workflow.steps[1]!), true);
  assert.equal(consequential(workflow.steps[0]!), false);
  const result = await replay(workflow, {}, driver, { siteTrust: "allow", settings });
  assert.equal(result.status, "paused");
  assert.equal(result.steps[0]?.status, "passed");
  assert.equal(result.steps[1]?.status, "paused");
  assert.equal(result.steps[1]?.reason, "confirm");
  assert.deepEqual(driver.clicks, ["save-note"]);
  assert.equal(driver.clicks.includes("apply"), false);
  assert.equal(driver.actions, 1);
  assert.equal(settings.heal, "auto");
  assert.equal(result.modelCalls, 0);
});

test("always ask does not dispatch an ordinary step, and a confirm step still stops on its own", async () => {
  const asked = counting([tree([ident({ testId: "save-note", text: "Save note" })])]);
  const paused = await replay(doc([
    step({ id: "save", action: "click", label: "Save note", identity: ident({ testId: "save-note", text: "Save note" }) }),
  ]), {}, asked, { siteTrust: "ask", settings: { heal: "approve" } });
  assert.equal(paused.status, "paused");
  assert.equal(paused.steps[0]?.reason, "always ask");
  assert.equal(asked.actions, 0);
  assert.deepEqual(asked.clicks, []);
  const confirm = counting([tree([ident({ testId: "apply", text: "Apply" })])]);
  const held = await replay(doc([
    step({ id: "apply", action: "confirm", human: true, label: 'you press "Apply"', identity: ident({ testId: "apply", text: "Apply" }) }),
  ]), {}, confirm, { siteTrust: "allow", settings: { heal: "approve" } });
  assert.equal(held.steps[0]?.reason, "confirm");
  assert.equal(confirm.actions, 0);
  const panel = siteTrustPanel(sitesForTrust(
    [{ startUrl: "http://127.0.0.1:9/fixture" }],
    { "http://127.0.0.1:9": "ask" },
  ));
  assert.match(panel, /id="site-trust"/);
  assert.match(panel, /Always ask/);
  assert.match(panel, /Allow/);
  assert.match(panel, /value="ask" selected/);
  assert.match(panel, /separate from when a step misses/);
  assert.equal(panel.includes('id="heal"'), false);
});
