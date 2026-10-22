import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020";
import { unavailableHeal, type HealProposal } from "../../src/v1/heal";
import { noteDrift, noteReplay, openProvisional, promotionEvent } from "../../src/v1/promote";
import { textScore } from "../../src/v1/repair";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";

const schema = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action">): WorkflowStep {
  return {
    index: 0,
    label: partial.label || partial.action,
    surface: "dom",
    timeoutMs: 0,
    ...partial,
  };
}

function doc(steps: WorkflowStep[]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "Freeze",
    startUrl: "http://127.0.0.1/freeze",
    createdAt: 1,
    inputs: [],
    steps: steps.map((item, index) => ({ ...item, index })),
  };
}

function tree(nodes: Identity[], extra: Partial<LiveTree> = {}): LiveTree {
  return { nodes, texts: [], values: [], ...extra };
}

function fake(pages: LiveTree[]): Driver & { clicks: string[]; proposes: number } {
  let n = 0;
  const state = { clicks: [] as string[], proposes: 0 };
  const current = () => pages[Math.min(n, pages.length - 1)]!;
  return {
    clicks: state.clicks,
    get proposes() { return state.proposes; },
    tree: async () => current(),
    snapshot: async () => ({ dom: "Status: none" }),
    click: async (node) => {
      state.clicks.push(node.testId || node.id || node.text || node.role);
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

test("credit freeze example validates and names the expect phase", () => {
  const freeze = JSON.parse(readFileSync("examples/workflows/credit-freeze.json", "utf8")) as WorkflowV2;
  const form = JSON.parse(readFileSync("examples/workflows/browser-form.json", "utf8")) as WorkflowV2;
  assert.deepEqual(validateWorkflow(freeze), []);
  assert.equal(validate(freeze), true);
  assert.equal(validate(form), true);
  assert.equal(freeze.steps.at(-1)?.action, "confirm");
  assert.equal(form.steps.at(-1)?.action, "verify");
});

test("verify fails in the expect phase and passes when the status text is re-read", async () => {
  const workflow = doc([
    step({ id: "v", action: "verify", label: "Verify freeze status", expect: { kind: "text", match: "Status: Frozen", timeoutMs: 0 } }),
  ]);
  const missed = await replay(workflow, {}, fake([tree([], { texts: ["Status: none"] })]), { heal: unavailableHeal() });
  assert.equal(missed.status, "failed");
  assert.equal(missed.failure?.phase, "expect");
  assert.match(missed.steps[0]?.reason || "", /^expect:/);
  const held = await replay(workflow, {}, fake([tree([], { texts: ["Status: Frozen"] })]), { heal: unavailableHeal() });
  assert.equal(held.status, "passed");
  assert.equal(held.heals.length, 0);
});

test("a label repair clicks the renamed control and does not call the model", async () => {
  let proposed = 0;
  const heal = {
    available: () => true,
    propose: async () => { proposed += 1; return null; },
  };
  const workflow = doc([
    step({
      id: "apply",
      action: "click",
      label: 'Click "Apply"',
      identity: ident({ testId: "missing-apply", text: "Apply" }),
    }),
  ]);
  const page = tree([ident({ role: "button", testId: "apply-now", text: "Apply now" })]);
  const driver = fake([page]);
  const result = await replay(workflow, {}, driver, { heal });
  assert.equal(result.status, "passed");
  assert.equal(result.repairs[0]?.repair, "label");
  assert.equal(proposed, 0);
  assert.deepEqual(driver.clicks, ["apply-now"]);
});

test("an anchor repair picks the button below the heading", async () => {
  const heading = ident({ role: "heading", id: "title", text: "Credit freeze" });
  const decoy = ident({ role: "button", id: "elsewhere", text: "Elsewhere" });
  const apply = ident({ role: "button", id: "apply", text: "Go" });
  const workflow = doc([
    step({
      id: "apply",
      action: "click",
      label: "Click Apply",
      identity: ident({ testId: "missing", role: "button", text: "Apply" }),
      anchor: { identity: heading, relation: "below" },
    }),
  ]);
  const page = tree([heading, decoy, apply], {
    boxes: [
      { x: 10, y: 10, w: 80, h: 20 },
      { x: 10, y: 10, w: 40, h: 16 },
      { x: 12, y: 80, w: 60, h: 24 },
    ],
  });
  const driver = fake([page]);
  const result = await replay(workflow, {}, driver, { heal: unavailableHeal() });
  assert.equal(result.status, "passed");
  assert.equal(result.repairs[0]?.repair, "anchor");
  assert.deepEqual(driver.clicks, ["apply"]);
});

test("an id locator wins over a glossary button that shares the field name", async () => {
  const filled: string[] = [];
  const glossary = ident({ role: "button", text: "Condition/disease", name: "Condition/disease" });
  const field = ident({ role: "textbox", id: "advcond", tag: "input", cssPath: "#advcond" });
  const workflow = doc([
    step({
      id: "cond",
      action: "type",
      label: "Type {{advcond}}",
      input: "advcond",
      value: "{{advcond}}",
      identity: field,
      locators: [
        { kind: "text", value: "Condition/disease" },
        { kind: "css", value: "#advcond" },
      ],
    }),
  ]);
  workflow.inputs = [{ name: "advcond", type: "text", default: "type 1 diabetes" }];
  const page = tree([glossary, field], {
    boxes: [
      { x: 40, y: 40, w: 180, h: 24 },
      { x: 40, y: 80, w: 240, h: 32 },
    ],
  });
  let n = 0;
  const driver: Driver = {
    tree: async () => page,
    snapshot: async () => ({ dom: "" }),
    click: async () => { n += 1; },
    fill: async (node) => { filled.push(node.id || node.text || ""); },
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
  const result = await replay(workflow, { advcond: "type 1 diabetes" }, driver, { heal: unavailableHeal() });
  assert.equal(result.status, "passed");
  assert.deepEqual(filled, ["advcond"]);
  assert.equal(n, 0);
  const early: string[] = [];
  const onlyGlossary = tree([glossary], {
    boxes: [{ x: 40, y: 40, w: 180, h: 24 }],
  });
  const earlyDriver: Driver = {
    ...driver,
    tree: async () => onlyGlossary,
    fill: async (node) => { early.push(node.id || node.text || ""); },
  };
  const missed = await replay(workflow, { advcond: "type 1 diabetes" }, earlyDriver, { heal: unavailableHeal() });
  assert.equal(missed.status, "failed");
  assert.deepEqual(early, []);
});

test("a search textbox whose id is gone still presses Enter on the combobox, not a button", async () => {
  const combo = ident({ role: "combobox", name: "Search Wikipedia", text: "Search Wikipedia" });
  const button = ident({ role: "button", name: "Search Wikipedia", text: "Search Wikipedia" });
  const workflow = doc([
    step({
      id: "go",
      action: "key",
      key: "Enter",
      label: "Press Enter",
      identity: ident({ role: "textbox", name: "Search Wikipedia", id: "searchInput" }),
      locators: [
        { kind: "role", role: "textbox", name: "Search Wikipedia" },
        { kind: "text", value: "Search Wikipedia" },
        { kind: "css", value: "#searchInput" },
      ],
    }),
  ]);
  const keys: string[] = [];
  const driver: Driver = {
    tree: async () => tree([combo], { boxes: [{ x: 10, y: 10, w: 200, h: 32 }] }),
    snapshot: async () => ({ dom: "" }),
    click: async () => {},
    fill: async () => {},
    key: async (name) => { keys.push(name); },
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
  const found = await replay(workflow, {}, driver, { heal: unavailableHeal() });
  assert.equal(found.status, "passed");
  assert.deepEqual(keys, ["Enter"]);
  const refused: string[] = [];
  const onlyButton: Driver = {
    ...driver,
    tree: async () => tree([button], { boxes: [{ x: 10, y: 10, w: 80, h: 24 }] }),
    key: async (name) => { refused.push(name); },
  };
  const missed = await replay(workflow, {}, onlyButton, { heal: unavailableHeal() });
  assert.equal(missed.status, "failed");
  assert.equal(missed.failure?.phase, "find");
  assert.deepEqual(refused, []);
});

test("a suggestion click prefers the option when the listbox shows the same text", async () => {
  const listbox = ident({ role: "listbox", id: "react-select-2-listbox", text: "Physics" });
  const option = ident({ role: "option", id: "react-select-2-option-0", text: "Physics", cssPath: "#react-select-2-option-0" });
  const workflow = doc([
    step({
      id: "subject",
      action: "click",
      label: "Click {{subjectsInput}}",
      identity: option,
      selection: { by: "text", input: "subjectsInput" },
      locators: [
        { kind: "role", role: "option", name: "Maths" },
        { kind: "text", value: "Maths" },
        { kind: "css", value: "#react-select-2-option-0" },
      ],
    }),
  ]);
  workflow.inputs = [{ name: "subjectsInput", type: "text", default: "Maths" }];
  const driver = fake([tree([listbox, option], {
    boxes: [
      { x: 40, y: 80, w: 240, h: 40 },
      { x: 40, y: 80, w: 240, h: 32 },
    ],
    hidden: [false, true],
  })]);
  const result = await replay(workflow, { subjectsInput: "Physics" }, driver, { heal: unavailableHeal() });
  assert.equal(result.status, "passed", result.failure?.reason);
  assert.deepEqual(driver.clicks, ["react-select-2-option-0"]);
});

test("an aria-hidden control with a box is still the recorded id", async () => {
  const button = ident({ role: "button", id: "action-bar-download-btn", text: "Download", name: "download", cssPath: "#action-bar-download-btn" });
  const workflow = doc([
    step({
      id: "dl",
      action: "click",
      label: "Click download",
      identity: button,
      locators: [
        { kind: "role", role: "button", name: "download" },
        { kind: "css", value: "#action-bar-download-btn" },
      ],
    }),
  ]);
  const driver = fake([tree([button], {
    boxes: [{ x: 40, y: 781, w: 135, h: 40 }],
    hidden: [true],
  })]);
  const result = await replay(workflow, {}, driver, { heal: unavailableHeal() });
  assert.equal(result.status, "passed", result.failure?.reason);
  assert.deepEqual(driver.clicks, ["action-bar-download-btn"]);
});

test("a dialog that contains the field is not dismissed before the type", async () => {
  const dialog = ident({ role: "dialog", text: "Registration Form" });
  const close = ident({ role: "button", text: "Close" });
  const field = ident({ role: "textbox", id: "firstName", tag: "input", cssPath: "#firstName" });
  const workflow = doc([
    step({
      id: "first",
      action: "type",
      label: "Type Alan",
      value: "Alan",
      identity: field,
      locators: [{ kind: "css", value: "#firstName" }],
    }),
  ]);
  const page = tree([dialog, close, field], {
    inDialog: [true, true, true],
    boxes: [
      { x: 40, y: 40, w: 400, h: 300 },
      { x: 400, y: 48, w: 24, h: 24 },
      { x: 60, y: 120, w: 180, h: 32 },
    ],
  });
  const driver = fake([page]);
  const result = await replay(workflow, {}, driver, { heal: unavailableHeal() });
  assert.equal(result.status, "passed");
  assert.equal(result.steps[0]?.reason || "", "");
  assert.deepEqual(driver.clicks, []);
});

test("an overlay repair dismisses the notice before the click and skips the model", async () => {
  let proposed = 0;
  const dismiss = ident({ role: "button", testId: "overlay-close", text: "Dismiss" });
  const apply = ident({ role: "button", testId: "apply", text: "Apply" });
  const covered = tree([ident({ role: "dialog", testId: "overlay", text: "A notice" }), dismiss]);
  const open = tree([apply]);
  const workflow = doc([
    step({ id: "apply", action: "click", label: "Click Apply", identity: ident({ testId: "apply", text: "Apply" }) }),
  ]);
  const driver = fake([covered, open]);
  const result = await replay(workflow, {}, driver, {
    heal: { available: () => true, propose: async () => { proposed += 1; return null; } },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.repairs.map((item) => item.repair).join(","), "overlay");
  assert.equal(proposed, 0);
  assert.deepEqual(driver.clicks, ["overlay-close", "apply"]);
});

test("a locate miss becomes a model heal only after the repairs refuse", async () => {
  const seen: string[] = [];
  const proposal: HealProposal = {
    patch: { identity: ident({ testId: "apply", text: "Continue" }) },
    model: { provider: "cursor", name: "cursor", version: "live" },
    prompt: "live",
    rawResponse: "{\"identity\":{\"testId\":\"apply\"}}",
  };
  const missing = tree([ident({ role: "button", testId: "apply", text: "Continue" })]);
  const workflow = doc([
    step({
      id: "apply",
      action: "click",
      label: 'Click "Submit freeze"',
      intent: "Submit freeze",
      identity: ident({ testId: "missing-apply", text: "Submit freeze" }),
      timeoutMs: 0,
    }),
  ]);
  const driver = fake([missing, missing]);
  const result = await replay(workflow, {}, driver, {
    heal: { available: () => true, propose: async (failure) => { seen.push(failure.phase); return proposal; } },
  });
  assert.deepEqual(seen, ["find"]);
  assert.equal(result.status, "passed");
  assert.equal(result.repairs.length, 0);
  assert.equal(result.heals[0]?.model?.version, "live");
});

test("promotion stays provisional until drift and three real runs pass, and reverts on either miss", () => {
  const before = step({ id: "s", action: "click", identity: ident({ testId: "missing" }) });
  const opened = openProvisional({
    healId: "heal-1",
    workflowId: "wf",
    stepId: "s",
    patch: { identity: ident({ testId: "apply" }) },
    before,
  });
  assert.equal(opened.status, "provisional");
  assert.equal(noteReplay(opened, true).status, "provisional");
  const drifted = noteDrift(opened, true);
  assert.equal(noteReplay(drifted, true).status, "provisional");
  const twice = noteReplay(noteReplay(drifted, true), true);
  assert.equal(twice.status, "provisional");
  assert.equal(twice.replays, 2);
  const promoted = noteReplay(twice, true);
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.replays, 3);
  const sooner = openProvisional({
    healId: "heal-2",
    workflowId: "wf",
    stepId: "s",
    patch: { identity: ident({ testId: "apply" }) },
    before,
    need: 1,
  });
  assert.equal(noteReplay(noteDrift(sooner, true), true).status, "promoted");
  assert.equal(noteDrift(opened, false).status, "reverted");
  assert.equal(noteDrift(opened, false).reason, "drift");
  assert.equal(noteReplay(drifted, false).reason, "replay");
  const event = promotionEvent(promoted, 5);
  assert.equal(event.kind, "promotion");
  assert.equal(JSON.stringify(event).includes("secret-value"), false);
});

test("property: text score stays in range and does not treat a dissimilar label as a repair", () => {
  fc.assert(fc.property(fc.string(), fc.string(), (a, b) => {
    const score = textScore(a, b);
    return score >= 0 && score <= 1 && Math.abs(score - textScore(b, a)) < 1e-9;
  }), { numRuns: 40 });
  assert.ok(textScore("Apply", "Apply now") >= 0.8);
  assert.ok(textScore("Submit freeze", "Continue") < 0.8);
});
