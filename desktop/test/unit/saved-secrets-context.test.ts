import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { getRun, runWorkflow, type LiveReplayer } from "../../src/mcp/catalog";
import { hashReceipt, ReceiptLog, verifyReceiptChain, type Receipt, type ReceiptBody } from "../../src/v1/receipt";
import { scrubSaved, STRIPPED_SECRET } from "../../src/v1/saved-secrets";
import type { ScrubReport } from "../../src/v1/scrub-home";
import type { WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { Library, type StoredRun } from "../../src/v1/store";

const FIELD = { surface: "dom" as const, role: "textbox", id: "entry", path: [] };
const PRIVATE = "Ada Lovelace";

function entry(extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id: "entry", index: 0, action: "type", label: "Fill", surface: "dom", timeoutMs: 0, identity: FIELD, ...extra };
}

function workflow(id: string, steps: WorkflowStep[]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: steps.some((step) => step.forEach) ? 3 : 2,
    id, name: "Runtime context", createdAt: 1, startUrl: "https://example.test/", steps,
    inputs: [{ name: "value", type: "text" }, { name: "ordinary", type: "text" }],
  };
}

function fixtureHome(t: TestContext, prefix: string): string {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function json<T = Record<string, unknown>>(home: string, relative: string): T {
  return JSON.parse(readFileSync(path.join(home, relative), "utf8")) as T;
}

function cli(home: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BAO_HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY"]) delete env[name];
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../../src/app/cli.js"), "scrub-secrets", ...args], { encoding: "utf8", env });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}

test("Library saves use structural bindings even when text inputs have no default", (t) => {
  const home = fixtureHome(t, "bao-secret-context-library-");
  const library = new Library(home);
  const structures: [string, Partial<WorkflowStep>, string | number][] = [
    ["cc-name", { identity: { ...FIELD, autocomplete: "section-payment billing cc-name" } }, PRIVATE],
    ["otp", { identity: { ...FIELD, autocomplete: "one-time-code" } }, "483921"],
    ["numeric-otp", { identity: { ...FIELD, autocomplete: "one-time-code" } }, 483921],
    ["zero-otp", { identity: { ...FIELD, autocomplete: "one-time-code" } }, 0],
    ["password", { identity: { ...FIELD, inputType: "password" } }, "unusual-private-phrase"],
    ["sensitive", { sensitive: true }, "private-memo-value"],
  ];
  for (const [kind, structure, secret] of structures) {
    for (const binding of ["explicit", "template", "nested-explicit", "nested-template", "row"] as const) {
      const nested = binding.startsWith("nested") || binding === "row";
      const target = entry({ ...structure, ...(binding.endsWith("explicit") ? { input: "value" } : { value: binding === "row" ? "{{ row.cell }}" : "{{value}}" }) });
      const doc = workflow(`${kind}-${binding}`, nested ? [entry({
        id: "loop", action: "for_each", identity: undefined,
        forEach: { over: { kind: "input", name: "rows" }, steps: [target] },
      })] : [target]);
      if (nested) doc.inputs.push({ name: "rows", type: "table" });
      const bound = binding === "row" ? "rows" : "value";
      const args = { value: binding === "row" ? "unrelated value" : secret, ordinary: "keep this", ...(nested ? { rows: binding === "row" ? `cell\n${secret}\n` : "cell\npublic row\n" } : {}) };
      const hidden = secret;
      const expected = { ...args, [bound]: binding === "row" ? `cell\n${STRIPPED_SECRET}\n` : STRIPPED_SECRET };
      const run: StoredRun = {
        id: `run-${doc.id}`, workflowId: doc.id, status: "failed", at: 1, inputs: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)])),
        steps: [{ id: "entry", reason: String(hidden) }], heals: [], failure: { reason: String(hidden) },
      };
      const original = structuredClone({ doc, args, run });
      library.save(doc);
      library.saveRun(run);
      library.savePublicInputs(doc.id, args);
      const saved = library.readRun(run.id);
      const label = `${kind} / ${binding}`;
      assert.deepEqual(saved.inputs, expected, label);
      assert.deepEqual(saved.failure, { reason: STRIPPED_SECRET }, label);
      assert.deepEqual(saved.steps, [{ id: "entry", reason: STRIPPED_SECRET }], label);
      assert.deepEqual(library.readPublicInputs(doc.id), expected, label);
      assert.deepEqual(library.read(doc.id), JSON.parse(JSON.stringify(doc)), label);
      assert.deepEqual({ doc, args, run }, original, `${label} changed live values`);
    }
  }
});

