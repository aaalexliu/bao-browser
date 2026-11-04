import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { liveReplayArgs } from "../../src/cdp-live/live-replay";
import { startApp } from "../../src/app/server";
import type { HealRecord } from "../../src/v1/heal";
import { cursorAccountHeal } from "../../src/v1/cursor-account";
import { ReceiptLog, verifyReceiptChain } from "../../src/v1/receipt";
import { appendDriftTrail } from "../../src/v1/real-drift";
import { applyCapturedData, bindStep, materializeOutputs, parseTable, type DataEvent } from "../../src/v1/data-steps";
import { beginFilesRun, endFilesRun, filesFor, prepareFilesDatesRun, renderTemplate, type TemplateScope } from "../../src/v1/files-dates";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { expectedText, replay, type Driver } from "../../src/v1/replay";
import { NEEDS_SECRET_VALUE, scrubSaved, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { subst, validateWorkflow, type WorkflowInput, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { projectTeach, type TeachDecision } from "../../src/v1/teach";
import { draftVersion, listVersions, versionDocument } from "../../src/v1/versions";

const PRIVATE = "arbitrary-private-value";
const CSV = `password\n${PRIVATE}\nsecond-private-value\n`;
const FIELD = { surface: "dom" as const, role: "textbox", id: "entry", path: [] };

function entry(extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id: "entry", index: 0, action: "type", label: "Fill", surface: "dom", timeoutMs: 0, identity: FIELD, ...extra };
}

function loop(body: WorkflowStep[], name = "rows", kind: "input" | "extract" = "input"): WorkflowStep {
  return entry({ id: "loop", action: "for_each", identity: undefined, forEach: { over: { kind, name }, steps: body } });
}

function workflow(steps: WorkflowStep[], inputs: WorkflowInput[]): WorkflowV2 {
  return { schema: "bao.workflow/v2", version: steps.some((step) => step.forEach || step.extract) ? 3 : 2, id: "bindings", name: "Bindings", createdAt: 1, startUrl: "https://example.test/", steps: steps.map((step, index) => ({ ...step, index })), inputs };
}

function recorded(): WorkflowV2 {
  const inputs: WorkflowInput[] = [];
  const rows = [{ password: PRIVATE }, { password: "second-private-value" }];
  const captured = applyCapturedData<DataEvent>([
    { events: [{ op: "copy", list: { as: "rows", rows } }], step: entry({ action: "click" }) },
    ...rows.map((row) => ({ events: [{ op: "type", value: row.password, sensitive: true }], step: entry({ value: row.password, input: "password", sensitive: true }) })),
  ], inputs);
  assert.equal(captured.version, 3);
  assert.equal(captured.pieces.length, 1);
  const doc = workflow(captured.pieces.map(({ step }) => step), inputs);
  assert.equal(doc.steps[0]!.forEach?.steps[0]!.input, undefined);
  assert.equal(doc.steps[0]!.forEach?.steps[0]!.value, "{{row.password}}");
  doc.inputs.find((input) => input.name === "rows")!.default = CSV;
  return doc;
}

function samples(): [string, WorkflowV2][] {
  const result: [string, WorkflowV2][] = [];
  const structures: Partial<WorkflowStep>[] = [
    { sensitive: true },
    { identity: { ...FIELD, role: "password" } },
    { identity: { ...FIELD, inputType: "password" } },
    { identity: { ...FIELD, autocomplete: "current-password" } },
    { identity: { ...FIELD, autocomplete: "one-time-code" } },
    { identity: { ...FIELD, autocomplete: "cc-name" } },
  ];
  for (const [index, structure] of structures.entries()) {
    for (const nested of [false, true]) {
      for (const explicit of [false, true]) {
        const step = entry({ ...structure, ...(explicit ? { input: "value" } : { value: "{{value}}" }) });
        const inputs: WorkflowInput[] = [{ name: "value", type: "text", default: PRIVATE }];
        if (nested) inputs.push({ name: "rows", type: "table", default: "name\nAda\n" });
        result.push([`${index}-${nested}-${explicit}`, workflow(nested ? [loop([step])] : [step], inputs)]);
      }
    }
    for (const value of ["{{row.password}}", "{{ row.password }}"]) {
      result.push([`${index}-${value}`, workflow([loop([entry({ ...structure, value })])], [{ name: "rows", type: "table", default: CSV }])]);
    }
  }
  result.push(["recorded", recorded()]);
  return result;
}

async function assertStopped(doc: WorkflowV2): Promise<void> {
  const calls: string[] = [];
  const driver = {
    tree: async () => ({ nodes: [FIELD], texts: [], url: doc.startUrl }), snapshot: async () => ({}),
    fill: async () => { calls.push("fill"); }, click: async () => { calls.push("click"); },
    key: async () => { calls.push("key"); }, sleep: async () => {},
  } as unknown as Driver;
  const run = await replay(doc, liveReplayArgs(doc, {}), driver, {
    heal: { available: () => true, propose: async () => { calls.push("heal"); return null; } },
  });
  assert.equal(run.status, "failed");
  assert.equal(run.failure?.reason, NEEDS_SECRET_VALUE);
  assert.deepEqual(calls, []);
}

function writerSurfaces(library: Library, doc: WorkflowV2): [string, () => WorkflowV2][] {
  const file = (relative: string) => JSON.parse(readFileSync(path.join(library.root, relative), "utf8"));
  return [
    ["workflow", () => { library.save(doc); const saved = file(`workflows/${doc.id}.json`); assert.deepEqual(library.read(doc.id), saved); return saved; }],
    ["trail", () => { library.saveTrail(doc.id, [doc]); return (library.readTrail(doc.id) as WorkflowV2[])[0]!; }],
    ["append", () => { library.saveTrail(doc.id, []); library.appendTrail(doc.id, doc); return (library.readTrail(doc.id) as WorkflowV2[])[0]!; }],
    ["run", () => { library.saveRun({ id: doc.id, workflowId: doc.id, status: "failed", at: 1, steps: [], heals: [doc] }); return library.readRun(doc.id).heals[0] as WorkflowV2; }],
    ["version", () => { library.save(doc); const row = draftVersion(library, doc, "edit"); return versionDocument(library, doc.id, row.n); }],
    ["promotion", () => { const promotion = { workflowId: doc.id, document: doc }; library.savePromotion(promotion); return file(`promotions/${doc.id}.json`).document; }],
    ["kept heal", () => { library.noteHealPromotion(doc.id, doc); return library.readKeptHeal(doc.id) as WorkflowV2; }],
    ["eval", () => { library.saveIntentEval(doc.id, doc); return library.readIntentEval(doc.id) as WorkflowV2; }],
    ["teach case", () => { library.saveTeachIntentCase(doc.id, doc); return file(`evals/intent/cases/${doc.id}.json`); }],
  ];
}

test("all binding representations strip across workflow, trail, run, version and metadata saves", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-binding-surfaces-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const [name, doc] of samples()) {
    const original = structuredClone(doc);
    for (const [surface, save] of writerSurfaces(library, doc)) {
      const saved = save();
      assert.equal(JSON.stringify(saved).includes(PRIVATE), false, `${name} / ${surface}`);
      const source = saved.inputs.find((input) => input.name === (name.includes("{{") || name === "recorded" ? "rows" : "value"))!;
      const table = source.type === "table";
      assert.equal(source.default, table ? `password\n${STRIPPED_SECRET}\n${STRIPPED_SECRET}\n` : STRIPPED_SECRET, `${name} / ${surface}`);
      const target = saved.steps[0]!.forEach?.steps[0] ?? saved.steps[0]!;
      assert.equal(target.unresolved?.reason, table ? undefined : NEEDS_SECRET_VALUE, `${name} / ${surface}`);
      if (table) {
        assert.deepEqual(parseTable(source.default), [{ password: STRIPPED_SECRET }, { password: STRIPPED_SECRET }]);
        assert.equal(bindStep(target, parseTable(source.default)[0]!, 0).value, STRIPPED_SECRET);
      }
      assert.deepEqual(validateWorkflow(saved), [], `${name} / ${surface}`);
      assert.deepEqual(scrubSaved(saved), saved, `${name} / ${surface}`);
      assert.deepEqual(doc, original, `${name} / ${surface} mutated live data`);
      if (surface === "workflow") await assertStopped(saved);
    }
  }
});

