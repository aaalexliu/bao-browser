import { stepText, testWorkflow } from "../support/workflow";
import { stepTitle, type WorkflowV2 } from "../../src/v1/schema";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { describeWorkflow, getRun, runWorkflow, type WorkflowOutcome } from "../../src/mcp/catalog";
import { Library } from "../../src/v1/store";
import { buildPushBody as push, stripUnsafe as strip } from "../../../web/src/lib/guard";
import { applyImportAnswers, applyRegistryImportAnswers } from "../../../web/src/lib/import-sheet";
import { redactForRelease } from "../../../web/src/lib/publish";
import { scaledMs } from "../runtime";

const secret = "fixture-outbound-password";
const stripped = "[secret stripped]";

function workflow(): WorkflowV2 {
  return testWorkflow({
    schema: "bao.workflow/v4", id: "outbound", name: "Outbound", createdAt: 1,
    startUrl: "https://example.test/",
    inputs: [{ name: "password", type: "secret", label: "Password", supply: "saved", default: secret }],
    steps: [{
      id: "password",
      index: 0,
      timeoutMs: 5000,
      caption: { text: "Password" },
      action: "type",
      target: {
        locators: [{ kind: "testid", value: "password" }, { kind: "css", value: "[data-testid=\"password\"]" }],
        hint: { role: "textbox", surface: "dom" },
      },
      text: { input: "password" },
      check: { kind: "value", match: "{{password}}", timeoutMs: 5000 },
    }],
  });
}

test("outbound guard scrubs whole user values without rewriting metadata or local input", () => {
  const doc = workflow();
  doc.steps.push({
    id: "copy",
    index: 1,
    timeoutMs: 0,
    caption: { text: secret },
    action: "type",
    target: { locators: [{ kind: "role", role: "textbox", name: secret }] },
    text: { literal: secret },
  });
  doc.steps.push({
    id: "card",
    index: 2,
    timeoutMs: 0,
    caption: { text: "Card" },
    action: "type",
    target: { locators: [{ kind: "role", role: "textbox", name: "Card" }] },
    text: { literal: "4111111111111111" },
  });
  doc.steps.push({
    id: "prose",
    index: 3,
    timeoutMs: 0,
    caption: { text: "Prose" },
    action: "type",
    target: { locators: [{ kind: "role", role: "textbox", name: "Prose" }] },
    text: { literal: `prefix ${secret} suffix` },
  });
  const original = structuredClone(doc);
  const cleaned = strip(doc, [secret]) as WorkflowV2;
  assert.equal(cleaned.inputs[0]?.default, undefined);
  assert.deepEqual(stepText(cleaned.steps[0]), { input: "password" });
  assert.deepEqual(stepText(cleaned.steps[1]), { literal: stripped });
  assert.equal((cleaned.steps[1] == null ? undefined : stepTitle(cleaned.steps[1])), secret);
  assert.deepEqual(stepText(cleaned.steps[2]), { literal: stripped });
  assert.deepEqual(stepText(cleaned.steps[3]), { literal: `prefix ${secret} suffix` });
  const projected = push(doc, { baseVersion: 0 }).document as WorkflowV2;
  assert.equal(projected.inputs[0]?.default, undefined);
  assert.deepEqual(stepText(projected.steps[0]), { input: "password" });
  assert.deepEqual(stepText(projected.steps[1]), { literal: stripped });
  assert.equal((projected.steps[1] == null ? undefined : stepTitle(projected.steps[1])), secret);
  assert.deepEqual(stepText(projected.steps[2]), { literal: stripped });
  assert.deepEqual(stepText(projected.steps[3]), { literal: `prefix ${secret} suffix` });
  const pushDoc = structuredClone(doc);
  pushDoc.steps[1]!.caption = { text: "Copy" };
  pushDoc.steps.pop();
  const pushed = push(pushDoc, { baseVersion: 0 }).document as WorkflowV2;
  assert.deepEqual(stepText(pushed.steps[1]), { literal: stripped });
  assert.deepEqual(stepText(pushed.steps[2]), { literal: stripped });
  assert.deepEqual(doc, original);
});

