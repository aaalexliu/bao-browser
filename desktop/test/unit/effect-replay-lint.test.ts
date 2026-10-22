import assert from "node:assert/strict";
import test from "node:test";
import { droppedNoEffectIds, condense } from "../../src/v1/condense";
import { lintIntent } from "../../src/eval/intent/lint";
import { GOOD_INTENTS } from "../../src/eval/intent/good-intents";
import { BAD_INTENT_TEXTS } from "../../src/eval/heldout/bad-judge";
import { buildLocators, matchLabeledControl } from "../../src/v1/locators";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";
import type { TrailEvent } from "../../src/v1/interpret";

const url = "https://example.test/page";

function click(id: string, identity: Identity, extra: Partial<TrailEvent> = {}): TrailEvent {
  return {
    id,
    ts: 1,
    kind: "act",
    op: "click",
    identity,
    beforeUrl: url,
    afterUrl: url,
    subtreeBefore: "Title",
    subtreeAfter: "Title",
    ...extra,
  };
}

const heading: Identity = { surface: "dom", role: "heading", text: "Title", cssPath: "h2.title", path: [] };
const radio: Identity = { surface: "dom", role: "radio", nameAttr: "size", label: "Small", cssPath: "input.size", path: [] };
const go: Identity = { surface: "dom", role: "button", id: "go", text: "Go", path: [] };
const help: Identity = { surface: "dom", role: "button", name: "Help", text: "Help", cssPath: "#help", path: [] };

test("effect filter drops a still click and keeps one that changed state", () => {
  const events = [
    click("head", heading),
    click("radio", radio, { checked: true }),
    click("nav", go, { beforeUrl: url, afterUrl: "https://example.test/next", subtreeBefore: "Go", subtreeAfter: "Go" }),
    click("help", help),
    click("open", { surface: "dom", role: "button", text: "Details", cssPath: "details", path: [] }, {
      subtreeBefore: "Details",
      subtreeAfter: "Details",
    }),
    {
      id: "inner",
      ts: 2,
      kind: "act" as const,
      op: "type",
      value: "Ada",
      identity: { surface: "dom" as const, role: "textbox", cssPath: "details > input", path: [] },
      beforeUrl: url,
      afterUrl: url,
    },
  ];
  const dropped = droppedNoEffectIds(events);
  assert.deepEqual(dropped, ["head"]);
  const workflow = condense(events, { id: "fx", name: "fx", startUrl: url });
  assert.equal(workflow.steps.some((step) => step.identity?.text === "Title"), false);
  assert.equal(workflow.steps.some((step) => step.identity?.nameAttr === "size"), true);
  assert.equal(workflow.steps.some((step) => step.identity?.id === "go"), true);
  assert.equal(workflow.steps.some((step) => step.identity?.name === "Help"), true);
  assert.equal(workflow.steps.some((step) => step.identity?.cssPath === "details"), true);
});

test("a shared radio name resolves to the input inside the recorded label", async () => {
  const recorded: Identity = {
    surface: "dom",
    role: "input",
    nameAttr: "size",
    tag: "input",
    label: "Small",
    cssPath: "form:nth-of-type(1) > label:nth-of-type(1) > input:nth-of-type(1)",
    path: [{ role: "form" }, { role: "label" }],
  };
  const small: Identity = { ...recorded, role: "radio" };
  const medium: Identity = { ...small, label: "Medium", cssPath: "form:nth-of-type(1) > label:nth-of-type(2) > input:nth-of-type(1)" };
  const large: Identity = { ...small, label: "Large", cssPath: "form:nth-of-type(1) > label:nth-of-type(3) > input:nth-of-type(1)" };
  const label: Identity = { surface: "dom", role: "label", text: "Small", label: "Small", path: [] };
  const workflow = condense([
    {
      id: "e3",
      ts: 1,
      kind: "act",
      op: "click",
      identity: recorded,
      checked: true,
      beforeUrl: url,
      afterUrl: url,
    },
  ], { id: "order", name: "order", startUrl: url });
  const step = workflow.steps[0];
  assert.equal(step?.action, "check");
  assert.equal(step?.locators?.some((item) => item.kind === "css" && item.value === 'input[name="size"]'), true);
  const nodes = [label, small, medium, large];
  const ambiguous = matchLabeledControl(
    step?.locators || [],
    { ...recorded, label: "Small" },
    [small, { ...small, cssPath: "form label.other input" }, medium],
  );
  assert.equal(ambiguous, undefined);
  let checked: Identity | undefined;
  const driver = memory(nodes, { flags: nodes.map(() => ({ checked: true })) });
  driver.check = async (node) => {
    checked = node;
  };
  const result = await replay(workflow, {}, driver, {});
  assert.equal(result.status, "passed", result.failure?.reason);
  assert.equal(checked?.label, "Small");
  assert.equal(checked?.role, "radio");
});