test("whole-value replacement keeps labels, selectors, free text and existing markers stable across writers", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-whole-value-writers-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const values = ["hunter2", "secret", "strip", "stripped", STRIPPED_SECRET];
  const doc = {
    ...workflow(values.map((value) => entry({
      id: value, sensitive: true, value, label: `see ${value}`, intent: value,
      identity: { ...FIELD, name: value }, locators: [{ kind: "text", value }],
    })), []),
    note: "see hunter2", copies: [...values, "see hunter2", `see ${STRIPPED_SECRET}`],
  };
  const original = structuredClone(doc);
  for (const [surface, save] of writerSurfaces(library, doc)) {
    const saved = save() as typeof doc;
    assert.deepEqual(saved.steps.map((step) => step.value), values.map(() => STRIPPED_SECRET), surface);
    assert.deepEqual(saved.steps.map((step) => step.label), values.map((value) => `see ${value}`), surface);
    assert.deepEqual(saved.steps.map((step) => step.intent), values, surface);
    assert.deepEqual(saved.steps.map((step) => step.identity!.name), values, surface);
    assert.deepEqual(saved.steps.map((step) => step.locators![0]!.value), values, surface);
    assert.deepEqual(saved.copies, doc.copies, surface);
    assert.equal(saved.note, "see hunter2", surface);
    assert.deepEqual(scrubSaved(saved), saved, surface);
    assert.deepEqual(scrubSaved(scrubSaved(saved)), saved, surface);
    assert.deepEqual(doc, original, surface);
  }
  const file = path.join(home, "runs", "whole.receipts.jsonl");
  const log = new ReceiptLog(file);
  for (const value of values) {
    const body = { kind: "read-back" as const, ts: 1, runId: "whole", workflowId: doc.id, stepId: "hunter2", source: "text" as const, expected: value, actual: `see ${value}`, pass: true };
    const before = structuredClone(body);
    const saved = log.append(body, { workflow: doc });
    assert.equal(saved.expected, STRIPPED_SECRET);
    assert.equal(saved.actual, `see ${value}`);
    assert.deepEqual(body, before);
  }
  const stored = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(verifyReceiptChain(stored), true);
  assert.deepEqual(scrubSaved(stored), stored);
});