test("row context strips saved cell copies as well as the source table", (t) => {
  const home = fixtureHome(t, "bao-secret-cell-context-");
  const library = new Library(home);
  const doc = workflow("cells", [entry({ id: "loop", action: "for_each", forEach: { over: { kind: "input", name: "rows" }, steps: [entry({ value: "{{ row.holder }}", identity: { ...FIELD, autocomplete: "cc-name" } })] } })]);
  doc.inputs = [{ name: "rows", type: "table" }];
  library.save(doc);
  const args = { rows: `holder,note\n${PRIVATE},ordinary\nKatherine Johnson,Grace Hopper\n` };
  const run: StoredRun = { id: "cells", workflowId: doc.id, at: 1, status: "passed", inputs: args, steps: [{ id: "entry", reason: PRIVATE }], heals: [], receipts: [{ actual: "Grace Hopper", expected: PRIVATE }] };
  library.saveRun(run);
  const saved = library.readRun(run.id);
  assert.deepEqual(saved.inputs, { rows: `holder,note\n${STRIPPED_SECRET},ordinary\n${STRIPPED_SECRET},Grace Hopper\n` });
  assert.deepEqual(saved.steps, [{ id: "entry", reason: STRIPPED_SECRET }]);
  assert.deepEqual(saved.receipts, [{ actual: "Grace Hopper", expected: STRIPPED_SECRET }]);
  assert.equal(args.rows.includes(PRIVATE), true);
});

test("numeric structural values scrub copied numbers and strings without changing metadata or live args", (t) => {
  const home = fixtureHome(t, "bao-secret-numeric-context-");
  const library = new Library(home);
  for (const secret of [483921, 0, 2, "483921", "0", "type", "dom", "bao.workflow/v2"]) {
    const doc = workflow(`numeric-${String(secret).replace(/\W/g, "-")}-${typeof secret}`, [entry({ input: "value", identity: { ...FIELD, autocomplete: "one-time-code" } })]);
    doc.inputs[0]!.type = "number";
    const args = { value: secret, ordinary: -17 };
    const copies = { numeric: Number.isFinite(Number(secret)) ? Number(secret) : secret, text: String(secret), ordinary: -17, ordinaryText: "-17" };
    const run: StoredRun = { id: doc.id, workflowId: doc.id, at: 1, status: "passed", inputs: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)])), steps: [copies], heals: [] };
    const original = structuredClone({ doc, args, run });
    library.save(doc);
    library.saveRun(run);
    library.savePublicInputs(doc.id, args);
    assert.deepEqual(library.readRun(run.id).inputs, { value: STRIPPED_SECRET, ordinary: "-17" });
    assert.deepEqual(library.readRun(run.id).steps, [{ numeric: STRIPPED_SECRET, text: STRIPPED_SECRET, ordinary: -17, ordinaryText: "-17" }]);
    assert.deepEqual(library.readPublicInputs(doc.id), { value: STRIPPED_SECRET, ordinary: -17 });
    assert.deepEqual(library.read(doc.id), doc);
    assert.deepEqual({ doc, args, run }, original);
  }

  const doc = workflow("array-context", [entry({ input: "value", identity: { ...FIELD, autocomplete: "one-time-code" } })]);
  const args = { value: [0, [2, "483921"]], ordinary: -17 };
  const payload = { schema: "bao.workflow/v2", version: 2, index: 0, action: "type", surface: "dom", inputs: args, copies: [0, "0", 2, "2", 483921, "483921", -17, "-17"] };
  const original = structuredClone({ args, payload });
  assert.deepEqual(scrubSaved(payload, { workflow: doc, args }), {
    schema: "bao.workflow/v2", version: 2, index: 0, action: "type", surface: "dom",
    inputs: { value: [STRIPPED_SECRET, [STRIPPED_SECRET, STRIPPED_SECRET]], ordinary: -17 },
    copies: [STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET, STRIPPED_SECRET, -17, "-17"],
  });
  assert.deepEqual({ args, payload }, original);
});

