import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import Ajv from "ajv/dist/2020";
import { driftMarkdown, driftReport, recoveryRows } from "../../src/v1/drift";
import { toPuppeteerReplay } from "../../src/v1/export-replay";
import { applyPatch, unavailableHeal } from "../../src/v1/heal";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { buildLocators, matchLocator } from "../../src/v1/locators";
import { uniqueNamedRole } from "../../src/v1/os-driver";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";

const schema = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

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
    name: "Locators",
    startUrl: "https://example.test/",
    createdAt: 1,
    inputs: [{ name: "query", type: "text", default: "ada" }],
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
      clicks.push(node.testId || node.text || node.name || node.role);
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

test("locators are stored in role, text, test id, css, xpath order and validate", () => {
  const target = ident({
    role: "textbox",
    name: "Search Wikipedia",
    text: "Search Wikipedia",
    id: "searchInput",
    cssPath: "#searchInput",
    xpath: '//*[@id="searchInput"]',
  });
  const heading = ident({ role: "heading", id: "title", text: "Wikipedia" });
  const locs = buildLocators(target, [heading, target], [
    { x: 10, y: 10, w: 80, h: 20 },
    { x: 10, y: 80, w: 200, h: 32 },
  ], 1);
  assert.deepEqual(locs.map((item) => item.kind), ["role", "text", "css", "xpath", "anchor"]);
  assert.equal(locs.at(-1)?.relation, "below");
  const events: TrailEvent[] = [{
    id: "e", ts: 1, kind: "act", op: "click", identity: target, locators: locs,
  }];
  const workflow = interpret(events, { id: "wf-search", name: "Search", startUrl: "https://en.wikipedia.org/" });
  assert.deepEqual(validateWorkflow(workflow), []);
  assert.equal(validate(workflow), true, JSON.stringify(validate.errors));
  assert.equal(workflow.steps[0]?.locators?.[0]?.kind, "role");
  const exported = toPuppeteerReplay(workflow, {});
  const click = exported.steps.find((item) => item.type === "click");
  const selectors = click?.selectors as string[][];
  assert.equal(selectors[0]?.[0], "aria/Search Wikipedia");
  assert.equal(click?.offsetX, 1);
  assert.equal(selectors.some((chain) => chain[0] === "#searchInput"), true);
  assert.equal(JSON.stringify(exported).includes("anchor"), false);
});

test("label repair does not click a collapsed node", async () => {
  const hidden = ident({ role: "button", text: "Add Element" });
  const workflow = doc([step({
    id: "add",
    action: "click",
    label: 'Click "Add"',
    intent: "Add",
    identity: ident({ role: "button", text: "Add now" }),
    locators: [{ kind: "role", role: "button", name: "Add now" }],
  })]);
  const driver = fake([tree([hidden], { boxes: [{ x: 0, y: 0, w: 0, h: 0 }] })]);
  const result = await replay(workflow, {}, driver, { locators: "primary", heal: unavailableHeal() });
  assert.equal(result.status, "failed");
  assert.deepEqual(driver.clicks, []);
});

test("a calculator button wins the tie with its label when the role is button", () => {
  const button = ident({ surface: "atspi", role: "button", name: "7", app: "gnome-calculator" });
  const label = ident({ surface: "atspi", role: "label", name: "7", app: "gnome-calculator" });
  assert.equal(uniqueNamedRole([button, label], "gnome-calculator", "button", "7"), button);
  assert.equal(uniqueNamedRole([button, { ...button }], "gnome-calculator", "button", "7"), undefined);
});

test("a collapsed box is not a locator hit", () => {
  const hidden = ident({ role: "textbox", name: "Search Wikipedia", id: "searchInput" });
  assert.equal(matchLocator(
    { kind: "css", value: "#searchInput" },
    [hidden],
    [{ x: 0, y: 0, w: 0, h: 0 }],
  ), undefined);
  assert.equal(matchLocator({ kind: "css", value: "#searchInput" }, [hidden])?.index, 0);
});

test("a duplicated text locator is refused and a unique test id hits", () => {
  const nodes = [
    ident({ role: "button", text: "Search", testId: "a" }),
    ident({ role: "button", text: "Search", testId: "b" }),
  ];
  assert.equal(matchLocator({ kind: "text", value: "Search" }, nodes), undefined);
  assert.equal(matchLocator({ kind: "testid", value: "b" }, nodes)?.index, 1);
});

test("multi-locator uses the test id after the role misses and does not repair", async () => {
  const live = ident({ role: "button", testId: "go", text: "Continue" });
  const workflow = doc([step({
    id: "go",
    action: "click",
    label: "Go",
    intent: "Go",
    identity: ident({ role: "button", text: "Go now" }),
    locators: [
      { kind: "role", role: "button", name: "Go now" },
      { kind: "testid", value: "go" },
    ],
  })]);
  const driver = fake([tree([live])]);
  const result = await replay(workflow, {}, driver, { locators: "all", heal: unavailableHeal() });
  assert.equal(result.status, "passed");
  assert.equal(result.locatorHits[0]?.kind, "testid");
  assert.equal(result.repairs.length, 0);
  assert.deepEqual(driver.clicks, ["go"]);
});