test("copied heal steps retain bindings through HTTP keep, revert, restore and promotion", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-whole-heal-copies-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const stale = { ...FIELD, id: "removed", name: "RemovedBox", testId: "removed" };
  const current = { ...FIELD, id: "current", name: "PresentBox", testId: "current" };
  const doc = workflow([entry({
    id: "credential", sensitive: true, identity: stale, input: "password", value: "{{password}}",
    label: "Type {{password}}", intent: "Fill {{password}}",
    postcondition: { kind: "value", match: "{{password}}", timeoutMs: 0 },
    expect: { kind: "text", match: "Checked {{password}}", timeoutMs: 0 },
  })], [{ name: "password", type: "secret" }]);
  library.save(doc);
  const args = { password: "fresh-credential" };
  let actual = "";
  const filled: string[] = [];
  const driver = (identity: typeof current) => ({
    tree: async () => ({ nodes: [identity], texts: [`Checked ${actual}`], values: [{ identity, value: actual }], url: doc.startUrl }),
    snapshot: async () => ({ dom: [] }), fill: async (_node: unknown, value: string) => { actual = value; filled.push(value); }, sleep: async () => {}, notify: async () => {},
  }) as unknown as Driver;
  const requestFile = path.join(home, "heal-request.json");
  const responseFile = path.join(home, "heal-response.json");
  const respond = setInterval(() => {
    if (existsSync(requestFile) && !existsSync(responseFile)) writeFileSync(responseFile, JSON.stringify({ identity: current }));
  }, 10);
  t.after(() => clearInterval(respond));
  const result = await replay(doc, args, driver(current), {
    runId: "copy-run", settings: { heal: "auto" }, secrets: ["pass", "secret", args.password],
    heal: await cursorAccountHeal({ BAO_HEAL_CURSOR_ACCOUNT: "0", BAO_HEAL_CURSOR: "1", BAO_HEAL_DIR: home, BAO_HEAL_WAIT_MS: "3000" }, ["pass", args.password]),
  });
  assert.equal(result.status, "passed", result.failure?.reason);
  assert.equal(result.heals.length, 1);
  const request = JSON.parse(readFileSync(requestFile, "utf8"));
  assert.deepEqual(request.step, doc.steps[0]);
  assert.equal(result.heals[0]!.prompt, request.prompt);
  assert.deepEqual(JSON.parse(request.prompt.split("\n").find((line: string) => line.startsWith("Step: ")).slice(6)), doc.steps[0]);
  const driftFile = path.join(home, "drift.jsonl");
  appendDriftTrail(driftFile, { before: request.step, private: args.password, note: "see hunter2", marker: STRIPPED_SECRET }, { workflow: doc, args, secrets: ["pass", "secret"] });
  const drift = JSON.parse(readFileSync(driftFile, "utf8"));
  assert.deepEqual(drift.before, doc.steps[0]);
  assert.equal(drift.private, args.password);
  assert.equal(drift.note, "see hunter2");
  assert.equal(drift.marker, STRIPPED_SECRET);
  const active = structuredClone(result.heals);
  const copiedHeals = result.heals.map((heal) => ({ ...heal, failedStep: request.step }));
  library.saveRun({ id: "copy-run", workflowId: doc.id, status: result.status, at: 1, steps: result.steps, heals: copiedHeals, inputs: args });
  const saved = library.readRun("copy-run");
  const heal = (saved.heals as HealRecord[])[0]!;
  assert.deepEqual(heal.failedStep, doc.steps[0]);
  assert.equal(saved.inputs!.password, STRIPPED_SECRET);
  assert.deepEqual(result.heals, active);
  const promotion = { workflowId: doc.id, before: structuredClone(doc.steps[0]), replacement: structuredClone(doc.steps[0]), proposal: { label: doc.steps[0]!.label, postcondition: doc.steps[0]!.postcondition } };
  library.savePromotion(promotion);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "promotions", `${doc.id}.json`), "utf8")), promotion);
  const bare = { action: "type", input: "password", sensitive: true, value: "{{password}}" };
  library.saveTrail(doc.id, [bare, { ...bare, id: "unmatched" }]);
  assert.deepEqual((library.readTrail(doc.id) as { value: string }[]).map((event) => event.value), [STRIPPED_SECRET, STRIPPED_SECRET]);
  const payload = { password: "{{password}}", document: doc };
  assert.equal(scrubSaved(payload, { workflow: doc, args: payload }).document.steps[0]!.value, STRIPPED_SECRET);
  const priorHome = process.env.BAO_HOME;
  const app = await startApp({ home, port: 0, extensionHost: false, chromeUserData: path.join(home, "source-profile"), liveTarget: "bao", liveLockFile: path.join(home, "live.lock") });
  try {
    const post = async (url: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${app.port}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    await post("/api/heal/keep", { id: doc.id, stepId: "credential", patch: heal.proposedPatch, runId: "copy-run", healId: heal.id });
    assert.equal((library.readKeptHeal(doc.id) as HealRecord).failedStep.value, "{{password}}");
    await post("/api/heal/revert", { id: doc.id, runId: "copy-run", healId: heal.id });
    const reverted = listVersions(library, doc.id).filter((row) => row.source === "restore").at(-1)!;
    assert.equal(versionDocument(library, doc.id, reverted.n).steps[0]!.value, "{{password}}");
    const restored = await post(`/api/workflows/${doc.id}/versions`, { action: "restore", n: reverted.n }) as { n: number };
    await post(`/api/workflows/${doc.id}/versions`, { action: "promote", n: restored.n });
    const promoted = library.read(doc.id);
    const step = promoted.steps[0]!;
    assert.deepEqual([step.value, step.label, step.intent, step.postcondition!.match, step.expect!.match], ["{{password}}", "Type {{password}}", "Fill {{password}}", "{{password}}", "Checked {{password}}"]);
    assert.equal(expectedText(step.expect!.match!, args), "Checked fresh-credential");
    actual = "";
    filled.length = 0;
    const replayed = await replay(promoted, args, driver(stale), { heal: { available: () => false, propose: async () => { throw new Error("unexpected heal"); } } });
    assert.equal(replayed.status, "passed", replayed.failure?.reason);
    assert.deepEqual(filled, ["fresh-credential"]);
    assert.deepEqual(args, { password: "fresh-credential" });
  } finally {
    await app.close();
    if (priorHome === undefined) delete process.env.BAO_HOME; else process.env.BAO_HOME = priorHome;
  }
});

test("copied password rows retain producer token spans through every writer and replay with fresh rows", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-copied-binding-spans-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const inputs: WorkflowInput[] = [];
  const rows = [{ password: "pass" }, { password: "password" }];
  const captured = applyCapturedData<DataEvent>([
    { events: [{ op: "copy", list: { as: "rows", rows } }], step: entry({ action: "click" }) },
    ...rows.map((row) => ({
      events: [{ op: "type", value: row.password, sensitive: true }],
      step: entry({
        sensitive: true, input: "entry", value: row.password,
        postcondition: { kind: "text", match: `Filled ${row.password}`, timeoutMs: 0 },
        expect: { kind: "text", match: "Checked {{entry}}", timeoutMs: 0 },
      }),
    })),
  ], inputs);
  assert.equal(captured.pieces.length, 1);
  assert.equal(captured.pieces[0]!.step.action, "for_each");
  const doc = workflow(captured.pieces.map(({ step }) => step), inputs);
  doc.inputs.find((input) => input.name === "rows")!.default = "password\npass\npassword\n";
  const original = structuredClone(doc);
  const producer = doc.steps[0]!.forEach!.steps[0]!;
  assert.deepEqual([producer.value, producer.label, producer.postcondition?.match, producer.expect?.match], [
    "{{row.password}}", "Type {{row.password}}", "Filled {{row.password}}", "Checked {{row.password}}",
  ]);
  const library = new Library(home);
  const args = { rows: "password\nfresh-alpha\nfresh-beta\n" };
  const originalArgs = structuredClone(args);
  for (const [surface, save] of writerSurfaces(library, doc)) {
    const saved = save();
    const target = saved.steps[0]!.forEach!.steps[0]!;
    assert.deepEqual([target.value, target.label, target.postcondition?.match, target.expect?.match], [
      "{{row.password}}", "Type {{row.password}}", "Filled {{row.password}}", "Checked {{row.password}}",
    ], surface);
    assert.equal(saved.inputs.find((input) => input.name === "rows")!.default, "password\n[secret stripped]\n[secret stripped]\n", surface);
    for (const [index, row] of parseTable(args.rows).entries()) {
      const bound = bindStep(target, row, index);
      const fresh = index === 0 ? "fresh-alpha" : "fresh-beta";
      assert.equal(bound.value, fresh, surface);
      assert.equal(expectedText(bound.postcondition!.match!, args), `Filled ${fresh}`, surface);
      assert.equal(expectedText(bound.expect!.match!, args), `Checked ${fresh}`, surface);
    }
    assert.deepEqual(validateWorkflow(saved), [], surface);
    assert.deepEqual(scrubSaved(saved), saved, surface);
    assert.deepEqual(doc, original, surface);
    if (surface === "workflow") {
      const fills: string[] = [];
      let value = "";
      const driver = {
        tree: async () => ({ nodes: [FIELD], texts: [`Filled ${value}`, `Checked ${value}`], url: saved.startUrl }),
        snapshot: async () => ({}),
        fill: async (_node: unknown, text: string) => { value = text; fills.push(text); },
        sleep: async () => {},
      } as unknown as Driver;
      const run = await replay(saved, args, driver, { heal: { available: () => false, propose: async () => null } });
      assert.equal(run.status, "passed");
      assert.deepEqual(fills, ["fresh-alpha", "fresh-beta"]);
    }
    assert.deepEqual(args, originalArgs, surface);
  }
});

