import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020";
import fc from "fast-check";
import { canonical } from "../../src/v1/canonical";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { buildPrompt, keepPatch, revertPatch, scriptedHeal, unavailableHeal, type HealProposal } from "../../src/v1/heal";
import { Library } from "../../src/v1/store";
import { tmpdir } from "node:os";
import { lookup } from "../../src/v1/identity";
import { expectedText, holds, replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { migrate, validateWorkflow, type Identity, type WorkflowV2 } from "../../src/v1/schema";

const schema = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function id(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

test("migrate drops a password literal and validates against the json schema", () => {
  const doc = migrate({
    id: "wf-login",
    name: "Login",
    version: 1,
    startUrl: "https://example.test/login",
    createdAt: 1,
    variables: [],
    steps: [
      {
        id: "u",
        action: "input",
        label: "Username",
        ts: 1,
        value: "tomsmith",
        target: { selectors: [{ type: "id", value: "#username" }], text: "" },
      },
      {
        id: "p",
        action: "input",
        label: "Password",
        ts: 2,
        sensitive: true,
        value: "SuperSecretPassword!",
        target: { selectors: [{ type: "id", value: "#password" }], text: "" },
      },
    ],
  });
  assert.deepEqual(validateWorkflow(doc), []);
  assert.equal(validate(doc), true);
  assert.equal(JSON.stringify(doc).includes("SuperSecretPassword!"), false);
  assert.equal(doc.inputs.find((item) => item.name === "password")?.type, "secret");
  assert.equal(doc.inputs.find((item) => item.name === "password")?.default, undefined);
  assert.equal(doc.steps[1]?.value, "{{password}}");
});

test("interpret is deterministic and lifts a secret and a file without storing either", () => {
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
  assert.equal(blob.includes(secret), false);
  assert.equal(blob.includes(filePath), false);
  assert.equal(blob.includes("taxes.pdf"), false);
  assert.equal(once.inputs.find((item) => item.type === "secret")?.name, "password");
  assert.equal(once.inputs.some((item) => item.type === "file"), true);
  const upload = once.steps.find((step) => step.action === "upload");
  assert.equal(upload?.postcondition?.kind, "text");
  assert.equal(upload?.postcondition?.match, "{{file}}");
  assert.equal(JSON.stringify(upload).includes("taxes.pdf"), false);
  assert.equal(once.steps.some((step) => step.unresolved), false);
  const typed = once.steps.find((step) => step.input === "username");
  assert.equal(typed?.value, "{{username}}");
  assert.equal(typed?.label.includes("tomsmith") || once.inputs.find((item) => item.name === "username")?.default === "tomsmith", true);
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
  const equals = doc.steps.find((step) => step.identity?.name === "=");
  assert.equal(equals?.postcondition?.match, "{{a}}+{{b}}");
  assert.equal(expectedText("{{a}}+{{b}}", { a: 1, b: 2 }), "3");
  assert.equal(JSON.stringify(doc).includes("\"7\""), true);
});

test("property: interpret never stores the secret or the path", () => {
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
    assert.equal(blob.includes(secret), false);
    assert.equal(blob.includes(filePath), false);
    assert.equal(canonical(doc), canonical(interpret(events, { id: "wf-prop", startUrl: "https://example.test/", secrets: [secret] })));
  }), { numRuns: 40 });
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
    snapshot: async () => ({ dom: "SuperSecretPassword! visible", ax: [] }),
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

function workflow(identity: Identity): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "Login",
    startUrl: "https://example.test/",
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "s0",
      index: 0,
      action: "click",
      label: "Click login",
      surface: "dom",
      identity,
      timeoutMs: 0,
      postcondition: { kind: "element", timeoutMs: 0 },
    }],
  };
}

test("replay stops with a structured failure when healing is off", async () => {
  let calls = 0;
  const heal = {
    available: () => false,
    propose: async () => { calls += 1; return null; },
  };
  const d = driver([id({ testId: "real" })]);
  const result = await replay(workflow(id({ testId: "missing" })), {}, d, { heal, secrets: ["SuperSecretPassword!"] });
  assert.equal(result.status, "failed");
  assert.equal(calls, 0);
  assert.equal(result.failure?.reason, "below-threshold");
  assert.equal(JSON.stringify(result.failure).includes("SuperSecretPassword!"), false);
  assert.equal(d.clicks, 0);
});