test("publishing scrubs copied secret and token values without changing the local document", () => {
  const doc = workflow();
  doc.steps.push({
    id: "copy",
    index: 1,
    timeoutMs: 0,
    caption: { text: "Copy" },
    action: "type",
    target: { locators: [{ kind: "role", role: "textbox", name: "Copy" }] },
    text: { literal: secret },
  });
  doc.steps.push({
    id: "token",
    index: 2,
    timeoutMs: 0,
    caption: { text: "Token" },
    action: "type",
    target: { locators: [{ kind: "role", role: "textbox", name: "Token" }] },
    text: { literal: "sk-outboundFixtureToken" },
  });
  const original = structuredClone(doc);
  const released = redactForRelease(doc).document as WorkflowV2;
  assert.equal(released.inputs[0]?.default, undefined);
  assert.deepEqual(stepText(released.steps[1]), { literal: stripped });
  assert.deepEqual(stepText(released.steps[2]), { literal: stripped });
  assert.deepEqual(doc, original);
});

test("MCP describe scrubs outbound text defaults and entry values without changing local defaults or required fields", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-outbound-describe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = new Library(root);
  const doc = workflow();
  doc.inputs[0]!.supply = "must";
  delete doc.inputs[0]!.default;
  doc.inputs.push(
    { name: "token", type: "text", label: "Token", supply: "saved", default: "sk-describeFixtureToken" },
    { name: "card", type: "text", label: "Card", supply: "saved", default: "4111111111111111" },
    { name: "note", type: "text", label: "Note", supply: "saved", default: "Keep this note" },
  );
  for (const [id, value] of [["copy", secret], ["token", "sk-describeFixtureToken"], ["card", "4111111111111111"]] as const) {
    doc.steps.push({
      id: id,
      index: doc.steps.length,
      timeoutMs: 0,
      caption: { text: id },
      action: "type",
      target: { locators: [{ kind: "role", role: "textbox", name: id }] },
      text: { literal: value },
    });
  }
  library.save(doc);
  const original = library.read(doc.id);
  const described = await describeWorkflow(library, doc.id);
  assert.equal(described.workflow.inputs[0]?.default, undefined);
  assert.deepEqual(described.workflow.inputs.slice(1).map((input) => input.default), [stripped, stripped, "Keep this note"]);
  assert.deepEqual(described.workflow.steps.slice(1).map((step) => stepText(step)), [{ literal: stripped }, { literal: stripped }, { literal: stripped }]);
  assert.deepEqual(stepText(described.workflow.steps[0]), { input: "password" });
  assert.deepEqual(described.inputs.map(({ name, type, required }) => ({ name, type, required })), [
    { name: "password", type: "secret", required: true },
    { name: "token", type: "text", required: false },
    { name: "card", type: "text", required: false },
    { name: "note", type: "text", required: false },
  ]);
  assert.deepEqual(described.workflow.inputs.map((input) => input.supply), original.inputs.map((input) => input.supply));
  assert.deepEqual(library.read(doc.id), original);
});

test("registry import answers retain ordinary defaults and omit secret and file defaults", () => {
  const document = {
    inputs: [
      { name: "password", type: "secret", label: "Password" },
      ...["email", "path", "phone", "ssn", "desk"].map((name) => ({ name, type: "text", label: name, askOnImport: true })),
      { name: "attachment", type: "file", label: "Attachment" },
    ],
  };
  const answers = {
    password: ` ${secret} `, email: "ada@example.test", path: "/Users/ada/file.txt",
    phone: "415-555-0123", ssn: "123-45-6789", desk: " west ", attachment: "/Users/ada/attachment.txt",
  };
  const local = applyImportAnswers(document, answers) as { inputs: { name: string; default?: string }[] };
  const cloud = applyRegistryImportAnswers(document, answers) as typeof local;
  for (const name of ["email", "path", "phone", "ssn"] as const) {
    assert.equal(local.inputs.find((input) => input.name === name)?.default, answers[name]);
    assert.equal(cloud.inputs.find((input) => input.name === name)?.default, answers[name]);
  }
  assert.equal(local.inputs.find((input) => input.name === "password")?.default, answers.password);
  assert.equal(cloud.inputs.find((input) => input.name === "password")?.default, undefined);
  assert.equal(local.inputs.find((input) => input.name === "desk")?.default, "west");
  assert.equal(cloud.inputs.find((input) => input.name === "desk")?.default, "west");
  assert.equal(local.inputs.find((input) => input.name === "attachment")?.default, undefined);
  assert.equal(cloud.inputs.find((input) => input.name === "attachment")?.default, undefined);
  assert.equal(document.inputs.some((input) => "default" in input), false);
});