test("scoped row and index templates remain whole in loop metadata", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-scoped-binding-spans-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const cases: [string, string, string][] = [
    ["{{row.password}}", "pass", "fresh-cell"],
    ["{{ row.password }}", "password", "fresh-cell"],
    ["{{row_index}}", "row_index", "3"],
    ["{{ row_index }}", "index", "3"],
  ];
  for (const [token, secret, resolved] of cases) {
    const mixed = `${secret} ${token}`;
    const doc = workflow([loop([entry({
      sensitive: true, value: mixed, label: mixed, intent: mixed,
      postcondition: { kind: "text", match: mixed, timeoutMs: 0 },
      expect: { kind: "text", match: mixed, timeoutMs: 0 },
    })])], [{ name: "rows", type: "table", default: "password\nordinary-cell\n" }, { name: "row_index", type: "text", default: "separate-value" }]);
    const original = structuredClone(doc);
    for (const [surface, save] of writerSurfaces(library, doc)) {
      const saved = save();
      const step = saved.steps[0]!.forEach!.steps[0]!;
      assert.deepEqual([step.value, step.label, step.intent, step.postcondition!.match, step.expect!.match], Array(5).fill(mixed), surface);
      const bound = bindStep(step, { password: "fresh-cell" }, 2);
      assert.equal(bound.value, `${secret} ${resolved}`, surface);
      assert.equal(expectedText(bound.postcondition!.match!, {}), `${secret} ${resolved}`, surface);
      assert.equal(expectedText(bound.expect!.match!, {}), `${secret} ${resolved}`, surface);
      assert.equal(saved.inputs[1]!.name, "row_index", surface);
      assert.equal(saved.inputs[1]!.default, "separate-value", surface);
      assert.deepEqual(validateWorkflow(saved), [], surface);
      assert.deepEqual(scrubSaved(saved), saved, surface);
      assert.deepEqual(doc, original, surface);
    }
  }
});

function interpretedBindings(): WorkflowV2 {
  const events: TrailEvent[] = [
    { id: "person", ts: 1, kind: "act", op: "type", parameter: "name", value: "Ada sample", identity: { ...FIELD, id: "person" } },
    { id: "account", ts: 2, kind: "act", op: "type", parameter: "username", value: "Grace sample", identity: { ...FIELD, id: "account" } },
    { id: "login", ts: 3, kind: "act", op: "login", afterText: "Welcome Grace sample" },
    { id: "choice", ts: 4, kind: "act", op: "select", value: "Blue", identity: { ...FIELD, id: "choice", role: "combobox" } },
    { id: "upload", ts: 5, kind: "act", op: "upload", fileName: "sample.txt", identity: { ...FIELD, id: "upload" } },
    { id: "digit", ts: 6, kind: "act", op: "osClick", identity: { surface: "ax", role: "AXButton", name: "7", path: [] } },
  ];
  return interpret(events, { id: "bindings", name: "Bindings", startUrl: "https://example.test/" });
}

test("interpreted input labels and login checks survive secret collisions across all writers", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-named-binding-spans-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const secret of ["name", "user", "pass", "password"]) {
    const doc = interpretedBindings();
    assert.deepEqual(doc.steps.map((step) => step.label), [
      "Type {{name}}", "Type {{username}}", "ensure logged in (import from chrome, else wait for user)", "Select {{choice}}", "Upload file", "Enter {{a}}",
    ]);
    assert.equal(doc.steps[2]!.postcondition!.match, "Welcome {{username}}");
    assert.equal(doc.steps[2]!.expect!.match, "Welcome {{username}}");
    doc.steps.push(entry({ id: "private", index: doc.steps.length, sensitive: true, value: secret }));
    const original = structuredClone(doc);
    const args = { name: "Fresh Person", username: "fresh-account", choice: "Green", file: { name: "fresh.txt", path: "/throwaway/fresh.txt" }, a: 42 };
    const originalArgs = structuredClone(args);
    for (const [surface, save] of writerSurfaces(library, doc)) {
      const saved = save();
      const message = `${secret} / ${surface}`;
      assert.deepEqual(saved.steps.slice(0, 2).map((step) => [step.value, step.label]), [
        ["{{name}}", "Type {{name}}"], ["{{username}}", "Type {{username}}"],
      ], message);
      assert.deepEqual(saved.steps.slice(3, 6).map((step) => step.value), ["{{choice}}", "{{file}}", "{{a}}"], message);
      assert.equal(saved.steps[3]!.label, "Select {{choice}}", message);
      assert.equal(saved.steps[5]!.label, "Enter {{a}}", message);
      assert.equal(saved.steps[6]!.value, "[secret stripped]", message);
      assert.equal(subst(saved.steps[0]!.label, args), "Type Fresh Person", message);
      assert.equal(subst(saved.steps[1]!.value!, args), "fresh-account", message);
      assert.equal(subst(saved.steps[3]!.label, args), "Select Green", message);
      assert.equal(subst(saved.steps[5]!.label, args), "Enter 42", message);
      assert.equal(expectedText(saved.steps[4]!.postcondition!.match!, args), "fresh.txt", message);
      for (const check of [saved.steps[2]!.postcondition!, saved.steps[2]!.expect!]) {
        assert.equal(check.match, "Welcome {{username}}", message);
        assert.equal(expectedText(check.match!, args), "Welcome fresh-account", message);
      }
      assert.deepEqual(validateWorkflow(saved), [], message);
      assert.deepEqual(scrubSaved(saved), saved, message);
      assert.deepEqual(doc, original, message);
      assert.deepEqual(args, originalArgs, message);
    }
  }
});

