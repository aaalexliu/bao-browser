import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { liveReplayArgs } from "../../src/cdp-live/live-replay";
import { applyCapturedData, bindStep, parseTable, type DataEvent } from "../../src/v1/data-steps";
import { replay, type Driver } from "../../src/v1/replay";
import { NEEDS_SECRET_VALUE, scrubSaved, STRIPPED_SECRET } from "../../src/v1/saved-secrets";
import { validateWorkflow, type WorkflowInput, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { draftVersion, versionDocument } from "../../src/v1/versions";

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

test("all binding representations strip across workflow, trail, run, version and metadata saves", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-binding-surfaces-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const [name, doc] of samples()) {
    const original = structuredClone(doc);
    const file = (relative: string) => JSON.parse(readFileSync(path.join(home, relative), "utf8"));
    const surfaces: [string, () => unknown][] = [
      ["workflow", () => { library.save(doc); return library.read(doc.id); }],
      ["trail", () => { library.saveTrail(doc.id, [doc]); return (library.readTrail(doc.id) as WorkflowV2[])[0]; }],
      ["append", () => { library.saveTrail(doc.id, []); library.appendTrail(doc.id, doc); return (library.readTrail(doc.id) as WorkflowV2[])[0]; }],
      ["run", () => { library.saveRun({ id: doc.id, workflowId: doc.id, status: "failed", at: 1, steps: [], heals: [doc] }); return library.readRun(doc.id).heals[0]; }],
      ["version", () => { library.save(doc); const row = draftVersion(library, doc, "edit"); return versionDocument(library, doc.id, row.n); }],
      ["promotion", () => { const promotion = { workflowId: doc.id, document: doc }; library.savePromotion(promotion); return file(`promotions/${doc.id}.json`).document; }],
      ["kept heal", () => { library.noteHealPromotion(doc.id, doc); return library.readKeptHeal(doc.id); }],
      ["eval", () => { library.saveIntentEval(doc.id, doc); return library.readIntentEval(doc.id); }],
      ["teach case", () => { library.saveTeachIntentCase(doc.id, doc); return file(`evals/intent/cases/${doc.id}.json`); }],
    ];
    for (const [surface, save] of surfaces) {
      const saved = save() as WorkflowV2;
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

test("CLI cleanup handles the binding matrix in JSON and JSONL without changing backups", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-binding-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const originals = new Map<string, string>();
  for (const [index, [, doc]] of samples().entries()) {
    for (const dir of ["workflows", "trails", "runs", "versions", "heals", "inputs", "promotions", "conflicts", "evals", "reports", "resumes"]) {
      const relative = `${dir}/binding-${index}.json`;
      const contents = JSON.stringify(doc);
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

test("numeric captured values scrub copies while preserving schema, enums and step indices", () => {
  const cases: [unknown, unknown, (string | number)[]][] = [
    [0, STRIPPED_SECRET, [STRIPPED_SECRET, STRIPPED_SECRET, 2, "2", 483921, "483921", -17, "-17"]],
    [2, STRIPPED_SECRET, [0, "0", STRIPPED_SECRET, STRIPPED_SECRET, 483921, "483921", -17, "-17"]],
    [483921, STRIPPED_SECRET, [0, "0", 2, "2", STRIPPED_SECRET, STRIPPED_SECRET, -17, "-17"]],
    ["483921", STRIPPED_SECRET, [0, "0", 2, "2", STRIPPED_SECRET, STRIPPED_SECRET, -17, "-17"]],
    [[0, [2, "483921"]], [STRIPPED_SECRET, [STRIPPED_SECRET, STRIPPED_SECRET]], [STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET, -17, "-17"]],
  ];
  for (const [value, expectedValue, expectedCopies] of cases) {
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
      copies: expectedCopies,
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