test("without workflow context, ordinary names and short codes stay outside heuristic detection", (t) => {
  const home = fixtureHome(t, "bao-secret-context-heuristic-");
  const library = new Library(home);
  const args = { name: PRIVATE, otp: "483921", phrase: "unusual-private-phrase", card: "4111 1111 1111 1111", token: "sk-runtime-context-token", ordinary: "keep this" };
  const expected = { ...args, card: STRIPPED_SECRET, token: STRIPPED_SECRET };
  library.savePublicInputs("unknown-workflow", args);
  assert.deepEqual(library.readPublicInputs("unknown-workflow"), expected);
  assert.deepEqual(scrubSaved(args), expected);
  const doc = workflow("context", [entry({ input: "value", identity: { ...FIELD, autocomplete: "cc-name" } })]);
  const value = { note: `Hello ${PRIVATE}`, ordinary: "keep this" };
  assert.deepEqual(scrubSaved(value), value);
  assert.deepEqual(scrubSaved(value, { workflow: doc, args: { value: PRIVATE } }), value);
  assert.deepEqual(value, { note: `Hello ${PRIVATE}`, ordinary: "keep this" });
});

test("CLI associates historical artifacts with workflows and skips legacy receipt bytes in both modes", (t) => {
  const home = fixtureHome(t, "bao-secret-context-cli-");
  const library = new Library(home);
  const doc = workflow("historical-context", [entry({ input: "value", identity: { ...FIELD, autocomplete: "cc-name" } })]);
  library.save(doc);
  const ordinary = workflow("ordinary-context", [entry({ input: "value" })]);
  library.save(ordinary);
  const inputs = { value: PRIVATE, ordinary: "keep this" };
  const expected = { value: STRIPPED_SECRET, ordinary: "keep this" };
  const fixtures: Record<string, unknown> = {
    [`inputs/${doc.id}.json`]: inputs,
    "runs/old.json": { workflowId: doc.id, inputs, failure: { reason: `Rejected ${PRIVATE}` } },
    "resumes/old.json": { workflowId: doc.id, publicInputs: inputs, ask: `Review ${PRIVATE}` },
    "reports/old.json": { workflowId: doc.id, args: inputs, reason: `Rejected ${PRIVATE}` },
    "reports/linked.json": { workflowId: doc.id, reason: PRIVATE },
    "pending-prompt.json": { ask: { workflowId: doc.id }, inputs, text: `Review ${PRIVATE}` },
  };
  const unchanged: Record<string, unknown> = {
    [`inputs/${ordinary.id}.json`]: inputs,
    "inputs/orphan.json": inputs,
    "runs/orphan.json": { workflowId: "missing", inputs, reason: PRIVATE },
  };
  const originals = new Map<string, string>();
  for (const [relative, value] of Object.entries({ ...fixtures, ...unchanged })) {
    mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
    const bytes = JSON.stringify(value);
    writeFileSync(path.join(home, relative), bytes);
    originals.set(relative, bytes);
  }
  const body: ReceiptBody = { kind: "read-back", ts: 1, runId: "legacy", workflowId: doc.id, stepId: "entry", source: "text", expected: "4111 1111 1111 1111", actual: PRIVATE, pass: true };
  const legacy = { ...body, prev: "" };
  const receipt: Receipt = { ...legacy, hash: hashReceipt(legacy) };
  const relative = "runs/legacy.receipts.jsonl";
  const bytes = `${JSON.stringify(receipt)}\n`;
  writeFileSync(path.join(home, relative), bytes);
  const dry = JSON.parse(cli(home, "--home", home)) as ScrubReport;
  assert.equal(dry.mode, "dry-run");
  assert.deepEqual(dry.files, Object.keys(fixtures).sort());
  assert.deepEqual(dry.skipped.map((item) => item.file), [relative]);
  assert.match(dry.skipped[0]!.reason, /append-only receipt chain/i);
  assert.match(dry.skipped[0]!.reason, /historical secrets may remain/i);
  for (const [file, original] of originals) assert.equal(readFileSync(path.join(home, file), "utf8"), original);
  assert.equal(readFileSync(path.join(home, relative), "utf8"), bytes);
  const written = JSON.parse(cli(home, "--home", home, "--write")) as ScrubReport;
  assert.equal(written.mode, "write");
  assert.deepEqual(written.files, dry.files);
  assert.deepEqual(written.skipped, dry.skipped);
  assert.equal(typeof written.backup, "string");
  for (const file of Object.keys(fixtures)) assert.equal(readFileSync(path.join(written.backup!, file), "utf8"), originals.get(file));
  assert.deepEqual(json(home, `inputs/${doc.id}.json`), expected);
  assert.deepEqual(json(home, "runs/old.json"), { workflowId: doc.id, inputs: expected, failure: { reason: `Rejected ${PRIVATE}` } });
  assert.deepEqual(json(home, "resumes/old.json"), { workflowId: doc.id, publicInputs: expected, ask: `Review ${PRIVATE}` });
  assert.deepEqual(json(home, "reports/old.json"), { workflowId: doc.id, args: expected, reason: `Rejected ${PRIVATE}` });
  assert.deepEqual(json(home, "reports/linked.json"), { workflowId: doc.id, reason: STRIPPED_SECRET });
  assert.deepEqual(json(home, "pending-prompt.json"), { ask: { workflowId: doc.id }, inputs: expected, text: `Review ${PRIVATE}` });
  for (const file of Object.keys(unchanged)) assert.equal(readFileSync(path.join(home, file), "utf8"), originals.get(file));
  assert.equal(readFileSync(path.join(home, relative), "utf8"), bytes);
  assert.equal(verifyReceiptChain([receipt]), true);
  const again = JSON.parse(cli(home, "--home", home, "--write")) as ScrubReport;
  assert.deepEqual(again.files, []);
  assert.deepEqual(again.skipped, dry.skipped);
  const help = cli(home, "--help");
  assert.match(help, /dry-run by default/i);
  assert.match(help, /whole secret data values only; secrets embedded in free text remain/i);
  assert.match(help, /receipt chains.*skipped.*never rewritten/i);
  assert.match(help, /historical secrets may remain/i);
  assert.match(help, /new receipts.*before hashing/i);
});