test("a click with no recorded urls is kept", () => {
  const workflow = condense([
    { id: "c", ts: 1, kind: "act", op: "click", identity: heading },
  ], { id: "bare", name: "bare", startUrl: url });
  assert.equal(workflow.steps.length, 1);
});

test("intent lint catches the bad texts and keeps the good ones", () => {
  assert.equal(GOOD_INTENTS.length, 24);
  assert.equal(BAD_INTENT_TEXTS.length, 10);
  const bad = BAD_INTENT_TEXTS.map((item) => lintIntent(item.text, item.target, item.secrets || []));
  assert.deepEqual(bad.map((reason) => reason == null), Array(10).fill(false));
  const good = GOOD_INTENTS.flatMap((item) => {
    const reason = lintIntent(item.text, item.target, item.secrets || []);
    return reason ? [`${item.id} ${reason}`] : [];
  });
  assert.deepEqual(good, []);
});

test("repairs resolve a text tie with a unique css path and leave the tie alone otherwise", async () => {
  const query: Identity = { surface: "dom", role: "link", text: "(about)", cssPath: "a.one", path: [] };
  const nodes: Identity[] = [
    { surface: "dom", role: "link", text: "(about)", cssPath: "a.one", path: [] },
    { surface: "dom", role: "link", text: "(about)", cssPath: "a.two", path: [] },
  ];
  const plain = await replay(clickWorkflow(query), {}, memory(nodes), {});
  assert.equal(plain.status, "failed");
  assert.equal(plain.failure?.reason, "tie");
  const repaired = await replay(clickWorkflow(query, buildLocators(query, nodes)), {}, memory(nodes), {});
  assert.equal(repaired.status, "passed");
});

test("stored locators find an id-less control by css and reveal a collapsed search field", async () => {
  const field: Identity = {
    surface: "dom",
    role: "textbox",
    cssPath: "header > input",
    path: [],
  };
  const nodes = [field];
  const found = await replay(typeWorkflow(field, buildLocators(field, nodes)), { text: "milk" }, memory(nodes), {});
  assert.equal(found.status, "passed");

  const hidden: Identity = {
    surface: "dom",
    role: "textbox",
    name: "search",
    label: "search",
    cssPath: "input.search",
    path: [{ role: "search" }],
  };
  const toggle: Identity = { surface: "dom", role: "button", text: "Search", path: [{ role: "search" }] };
  const opened: Identity = { ...hidden, cssPath: "input.search" };
  let revealed = false;
  const driver = memory([hidden, toggle], {
    boxes: [{ x: 0, y: 0, w: 0, h: 0 }, { x: 10, y: 10, w: 20, h: 20 }],
    hidden: [true, false],
  }, () => {
    revealed = true;
    return {
      nodes: [opened, toggle],
      boxes: [{ x: 10, y: 40, w: 80, h: 24 }, { x: 10, y: 10, w: 20, h: 20 }],
      hidden: [false, false],
    };
  });
  const result = await replay(typeWorkflow(hidden, buildLocators(hidden, [hidden, toggle])), { text: "q" }, driver, {});
  assert.equal(revealed, true);
  assert.equal(result.status, "passed");
});

function clickWorkflow(identity: Identity, locators?: WorkflowV2["steps"][number]["locators"]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "wf",
    startUrl: url,
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "s0",
      index: 0,
      action: "click",
      label: "Click",
      surface: "dom",
      identity,
      locators,
      timeoutMs: 0,
    }],
  };
}

function typeWorkflow(identity: Identity, locators?: WorkflowV2["steps"][number]["locators"]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "wf",
    startUrl: url,
    createdAt: 1,
    inputs: [{ name: "text", type: "text", required: true }],
    steps: [{
      id: "s0",
      index: 0,
      action: "type",
      label: "Type",
      surface: "dom",
      identity,
      locators,
      input: "text",
      timeoutMs: 0,
    }],
  };
}

function memory(
  nodes: Identity[],
  extra: Partial<LiveTree> = {},
  afterClick?: () => Partial<LiveTree>,
): Driver {
  let tree: LiveTree = { nodes, texts: [], values: [], ...extra };
  return {
    tree: async () => tree,
    snapshot: async () => ({}),
    click: async () => {
      if (afterClick) tree = { ...tree, texts: [], values: [], ...afterClick() };
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
