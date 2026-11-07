import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getRun, runWorkflow, type WorkflowOutcome } from "../../src/mcp/catalog";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { buildPushBody as desktopPush, stripUnsafe as desktopStrip } from "../../src/v1/sync-guard";
import { buildPushBody as webPush, stripUnsafe as webStrip } from "../../../web/src/lib/guard";
import { applyImportAnswers, applyRegistryImportAnswers } from "../../../web/src/lib/import-sheet";
import { redactForRelease } from "../../../web/src/lib/publish";

const secret = "fixture-outbound-password";
const stripped = "[secret stripped]";

function workflow(): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id: "outbound", name: "Outbound", createdAt: 1,
    startUrl: "https://example.test/",
    inputs: [{ name: "password", type: "secret", label: "Password", default: secret }],
    steps: [{
      id: "password", index: 0, action: "type", label: "Password", surface: "dom", timeoutMs: 5000,
      input: "password", value: "{{password}}",
      identity: { surface: "dom", role: "textbox", testId: "password", path: [] },
      postcondition: { kind: "value", match: "{{password}}", timeoutMs: 5000 },
    }],
  };
}

for (const [name, strip, push] of [["desktop", desktopStrip, desktopPush], ["web", webStrip, webPush]] as const) {
  test(`${name} outbound guard scrubs whole user values without rewriting metadata or local input`, () => {
    const doc = workflow();
    doc.steps.push({
      id: "copy", index: 1, action: "type", label: secret, surface: "dom", timeoutMs: 0, value: secret,
    });
    doc.steps.push({
      id: "card", index: 2, action: "type", label: "Card", surface: "dom", timeoutMs: 0, value: "4111111111111111",
    });
    doc.steps.push({
      id: "prose", index: 3, action: "type", label: "Prose", surface: "dom", timeoutMs: 0, value: `prefix ${secret} suffix`,
    });
    const original = structuredClone(doc);
    const cleaned = strip(doc, [secret]) as WorkflowV2;
    assert.equal(cleaned.inputs[0]?.default, undefined);
    assert.equal(cleaned.steps[0]?.value, "{{password}}");
    assert.equal(cleaned.steps[1]?.value, stripped);
    assert.equal(cleaned.steps[1]?.label, secret);
    assert.equal(cleaned.steps[2]?.value, stripped);
    assert.equal(cleaned.steps[3]?.value, `prefix ${secret} suffix`);
    assert.throws(() => push(doc, { baseVersion: 0 }), /secret param/);
    const pushDoc = structuredClone(doc);
    pushDoc.steps[1]!.label = "Copy";
    pushDoc.steps.pop();
    const pushed = push(pushDoc, { baseVersion: 0 }).document as WorkflowV2;
    assert.equal(pushed.steps[1]?.value, stripped);
    assert.equal(pushed.steps[2]?.value, stripped);
    assert.deepEqual(doc, original);
  });
}

test("publishing scrubs copied secret and token values without changing the local document", () => {
  const doc = workflow();
  doc.steps.push({ id: "copy", index: 1, action: "type", label: "Copy", surface: "dom", timeoutMs: 0, value: secret });
  doc.steps.push({ id: "token", index: 2, action: "type", label: "Token", surface: "dom", timeoutMs: 0, value: "sk-outboundFixtureToken" });
  const original = structuredClone(doc);
  const released = redactForRelease(doc).document as WorkflowV2;
  assert.equal(released.inputs[0]?.default, undefined);
  assert.equal(released.steps[1]?.value, stripped);
  assert.equal(released.steps[2]?.value, stripped);
  assert.deepEqual(doc, original);
});

test("registry import answers omit personal defaults while desktop import answers stay local", () => {
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
  for (const name of ["password", "email", "path", "phone", "ssn"]) {
    assert.equal(local.inputs.find((input) => input.name === name)?.default, answers[name as keyof typeof answers]);
    assert.equal(cloud.inputs.find((input) => input.name === name)?.default, undefined);
  }
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

test("MCP replay scrubs its public receipt and report but retains raw local run inputs", { timeout: 60_000 }, async (t) => {
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
