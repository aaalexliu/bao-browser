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
  const structures: [string, Partial<WorkflowStep>, string][] = [
    ["cc-name", { identity: { ...FIELD, autocomplete: "section-payment billing cc-name" } }, PRIVATE],
    ["otp", { identity: { ...FIELD, autocomplete: "one-time-code" } }, "483921"],
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
      const hidden = args[bound];
      const expected = { ...args, [bound]: STRIPPED_SECRET };
      const run: StoredRun = {
        id: `run-${doc.id}`, workflowId: doc.id, status: "failed", at: 1, inputs: args,
        steps: [{ id: "entry", reason: `Observed ${hidden}` }], heals: [], failure: { reason: `Rejected ${hidden}` },
      };
      const original = structuredClone({ doc, args, run });
      library.save(doc);
      library.saveRun(run);
      library.savePublicInputs(doc.id, args);
      const saved = library.readRun(run.id);
      const label = `${kind} / ${binding}`;
      assert.deepEqual(saved.inputs, expected, label);
      assert.deepEqual(saved.failure, { reason: `Rejected ${STRIPPED_SECRET}` }, label);
      assert.deepEqual(saved.steps, [{ id: "entry", reason: `Observed ${STRIPPED_SECRET}` }], label);
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
  const args = { rows: `holder,note\n${PRIVATE},ordinary\nGrace Hopper,keep this\n` };
  const run: StoredRun = { id: "cells", workflowId: doc.id, at: 1, status: "passed", inputs: args, steps: [{ id: "entry", reason: PRIVATE }], heals: [], receipts: [{ actual: "Grace Hopper", expected: PRIVATE }] };
  library.saveRun(run);
  const saved = library.readRun(run.id);
  assert.deepEqual(saved.inputs, { rows: STRIPPED_SECRET });
  assert.deepEqual(saved.steps, [{ id: "entry", reason: STRIPPED_SECRET }]);
  assert.deepEqual(saved.receipts, [{ actual: STRIPPED_SECRET, expected: STRIPPED_SECRET }]);
  assert.equal(args.rows.includes(PRIVATE), true);
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
  assert.deepEqual(scrubSaved(value, { workflow: doc, args: { value: PRIVATE } }), { note: `Hello ${STRIPPED_SECRET}`, ordinary: "keep this" });
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
    "reports/linked.json": { workflowId: doc.id, reason: `Rejected ${PRIVATE}` },
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
  assert.deepEqual(json(home, "runs/old.json"), { workflowId: doc.id, inputs: expected, failure: { reason: `Rejected ${STRIPPED_SECRET}` } });
  assert.deepEqual(json(home, "resumes/old.json"), { workflowId: doc.id, publicInputs: expected, ask: `Review ${STRIPPED_SECRET}` });
  assert.deepEqual(json(home, "reports/old.json"), { workflowId: doc.id, args: expected, reason: `Rejected ${STRIPPED_SECRET}` });
  assert.deepEqual(json(home, "reports/linked.json"), { workflowId: doc.id, reason: `Rejected ${STRIPPED_SECRET}` });
  assert.deepEqual(json(home, "pending-prompt.json"), { ask: { workflowId: doc.id }, inputs: expected, text: `Review ${STRIPPED_SECRET}` });
  for (const file of Object.keys(unchanged)) assert.equal(readFileSync(path.join(home, file), "utf8"), originals.get(file));
  assert.equal(readFileSync(path.join(home, relative), "utf8"), bytes);
  assert.equal(verifyReceiptChain([receipt]), true);
  const again = JSON.parse(cli(home, "--home", home, "--write")) as ScrubReport;
  assert.deepEqual(again.files, []);
  assert.deepEqual(again.skipped, dry.skipped);
  const help = cli(home, "--help");
  assert.match(help, /dry-run by default/i);
  assert.match(help, /receipt chains.*skipped.*never rewritten/i);
  assert.match(help, /historical secrets may remain/i);
  assert.match(help, /new receipts.*before hashing/i);
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
  assert.equal(first.actual, `Read ${STRIPPED_SECRET}`);
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
  assert.equal(appended.actual, `Read ${STRIPPED_SECRET}`);
  const after = readFileSync(legacyFile, "utf8");
  assert.equal(after.slice(0, legacyBytes.length), legacyBytes);
  assert.deepEqual(after.trim().split("\n").map((line) => JSON.parse(line)), [legacy, appended]);
  assert.equal(verifyReceiptChain([legacy, appended]), true);
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
