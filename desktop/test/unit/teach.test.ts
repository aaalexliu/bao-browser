// Teach narration, corrections, eval pairs, splicing a fix, and merging takes.
// No browser. The fixture replay lives in teach-app.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv/dist/2020";
import { canonical } from "../../src/v1/canonical";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowV2 } from "../../src/v1/schema";
import {
  decide,
  decisionEvent,
  intentEvalPair,
  measureIntentPair,
  mergeDemonstrations,
  narratorFromEnv,
  projectTeach,
  spliceFix,
} from "../../src/v1/teach";
import { rail, teachPanel, teachReview, type TeachCardView } from "../../src/app/views";

const schema = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "textbox", path: [], ...partial };
}

const secret = "SuperSecretPassword!";

function fixtureEvents(): TrailEvent[] {
  return [
    { id: "click-note", ts: 1, kind: "act", op: "click", identity: ident({ id: "note-input", nameAttr: "note", testId: "note" }) },
    {
      id: "type-note", ts: 2, kind: "act", op: "type", value: "ship the notes",
      identity: ident({ id: "note-input", nameAttr: "note", testId: "note" }),
    },
    {
      id: "type-secret", ts: 3, kind: "act", op: "type", sensitive: true, value: secret,
      identity: ident({ id: "password", role: "password", nameAttr: "password" }),
    },
    {
      id: "drop-file", ts: 4, kind: "act", op: "drop", fileName: "note.txt", rawPath: "/tmp/secret-folder/note.txt",
      identity: ident({ id: "drop", role: "div", testId: "drop", text: "Drop a file here" }),
    },
    {
      id: "click-apply", ts: 5, kind: "act", op: "click", afterText: "Applied",
      identity: ident({ id: "apply-btn", role: "button", testId: "apply", text: "Apply" }),
    },
  ];
}

const meta = { id: "wf-teach", name: "Taught workflow", startUrl: "http://127.0.0.1/fixture" };

test("the heuristic narrates the fixture and a note becomes the intent", () => {
  const projected = projectTeach(fixtureEvents(), [], meta);
  const note = projected.cards.find((card) => card.id === "type-note");
  const hidden = projected.cards.find((card) => card.id === "type-secret");
  const drop = projected.cards.find((card) => card.id === "drop-file");
  const apply = projected.cards.find((card) => card.id === "click-apply");
  assert.equal(note?.intent, "Type {{note}}");
  assert.equal(note?.narrator, "heuristic");
  assert.equal(note?.values[0]?.label, "{{note}}");
  assert.equal(hidden?.intent, "Type secret");
  assert.equal(hidden?.values[0]?.role, "secret");
  assert.equal(drop?.intent, "Drop file");
  assert.equal(apply?.intent, "Click Apply");
  assert.equal(apply?.outcome, "Applied");
  const named = projected.cards.find((card) => card.id === "click-note");
  assert.equal(named?.intent, "Click note");
  const decisions = decide([], { kind: "note", cardId: "type-note", note: "type the note" }, 10);
  const corrected = projectTeach(fixtureEvents(), decisions, meta);
  assert.equal(corrected.workflow.steps.find((step) => step.input === "note")?.intent, "type the note");
  assert.equal(decisions[0]?.detail, "note became intent");
});

test("three corrections change the workflow and the eval pair measures them", () => {
  let decisions = decide([], { kind: "drop", cardId: "click-note" }, 1);
  decisions = decide(decisions, { kind: "note", cardId: "type-note", note: "type the note" }, 2);
  decisions = decide(decisions, { kind: "human", cardId: "click-apply" }, 3);
  const pair = intentEvalPair("wf-teach", fixtureEvents(), decisions, meta);
  assert.equal(validate(pair.workflow), true);
  assert.deepEqual(validateWorkflow(pair.workflow), []);
  const blob = JSON.stringify(pair);
  assert.equal(blob.includes(secret), false);
  assert.equal(blob.includes("/tmp/secret-folder"), false);
  assert.equal(pair.workflow.steps.some((step) => step.identity?.id === "note-input" && step.action === "click"), false);
  const typed = pair.workflow.steps.find((step) => step.input === "note");
  assert.equal(typed?.intent, "type the note");
  const confirm = pair.workflow.steps.find((step) => step.action === "confirm");
  assert.equal(confirm?.human, true);
  assert.equal(confirm?.postcondition?.match, "Applied");
  assert.equal(confirm?.provenance, undefined);
  const secretInput = pair.workflow.inputs.find((input) => input.type === "secret");
  assert.ok(secretInput);
  assert.equal(secretInput?.default, undefined);
  assert.ok(pair.workflow.inputs.some((input) => input.type === "file"));
  const measured = measureIntentPair(pair);
  assert.equal(measured.corrections, 3);
  assert.ok(measured.intentChanges.some((change) => change.to === "type the note"));
  assert.ok(measured.humanSteps >= 1);
  assert.ok(measured.droppedSteps >= 1);
  const trail = [...pair.rawTrail, ...pair.decisions.map((decision, index) => decisionEvent(decision, index))];
  const acts = trail.filter((event) => event.kind === "act");
  assert.equal(canonical(interpret(acts, meta)), canonical(interpret(trail, meta)));
  assert.ok(trail.slice(-3).every((event) => event.kind === "decision"));
});