test("canonical metadata and mixed binding expressions remain unchanged in every writer", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-mixed-binding-spans-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const secret of ["name", "user", "pass", "password"]) {
    const mixed = `${secret} {{name}}`;
    const doc = workflow([
      entry({
        sensitive: true, value: mixed, label: mixed, intent: mixed,
        postcondition: { kind: "text", match: mixed, timeoutMs: 0 },
        expect: { kind: "text", match: mixed, timeoutMs: 0 },
        waitFor: { kind: "text", match: mixed, timeoutMs: 0 },
        gone: { kind: "text", match: mixed, timeoutMs: 0 },
        readBack: { source: "text", match: mixed, timeoutMs: 0 },
      }),
      entry({ id: "private", sensitive: true, value: secret }),
    ], [{ name: "name", type: "text" }]);
    doc.readBack = { source: "text", match: mixed, timeoutMs: 0 };
    const original = structuredClone(doc);
    for (const [surface, save] of writerSurfaces(library, doc)) {
      const saved = save();
      const step = saved.steps[0]!;
      assert.deepEqual([
        step.value, step.label, step.intent, step.postcondition!.match, step.expect!.match,
        step.waitFor!.match, step.gone!.match, step.readBack!.match, saved.readBack!.match,
      ], Array(9).fill(mixed), `${secret} / ${surface}`);
      assert.equal(saved.steps[1]!.value, STRIPPED_SECRET);
      assert.equal(subst(step.value!, { name: "Fresh Person" }), `${secret} Fresh Person`);
      assert.equal(expectedText(step.expect!.match!, { name: "Fresh Person" }), `${secret} Fresh Person`);
      assert.deepEqual(validateWorkflow(saved), []);
      assert.deepEqual(scrubSaved(saved), saved);
      assert.deepEqual(doc, original);
    }
  }
});

test("undeclared, numeric and out-of-loop tokens in structural values remain secret data", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-unknown-binding-spans-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const value of ["{{private}}", "secret{{1}}", "{{row.password}}", "{{row_index}}"]) {
    const doc = workflow([entry({ sensitive: true, value })], [{ name: "name", type: "text" }]);
    const original = structuredClone(doc);
    for (const [surface, save] of writerSurfaces(library, doc)) {
      const saved = save();
      assert.equal(saved.steps[0]!.value, "[secret stripped]", `${value} / ${surface}`);
      assert.equal(saved.steps[0]!.unresolved?.reason, NEEDS_SECRET_VALUE);
      assert.deepEqual(validateWorkflow(saved), []);
      assert.deepEqual(scrubSaved(saved), saved);
      assert.deepEqual(doc, original);
    }
  }
});

test("runtime arguments and trail records never gain document binding ownership from their shape", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-data-binding-spans-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const doc = workflow([entry({ sensitive: true, input: "name", value: "{{name}}", label: "Type {{name}}" })], [{ name: "name", type: "secret" }]);
  const original = structuredClone(doc);
  library.save(doc);
  const args = { name: "{{name}}", ordinary: "keep this" };
  const originalArgs = structuredClone(args);
  library.savePublicInputs(doc.id, args);
  assert.deepEqual(library.readPublicInputs(doc.id), { name: "[secret stripped]", ordinary: "keep this" });
  for (const record of [
    { op: "type", parameter: "name", sensitive: true, value: "{{name}}" },
    { action: "type", input: "name", sensitive: true, value: "{{name}}" },
  ]) {
    const live = structuredClone(record);
    const expected = { ...record, value: "[secret stripped]", ...("action" in record ? { unresolved: { reason: NEEDS_SECRET_VALUE } } : {}) };
    library.saveTrail(doc.id, [record]);
    assert.deepEqual(library.readTrail(doc.id), [expected]);
    const runtime = { name: "{{name}}", typed: record };
    const originalRuntime = structuredClone(runtime);
    assert.deepEqual(scrubSaved(runtime, { workflow: doc, args: runtime }), {
      name: "[secret stripped]", typed: { ...record, value: STRIPPED_SECRET },
    });
    assert.deepEqual(runtime, originalRuntime);
    assert.deepEqual(record, live);
    const savedRuntime = scrubSaved(runtime, { workflow: doc, args: runtime });
    assert.deepEqual(scrubSaved(savedRuntime, { workflow: doc, args: savedRuntime }), savedRuntime);
  }
  assert.equal(library.read(doc.id).steps[0]!.value, "{{name}}");
  assert.deepEqual(doc, original);
  assert.deepEqual(args, originalArgs);
});

test("files templates keep their own grammar across every writer", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-file-binding-spans-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const doc = workflow([
    entry({ action: "download", download: { output: "report", name: "{{run.date}}-{{ name }}-{{suggested}}-{{run.id}}", url: "https://example.test/{{ name }}" } }),
    entry({ id: "open-url", action: "open", open: { target: "url", url: "https://example.test/{{name}}" } }),
    entry({ id: "open-file", action: "open", open: { target: "file", file: "{{ report.name }}" } }),
    entry({ id: "private", sensitive: true, value: "name" }),
  ], [{ name: "name", type: "text" }]);
  doc.version = 3;
  doc.filesDates = 1;
  const scope: TemplateScope = {
    args: { name: "fresh" }, run: { date: "2026-04-01", id: "fresh-run" }, suggested: "source.csv",
    outputs: new Map([["report", { kind: "file", name: "fresh-report.csv", path: "/throwaway/fresh-report.csv", size: 1, sha256: "hash" }]]),
  };
  const originalArgs = structuredClone(scope.args);
  for (const secret of ["name", "date", "suggested", "report"]) {
    doc.steps[3]!.value = secret;
    const original = structuredClone(doc);
    for (const [surface, save] of writerSurfaces(library, doc)) {
      const saved = save();
      assert.equal(saved.steps[0]!.download!.name, "{{run.date}}-{{ name }}-{{suggested}}-{{run.id}}", surface);
      assert.equal(saved.steps[0]!.download!.url, "https://example.test/{{ name }}", surface);
      assert.equal(saved.steps[1]!.open!.url, "https://example.test/{{name}}", surface);
      assert.equal(saved.steps[2]!.open!.file, "{{ report.name }}", surface);
      assert.equal(renderTemplate(saved.steps[0]!.download!.name, scope), "2026-04-01-fresh-source.csv-fresh-run", surface);
      assert.equal(renderTemplate(saved.steps[0]!.download!.url!, scope), "https://example.test/fresh", surface);
      assert.equal(renderTemplate(saved.steps[1]!.open!.url!, scope), "https://example.test/fresh", surface);
      assert.equal(renderTemplate(saved.steps[2]!.open!.file!, scope), "fresh-report.csv", surface);
      assert.equal(saved.steps[3]!.value, "[secret stripped]", surface);
      assert.deepEqual(validateWorkflow(saved), [], surface);
      assert.deepEqual(scrubSaved(saved), saved, surface);
      assert.deepEqual(doc, original, surface);
      assert.deepEqual(scope.args, originalArgs, surface);
    }
  }
});

