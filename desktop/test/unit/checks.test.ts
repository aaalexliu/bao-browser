import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { driftMarkdown, recoveryRows } from "../../src/v1/drift";
import { unavailableHeal } from "../../src/v1/heal";
import { isCollapsedBox, matchLocator } from "../../src/v1/locators";
import { ReceiptLog, verifyReceiptChain } from "../../src/v1/receipt";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import { diffTrajectory, type TrajectoryStep } from "../../src/v1/trajectory";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action">): WorkflowStep {
  return { index: 0, label: partial.label || partial.action, surface: "dom", timeoutMs: 0, ...partial };
}

function doc(steps: WorkflowStep[], inputs: WorkflowV2["inputs"] = []): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "Checks",
    startUrl: "https://example.test/",
    createdAt: 1,
    inputs,
    steps: steps.map((item, index) => ({ ...item, index })),
  };
}

function tree(nodes: Identity[], extra: Partial<LiveTree> = {}): LiveTree {
  return { nodes, texts: [], values: [], ...extra };
}

function fake(pages: LiveTree[]): Driver & { clicks: string[] } {
  let n = 0;
  const clicks: string[] = [];
  const current = () => pages[Math.min(n, pages.length - 1)]!;
  return {
    clicks,
    tree: async () => current(),
    snapshot: async () => ({ dom: "none" }),
    click: async (node) => {
      clicks.push(node.testId || node.text || node.name || node.id || node.role);
      n += 1;
    },
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

const searchInput = ident({ role: "input", name: "Search Wikipedia", id: "searchInput" });
const searchToggle = ident({ role: "link", text: "Search", path: [{ role: "search" }] });
const opened = ident({ role: "input", name: "Search Wikipedia", nameAttr: "search" });

function searchWorkflow(reveal: boolean): WorkflowV2 {
  return doc([step({
    id: "q",
    action: "type",
    label: "Type {{searchInput}}",
    input: "searchInput",
    value: "{{searchInput}}",
    identity: searchInput,
    locators: [
      { kind: "role", role: "input", name: "Search Wikipedia" },
      { kind: "css", value: "#searchInput" },
    ],
    reveal: reveal ? { kind: "role", role: "link", name: "Search" } : undefined,
  })], [{ name: "searchInput", type: "text", default: "Ada Lovelace" }]);
}

test("a hidden box is not a locator hit", () => {
  assert.equal(isCollapsedBox(0, [{ x: 1, y: 1, w: 40, h: 20 }], [true]), true);
  assert.equal(matchLocator(
    { kind: "css", value: "#searchInput" },
    [searchInput],
    [{ x: 1, y: 1, w: 40, h: 20 }],
    [true],
  ), undefined);
});

test("a recorded reveal opens a 0x0 target and is logged as a repair", async () => {
  const collapsed = tree([searchInput, searchToggle], {
    boxes: [{ x: 0, y: 0, w: 0, h: 0 }, { x: 500, y: 10, w: 44, h: 44 }],
  });
  const open = tree([opened], { boxes: [{ x: 20, y: 48, w: 420, h: 32 }] });
  const driver = fake([collapsed, open]);
  const result = await replay(searchWorkflow(true), { searchInput: "Ada Lovelace" }, driver, { heal: unavailableHeal() });
  assert.equal(result.status, "passed");
  assert.deepEqual(driver.clicks, ["Search"]);
  assert.equal(result.repairs[0]?.repair, "reveal");
  assert.match(result.repairs[0]?.detail || "", /recorded/);
  assert.equal(result.steps[0]?.status, "passed");
});

test("a discoverable search toggle is used when the step has no reveal locator", async () => {
  const collapsed = tree([searchInput, searchToggle], {
    boxes: [{ x: 0, y: 0, w: 0, h: 0 }, { x: 500, y: 10, w: 44, h: 44 }],
  });
  const open = tree([opened], { boxes: [{ x: 20, y: 48, w: 420, h: 32 }] });
  const driver = fake([collapsed, open]);
  const result = await replay(searchWorkflow(false), { searchInput: "Ada Lovelace" }, driver, {
    locators: "primary",
    heal: unavailableHeal(),
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(driver.clicks, ["Search"]);
  assert.equal(result.repairs[0]?.repair, "reveal");
  assert.match(result.repairs[0]?.detail || "", /discovered Search/);
});

test("a visible target does not click the search toggle", async () => {
  const open = tree([searchInput, searchToggle], {
    boxes: [{ x: 20, y: 48, w: 420, h: 32 }, { x: 500, y: 10, w: 44, h: 44 }],
  });
  const driver = fake([open]);
  const result = await replay(searchWorkflow(true), { searchInput: "Ada Lovelace" }, driver, { heal: unavailableHeal() });
  assert.equal(result.status, "passed");
  assert.deepEqual(driver.clicks, []);
  assert.equal(result.repairs.some((item) => item.repair === "reveal"), false);
});

test("wait_for fails in that phase and gone fails in expect", async () => {
  const waiting = doc([step({
    id: "w",
    action: "click",
    identity: ident({ testId: "go", text: "Go" }),
    waitFor: { kind: "text", match: "Ready", timeoutMs: 0 },
  })]);
  const missed = await replay(waiting, {}, fake([tree([ident({ testId: "go", text: "Go" })], { texts: [] })]), { heal: unavailableHeal() });
  assert.equal(missed.status, "failed");
  assert.equal(missed.failure?.phase, "wait_for");
  assert.equal(missed.steps[0]?.phase, "wait_for");
  assert.match(missed.steps[0]?.reason || "", /^wait_for:/);

  const covering = doc([step({
    id: "g",
    action: "click",
    identity: ident({ testId: "go", text: "Go" }),
    gone: { kind: "text", match: "Loading", timeoutMs: 0 },
  })]);
  const stuck = await replay(covering, {}, fake([
    tree([ident({ testId: "go", text: "Go" })], { texts: ["Loading"] }),
    tree([ident({ testId: "go", text: "Go" })], { texts: ["Loading"] }),
  ]), { heal: unavailableHeal() });
  assert.equal(stuck.failure?.phase, "expect");
  assert.match(stuck.failure?.reason || "", /^gone:/);
  assert.equal(stuck.steps[0]?.phase, "expect");
});

test("a read-back writes a hashed receipt and a file outside temp fails closed", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-receipt-"));
  const note = path.join(home, "note.txt");
  writeFileSync(note, "bao drift\n");
  const log = new ReceiptLog(path.join(home, "receipts.jsonl"));
  const workflow = doc([step({
    id: "save",
    action: "key",
    key: "ctrl+s",
    label: "Save",
    readBack: { source: "file", fileInput: "note", match: "{{text}}", timeoutMs: 0 },
  })], [
    { name: "text", type: "text", default: "bao drift" },
    { name: "note", type: "text" },
  ]);
  assert.deepEqual(validateWorkflow(workflow), []);
  const passed = await replay(workflow, { text: "bao drift", note }, fake([tree([])]), {
    heal: unavailableHeal(),
    receipts: log,
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.receipts[0]?.pass, true);
  assert.equal(passed.receipts[0]?.expected, "bao drift");
  assert.equal(passed.receipts[0]?.actual, "bao drift");
  assert.equal(verifyReceiptChain(passed.receipts), true);
  assert.match(readFileSync(path.join(home, "receipts.jsonl"), "utf8"), /"kind":"read-back"/);

  const again = await replay(workflow, { text: "bao drift", note }, fake([tree([])]), { heal: unavailableHeal(), receipts: log });
  assert.equal(again.status, "passed");
  assert.equal(log.entries[1]?.prev, log.entries[0]?.hash);
  assert.equal(verifyReceiptChain(log.entries), true);

  const outside = doc([step({
    id: "save",
    action: "key",
    key: "ctrl+s",
    readBack: { source: "file", fileInput: "note", match: "{{text}}", timeoutMs: 0 },
  })], [
    { name: "text", type: "text" },
    { name: "note", type: "text" },
  ]);
  const refused = await replay(outside, { text: "bao drift", note: "/etc/hostname" }, fake([tree([])]), { heal: unavailableHeal() });
  assert.equal(refused.status, "failed");
  assert.equal(refused.failure?.phase, "expect");
  assert.match(refused.failure?.reason || "", /read-back/);
  assert.match(refused.receipts[0]?.actual || "", /throwaway/);
  assert.equal(refused.receipts[0]?.pass, false);
});

test("a form read-back re-reads the saved text", async () => {
  const save = ident({ role: "button", testId: "save-note", text: "Save note" });
  const workflow = doc([step({
    id: "save",
    action: "click",
    identity: save,
    readBack: { source: "text", match: "{{note}}", timeoutMs: 0 },
  })], [{ name: "note", type: "text", default: "hello" }]);
  const driver = fake([
    tree([save], { texts: [] }),
    tree([save], { texts: ["hello"] }),
  ]);
  const result = await replay(workflow, { note: "hello" }, driver, { heal: unavailableHeal() });
  assert.equal(result.status, "passed");
  assert.equal(result.receipts[0]?.pass, true);
  assert.equal(result.receipts[0]?.expected, "hello");
  assert.equal(result.receipts[0]?.actual, "hello");
  assert.equal(result.receipts[0]?.source, "text");
});

test("trajectory diff names the target, action, postcondition, and timing bucket", () => {
  const recorded: TrajectoryStep[] = [{
    stepId: "wf-wikipedia-0",
    action: "type",
    target: "input#searchInput",
    postcondition: "none",
    timing: "lt1s",
  }];
  const replayed: TrajectoryStep[] = [{
    stepId: "wf-wikipedia-0",
    action: "type",
    target: "input[name=search]",
    postcondition: "none",
    timing: "lt10s",
  }];
  const lines = diffTrajectory(recorded, replayed);
  assert.equal(lines.length, 2);
  assert.match(lines[0] || "", /aimed at input#searchInput in the recording and at input\[name=search\] on replay/);
  assert.match(lines[1] || "", /under 1s bucket in the recording and the under 10s bucket on replay/);
  assert.match(diffTrajectory(recorded, recorded)[0] || "", /matched the recording/);
});

test("the drift report shows the failure phase", () => {
  const rows = recoveryRows({
    workflow: "wikipedia-search",
    change: "resize",
    steps: [{ id: "s", passed: false, brokenAttr: "role", reason: "find: below-threshold", phase: "find" }],
    firstLocator: { s: "role" },
  });
  assert.equal(rows[0]?.phase, "find");
  const markdown = driftMarkdown({
    generatedAt: "2026-10-21T00:00:00.000Z",
    rows,
    summary: [],
    steps: [],
    workflows: [],
  });
  assert.match(markdown, /\| phase \|/);
  assert.match(markdown, /\| wikipedia-search \| resize \| s \| find \| role \| none \| find: below-threshold \|/);
});

test("credit freeze read-back is the status text and validates", () => {
  const freeze = JSON.parse(readFileSync("examples/workflows/credit-freeze.json", "utf8")) as WorkflowV2;
  assert.deepEqual(validateWorkflow(freeze), []);
  const frozen = freeze.steps.find((item) => item.label === "Click Frozen");
  assert.equal(frozen?.readBack?.source, "text");
  assert.equal(frozen?.readBack?.match, "Status: none");
  assert.equal(freeze.steps.some((item) => item.action === "click" && item.identity?.id === "apply"), false);
  assert.equal(freeze.steps.at(-1)?.action, "confirm");
  assert.equal(freeze.precondition?.phase, "auth");
});