test("CLI associates Library array trails with their workflow filenames", (t) => {
  const home = fixtureHome(t, "bao-secret-trail-context-");
  const library = new Library(home);
  const event = { op: "type", input: "value", value: PRIVATE, label: "Type {{value}}", note: `Hello ${PRIVATE}` };
  const originals = new Map<string, string>();
  for (const source of ["default", "args"] as const) {
    const doc = workflow(`trail-${source}`, [entry({ input: "value", identity: { ...FIELD, autocomplete: "cc-name" } })]);
    // Write the trail through the public producer before its historical workflow exists.
    library.saveTrail(doc.id, [event]);
    if (source === "args") library.savePublicInputs(doc.id, { value: PRIVATE });
    library.save(doc);
    if (source === "default") {
      doc.inputs[0]!.default = PRIVATE;
      writeFileSync(path.join(home, "workflows", `${doc.id}.json`), JSON.stringify(doc));
    }
    for (const relative of [`trails/${doc.id}.json`, source === "default" ? `workflows/${doc.id}.json` : `inputs/${doc.id}.json`]) {
      originals.set(relative, readFileSync(path.join(home, relative), "utf8"));
    }
    assert.deepEqual(library.readTrail(doc.id), [event]);
  }
  library.saveTrail("orphan", [event]);
  const orphan = readFileSync(path.join(home, "trails", "orphan.json"), "utf8");
  const dry = JSON.parse(cli(home, "--home", home)) as ScrubReport;
  assert.deepEqual(dry.files, [...originals.keys()].sort());
  for (const [relative, bytes] of originals) assert.equal(readFileSync(path.join(home, relative), "utf8"), bytes);
  const written = JSON.parse(cli(home, "--home", home, "--write")) as ScrubReport;
  assert.deepEqual(written.files, dry.files);
  for (const [relative, bytes] of originals) assert.equal(readFileSync(path.join(written.backup!, relative), "utf8"), bytes);
  for (const source of ["default", "args"]) assert.deepEqual(library.readTrail(`trail-${source}`), [{ ...event, value: STRIPPED_SECRET }]);
  assert.equal(readFileSync(path.join(home, "trails", "orphan.json"), "utf8"), orphan);
  assert.deepEqual((JSON.parse(cli(home, "--home", home, "--write")) as ScrubReport).files, []);
});