test("binding declarations and direct references survive name collisions through their real consumers", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-reference-binding-spans-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const receiptFile = path.join(home, "receipt.txt");
  writeFileSync(receiptFile, "receipt body");
  for (const secret of ["report", "date", "file", "name"]) {
    const doc = workflow([
      entry({ action: "download", download: { output: "report", name: "{{run.date}}-{{suggested}}" } }),
      entry({ id: "upload", action: "upload", input: "file", value: "{{file}}", fileFrom: "report" }),
      entry({ id: "date-range", action: "click", datePicker: { input: "date", endInput: "date_end" } }),
      entry({ id: "read", action: "verify", expect: { kind: "settled", timeoutMs: 0 }, readBack: { source: "file", fileInput: "file", match: "receipt body", timeoutMs: 0 } }),
      entry({ id: "private", sensitive: true, value: secret }),
    ], [{ name: "file", type: "file", fromOutput: "report" }, { name: "date", type: "date" }, { name: "date_end", type: "date" }, { name: "name", type: "table" }]);
    doc.version = 3;
    doc.filesDates = 1;
    doc.outputs = [{ name: "result", type: "text", from: "name" }];
    doc.readBack = { source: "file", fileInput: "file", match: "receipt body", timeoutMs: 0 };
    const original = structuredClone(doc);
    for (const [surface, save] of writerSurfaces(library, doc)) {
      const saved = save();
      assert.equal(saved.steps[0]!.download!.output, "report", surface);
      assert.equal(saved.steps[1]!.fileFrom, "report", surface);
      assert.equal(saved.inputs[0]!.fromOutput, "report", surface);
      assert.deepEqual(saved.steps[2]!.datePicker, { input: "date", endInput: "date_end" }, surface);
      assert.equal(saved.steps[3]!.readBack!.fileInput, "file", surface);
      assert.equal(saved.readBack!.fileInput, "file", surface);
      assert.equal(saved.outputs![0]!.from, "name", surface);
      assert.equal(saved.steps[4]!.value, STRIPPED_SECRET, surface);
      assert.deepEqual(validateWorkflow(saved), [], surface);
      const run = prepareFilesDatesRun(saved, { date: "2026-04-01", date_end: "2026-04-02" }, {
        now: new Date("2026-04-01T12:00:00Z"), zone: "UTC", runId: "binding-consumer", downloadDir: home,
      });
      assert.equal(run.dates.get(saved.steps[2]!.datePicker!.input)!.iso, "2026-04-01", surface);
      assert.equal(run.dates.get(saved.steps[2]!.datePicker!.endInput!)!.iso, "2026-04-02", surface);
      run.outputs.set("report", { kind: "file", name: "fresh.txt", path: receiptFile, size: 12, sha256: "hash" });
      beginFilesRun(run);
      try {
        assert.deepEqual(filesFor(run.runId, saved.steps[1]!, saved), [{ name: "fresh.txt", path: receiptFile }], surface);
        assert.deepEqual(filesFor(run.runId, { ...saved.steps[1]!, fileFrom: undefined }, saved), [{ name: "fresh.txt", path: receiptFile }], surface);
      } finally {
        endFilesRun(run.runId);
      }
      assert.deepEqual(materializeOutputs(saved, new Map([["name", [{ note: "public-row" }]]])), [{ name: "result", type: "text", label: undefined, value: "public-row" }], surface);
      for (const atStep of [false, true]) {
        const proof = workflow([entry({ action: "verify", expect: { kind: "settled", timeoutMs: 0 }, ...(atStep ? { readBack: saved.steps[3]!.readBack } : {}) })], [{ name: "file", type: "text" }]);
        if (!atStep) proof.readBack = saved.readBack;
        const driver = { tree: async () => ({ nodes: [], texts: [], values: [], url: proof.startUrl }), snapshot: async () => ({}) } as unknown as Driver;
        const checked = await replay(proof, { file: receiptFile }, driver, { heal: { available: () => false, propose: async () => null } });
        assert.equal(checked.status, "passed", `${surface}: ${checked.failure?.reason}`);
        assert.equal(checked.receipts!.at(-1)!.pass, true, surface);
      }
      assert.deepEqual(scrubSaved(saved), saved, surface);
      assert.deepEqual(doc, original, surface);
    }
  }
});

test("teaching projections preserve owned card and decision spans without treating their trail as templates", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-teach-binding-spans-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const events: TrailEvent[] = [{ id: "typed", ts: 1, kind: "act", op: "type", parameter: "name", value: "Ada sample", identity: FIELD }];
  const decisions: TeachDecision[] = [{ ts: 2, cardId: "typed", kind: "input", name: "name", detail: "input {{name}}" }];
  const projection = projectTeach(events, decisions, { id: "bindings", startUrl: "https://example.test/" });
  projection.workflow.steps.push(entry({ id: "private", index: projection.workflow.steps.length, sensitive: true, value: "name" }));
  const rawTrail: TrailEvent[] = [...events, { id: "raw-secret", ts: 3, kind: "act", op: "type", parameter: "name", sensitive: true, value: "{{name}}", identity: FIELD }];
  const pair = { schema: "bao.intent-eval/v1", id: "bindings", ...projection, decisions, rawTrail };
  const original = structuredClone(pair);
  for (const surface of ["eval", "teach case", "trail"]) {
    let saved: typeof pair;
    if (surface === "eval") {
      library.saveIntentEval(pair.id, pair);
      saved = library.readIntentEval(pair.id) as typeof pair;
    } else if (surface === "teach case") {
      library.saveTeachIntentCase(pair.id, pair);
      saved = JSON.parse(readFileSync(path.join(home, "evals/intent/cases/bindings.json"), "utf8"));
    } else {
      library.saveTrail(pair.id, [pair]);
      saved = (library.readTrail(pair.id) as (typeof pair)[])[0]!;
    }
    assert.equal(saved.cards[0]!.intent, "Type {{name}} into Entry", surface);
    assert.equal(saved.cards[0]!.outcome, "the field shows {{name}}", surface);
    assert.deepEqual(saved.cards[0]!.values, [{ role: "input", name: "name", label: "{{name}}" }], surface);
    assert.equal(saved.decisions[0]!.detail, "input {{name}}", surface);
    assert.equal(saved.rawTrail[1]!.value, "[secret stripped]", surface);
    assert.equal(subst(saved.cards[0]!.intent, { name: "Fresh Person" }), "Type Fresh Person into Entry", surface);
    assert.equal(saved.workflow.steps[0]!.value, "{{name}}", surface);
    assert.equal(saved.workflow.steps[1]!.value, "[secret stripped]", surface);
    assert.deepEqual(validateWorkflow(saved.workflow), [], surface);
    assert.deepEqual(scrubSaved(saved), saved, surface);
    assert.deepEqual(pair, original, surface);
  }
});

