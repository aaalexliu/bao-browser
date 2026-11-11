import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv/dist/2020";
import { decide, projectTeach, type TeachDecision } from "../../src/v1/teach";
import type { TrailEvent } from "../../src/v1/interpret";
import { parseWorkflow, validateWorkflow, type Identity, type WorkflowV2 } from "../../src/v1/schema";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { workflowJsonSchema } from "../../src/v1/workflow-json-schema";

const validate = new Ajv({ strict: false }).compile(workflowJsonSchema());
const load = (variant: string): TrailEvent[] => JSON.parse(readFileSync(path.join(process.cwd(), `desktop/test/fixtures/signin-${variant}.recording.json`), "utf8")) as TrailEvent[];
const meta = { id: "signin", name: "Recorded fixture sign-in", startUrl: "http://fixture.test/" };

function owned(events: TrailEvent[], cardId: string, prior: TeachDecision[] = []) {
  const last = events.find((event) => event.op === "verify")!;
  const decisions = decide(prior, { kind: "human", cardId, signIn: { firstEventId: events[0]!.id, lastEventId: last.id } }, 100);
  return { decisions, ...projectTeach(events, decisions, meta) };
}

for (const variant of ["single", "multi"]) {
  test(`${variant} recorder output folds marks on every sign-in card into one owner handoff`, () => {
    const events = load(variant);
    const baseline = projectTeach(events, [], meta);
    const last = events.find((event) => event.op === "verify")!;
    const lastIndex = baseline.cards.findIndex((card) => card.id === last.id);
    for (const card of baseline.cards.slice(0, lastIndex + 1)) {
      assert.deepEqual(card.signIn, { status: "suggested", firstEventId: events[0]!.id, lastEventId: last.id });
      const result = owned(events, card.id);
      assert.deepEqual(result.workflow.inputs, []);
      assert.deepEqual(result.workflow.steps.map((step) => step.action), ["handoff", "click"]);
      const handoff = result.workflow.steps[0]!;
      assert.equal(handoff.action, "handoff");
      if (handoff.action !== "handoff") throw new Error("Expected a handoff");
      assert.equal(handoff.reason, "sign-in");
      assert.equal(handoff.actor, "owner");
      assert.equal(handoff.target, undefined);
      assert.equal(handoff.check?.kind, "text");
      assert.equal(handoff.check && "match" in handoff.check ? handoff.check.match : undefined, "Account overview");
      const survivor = result.cards.find((item) => !item.merged)!;
      assert.deepEqual(survivor.eventIds, events.slice(0, events.indexOf(last) + 1).map((event) => event.id));
      assert.deepEqual(validateWorkflow(result.workflow), []);
      assert.equal(validate(result.workflow), true, JSON.stringify(validate.errors));
    }
    assert.ok(events.some((event) => event.op === "key" && event.key === "Enter"));
    assert.ok(events.some((event) => event.op === "check"));
    assert.ok(events.some((event) => event.op === "click" && event.identity?.id === "password"));
    if (variant === "multi") {
      assert.ok(events.some((event) => event.identity?.id === "confirm-password"));
      assert.ok(events.some((event) => event.identity?.id === "pin"));
      assert.ok(events.some((event) => event.afterUrl?.endsWith("/challenge")));
    }
  });
}

test("renames and notes survive folding in either correction order, and repeated marks remain one handoff", () => {
  const events = load("multi");
  const cardId = "evt-1";
  const before = decide([], { kind: "rename", cardId, intent: "Sign in to the fixture account" }, 1);
  const result = owned(events, cardId, before);
  assert.equal(result.workflow.steps[0]?.caption.text, "Sign in to the fixture account");
  const later = decide(result.decisions, { kind: "note", cardId: "evt-9", note: "Complete every sign-in screen" }, 2);
  assert.equal(projectTeach(events, later, meta).workflow.steps[0]?.caption.text, "Complete every sign-in screen");
  const repeat = owned(events, "evt-9", later);
  assert.deepEqual(repeat.workflow.steps.map((step) => step.action), ["handoff", "click"]);
});