test("the primary locator misses, so the label repair runs and the later locator is not tried", async () => {
  const live = ident({ role: "button", testId: "go", text: "Go" });
  const workflow = doc([step({
    id: "go",
    action: "click",
    label: 'Click "Go"',
    intent: "Go",
    identity: ident({ role: "button", text: "Missing" }),
    locators: [
      { kind: "role", role: "button", name: "Missing" },
      { kind: "testid", value: "go" },
    ],
  })]);
  const driver = fake([tree([live])]);
  const result = await replay(workflow, {}, driver, { locators: "primary", heal: unavailableHeal() });
  assert.equal(result.status, "passed");
  assert.equal(result.locatorHits.length, 0);
  assert.equal(result.repairs[0]?.repair, "label");
  assert.deepEqual(driver.clicks, ["go"]);
});

test("a healed identity replaces the locators instead of keeping the miss", () => {
  const before = step({
    id: "go",
    action: "click",
    identity: ident({ role: "button", testId: "missing", text: "Submit freeze" }),
    locators: [{ kind: "role", role: "button", name: "Submit freeze" }],
  });
  const patched = applyPatch(before, {
    identity: ident({ role: "button", text: "Add Element" }),
  });
  assert.equal(patched.identity?.testId, undefined);
  assert.equal(patched.locators?.[0]?.kind, "role");
  assert.equal(patched.locators?.[0]?.name, "Add Element");
  assert.equal(JSON.stringify(patched).includes("missing"), false);
});

test("puppeteer export inlines the query and does not keep a secret", () => {
  const workflow = doc([
    step({
      id: "q",
      action: "type",
      input: "query",
      value: "{{query}}",
      identity: ident({ role: "textbox", id: "q", nameAttr: "q", tag: "input" }),
      locators: [{ kind: "css", value: 'input[name="q"]' }],
    }),
    step({
      id: "secret",
      action: "type",
      value: "{{password}}",
      sensitive: true,
      identity: ident({ role: "textbox", id: "password" }),
      locators: [{ kind: "css", value: "#password" }],
    }),
  ]);
  workflow.inputs.push({ name: "password", type: "secret" });
  const exported = toPuppeteerReplay(workflow, { query: "json" });
  const blob = JSON.stringify(exported);
  assert.match(blob, /json/);
  assert.equal(blob.includes("{{"), false);
  assert.equal(blob.includes("password-value"), false);
  const change = exported.steps.filter((item) => item.type === "change");
  assert.equal(change[0]?.value, "json");
  assert.equal(change[1]?.value, "");
});

test("property: a unique name hits and a repeated name is refused", () => {
  fc.assert(fc.property(
    fc.stringMatching(/^[a-z]{2,12}$/),
    fc.constantFrom("button", "link", "textbox"),
    (name, role) => {
      const node = ident({ role, name, text: name, testId: "t", id: "t" });
      const other = ident({ role, name: `${name}x`, text: `${name}x`, testId: "u", id: "u" });
      const locs = buildLocators(node, [node, other]);
      assert.equal(locs[0]?.kind, "role");
      assert.equal(matchLocator(locs[0]!, [node, other])?.index, 0);
      assert.equal(matchLocator({ kind: "text", value: name }, [node, { ...node, testId: "z", id: "z" }]), undefined);
      const exported = toPuppeteerReplay(doc([step({
        id: "s",
        action: "type",
        value: "{{query}}",
        locators: locs,
      })]), { query: name });
      const blob = JSON.stringify(exported);
      assert.equal(blob.includes("{{"), false);
      assert.equal(blob.includes(name), true);
      return true;
    },
  ), { numRuns: 30 });
});

test("recovery rows name the locator or the repair and the drift report groups workflows", () => {
  const recovered = recoveryRows({
    workflow: "wikipedia-search",
    change: "lang",
    steps: [{ id: "s", label: "Type", passed: true }],
    locatorHits: [{ stepId: "s", kind: "css", detail: "css #searchInput" }],
    firstLocator: { s: "role" },
  });
  assert.equal(recovered[0]?.fixedBy, "locator:css");
  assert.equal(recovered[0]?.brokenAttr, "role");
  const missed = recoveryRows({
    workflow: "wikipedia-search",
    change: "lang",
    steps: [{ id: "s", passed: false, brokenAttr: "role", reason: "locate: below-threshold" }],
    firstLocator: { s: "role" },
  });
  assert.equal(missed[0]?.fixedBy, "none");
  const report = driftReport([...recovered, ...missed], "2026-10-21T00:00:00.000Z");
  assert.equal(report.workflows[0]?.workflow, "wikipedia-search");
  assert.match(driftMarkdown(report), /Recovered/);
  assert.match(driftMarkdown(report), /locator:css/);
});