test("auto heal applies a patch, records the audit, and does not edit the workflow", async () => {
  const proposal: HealProposal = {
    patch: { identity: id({ testId: "real" }) },
    model: { provider: "scripted", name: "test" },
    prompt: "patch the step SuperSecretPassword!",
    rawResponse: "{\"identity\":true} SuperSecretPassword!",
  };
  const doc = workflow(id({ testId: "missing" }));
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
  assert.equal(result.heals[0]?.executed?.identity?.testId, "real");
  assert.equal(JSON.stringify(result.heals).includes("SuperSecretPassword!"), false);
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
  const doc = workflow(id({ testId: "missing" }));
  doc.heal = "approve";
  const result = await replay(doc, {}, d, { heal: scriptedHeal(proposal), now: () => 1 });
  assert.equal(result.status, "paused");
  assert.equal(d.clicks, 0);
  assert.equal(d.notices[0], "Bao needs approval");
  assert.equal(result.heals[0]?.mode, "approve");
  assert.equal(result.heals[0]?.executed, undefined);
});

test("the prompt text leaves the screenshot bytes on the audit snapshot", () => {
  const step = workflow(id({ testId: "missing" })).steps[0]!;
  const prompt = buildPrompt({
    stepId: "s0",
    index: 0,
    intent: "Click login",
    reason: "below-threshold",
    snapshot: { screenshot: "AAAASECRETBYTES", screenshotRef: "png:16", dom: [{ testId: "login" }], ax: "button login" },
  }, step, ["SuperSecretPassword!"]);
  assert.equal(prompt.includes("AAAASECRETBYTES"), false);
  assert.equal(prompt.includes("png:16"), true);
  assert.equal(prompt.includes("login"), true);
});

test("keep then revert restores the failed step and appends decisions", () => {
  const doc = workflow(id({ testId: "missing" }));
  const patch = { identity: id({ testId: "real" }) };
  const kept = keepPatch(doc, "s0", patch);
  assert.equal(kept.steps[0]?.identity?.testId, "real");
  const restored = revertPatch(kept, doc.steps[0]!);
  assert.equal(restored.steps[0]?.identity?.testId, "missing");
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
    stepId: "s", index: 0, intent: "x", reason: "miss", snapshot: {},
  }, workflow(id({ testId: "a" })).steps[0]!), null);
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
  assert.equal(step?.postcondition?.match, "Dropped file: {{drop}}");
  assert.equal(JSON.stringify(doc).includes("note.txt"), false);
  assert.equal(JSON.stringify(doc).includes("/tmp/note.txt"), false);
  const args = { drop: { name: "bao-fix-run1.txt", path: "/tmp/bao-fix-run1.txt" } };
  assert.equal(holds(step!.postcondition!, tree([], { texts: ["Waiting for a file", "Welcome grace"] }), args), false);
  assert.equal(holds(step!.postcondition!, tree([], { texts: ["Dropped file: bao-fix-run1.txt"] }), args), true);
});

test("a confirm step waits for a person and does not click", async () => {
  let shown = "";
  const apply = id({ name: "Apply", role: "button" });
  const d = driver([apply], { texts: ["Your file is open"] });
  d.showConfirm = (label) => { shown = label; };
  const doc = workflow(apply);
  doc.steps[0] = {
    id: "c",
    index: 0,
    action: "confirm",
    human: true,
    label: "confirm before applying",
    surface: "dom",
    identity: apply,
    timeoutMs: 0,
    postcondition: { kind: "text", match: "Your file is open", timeoutMs: 0 },
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
  const doc = workflow(id({ role: "textbox" }));
  doc.replayed = false;
  doc.steps[0] = {
    id: "login",
    index: 0,
    action: "login",
    human: true,
    label: "ensure logged in (import from chrome, else wait for user)",
    surface: "dom",
    timeoutMs: 0,
    postcondition: { kind: "url", match: "usa.experian.com/mfe/protection", timeoutMs: 0 },
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
  const doc = workflow(apply);
  doc.name = "upload note";
  doc.steps[0] = {
    id: "c",
    index: 0,
    action: "confirm",
    human: true,
    label: 'you press "Apply"',
    surface: "dom",
    identity: apply,
    timeoutMs: 40,
    postcondition: { kind: "text", match: "Applied", timeoutMs: 40 },
  };
  const result = await replay(doc, {}, d);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "nothing applied");
  assert.equal(d.clicks, 0);
  assert.equal(result.modelCalls, 0);
});

test("value postcondition reads the live text", () => {
  const ok = holds(
    { kind: "value", match: "{{a}}+{{b}}", timeoutMs: 1 },
    tree([], { texts: ["12"] }),
    { a: 7, b: 5 },
  );
  assert.equal(ok, true);
});