test("CLI strips numeric bound args and their copies but keeps structural numbers", (t) => {
  const home = fixtureHome(t, "bao-secret-numeric-cli-");
  const library = new Library(home);
  const doc = workflow("numeric-history", [entry({ input: "value", identity: { ...FIELD, autocomplete: "one-time-code" } })]);
  library.save(doc);
  const relative = "reports/numeric.json";
  mkdirSync(path.join(home, "reports"), { recursive: true });
  const original = JSON.stringify({ workflowId: doc.id, version: 2, index: 0, args: { value: 0, ordinary: -17 }, actual: 0, expected: "0" });
  writeFileSync(path.join(home, relative), original);
  assert.deepEqual((JSON.parse(cli(home, "--home", home)) as ScrubReport).files, [relative]);
  assert.equal(readFileSync(path.join(home, relative), "utf8"), original);
  const written = JSON.parse(cli(home, "--home", home, "--write")) as ScrubReport;
  assert.deepEqual(written.files, [relative]);
  assert.equal(readFileSync(path.join(written.backup!, relative), "utf8"), original);
  assert.deepEqual(json(home, relative), { workflowId: doc.id, version: 2, index: 0, args: { value: STRIPPED_SECRET, ordinary: -17 }, actual: STRIPPED_SECRET, expected: STRIPPED_SECRET });
});

test("ReceiptLog scrubs string read-backs of numeric OTP args before hashing", (t) => {
  const home = fixtureHome(t, "bao-secret-numeric-receipts-");
  const doc = workflow("numeric-receipts", [entry({ input: "value", identity: { ...FIELD, autocomplete: "one-time-code" } })]);
  const file = path.join(home, "runs", "numeric.receipts.jsonl");
  const receipts: Receipt[] = [];
  for (const secret of [0, 483921, "483921"]) {
    const args = { value: secret, ordinary: -17 };
    const body: ReceiptBody = { kind: "read-back", ts: 2, runId: "numeric", workflowId: doc.id, stepId: "entry", source: "text", expected: String(secret), actual: String(secret), pass: true };
    const original = structuredClone({ body, args });
    const saved = new ReceiptLog(file).append(body, { workflow: doc, args });
    assert.equal(saved.expected, STRIPPED_SECRET);
    assert.equal(saved.actual, STRIPPED_SECRET);
    assert.equal(saved.ts, 2);
    receipts.push(saved);
    assert.equal(verifyReceiptChain(receipts), true);
    assert.deepEqual({ body, args }, original);
  }
  assert.deepEqual(readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)), receipts);
});