test("a model narration is labeled, and a failed model call stays on the heuristic", async () => {
  const card = projectTeach(fixtureEvents(), [], meta).cards.find((item) => item.id === "type-note");
  assert.ok(card);
  const spoken = new Map([[card.id, { narrator: "model" as const, modelName: "bao-teach-fixture", intent: card.intent, outcome: card.outcome }]]);
  const labeled = projectTeach(fixtureEvents(), [], meta, spoken);
  assert.equal(labeled.cards.find((item) => item.id === "type-note")?.narrator, "model");
  assert.equal(labeled.cards.find((item) => item.id === "type-note")?.modelName, "bao-teach-fixture");
  const fixture = narratorFromEnv({ BAO_TEACH_FIXTURE: "1" });
  assert.equal(fixture?.name, "bao-teach-fixture");
  assert.deepEqual(await fixture?.narrate(card), { intent: card.intent, outcome: card.outcome });
  const offline = narratorFromEnv({ OPENAI_API_KEY: "test-key" }, async () => { throw new Error("offline"); });
  assert.equal(await offline?.narrate(card), null);
  assert.equal(narratorFromEnv({}), null);
  const html = teachPanel({
    phase: "live",
    since: 5,
    narrator: "heuristic",
    blur: true,
    paused: true,
    cards: [card as TeachCardView],
  });
  assert.match(html, /Add check/);
  assert.match(html, /Discard/);
  assert.match(html, />Resume</);
  assert.match(html, /Sensitive fields blurred/);
  assert.match(html, /data-narrator="heuristic"/);
  assert.match(html, /teach-row/);
  assert.match(html, /\/api\/capture\/shots\//);
  assert.match(html, /class="step-card teach-card[^"]* on"/);
  assert.doesNotMatch(html, /No expected outcome yet/);
  assert.match(html, /You do this/);
  assert.match(html, /Check/);
  const dropped = projectTeach(fixtureEvents(), decide([], { kind: "drop", cardId: "click-note" }, 1), meta);
  const review = teachReview({
    phase: "review",
    cards: dropped.cards as TeachCardView[],
    decisions: [
      { kind: "drop", detail: "dropped", cardId: "click-note" },
      { kind: "note", detail: "note became intent", cardId: "type-note" },
    ],
    review: { raw: [{ kind: "act", op: "click" }], workflow: { name: "Taught", inputs: [], steps: [] } },
  });
  assert.match(review, /Dropped \(1\)/);
  assert.match(review, /id="teach-trail"/);
  assert.match(review, /Raw trail/);
  assert.match(review, /badge edited/);
  assert.match(review, /data-shot=/);
  assert.doesNotMatch(review, /You do this/);
  assert.doesNotMatch(review, /<h3 class="section">Workflow/);
  const nav = rail({});
  assert.ok(nav.indexOf('data-screen="capture"') < nav.indexOf('data-screen="teach"'));
});

test("marking a secret constant is refused, and a check is a verify step", () => {
  const constant = projectTeach(fixtureEvents(), decide([], { kind: "constant", cardId: "type-secret" }, 1), meta);
  assert.equal(constant.workflow.inputs.some((input) => input.type === "secret"), true);
  assert.equal(JSON.stringify(constant.workflow).includes(secret), false);
  const checked = projectTeach(
    fixtureEvents(),
    decide([], { kind: "verify", cardId: "click-apply", outcome: "Applied" }, 2),
    meta,
  );
  const step = checked.workflow.steps.find((item) => item.action === "verify");
  assert.equal(step?.expect?.match, "Applied");
  assert.equal(step?.human, undefined);
});

test("merge keeps the shared step and branches where the takes differ", async () => {
  const save = interpret([
    { id: "t", ts: 1, kind: "act", op: "type", value: "hello", identity: ident({ id: "note-input", nameAttr: "note" }) },
    { id: "s", ts: 2, kind: "act", op: "click", identity: ident({ id: "save-note", role: "button", testId: "save-note", text: "Save note" }) },
  ], { id: "wf-save", name: "Save the note", startUrl: "http://127.0.0.1/fixture" });
  const apply = interpret([
    { id: "t", ts: 1, kind: "act", op: "type", value: "hello", identity: ident({ id: "note-input", nameAttr: "note" }) },
    { id: "a", ts: 2, kind: "act", op: "click", afterText: "Applied", identity: ident({ id: "apply-btn", role: "button", testId: "apply", text: "Apply" }) },
  ], { id: "wf-apply", name: "Apply the change", startUrl: "http://127.0.0.1/fixture" });
  const merged = mergeDemonstrations([save, apply], { id: "wf-merged", name: "Note two ways", now: 5 });
  assert.equal(validate(merged), true);
  assert.deepEqual(validateWorkflow(merged), []);
  const route = merged.inputs.find((input) => input.type === "choice");
  assert.deepEqual(route?.choices, ["Save the note", "Apply the change"]);
  assert.equal(merged.steps.filter((step) => step.action === "type").length, 1);
  assert.equal(merged.steps.find((step) => step.action === "type")?.when, undefined);
  assert.equal(merged.steps.filter((step) => step.when).length, 2);
  const clicks: string[] = [];
  const driver = branchDriver(merged, clicks);
  const saved = await replay(merged, { note: "alpha", route: "Save the note" }, driver);
  assert.equal(saved.status, "passed", JSON.stringify(saved.failure));
  assert.deepEqual(clicks, ["save-note"]);
  clicks.length = 0;
  const applied = await replay(merged, { note: "beta", route: "Apply the change" }, driver);
  assert.equal(applied.status, "passed", JSON.stringify(applied.failure));
  assert.deepEqual(clicks, ["apply-btn"]);
});

test("teach the fix replaces only the failed step", () => {
  const original: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf-broken",
    name: "Broken",
    startUrl: "http://127.0.0.1/fixture",
    createdAt: 1,
    inputs: [],
    steps: [
      {
        id: "keep", index: 0, action: "click", label: "Click save", surface: "dom", timeoutMs: 1000,
        identity: ident({ id: "save-note", role: "button" }),
      },
      {
        id: "bad", index: 1, action: "click", label: "Click missing", surface: "dom", timeoutMs: 1000,
        identity: ident({ id: "missing", role: "button", testId: "missing" }),
      },
    ],
  };
  const taught = interpret([
    { id: "a", ts: 1, kind: "act", op: "click", afterText: "Applied", identity: ident({ id: "apply-btn", role: "button", text: "Apply" }) },
  ], { id: "wf-fix", name: "Fix", startUrl: original.startUrl });
  const spliced = spliceFix(original, "bad", taught, 9);
  assert.deepEqual(validateWorkflow(spliced), []);
  assert.equal(spliced.steps.length, 2);
  assert.equal(spliced.steps[0]?.id, "keep");
  assert.equal(spliced.steps[1]?.identity?.id, "apply-btn");
  assert.equal(spliced.steps[1]?.index, 1);
  assert.throws(() => spliceFix(original, "nope", taught), /missing step/);
});

function branchDriver(doc: WorkflowV2, clicks: string[]): Driver {
  const nodes = doc.steps.flatMap((step) => step.identity ? [step.identity] : []);
  const values: LiveTree["values"] = [];
  return {
    tree: async () => ({ nodes, texts: ["Applied"], values, url: doc.startUrl }),
    snapshot: async () => ({}),
    click: async (node) => { clicks.push(node.id || ""); },
    fill: async (node, text) => { values.push({ identity: node, value: text }); },
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
}
