import { stepText, targetFor, testWorkflow } from "../support/workflow";
import { stepTarget, checkMatch, handoffReason, type Identity, locatorValue, targetName, stepCheck, stepInputName, stepKey, stepLocators, stepSensitive, stepTitle, type Target, validateWorkflow, WORKFLOW_SCHEMA_ID, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020";
import fc from "fast-check";
import { canonical } from "../../src/v1/canonical";
import { runViewer } from "../../src/app/views";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { buildPrompt, effectiveMode, keepPatch, revertPatch, scriptedHeal, stepPolicy, unavailableHeal, type GlobalHealMode, type HealProposal } from "../../src/v1/heal";
import { Library } from "../../src/v1/store";
import { NEEDS_SECRET_VALUE, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { tmpdir } from "node:os";
import { lookup } from "../../src/v1/identity";
import { checkHolds, expectedText, replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { parseRecordedDate } from "../../src/v1/dates";

const schema = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function id(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

test("missing locator payloads are rejected at the document boundary", () => {
  const step = (id: string, index: number, locators?: unknown[], reveal?: unknown) => ({
    id,
    index,
    timeoutMs: 0,
    caption: { text: id },
    action: "click",
    target: {
      locators: locators ?? [{ kind: "role", role: "button", name: id }],
      ...(reveal ? { reveal } : {}),
    },
  });
  const raw = {
    schema: WORKFLOW_SCHEMA_ID,
    id: "wf-locator-payloads",
    name: "Locator payloads",
    startUrl: "https://example.test/",
    createdAt: 1,
    inputs: [],
    steps: [
      step("missing-role", 0, [{ kind: "role", name: "Open" }]),
      step("empty-role", 1, [{ kind: "role", role: "", name: "Open" }]),
      step("null-name", 2, [{ kind: "role", role: "button", name: null }]),
      step("unnamed", 3, [{ kind: "role", role: "button", name: "" }]),
      step("text", 4, [{ kind: "text" }]),
      step("testid", 5, [{ kind: "testid", value: "" }]),
      step("css", 6, [{ kind: "css" }]),
      step("xpath", 7, [{ kind: "xpath", value: "" }]),
      step("anchor", 8, [{ kind: "anchor", role: "button" }]),
      step("reveal", 9, undefined, { kind: "role", name: "Open" }),
      step("legacy", 10, [{ kind: "css", value: "#ok", role: "button", name: "Ok", label: "css #ok" }]),
      step("unknown-kept", 11, [{ kind: "legacy", value: "#kept" }]),
      step("unknown-missing", 12, [{ kind: "legacy" }]),
    ],
  };
  const doc = raw as unknown as WorkflowV2;
  assert.deepEqual(validateWorkflow(doc), [
    "role locator missing-role",
    "role locator empty-role",
    "role locator null-name",
    "locator value text",
    "locator value testid",
    "locator value css",
    "locator value xpath",
    "anchor locator anchor",
    "role locator reveal",
    "locator value unknown-missing",
  ]);
  const legacy = stepLocators(doc.steps.find((item) => item.id === "legacy")!)?.[0];
  assert.deepEqual(JSON.parse(canonical(legacy)), {
    kind: "css",
    label: "css #ok",
    name: "Ok",
    role: "button",
    value: "#ok",
  });
});

test("redacted keys stay explicit and replay stops before dispatching a missing or placeholder key", async () => {
  const events: TrailEvent[] = [
    { id: "redacted", ts: 1, kind: "act", op: "key", sensitive: true, key: STRIPPED_SECRET },
    { id: "enter", ts: 2, kind: "act", op: "key", key: "Enter" },
  ];
  const doc = interpret(events, { id: "redacted-keys", startUrl: "https://example.test/" });
  assert.deepEqual(doc.steps.map((step) => step.action), ["key", "key"]);
  assert.equal(stepKey(doc.steps[0]!), STRIPPED_SECRET);
  assert.equal(stepKey(doc.steps[1]!), "Enter");
  assert.deepEqual(validateWorkflow(doc), []);
  assert.equal(validate(doc), true);
  const keys: string[] = [];
  const d = driver([]);
  d.key = async (key) => { keys.push(key); };
  const result = await replay(doc, {}, d, { heal: unavailableHeal() });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "This step needs a value. Its saved value was stripped because it may contain a secret.");
  assert.deepEqual(keys, []);
});

test("sensitive key events without a value fail before dispatch or healing while real keys replay", async () => {
  for (const fields of [{}, { key: "" }, { key: "Enter" }, { value: "Tab" }]) {
    const doc = interpret([
      { id: "key", ts: 1, kind: "act", op: "key", sensitive: true, ...fields },
    ], { id: "sensitive-key", startUrl: "https://example.test/" });
    const key = fields.key || fields.value;
    assert.equal((doc.steps[0] == null ? undefined : stepKey(doc.steps[0])), key);
    const keys: string[] = [];
    let modelCalls = 0;
    const d = driver([], { url: doc.startUrl });
    d.key = async (value) => { keys.push(value); };
    const result = await replay(doc, {}, d, {
      settings: { heal: "auto" },
      heal: {
        available: () => true,
        propose: async () => { modelCalls += 1; return null; },
      },
    });
    assert.equal(result.status, key ? "passed" : "failed");
    assert.equal(result.failure?.reason, key ? undefined : NEEDS_SECRET_VALUE);
    assert.deepEqual(keys, key ? [key] : []);
    assert.equal(d.clicks, 0);
    assert.equal(modelCalls, 0);
  }
});

test("a refused confirm click does not keep the pre-click status as its postcondition", () => {
  const events: TrailEvent[] = [
    {
      id: "e1", ts: 1, kind: "act", op: "click", performed: true,
      identity: id({ id: "delete", testId: "delete", text: "Delete" }),
      afterText: "Armed",
    },
    {
      id: "e2", ts: 2, kind: "act", op: "click", performed: false, gate: "confirm",
      identity: id({ id: "confirm", testId: "confirm", text: "Confirm" }),
      afterText: "Armed",
    },
  ];
  const doc = interpret(events, { id: "c", startUrl: "https://fixture.test/confirm" });
  assert.equal((doc.steps[0] == null ? undefined : stepCheck(doc.steps[0]))?.kind, "text");
  assert.equal(checkMatch(doc.steps[0] == null ? undefined : stepCheck(doc.steps[0])), "Armed");
  assert.equal((doc.steps[1] == null ? undefined : handoffReason(doc.steps[1])), "owner-press");
  assert.notEqual((doc.steps[1] == null ? undefined : stepCheck(doc.steps[1]))?.kind, "text");
});

test("interpret is deterministic and lifts a secret default and a file input", () => {
  const secret = "SuperSecretPassword!";
  const filePath = "/home/alex/secret-folder/taxes.pdf";
  const events: TrailEvent[] = [
    { id: "e0", ts: 10, kind: "read", op: "screenshot" },
    { id: "e1", ts: 11, kind: "read", op: "move" },
    { id: "e2", ts: 12, kind: "act", op: "wait" },
    {
      id: "e3", ts: 13, kind: "act", op: "click",
      identity: id({ testId: "user", role: "textbox", id: "username" }),
    },
    {
      id: "e4", ts: 14, kind: "act", op: "type", value: "t",
      identity: id({ id: "username", role: "textbox", nameAttr: "username" }),
    },
    {
      id: "e5", ts: 15, kind: "act", op: "type", value: "omsmith",
      identity: id({ id: "username", role: "textbox", nameAttr: "username" }),
    },
    {
      id: "e6", ts: 16, kind: "act", op: "type", value: secret, sensitive: true,
      identity: id({ id: "password", role: "textbox", nameAttr: "password" }),
    },
    {
      id: "e7", ts: 17, kind: "act", op: "upload", fileName: "taxes.pdf", rawPath: filePath,
      identity: id({ id: "file", role: "textbox", testId: "file" }),
    },
    { id: "e8", ts: 18, kind: "act", op: "click", unresolved: { reason: "nope" } },
  ];
  const meta = { id: "wf-form", name: "Form", startUrl: "https://example.test/", secrets: [secret] };
  const once = interpret(events, meta);
  const twice = interpret(events, meta);
  assert.equal(canonical(once), canonical(twice));
  const blob = canonical(once);
  assert.equal(blob.includes(secret), true);
  assert.equal(blob.includes(filePath), false);
  assert.equal(blob.includes("taxes.pdf"), false);
  assert.equal(once.inputs.find((item) => item.type === "secret")?.name, "password");
  assert.equal(once.inputs.some((item) => item.type === "file"), true);
  const upload = once.steps.find((step) => step.action === "upload");
  assert.equal((upload == null ? undefined : stepCheck(upload))?.kind, "text");
  assert.equal(checkMatch(upload == null ? undefined : stepCheck(upload)), "{{file}}");
  assert.equal(JSON.stringify(upload).includes("taxes.pdf"), false);

  const typed = once.steps.find((step) => stepInputName(step) === "username");
  assert.deepEqual(stepText(typed), { input: "username" });
  assert.equal((typed ? stepTitle(typed) : "").includes("tomsmith") || once.inputs.find((item) => item.name === "username")?.default === "tomsmith", true);
});

test("interpret uses requested navigation targets while legacy navigation keeps its observed URL", () => {
  const event: TrailEvent = { id: "open", ts: 1, kind: "act", op: "navigate", value: "https://target.test/entry?mode=edit", beforeUrl: "https://start.test/", afterUrl: "https://redirect.test/done" };
  const meta = { id: "wf-explicit-open", startUrl: "https://start.test/" };
  const explicit = interpret([event], meta);
  assert.equal(navigateUrl(explicit.steps[0]), event.value);
  assert.equal(checkMatch(explicit.steps[0] == null ? undefined : stepCheck(explicit.steps[0])), "redirect.test");
  assert.equal(checkMatch(stepCheck(interpret([{ ...event, afterUrl: undefined }], meta).steps[0]!)), "target.test");
  for (const afterUrl of ["about:blank", "file:///private", "not a URL"]) {
    const step = interpret([{ ...event, afterUrl }], meta).steps[0]!;
    assert.equal(navigateUrl(step), event.value);
    assert.equal(stepCheck(step), undefined);
  }
  const legacy = interpret([{ ...event, value: undefined }], meta);
  assert.equal(navigateUrl(legacy.steps[0]), event.afterUrl);
  assert.equal(checkMatch(legacy.steps[0] == null ? undefined : stepCheck(legacy.steps[0])), "redirect.test");
});

test("sensitive generic fields retain defaults beside ordinary long text", () => {
  const note = "Ordinary note. ".repeat(12);
  const events: TrailEvent[] = [
    { id: "password", ts: 1, kind: "act", op: "type", sensitive: true, literal: true, value: "demo-private-password", identity: id({ role: "textbox", name: "Secret", id: "entry" }) },
    { id: "code", ts: 2, kind: "act", op: "type", sensitive: true, value: "654321", identity: id({ role: "textbox", name: "Verification code", id: "challenge" }) },
    { id: "note", ts: 3, kind: "act", op: "type", value: note, identity: id({ role: "textbox", name: "Note", id: "note" }) },
  ];
  const workflow = interpret(events, { id: "wf-secret-fields", startUrl: "https://example.test/form" });
  assert.deepEqual(workflow.inputs.map((input) => [input.type, input.default]), [["secret", "demo-private-password"], ["secret", "654321"], ["text", note]]);
  assert.deepEqual(workflow.steps.map((step) => !!stepSensitive(step)), [true, true, false]);
  assert.equal(JSON.stringify(workflow).includes("demo-private-password"), true);
  assert.equal(JSON.stringify(workflow).includes("654321"), true);
  assert.deepEqual(validateWorkflow(workflow), []);
});

test("calculator clicks become number inputs and the equals check is the expression", () => {
  const button = (name: string, ts: number): TrailEvent => ({
    id: `b${ts}`, ts, kind: "act", op: "osClick",
    identity: { surface: "atspi", role: "push button", name, app: "baocalc.py", path: [] },
  });
  const doc = interpret([
    button("7", 1), button("+", 2), button("5", 3), button("=", 4),
  ], { id: "wf-calc", name: "Calc", startUrl: "desktop://baocalc" });
  assert.deepEqual(doc.inputs.map((item) => item.type), ["number", "number"]);
  assert.equal(doc.inputs[0]?.default, "7");
  assert.equal(doc.inputs[1]?.default, "5");
  const equals = doc.steps.find((step) => targetName(stepTarget(step)) === "=");
  assert.equal(checkMatch(equals == null ? undefined : stepCheck(equals)), "{{a}}+{{b}}");
  assert.equal(expectedText("{{a}}+{{b}}", { a: 1, b: 2 }), "3");
  assert.equal(JSON.stringify(doc).includes("\"7\""), true);
});

test("property: interpret retains secret defaults while keeping paths in file inputs", () => {
  const secretArb = fc.stringMatching(/^[a-f0-9]{8}$/).map((s) => `ZZ${s}`);
  const pathArb = fc.stringMatching(/^\/tmp\/bao-[a-z0-9]{6}\.pdf$/);
  fc.assert(fc.property(secretArb, pathArb, fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[a-z]+$/.test(s)), (secret, filePath, user) => {
    const events: TrailEvent[] = [
      {
        id: "t", ts: 1, kind: "act", op: "type", value: secret, sensitive: true,
        identity: id({ id: "password", nameAttr: "password", role: "textbox" }),
        afterText: `leaked ${secret}`,
      },
      {
        id: "f", ts: 2, kind: "act", op: "drop", rawPath: filePath, fileName: "note.pdf",
        identity: id({ testId: "drop", role: "region" }),
      },
      {
        id: "u", ts: 3, kind: "act", op: "type", value: user,
        identity: id({ id: "username", nameAttr: "username", role: "textbox" }),
      },
    ];
    const doc = interpret(events, { id: "wf-prop", startUrl: "https://example.test/", secrets: [secret] });
    const blob = canonical(doc);
    assert.equal(doc.inputs.find((input) => input.type === "secret")!.default, secret);
    assert.deepEqual(stepText(doc.steps[0]), { input: "password" });
    assert.equal(stepCheck(doc.steps[0]!), undefined);
    assert.equal(blob.includes(secret), true);
    const effects: [TrailEvent, string | undefined][] = [
      [events[0]!, undefined],
      [{ ...events[2]!, literal: true, afterText: `leaked ${secret}` }, `leaked ${secret}`],
    ];
    for (const [event, match] of effects) {
      const effect = interpret([event], { id: "effect", startUrl: "https://example.test/", secrets: [secret] });
      assert.equal(checkMatch(stepCheck(effect.steps[0]!)), match);
    }
    assert.equal(blob.includes(filePath), false);
    assert.equal(canonical(doc), canonical(interpret(events, { id: "wf-prop", startUrl: "https://example.test/", secrets: [secret] })));
  }), { numRuns: 40, examples: [["ZZa0a00a0a", "/tmp/bao-0a000a.pdf", "ake"]] });
});

function tree(nodes: Identity[], extra: Partial<LiveTree> = {}): LiveTree {
  return { nodes, texts: [], values: [], ...extra };
}

function driver(nodes: Identity[], extra: Partial<LiveTree> = {}): Driver & { clicks: number; notices: string[] } {
  const state = { clicks: 0, notices: [] as string[] };
  return {
    get notices() { return state.notices; },
    get clicks() { return state.clicks; },
    tree: async () => tree(nodes, extra),
    snapshot: async () => ({ dom: { value: "SuperSecretPassword!", text: "SuperSecretPassword! visible", label: "Type {{password}}", marker: STRIPPED_SECRET }, ax: [] }),
    click: async () => { state.clicks += 1; },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async (notice) => { state.notices.push(notice.title); },
    sleep: async () => {},
  };
}

function navigateUrl(step: WorkflowStep | undefined): string | undefined {
  return step?.action === "navigate" ? step.url : undefined;
}

function byTestId(testId: string): Target {
  return { locators: [{ kind: "testid", value: testId }, { kind: "css", value: `[data-testid="${testId}"]` }], hint: { role: "button", surface: "dom" } };
}

function workflow(target: Target): WorkflowV2 {
  return testWorkflow({
    id: "wf",
    name: "Login",
    steps: [{
      id: "s0",
      index: 0,
      timeoutMs: 0,
      caption: { text: "Click login" },
      action: "click",
      target,
      check: { kind: "element", locators: target.locators, timeoutMs: 0 },
    }],
  });
}

test("replay stops with a structured failure when healing is off", async () => {
  let calls = 0;
  const heal = {
    available: () => false,
    propose: async () => { calls += 1; return null; },
  };
  const d = driver([id({ testId: "real" })]);
  const result = await replay(workflow(byTestId("missing")), {}, d, { heal, secrets: ["SuperSecretPassword!"] });
  assert.equal(result.status, "failed");
  assert.equal(calls, 0);
  assert.equal(result.failure?.reason, "below-threshold");
  assert.deepEqual(result.failure!.snapshot.dom, { value: "SuperSecretPassword!", text: "SuperSecretPassword! visible", label: "Type {{password}}", marker: STRIPPED_SECRET });
  assert.equal(d.clicks, 0);
});

test("global Stop inherits the existing workflow and step policy precedence", () => {
  const doc = workflow(byTestId("missing"));
  assert.equal(effectiveMode(doc, {}), "auto");
  for (const global of ["auto", "approve", "never"] as const) {
    assert.equal(effectiveMode(doc, { heal: global }), global);
    assert.equal(stepPolicy({}, doc, { heal: global }), global);
    for (const override of ["auto", "approve"] as const) {
      assert.equal(effectiveMode({ ...doc, heal: override }, { heal: global }), override);
    }
    for (const [step, expected] of [["auto", "auto"], ["ask", "approve"], ["never", "never"]] as const) {
      assert.equal(stepPolicy({ heal: step }, doc, { heal: global }), expected);
      assert.equal(stepPolicy({ heal: step }, { ...doc, heal: "approve" }, { heal: global }), expected);
    }
  }
});

for (const mode of ["never", "auto", "approve"] satisfies GlobalHealMode[]) {
  test(`global ${mode} controls a changed step with an available healer`, async () => {
    const doc = workflow(byTestId("missing"));
    doc.steps.push({
      id: "after-miss",
      index: 1,
      timeoutMs: 0,
      caption: { text: "After the changed step" },
      action: "note",
      text: "After the changed step",
    });
    const d = driver([id({ testId: "real" })]);
    let checks = 0;
    let calls = 0;
    const result = await replay(doc, {}, d, {
      settings: { heal: mode },
      heal: {
        available: () => { checks += 1; return true; },
        propose: async () => {
          calls += 1;
          return { patch: { identity: id({ testId: "real" }) }, model: { provider: "fixture", name: "test" }, prompt: "fixture", rawResponse: "{}" };
        },
      },
    });
    assert.equal(result.status, mode === "never" ? "failed" : mode === "approve" ? "paused" : "passed");
    assert.equal(checks, mode === "never" ? 0 : 1);
    assert.equal(calls, mode === "never" ? 0 : 1);
    assert.equal(result.heals.length, mode === "never" ? 0 : 1);
    assert.equal(d.clicks, mode === "auto" ? 1 : 0);
    assert.equal(result.steps.find((step) => step.id === "after-miss")?.status, mode === "auto" ? "passed" : "pending");
    if (mode === "never") {
      assert.equal(result.failure?.stepId, "s0");
      assert.equal(result.steps[0]?.triage, "never");
      assert.match(runViewer({ id: result.runId, workflowId: doc.id, status: result.status, steps: result.steps.map(({ id, status, triage }) => ({ id, status, triage })) }, doc), /Sorted as healing turned off \(Stop\)\. Bao did not call a model\./);
      assert.deepEqual(d.notices, []);
    }
  });
}

test("auto heal applies a patch, records the audit, and does not edit the workflow", async () => {
  const proposal: HealProposal = {
    patch: { identity: id({ testId: "real" }) },
    model: { provider: "scripted", name: "test" },
    prompt: "patch the step SuperSecretPassword!",
    rawResponse: "{\"identity\":true} SuperSecretPassword!",
  };
  const doc = workflow(byTestId("missing"));
  const before = canonical(doc);
  const d = driver([id({ testId: "real" })]);
  const result = await replay(doc, {}, d, {
    heal: scriptedHeal(proposal),
    settings: { heal: "auto" },
    secrets: ["SuperSecretPassword!"],
    now: () => 42,
    runId: "run-1",
  });
  assert.equal(result.status, "passed");
  assert.equal(d.clicks, 1);
  assert.equal(d.notices[0], "Bao healed a step");
  assert.equal(result.heals[0]?.postconditionPassed, true);
  assert.equal(result.heals[0]?.model?.name, "test");
  assert.equal(result.heals[0]?.model?.version, "test");
  assert.equal(locatorValue(result.heals[0]?.executed?.target, "testid"), "real");
  assert.deepEqual(result.heals[0]!.snapshot.dom, { value: "SuperSecretPassword!", text: "SuperSecretPassword! visible", label: "Type {{password}}", marker: STRIPPED_SECRET });
  assert.equal(result.heals[0]!.prompt, proposal.prompt);
  assert.equal(result.heals[0]!.rawResponse, proposal.rawResponse);
  assert.equal(canonical(doc), before);
});

test("approve pauses before the patch is applied", async () => {
  const proposal: HealProposal = {
    patch: { identity: id({ testId: "real" }) },
    model: { provider: "scripted", name: "test" },
    prompt: "wait",
    rawResponse: "{}",
  };
  const d = driver([id({ testId: "real" })]);
  const doc = workflow(byTestId("missing"));
  doc.heal = "approve";
  const result = await replay(doc, {}, d, { heal: scriptedHeal(proposal), now: () => 1 });
  assert.equal(result.status, "paused");
  assert.equal(d.clicks, 0);
  assert.equal(d.notices[0], "Bao needs approval");
  assert.equal(result.heals[0]?.mode, "approve");
  assert.equal(result.heals[0]?.executed, undefined);
});

test("the prompt text leaves the screenshot bytes on the audit snapshot", () => {
  const step = workflow(byTestId("missing")).steps[0]!;
  const prompt = buildPrompt({
    stepId: "s0",
    index: 0,
    phase: "find",
    intent: "Click login",
    reason: "below-threshold",
    snapshot: { screenshot: "AAAASECRETBYTES", screenshotRef: "png:16", dom: [{ testId: "login" }], ax: "button login" },
  }, step);
  assert.equal(prompt.includes("AAAASECRETBYTES"), false);
  assert.equal(prompt.includes("png:16"), true);
  assert.equal(prompt.includes("login"), true);
});

test("keep then revert restores the failed step and appends decisions", () => {
  const doc = workflow(byTestId("missing"));
  const patch = { identity: id({ testId: "real" }) };
  const kept = keepPatch(doc, "s0", patch);
  assert.equal(locatorValue(stepTarget(kept.steps[0]), "testid"), "real");
  const restored = revertPatch(kept, doc.steps[0]!);
  assert.equal(locatorValue(stepTarget(restored.steps[0]), "testid"), "missing");
  const home = mkdtempSync(path.join(tmpdir(), "bao-lib-"));
  const library = new Library(home);
  const heal = { id: "heal-1", failedStep: doc.steps[0], prompt: "untouched" };
  library.saveRun({ id: "run-1", workflowId: doc.id, status: "passed", at: 1, heals: [heal], steps: [] });
  library.appendDecision("run-1", { ts: 2, healId: "heal-1", decision: "keep" });
  const after = library.appendDecision("run-1", { ts: 3, healId: "heal-1", decision: "revert" });
  assert.deepEqual(after.decisions?.map((item) => item.decision), ["keep", "revert"]);
  assert.equal((after.heals[0] as { prompt: string }).prompt, "untouched");
});

test("llm provider is unavailable without a key and does not fetch", async () => {
  const { llmHealFromEnv } = await import("../../src/v1/heal");
  let fetched = 0;
  const heal = llmHealFromEnv({}, (async () => { fetched += 1; return new Response("{}"); }) as typeof fetch);
  assert.equal(heal.available(), false);
  assert.equal(await heal.propose({
    stepId: "s", index: 0, phase: "find", intent: "x", reason: "miss", snapshot: {},
  }, workflow(byTestId("a")).steps[0]!), null);
  assert.equal(fetched, 0);
  assert.equal(unavailableHeal().available(), false);
});

test("selection rule picks the row named by the input", () => {
  const nodes = [
    id({ role: "row", name: "Ada", testId: "row" }),
    id({ role: "row", name: "Grace", testId: "row" }),
  ];
  const filtered = nodes.filter((node) => node.name === "Grace");
  const hit = lookup(id({ role: "row", name: "Ada", testId: "row" }), filtered);
  assert.equal(hit.ok, true);
  assert.equal(filtered[hit.index!]?.name, "Grace");
});

test("a drop postcondition is the visible echo and a bare filename does not pass", () => {
  const doc = interpret([
    {
      id: "d", ts: 1, kind: "act", op: "drop", fileName: "note.txt", rawPath: "/tmp/note.txt",
      identity: id({ id: "drop", role: "div", testId: "drop", text: "Drop a file here" }),
    },
  ], { id: "wf-drop", name: "Drop", startUrl: "https://example.test/fixture" });
  const step = doc.steps.find((item) => item.action === "drop");
  assert.equal((step ? stepInputName(step) : undefined), "file");
  assert.equal(checkMatch(step ? stepCheck(step) : undefined), "Dropped file: {{file}}");
  assert.equal(JSON.stringify(doc).includes("note.txt"), false);
  assert.equal(JSON.stringify(doc).includes("/tmp/note.txt"), false);
  const args = { file: { name: "bao-fix-run1.txt", path: "/tmp/bao-fix-run1.txt" } };
  assert.equal(checkHolds(stepCheck(step!)!, tree([], { texts: ["Waiting for a file", "Welcome grace"] }), args), false);
  assert.equal(checkHolds(stepCheck(step!)!, tree([], { texts: ["Dropped file: bao-fix-run1.txt"] }), args), true);
});

test("interpret keeps login and confirm as human steps with no coordinates", () => {
  const doc = interpret([
    {
      id: "login", ts: 1, kind: "act", op: "login",
      provenance: { x: 4, y: 5, space: "viewport" },
    },
    {
      id: "open", ts: 2, kind: "act", op: "click",
      identity: id({ role: "radio", name: "Open" }),
      afterText: "Open",
    },
    {
      id: "apply", ts: 3, kind: "act", op: "confirm",
      provenance: { x: 9, y: 9, space: "screen" },
      afterText: "Security freeze is off",
    },
  ], { id: "wf-human", name: "experian: unfreeze", startUrl: "https://usa.experian.com/mfe/protection/credit-protection-wizard" });
  assert.equal(validateWorkflow(doc).length, 0);
  assert.equal(doc.steps[0]?.action, "handoff");
  assert.equal((doc.steps[0] == null ? undefined : (doc.steps[0].action === "handoff")), true);
  assert.equal((doc.steps[0] == null ? undefined : doc.steps[0].caption.targetBox), undefined);
  assert.equal((doc.steps[0] == null ? undefined : stepTitle(doc.steps[0])), "Sign in");
  assert.equal(doc.steps[1]?.action, "click");
  assert.equal(targetName(stepTarget(doc.steps[1])), "Open");
  assert.equal(doc.steps[2]?.action, "handoff");
  assert.equal((doc.steps[2] == null ? undefined : (doc.steps[2].action === "handoff")), true);
  assert.equal((doc.steps[2] == null ? undefined : doc.steps[2].caption.targetBox), undefined);
  assert.equal((doc.steps[2] == null ? undefined : stepTitle(doc.steps[2])), "You press the button");
  assert.equal(checkMatch(doc.steps[2] == null ? undefined : stepCheck(doc.steps[2])), "Security freeze is off");
});

test("interpret turns a status re-read into a verify step", () => {
  const doc = interpret([
    {
      id: "open", ts: 1, kind: "act", op: "click",
      identity: id({ role: "radio", name: "Open" }),
    },
    {
      id: "apply", ts: 2, kind: "act", op: "confirm",
    },
    {
      id: "status", ts: 3, kind: "act", op: "verify",
      afterText: "Open",
      provenance: { x: 1, y: 2, space: "viewport" },
    },
  ], { id: "wf-verify", name: "experian: unfreeze", startUrl: "https://usa.experian.com/mfe/protection/credit-protection-wizard" });
  assert.equal(validateWorkflow(doc).length, 0);
  assert.equal(doc.steps[2]?.action, "verify");
  assert.equal((doc.steps[2] == null ? undefined : stepTitle(doc.steps[2])), "Check Open");

  assert.equal((doc.steps[2] == null ? undefined : doc.steps[2].caption.targetBox), undefined);
  assert.equal((doc.steps[2] == null ? undefined : stepCheck(doc.steps[2]))?.kind, "text");
  assert.equal(checkMatch(doc.steps[2] == null ? undefined : stepCheck(doc.steps[2])), "Open");
});

test("a confirm step waits for a person and does not click", async () => {
  let shown = "";
  const apply = id({ name: "Apply", role: "button" });
  const d = driver([apply], { texts: ["Your file is open"] });
  d.showConfirm = (label) => { shown = label; };
  const doc = workflow(targetFor(apply));
  doc.steps[0] = {
    id: "c",
    index: 0,
    timeoutMs: 0,
    caption: { text: "confirm before applying" },
    action: "handoff",
    reason: "owner-press",
    target: {
      locators: [{ kind: "role", role: "button", name: "Apply" }, { kind: "text", value: "Apply" }],
      hint: { role: "button", surface: "dom" },
    },
    check: { kind: "text", match: "Your file is open", timeoutMs: 0 },
  };
  const result = await replay(doc, {}, d);
  assert.equal(result.status, "passed");
  assert.equal(d.clicks, 0);
  assert.equal(shown, "confirm before applying");
  assert.equal(validate(doc), true);
  assert.deepEqual(validateWorkflow(doc), []);
});

test("a login step never types", async () => {
  let fills = 0;
  const d = driver([], { url: "https://usa.experian.com/mfe/protection/credit-protection-wizard" });
  d.fill = async () => { fills += 1; };
  const doc = workflow({ locators: [], hint: { role: "textbox", surface: "dom" } });
  doc.replayed = false;
  doc.steps[0] = {
    id: "login",
    index: 0,
    timeoutMs: 0,
    caption: { text: "ensure logged in (import from chrome, else wait for user)" },
    action: "handoff",
    reason: "sign-in",
    check: { kind: "url", match: "usa.experian.com/mfe/protection", timeoutMs: 0 },
  };
  const ready = await replay(doc, {}, d);
  assert.equal(ready.status, "passed");
  assert.equal(fills, 0);
  assert.equal(d.clicks, 0);
  d.tree = async () => tree([], { url: "https://usa.experian.com/login" });
  const waiting = await replay(doc, {}, d);
  assert.equal(waiting.status, "failed");
  assert.equal(waiting.failure?.reason, "waiting for you to log in");
  assert.equal(fills, 0);
  assert.equal(validate(doc), true);
});

test("a confirm step times out without clicking and says nothing was applied", async () => {
  const apply = id({ name: "Apply", role: "button" });
  const d = driver([apply], { texts: ["Waiting to apply"] });
  const doc = workflow(targetFor(apply));
  doc.name = "upload note";
  doc.steps[0] = {
    id: "c",
    index: 0,
    timeoutMs: 40,
    caption: { text: "you press \"Apply\"" },
    action: "handoff",
    reason: "owner-press",
    target: {
      locators: [{ kind: "role", role: "button", name: "Apply" }, { kind: "text", value: "Apply" }],
      hint: { role: "button", surface: "dom" },
    },
    check: { kind: "text", match: "Applied", timeoutMs: 40 },
  };
  const result = await replay(doc, {}, d);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "nothing applied");
  assert.equal(d.clicks, 0);
  assert.equal(result.modelCalls, 0);
});

test("closing the page during a confirm wait leaves the prompt in place", async () => {
  const apply = id({ name: "Apply", role: "button" });
  const d = driver([apply], { texts: ["Waiting to apply"] });
  let asks = 0;
  let clears = 0;
  d.showAsk = async () => { asks += 1; };
  d.clearConfirm = () => { clears += 1; };
  let reads = 0;
  d.tree = async () => {
    reads += 1;
    if (reads > 2) throw new Error("page closed");
    return tree([apply], { texts: ["Waiting to apply"] });
  };
  const doc = workflow(targetFor(apply));
  doc.steps[0] = {
    id: "c",
    index: 0,
    timeoutMs: 40,
    caption: { text: "you press \"Apply\"" },
    action: "handoff",
    reason: "owner-press",
    target: {
      locators: [{ kind: "role", role: "button", name: "Apply" }, { kind: "text", value: "Apply" }],
      hint: { role: "button", surface: "dom" },
    },
    check: { kind: "text", match: "Applied", timeoutMs: 40 },
  };
  await assert.rejects(() => replay(doc, {}, d), /page closed/);
  assert.equal(asks, 1);
  assert.equal(clears, 0);
  assert.equal(d.clicks, 0);
});

test("value postcondition reads the live text", () => {
  const ok = checkHolds(
    { kind: "value", match: "{{a}}+{{b}}", timeoutMs: 1 },
    tree([], { texts: ["12"] }),
    { a: 7, b: 5 },
  );
  assert.equal(ok, true);
});

test("a repeated field snapshot stays one value and a suggestion click uses that input", () => {
  const field = id({ role: "textbox", id: "react-select-3-input", cssPath: "#react-select-3-input" });
  const option = id({ role: "option", text: "NCR", cssPath: "#react-select-3-option-0" });
  const start = id({ role: "textbox", name: "Date Picker", cssPath: "#start" });
  const end = id({ role: "textbox", name: "Date Picker", cssPath: "#end" });
  const doc = interpret([
    { id: "n", ts: 1, kind: "act", op: "type", value: "N", identity: field },
    { id: "nc", ts: 2, kind: "act", op: "type", value: "NC", identity: field },
    { id: "ncr", ts: 3, kind: "act", op: "type", value: "NCR", identity: field },
    { id: "again", ts: 4, kind: "act", op: "type", value: "NCR", identity: field },
    { id: "opt", ts: 5, kind: "act", op: "click", identity: option },
    { id: "s1", ts: 6, kind: "act", op: "type", value: "01/15/2020", identity: start },
    { id: "s2", ts: 7, kind: "act", op: "type", value: "01/15/2020", identity: start },
    { id: "e1", ts: 8, kind: "act", op: "type", value: "12/31/2024", identity: end },
  ], { id: "wf-snap", name: "Snap", startUrl: "https://example.test/" });
  assert.equal(doc.inputs.find((item) => item.default === "NCR")?.default, "NCR");
  assert.equal(doc.inputs.some((item) => item.default === "NCRNCR"), false);
  const click = doc.steps.find((step) => step.action === "click");
  assert.equal(click?.selection?.by, "text");
  assert.equal(click?.selection?.input, doc.inputs.find((item) => item.default === "NCR")?.name);
  assert.equal(doc.inputs.filter((item) => item.type === "date").length, 2);
  assert.equal(doc.inputs.find((item) => item.format === "MM/DD/YYYY")?.format, "MM/DD/YYYY");
  assert.equal(parseRecordedDate("01/15/2020")?.format, "MM/DD/YYYY");
  assert.equal(parseRecordedDate("1/5/2020")?.format, "D/M/YYYY");
});