test("CLI cleanup handles the binding matrix in JSON and JSONL without changing backups", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-binding-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const originals = new Map<string, string>();
  for (const [index, [, source]] of samples().entries()) {
    const doc = { ...source, id: `binding-${index}` };
    for (const dir of ["workflows", "trails", "runs", "versions", "heals", "inputs", "promotions", "conflicts", "evals", "reports", "resumes"]) {
      const relative = `${dir}/${doc.id}.json`;
      const contents = JSON.stringify(dir === "inputs" ? Object.fromEntries(doc.inputs.map((input) => [input.name, input.default])) : doc);
      mkdirSync(path.join(home, dir), { recursive: true });
      writeFileSync(path.join(home, relative), contents);
      originals.set(relative, contents);
    }
  }
  for (const relative of ["trail.jsonl", "live-session/trail.jsonl", "live-session/session.json"]) {
    mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
    const contents = relative.endsWith(".jsonl") ? samples().map(([, doc]) => JSON.stringify(doc)).join("\n") + "\n" : JSON.stringify(recorded());
    writeFileSync(path.join(home, relative), contents);
    originals.set(relative, contents);
  }
  const cli = (write: boolean) => {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, "../../src/app/cli.js"), "scrub-secrets", "--home", home, ...(write ? ["--write"] : [])], { encoding: "utf8", env: { ...process.env, HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" } });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as { files: string[]; backup?: string };
  };
  assert.deepEqual(cli(false).files, [...originals.keys()].sort());
  for (const [relative, contents] of originals) assert.equal(readFileSync(path.join(home, relative), "utf8"), contents);
  const written = cli(true);
  for (const [relative, contents] of originals) {
    assert.equal(readFileSync(path.join(written.backup!, relative), "utf8"), contents);
    const saved = readFileSync(path.join(home, relative), "utf8");
    assert.equal(saved.includes(PRIVATE), false);
    assert.ok(saved.includes(STRIPPED_SECRET));
    if (relative.startsWith("workflows/")) await assertStopped(JSON.parse(saved));
  }
  assert.deepEqual(cli(true).files, []);
});

test("cell stripping preserves raw headers, quoted cells and harmless duplicate values", () => {
  const csv = '"Card\nholder",note\n"Ada ""Enchantress"" Lovelace","leave ""at"", door"\n0,0\n';
  const rows = parseTable(csv);
  const column = Object.keys(rows[0]!)[0]!;
  const doc = workflow([loop([entry({ value: `{{ row.${column} }}`, identity: { ...FIELD, autocomplete: "cc-name" } })])], [{ name: "rows", type: "table", default: csv }]);
  const original = structuredClone(doc);
  const saved = scrubSaved(doc);
  assert.equal(saved.inputs[0]!.default, `"Card\nholder",note\n${STRIPPED_SECRET},"leave ""at"", door"\n${STRIPPED_SECRET},0\n`);
  assert.deepEqual(parseTable(saved.inputs[0]!.default), rows.map((row) => ({ ...row, [column]: STRIPPED_SECRET })));
  assert.deepEqual(scrubSaved(saved), saved);
  assert.deepEqual(doc, original);
});

test("a sensitive target bound to an entire table strips cells and refuses marker dispatch", async () => {
  for (const explicit of [true, false]) {
    const doc = workflow([entry({ sensitive: true, ...(explicit ? { input: "rows" } : { value: "{{rows}}" }) })], [{ name: "rows", type: "table", default: "holder,note\nAda Lovelace,leave at door\n" }]);
    doc.version = 3;
    const saved = scrubSaved(doc);
    assert.equal(saved.inputs[0]!.default, `holder,note\n${STRIPPED_SECRET},${STRIPPED_SECRET}\n`);
    await assertStopped(saved);
  }
});

test("runtime payload names do not inherit schema metadata exemptions", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-numeric-metadata-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const name of ["index", "version", "id", "type", "name"]) {
    const doc = workflow([entry({ input: name, value: `{{${name}}}`, identity: { ...FIELD, autocomplete: "one-time-code" } })], [{ name, type: "number" }]);
    const args = { [name]: 0, ordinary: -17 };
    library.save(doc);
    library.savePublicInputs(doc.id, args);
    assert.deepEqual(library.readPublicInputs(doc.id), { [name]: STRIPPED_SECRET, ordinary: -17 });
    assert.deepEqual(args, { [name]: 0, ordinary: -17 });
    assert.equal(library.read(doc.id).steps[0]!.value, `{{${name}}}`);
  }
});

test("numeric captured values strip without rewriting unlisted copies or metadata", () => {
  const cases: [unknown, unknown][] = [
    [0, STRIPPED_SECRET], [2, STRIPPED_SECRET], [483921, STRIPPED_SECRET], ["483921", STRIPPED_SECRET],
    [[0, [2, "483921"]], [STRIPPED_SECRET, [STRIPPED_SECRET, STRIPPED_SECRET]]],
  ];
  for (const [value, expectedValue] of cases) {
    const captured = {
      schema: "bao.workflow/v2", version: 2, index: 0, action: "type", surface: "dom",
      identity: { ...FIELD, inputType: "password" }, sensitive: true, value,
      copies: [0, "0", 2, "2", 483921, "483921", -17, "-17"],
    };
    const original = structuredClone(captured);
    const saved = scrubSaved(captured);
    assert.deepEqual(saved, {
      ...captured,
      value: expectedValue,
      copies: captured.copies,
      unresolved: { reason: NEEDS_SECRET_VALUE },
    });
    assert.deepEqual(captured, original);
  }
});