test("ReceiptLog strips before hashing, preserves live bodies, and extends legacy chains without rewriting", (t) => {
  const home = fixtureHome(t, "bao-secret-context-receipts-");
  const file = path.join(home, "runs", "future.receipts.jsonl");
  const doc = workflow("receipt-context", [entry({ value: "{{value}}", identity: { ...FIELD, autocomplete: "cc-name" } })]);
  const args = { value: PRIVATE };
  const body: ReceiptBody = { kind: "read-back", ts: 1, runId: "future", workflowId: doc.id, stepId: "entry", source: "text", expected: PRIVATE, actual: `Read ${PRIVATE}`, pass: true };
  const original = structuredClone(body);
  const first = new ReceiptLog(file).append(body, { workflow: doc, args });
  assert.equal(first.expected, STRIPPED_SECRET);
  assert.equal(first.actual, `Read ${PRIVATE}`);
  const second = new ReceiptLog(file).append({ ...body, ts: 2, expected: "4111 1111 1111 1111", actual: "keep this" });
  assert.equal(second.expected, STRIPPED_SECRET);
  assert.equal(second.actual, "keep this");
  assert.equal(second.prev, first.hash);
  const saved = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Receipt);
  assert.deepEqual(saved, [first, second]);
  assert.equal(verifyReceiptChain(saved), true);
  assert.equal(verifyReceiptChain([{ ...first, actual: "changed" }, second]), false);
  assert.deepEqual(body, original);
  assert.deepEqual(args, { value: PRIVATE });

  const legacyFile = path.join(home, "runs", "legacy.receipts.jsonl");
  const legacyBody = { ...body, prev: "" };
  const legacy: Receipt = { ...legacyBody, hash: hashReceipt(legacyBody) };
  const legacyBytes = `${JSON.stringify(legacy)}\n`;
  writeFileSync(legacyFile, legacyBytes);
  const appended = new ReceiptLog(legacyFile).append({ ...body, ts: 3 }, { workflow: doc, args });
  assert.equal(appended.prev, legacy.hash);
  assert.equal(appended.actual, `Read ${PRIVATE}`);
  const after = readFileSync(legacyFile, "utf8");
  assert.equal(after.slice(0, legacyBytes.length), legacyBytes);
  assert.deepEqual(after.trim().split("\n").map((line) => JSON.parse(line)), [legacy, appended]);
  assert.equal(verifyReceiptChain([legacy, appended]), true);
});

test("MCP keeps numeric OTP args live while stripping paused and resumed artifacts", async (t) => {
  const home = fixtureHome(t, "bao-secret-numeric-mcp-");
  const library = new Library(home);
  for (const [index, secret] of [0, 483921, "483921"].entries()) {
    const doc = { ...workflow(`numeric-mcp-${index}`, [entry({ input: "value", value: "{{value}}", identity: { ...FIELD, autocomplete: "one-time-code" } })]), driver: "cdp-live" as const };
    library.save(doc);
    const seen: Record<string, unknown>[] = [];
    const live: LiveReplayer = async (_workflow, inputs) => {
      seen.push(structuredClone(inputs));
      const paused = seen.length === 1;
      return {
        runId: `${doc.id}-${paused ? "paused" : "resumed"}`, status: paused ? "paused" : "passed",
        steps: [{ id: "entry", status: paused ? "paused" : "passed" }],
        heals: [], repairs: [], locatorHits: [], receipts: [], trajectory: [], trail: [], pageClasses: [], modelCalls: 0,
      };
    };
    const inputs = { value: secret, ordinary: -17 };
    const original = structuredClone(inputs);
    const paused = await runWorkflow(library, { id: doc.id, inputs }, undefined, { live });
    assert.equal(paused.outcome, "needs_human");
    assert.equal(typeof paused.resume, "string");
    assert.deepEqual(json(home, `resumes/${paused.resume}.json`).publicInputs, { value: STRIPPED_SECRET, ordinary: -17 });
    assert.deepEqual(library.readRun(`${doc.id}-paused`).inputs, { value: STRIPPED_SECRET, ordinary: "-17" });
    const fresh = { value: 912345 };
    const resumed = await runWorkflow(library, { resume: paused.resume, inputs: fresh }, undefined, { live });
    assert.equal(resumed.outcome, "ok", resumed.reason);
    assert.deepEqual(getRun(library, `${doc.id}-resumed`).receipts, [{ id: "entry", status: "passed", readBack: STRIPPED_SECRET }]);
    assert.deepEqual(library.readRun(`${doc.id}-resumed`).inputs, { value: STRIPPED_SECRET, ordinary: "-17" });
    assert.deepEqual(library.readPublicInputs(doc.id), { value: STRIPPED_SECRET, ordinary: -17 });
    assert.deepEqual(seen, [inputs, { value: 912345, ordinary: -17 }]);
    assert.deepEqual(inputs, original);
    assert.deepEqual(fresh, { value: 912345 });
  }
});

