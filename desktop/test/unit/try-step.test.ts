// Try looks up a fixture step and does not act.

import assert from "node:assert/strict";
import test from "node:test";
import { tryResult, workflowDetail } from "../../src/app/views";
import type { HealProvider } from "../../src/v1/heal";
import type { Driver, LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowStep } from "../../src/v1/schema";
import { tryStep } from "../../src/v1/try-step";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action">): WorkflowStep {
  return { index: 0, label: partial.label || partial.action, surface: "dom", timeoutMs: 0, ...partial };
}

function tree(nodes: Identity[]): LiveTree {
  return { nodes, texts: [], values: [] };
}

test("Try on a fixture step matches with no actions and no model call", async () => {
  let actions = 0;
  let outlined = "";
  const bump = async () => { actions += 1; };
  const driver: Driver = {
    tree: async () => tree([ident({ testId: "save-note", role: "button" })]),
    snapshot: async () => ({ dom: "fixture" }),
    click: bump,
    fill: async () => { actions += 1; },
    key: bump,
    upload: async () => { actions += 1; },
    drop: async () => { actions += 1; },
    digits: async () => { actions += 1; },
    check: async () => { actions += 1; },
    notify: async () => {},
    outline: async (node) => { outlined = node.testId || ""; },
  };
  let models = 0;
  const heal: HealProvider = {
    available: () => true,
    propose: async () => { models += 1; return null; },
  };
  const result = await tryStep(step({
    id: "save",
    action: "click",
    label: "Save note",
    identity: ident({ testId: "save-note" }),
  }), driver, heal);
  assert.equal(result.matched, true);
  assert.equal(actions, 0);
  assert.equal(result.actions, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(models, 0);
  assert.equal(outlined, "save-note");
  assert.equal(result.identity?.candidates[0]?.score, 100);
  assert.equal(typeof result.identity?.lead, "number");
  assert.ok((result.identity?.lead || 0) >= 25);
  const html = tryResult(result);
  assert.match(html, /id="try-result"/);
  assert.match(html, /data-actions="0"/);
  assert.match(html, /data-model-calls="0"/);
  assert.match(html, /id="identity-table"/);
  assert.match(html, /id="try-lead"/);
  assert.match(html, />100</);
  const page = workflowDetail({
    id: "wf",
    name: "fixture",
    steps: [
      { id: "note", action: "type", label: "Type the note" },
      { id: "save", action: "click", label: "Save note" },
      { id: "apply", action: "confirm", label: "Apply" },
    ],
  });
  assert.match(page, /data-try-step="save"/);
  assert.match(page, /data-run-from="save" data-step-n="2"/);
  assert.match(page, /Run from step 3/);
});