test("cell markers retain CSV shape and let a harmless column run before plain secret failure", async () => {
  for (const template of ["{{row.code}}", "{{ row.code }}"]) {
    const body = [entry({ id: "note", value: "{{ row.note }}" }), entry({ id: "code", index: 1, value: template, identity: { ...FIELD, autocomplete: "one-time-code" } })];
    const doc = workflow([loop(body)], [{ name: "rows", type: "table", default: "note,code\nGrace Hopper,0\nordinary,483921\n" }]);
    const original = structuredClone(doc);
    const saved = scrubSaved(doc);
    assert.equal(saved.inputs[0]!.default, `note,code\nGrace Hopper,${STRIPPED_SECRET}\nordinary,${STRIPPED_SECRET}\n`);
    assert.deepEqual(parseTable(saved.inputs[0]!.default), [{ note: "Grace Hopper", code: STRIPPED_SECRET }, { note: "ordinary", code: STRIPPED_SECRET }]);
    const row = parseTable(saved.inputs[0]!.default)[0]!;
    assert.equal(bindStep(saved.steps[0]!.forEach!.steps[0]!, row, 0).value, "Grace Hopper");
    assert.equal(bindStep(saved.steps[0]!.forEach!.steps[1]!, row, 0).value, STRIPPED_SECRET);
    const calls: string[] = [];
    const driver = {
      tree: async () => ({ nodes: [FIELD], texts: [], url: doc.startUrl }), snapshot: async () => ({}),
      fill: async (_node: unknown, value: string) => { calls.push(value); },
    } as unknown as Driver;
    const run = await replay(saved, liveReplayArgs(saved, {}), driver, {
      heal: { available: () => true, propose: async () => { calls.push("heal"); return null; } },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.failure?.reason, NEEDS_SECRET_VALUE);
    assert.deepEqual(calls, ["Grace Hopper"]);
    assert.deepEqual(doc, original);
    const historical = structuredClone(saved);
    historical.inputs[0]!.default = STRIPPED_SECRET;
    await assertStopped(historical);
  }
});

test("array tables keep their shape and mark only bound secret cells", () => {
  const doc = workflow([loop([entry({ value: "{{ row.code }}", identity: { ...FIELD, autocomplete: "one-time-code" } })])], [{ name: "rows", type: "table" }]);
  const args = { rows: [{ note: "Grace Hopper", code: 0 }, { note: "keep this", code: "483921" }], ordinary: -17 };
  const original = structuredClone(args);
  const saved = scrubSaved(args, { workflow: doc, args });
  assert.deepEqual(saved, { rows: [{ note: "Grace Hopper", code: STRIPPED_SECRET }, { note: "keep this", code: STRIPPED_SECRET }], ordinary: -17 });
  const rows = parseTable(saved.rows);
  assert.deepEqual(rows, [{ note: "Grace Hopper", code: STRIPPED_SECRET }, { note: "keep this", code: STRIPPED_SECRET }]);
  assert.equal(bindStep(doc.steps[0]!.forEach!.steps[0]!, rows[0]!, 0).value, STRIPPED_SECRET);
  assert.deepEqual(args, original);
});

test("array table cells use the binder's normalized column names", () => {
  const rows = [{ "One-time code": 0, note: "0" }, { "One-time code": 483921, note: "keep this" }];
  const column = Object.keys(parseTable(rows)[0]!)[0]!;
  const doc = workflow([loop([entry({ value: `{{ row.${column} }}`, identity: { ...FIELD, autocomplete: "one-time-code" } })])], [{ name: "rows", type: "table" }]);
  const args = { rows };
  const original = structuredClone(args);
  const saved = scrubSaved(args, { workflow: doc, args });
  assert.deepEqual(saved.rows, rows.map((row) => ({ ...row, "One-time code": STRIPPED_SECRET })));
  assert.deepEqual(parseTable(saved.rows), rows.map((row) => ({ [column]: STRIPPED_SECRET, note: row.note })));
  assert.deepEqual(args, original);
});

test("ordinary, unrelated, computed and extract-backed row sources retain their defaults", async () => {
  const inputs: WorkflowInput[] = [
    { name: "rows", type: "table", default: CSV },
    { name: "unrelated", type: "table", default: "name\nGrace\n" },
    { name: "row_index", type: "text", default: "ordinal-default" },
  ];
  const ordinary = workflow([loop([entry({ value: "{{ row.password }}" })])], inputs);
  const computed = workflow([loop([entry({ value: "{{ row_index }}", sensitive: true })])], inputs);
  const extracted = workflow([
    entry({ id: "extract", action: "extract", extract: { as: "rows", mode: "list", locators: [{ kind: "css", value: "tr" }], columns: [{ name: "password", type: "text", read: "text", locators: [{ kind: "css", value: "td" }] }] } }),
    loop([entry({ value: "{{row.password}}", sensitive: true })], "rows", "extract"),
  ], inputs);
  for (const doc of [ordinary, computed, extracted]) {
    assert.deepEqual(validateWorkflow(doc), []);
    assert.deepEqual(scrubSaved(doc), doc);
  }
  const sensitive = workflow([loop([entry({ value: "{{row.password}}", sensitive: true })])], inputs);
  const saved = scrubSaved(sensitive);
  assert.equal(saved.inputs[0]!.default, `password\n${STRIPPED_SECRET}\n${STRIPPED_SECRET}\n`);
  assert.deepEqual(saved.inputs.slice(1), inputs.slice(1));
  const calls: string[] = [];
  const driver = { tree: async () => ({ nodes: [FIELD], texts: [], url: ordinary.startUrl }), snapshot: async () => ({}), fill: async (_node: unknown, value: string) => { calls.push(value); } } as unknown as Driver;
  const run = await replay(ordinary, liveReplayArgs(ordinary, {}), driver, { heal: { available: () => false, propose: async () => null } });
  assert.equal(run.status, "passed");
  assert.deepEqual(calls, [PRIVATE, "second-private-value"]);
  const stripped = structuredClone(ordinary);
  stripped.inputs[0]!.default = STRIPPED_SECRET;
  await assertStopped(stripped);
  const ordinal = structuredClone(computed);
  ordinal.inputs.find((input) => input.name === "row_index")!.default = STRIPPED_SECRET;
  ordinal.steps[0]!.forEach!.steps[0]!.value = "{{row_index}}";
  calls.length = 0;
  const counted = await replay(ordinal, liveReplayArgs(ordinal, {}), driver, { heal: { available: () => false, propose: async () => null } });
  assert.equal(counted.status, "passed");
  assert.deepEqual(calls, ["1", "2"]);
});