test("MCP pause writes a stripped resume and report, then fresh args reach the injected live replayer", async (t) => {
  const home = fixtureHome(t, "bao-secret-context-mcp-");
  const library = new Library(home);
  const doc = { ...workflow("mcp-context", [entry({ value: "{{value}}", identity: { ...FIELD, autocomplete: "cc-name" } })]), driver: "cdp-live" as const };
  library.save(doc);
  const seen: Record<string, unknown>[] = [];
  const live: LiveReplayer = async (_workflow, inputs) => {
    seen.push(structuredClone(inputs));
    const paused = seen.length === 1;
    return {
      runId: paused ? "context-paused" : "context-resumed", status: paused ? "paused" : "passed",
      steps: [{ id: "entry", status: paused ? "paused" : "passed" }],
      heals: [], repairs: [], locatorHits: [], receipts: [], trajectory: [], trail: [], pageClasses: [], modelCalls: 0,
    };
  };
  const inputs = { value: PRIVATE, ordinary: "keep this" };
  const paused = await runWorkflow(library, { id: doc.id, inputs }, undefined, { live });
  assert.equal(paused.outcome, "needs_human");
  assert.equal(paused.runId, "context-paused");
  assert.equal(typeof paused.resume, "string");
  assert.deepEqual(paused.receipts, [{ id: "entry", status: "paused", readBack: STRIPPED_SECRET }]);
  assert.deepEqual(getRun(library, "context-paused").receipts, paused.receipts);
  const resume = json(home, `resumes/${paused.resume}.json`);
  assert.equal(resume.workflowId, doc.id);
  assert.deepEqual(resume.publicInputs, { value: STRIPPED_SECRET, ordinary: "keep this" });
  assert.deepEqual(library.readRun("context-paused").inputs, { value: STRIPPED_SECRET, ordinary: "keep this" });
  assert.deepEqual(library.readPublicInputs(doc.id), { value: STRIPPED_SECRET, ordinary: "keep this" });
  const fresh = { value: "Grace Hopper" };
  const resumed = await runWorkflow(library, { resume: paused.resume, inputs: fresh }, undefined, { live });
  assert.equal(resumed.outcome, "ok", resumed.reason);
  assert.equal(resumed.runId, "context-resumed");
  assert.deepEqual(resumed.receipts, [{ id: "entry", status: "passed", readBack: STRIPPED_SECRET }]);
  assert.deepEqual(getRun(library, "context-resumed").receipts, resumed.receipts);
  assert.deepEqual(library.readRun("context-resumed").inputs, { value: STRIPPED_SECRET, ordinary: "keep this" });
  assert.deepEqual(seen, [inputs, { value: "Grace Hopper", ordinary: "keep this" }]);
  assert.deepEqual(inputs, { value: PRIVATE, ordinary: "keep this" });
  assert.deepEqual(fresh, { value: "Grace Hopper" });
});
