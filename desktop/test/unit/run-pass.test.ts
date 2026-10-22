// Re-run from a past run, collapsed idle, and the per-step heal limit.

import assert from "node:assert/strict";
import test from "node:test";
import { actBar, reviewItems, runViewer, secretInput } from "../../src/app/views";
import { idleSkips, skipLabel } from "../../src/v1/filmstrip";
import { attentionCount } from "../../src/v1/human-ask";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { consecutiveHeals, stepsNeedingReview } from "../../src/v1/triage";

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
    name: "upload note",
    startUrl: "http://127.0.0.1/fixture",
    createdAt: 1,
    inputs: [],
    steps: steps.map((item, index) => ({ ...item, index })),
  };
}

function tree(nodes: Identity[]): LiveTree {
  return { nodes, texts: [], values: [] };
}

test("a secret is asked again and is not written into the re-run field", () => {
  const html = secretInput("password", "Password", true);
  assert.match(html, /type="password"/);
  assert.match(html, /Last run used a secret/);
  assert.equal(html.includes("value="), false);
  assert.equal(html.includes("SuperSecretPassword!"), false);
  assert.equal(html.includes("••••"), false);
  const viewer = runViewer({
    id: "run-9",
    workflowId: "wf",
    status: "passed",
    inputs: { note: "ada note", password: "••••" },
    steps: [
      { id: "type", status: "passed", label: "type the note", startedAt: 0, endedAt: 400 },
      { id: "save", status: "passed", label: "save", startedAt: 12_400, endedAt: 12_900 },
    ],
  }, { name: "upload note", steps: [{ id: "type", label: "type the note" }, { id: "save", label: "save" }] }, "save");
  assert.match(viewer, /Re-run with this run's inputs/);
  assert.match(viewer, /Debug from this step/);
  assert.match(viewer, /data-step="save"/);
  assert.match(viewer, /ada note/);
  assert.match(viewer, /••••/);
  assert.match(viewer, /A secret is asked again and is not kept in the run/);
  assert.equal(viewer.includes("SuperSecretPassword!"), false);
  assert.equal(viewer.includes("BaoSecretFixture9kQ7m"), false);
});

test("an idle gap over 3 seconds is marked skipped 12s and a 2 second gap stays", () => {
  const steps = [
    { id: "a", startedAt: 1_000, endedAt: 1_500 },
    { id: "b", startedAt: 3_500, endedAt: 4_000 },
    { id: "c", startedAt: 16_000, endedAt: 16_400 },
  ];
  const skips = idleSkips(steps, 1_000);
  assert.equal(skips.length, 1);
  assert.equal(skips[0]?.label, "skipped 12s");
  assert.equal(skipLabel(12_000), "skipped 12s");
  assert.equal(Math.round((skips[0]?.to || 0) - (skips[0]?.from || 0)), 12);
  const html = runViewer({
    id: "run-gap",
    workflowId: "wf",
    status: "passed",
    video: "run-gap.webm",
    videoStartedAt: 1_000,
    steps: steps.map((item) => ({ ...item, status: "passed" as const })),
  }, { name: "upload note", steps: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  assert.match(html, /class="skip-marker"[^>]*>skipped 12s</);
  assert.match(html, /data-skips="[^"]*skipped 12s/);
});

test("three consecutive heals on one step stop auto-heal and open the act bar", async () => {
  const healed = (at: number) => ({
    at,
    workflowId: "wf",
    heals: [{ id: `h-${at}`, failedStep: { id: "save", label: "save" } }],
    steps: [{ id: "save", status: "passed" as const }],
  });
  const runs = [healed(1), healed(2), healed(3)];
  assert.equal(consecutiveHeals(runs, "save"), 3);
  assert.equal(consecutiveHeals(runs.slice(0, 2), "save"), 2);
  assert.equal(stepsNeedingReview(runs).length, 1);
  assert.equal(stepsNeedingReview(runs.slice(0, 2)).length, 0);
  const broken = [...runs, { at: 4, workflowId: "wf", heals: [], steps: [{ id: "save", status: "passed" }] }];
  assert.equal(consecutiveHeals(broken, "save"), 0);
  const held = [...runs, { at: 4, workflowId: "wf", heals: [], steps: [{ id: "save", status: "failed", triage: "review" }] }];
  assert.equal(consecutiveHeals(held, "save"), 4);

  const bar = actBar({
    workflows: [{ id: "wf", name: "upload note", steps: 1 }],
    runs: runs.map((run, index) => ({ ...run, id: `run-${index}`, status: "passed" as const })),
  });
  assert.match(bar, /data-ask="review"/);
  assert.match(bar, /needs review/);
  assert.match(bar, /3 runs in a row/);
  assert.match(bar, /auto-heal is off/);
  assert.equal(attentionCount({ pendingHeals: 0, reviews: reviewItems(runs.map((run, index) => ({
    ...run,
    id: `run-${index}`,
    status: "passed" as const,
  }))).length }), 1);

  const missing = tree([ident({ role: "button", testId: "save", text: "Continue" })]);
  let calls = 0;
  const click = step({
    id: "save",
    action: "click",
    label: "save",
    intent: "Save the note",
    identity: ident({ testId: "missing-save", text: "Save" }),
  });
  const stopped = await replay(doc([click]), {}, fake([missing]), {
    heal: { available: () => true, propose: async () => { calls += 1; return null; } },
    reviewSteps: new Set(["save"]),
  });
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.steps[0]?.triage, "review");
  assert.equal(stopped.heals.length, 0);
  assert.equal(calls, 0);
});

test("debug from a later step does not run the earlier step", async () => {
  let clicks = 0;
  const button = ident({ role: "button", testId: "save", name: "Save" });
  const driver: Driver = {
    tree: async () => tree([button]),
    snapshot: async () => ({}),
    click: async () => { clicks += 1; },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
  const result = await replay(doc([
    step({ id: "type", action: "click", identity: button }),
    step({ id: "save", action: "click", identity: button }),
  ]), {}, driver, { fromStepId: "save" });
  assert.equal(result.steps[0]?.status, "skipped");
  assert.equal(result.steps[0]?.reason, "not re-run");
  assert.equal(result.steps[1]?.status, "passed");
  assert.equal(clicks, 1);
});

function fake(pages: LiveTree[]): Driver {
  let n = 0;
  const current = () => pages[Math.min(n, pages.length - 1)]!;
  return {
    tree: async () => current(),
    snapshot: async () => ({}),
    click: async () => { n += 1; },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
}