test("invalid, partial-card and overlapping spans do not silently fold another interval", () => {
  const events = load("multi");
  for (const span of [
    { firstEventId: "missing", lastEventId: "evt-14" },
    { firstEventId: "evt-9", lastEventId: "evt-0" },
    { firstEventId: "evt-9", lastEventId: "evt-14" },
  ]) {
    const decisions = decide([], { kind: "human", cardId: "evt-1", signIn: span }, 1);
    assert.throws(() => projectTeach(events, decisions, meta), /Include the marked step/);
  }
  const result = owned(events, "evt-1");
  const overlap = decide(result.decisions, { kind: "human", cardId: "evt-15", signIn: { firstEventId: "evt-0", lastEventId: "evt-15" } }, 2);
  assert.throws(() => projectTeach(events, overlap, meta), /dropped or merged|overlap/);
});

test("old sign-in documents keep credential behavior while bad actors fail validation", () => {
  const doc = owned(load("single"), "evt-1").workflow;
  const legacy = structuredClone(doc);
  const step = legacy.steps[0]!;
  assert.equal(step.action, "handoff");
  if (step.action !== "handoff") throw new Error("Expected a handoff");
  delete step.actor;
  const loaded = parseWorkflow(legacy);
  assert.equal(loaded.steps[0]?.action === "handoff" ? loaded.steps[0].actor : undefined, "credentials");
  assert.equal(step.actor, undefined, "loading must not mutate the old document");
  const invalid = structuredClone(doc);
  const bad = invalid.steps[0]!;
  if (bad.action !== "handoff") throw new Error("Expected a handoff");
  bad.reason = "owner-press";
  assert.match(validateWorkflow(invalid).join(","), /handoff actor/);
  assert.equal(validate(invalid), false);
});

function observingDriver(): { driver: Driver; effects: string[]; asks: string[]; setTree(tree: LiveTree): void } {
  let tree: LiveTree = { url: meta.startUrl, texts: ["Sign in"], nodes: [], values: [] };
  const effects: string[] = [];
  const asks: string[] = [];
  const driver: Driver = {
    tree: async () => tree,
    snapshot: async () => ({ dom: {}, ax: [] }),
    click: async (node: Identity) => { effects.push(`click:${node.id}`); },
    fill: async () => { effects.push("fill"); }, key: async () => { effects.push("key"); },
    check: async () => { effects.push("check"); }, digits: async () => { effects.push("digits"); },
    upload: async () => { effects.push("upload"); }, drop: async () => { effects.push("drop"); },
    notify: async () => {}, showAsk: async (ask) => { asks.push(ask.kind); },
    showLoginWait: async () => {}, clearLoginWait: async () => {},
  };
  return { driver, effects, asks, setTree: (value) => { tree = value; } };
}

test("an owner sign-in never fills or submits with any supplied secret, on initial pause or premature resume", async () => {
  const workflow = owned(load("multi"), "evt-1").workflow;
  const probe = observingDriver();
  for (const humanReady of [undefined, true, "confirmed"] as const) {
    const run = await replay(workflow, { username: "other-user", password: "supplied-secret", code: "654321" }, probe.driver, { yieldHuman: true, humanReady });
    assert.equal(run.status, "paused");
    assert.deepEqual(probe.effects, []);
  }
  assert.deepEqual(probe.asks, ["login"]);
});

test("completion resumes at the unrelated next action without replaying any sign-in action", async () => {
  const workflow = owned(load("multi"), "evt-1").workflow;
  const probe = observingDriver();
  const business: Identity = { id: "business", role: "button", name: "Open statement", surface: "dom", path: [] };
  probe.setTree({ url: "http://fixture.test/account", texts: ["Account overview", "Statement opened"], nodes: [business], values: [] });
  const run = await replay(workflow, { password: "supplied-secret" }, probe.driver, { yieldHuman: true, humanReady: true });
  assert.equal(run.status, "passed", JSON.stringify(run.failure));
  assert.deepEqual(probe.effects, ["click:business"]);
});

test("a span without a recorded completion waits for explicit owner completion", async () => {
  const workflow: WorkflowV2 = owned(load("multi"), "evt-1").workflow;
  workflow.steps = workflow.steps.slice(0, 1);
  const step = workflow.steps[0]!;
  if (step.action !== "handoff") throw new Error("Expected a handoff");
  delete step.check;
  const probe = observingDriver();
  const paused = await replay(workflow, { password: "supplied-secret" }, probe.driver, { yieldHuman: true });
  assert.equal(paused.status, "paused");
  const done = await replay(workflow, { password: "supplied-secret" }, probe.driver, { yieldHuman: true, humanReady: "confirmed" });
  assert.equal(done.status, "passed");
  assert.deepEqual(probe.effects, []);
});