test("public run lookups scrub raw outputs and report readBack without rewriting either file", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-outbound-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = new Library(root);
  library.save(workflow());
  const outputs = [{ name: "password", type: "text" as const, value: secret }];
  library.saveRun({
    id: "raw", workflowId: "outbound", status: "passed", at: 1, heals: [],
    inputs: { password: secret }, steps: [{ id: "password", status: "passed", value: secret }], outputs,
  });
  assert.deepEqual(getRun(library, "raw").outputs, [{ name: "password", type: "text", value: stripped }]);
  assert.deepEqual(library.readRun("raw").outputs, outputs);
  assert.equal((library.readRun("raw").steps[0] as { value: string }).value, secret);
  const report: WorkflowOutcome = {
    outcome: "ok", workflowId: "outbound", runId: "report", link: "bao://workflow/outbound", stops: [],
    receipts: [{ id: "password", status: "passed", readBack: secret }], outputs,
  };
  mkdirSync(path.join(root, "reports"), { recursive: true });
  const file = path.join(root, "reports", "report.json");
  writeFileSync(file, JSON.stringify(report));
  assert.equal(getRun(library, "report").receipts[0]?.readBack, stripped);
  assert.deepEqual(getRun(library, "report").outputs, [{ name: "password", type: "text", value: stripped }]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), report);
});

for (const damage of ["missing", "invalid JSON", "invalid structure", "unreadable file"] as const) {
  test(`public run lookups remain readable and scrubbed when their workflow has ${damage}`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bao-outbound-damaged-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const library = new Library(root);
    const workflowFile = path.join(root, "workflows", "outbound.json");
    if (damage === "invalid JSON") writeFileSync(workflowFile, "{");
    if (damage === "invalid structure") writeFileSync(workflowFile, JSON.stringify({ schema: "bao.workflow/v4" }));
    if (damage === "unreadable file") mkdirSync(workflowFile);
    const outputs = [
      { name: "token", type: "text" as const, value: "sk-damagedWorkflowToken" },
      { name: "card", type: "text" as const, value: "4111111111111111" },
      { name: "note", type: "text" as const, value: "Keep this note" },
    ];
    library.saveRun({
      id: "raw", workflowId: "outbound", status: "passed", at: 1, heals: [],
      steps: [{ id: "entry", status: "passed" }], outputs,
    });
    const raw = library.readRun("raw");
    const report: WorkflowOutcome = {
      outcome: "ok", workflowId: "outbound", runId: "report", link: "bao://workflow/outbound", stops: [],
      receipts: [{ id: "entry", status: "passed", readBack: "sk-damagedWorkflowToken" }], outputs,
    };
    mkdirSync(path.join(root, "reports"), { recursive: true });
    const reportFile = path.join(root, "reports", "report.json");
    writeFileSync(reportFile, JSON.stringify(report));
    const reportBytes = readFileSync(reportFile, "utf8");
    const expected = [
      { name: "token", type: "text", value: stripped },
      { name: "card", type: "text", value: stripped },
      { name: "note", type: "text", value: "Keep this note" },
    ];
    for (const id of ["raw", "report"]) {
      const found = getRun(library, id);
      assert.equal(found.runId, id);
      assert.equal(found.outcome, "ok");
      assert.deepEqual(found.outputs, expected);
    }
    assert.equal(getRun(library, "report").receipts[0]?.readBack, stripped);
    assert.deepEqual(library.readRun("raw"), raw);
    assert.equal(readFileSync(reportFile, "utf8"), reportBytes);
  });
}

test("MCP replay scrubs its public receipt and report but retains raw local run inputs", { timeout: scaledMs(60_000) }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-outbound-replay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><input data-testid="password" aria-label="Password">');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const library = new Library(root);
    const doc = workflow();
    doc.startUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    library.save(doc);
    const outcome = await runWorkflow(library, { id: doc.id });
    assert.equal(outcome.outcome, "ok", outcome.reason);
    assert.equal(outcome.receipts[0]?.readBack, stripped);
    assert.equal(library.readRun(outcome.runId!).inputs?.password, secret);
    assert.equal(library.read(doc.id).inputs[0]?.default, secret);
    const report = JSON.parse(readFileSync(path.join(root, "reports", `${outcome.runId}.json`), "utf8")) as WorkflowOutcome;
    assert.equal(report.receipts[0]?.readBack, stripped);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
