import { projectStep } from "../../src/v1/schema";
import { fixtureDoc, fixtureInput, fixtureStep, withStep } from "../support/fixture-step";
import assert from "node:assert/strict";
import fs, { fstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import Ajv from "ajv";
import { inspectRunView, listRunViews, openStepPictures, VIEW_PICTURE_BYTES, VIEW_RECORD_BYTES } from "../../src/mcp/run-view";
import { callViewerTool, VIEWER_TOOLS } from "../../src/mcp/viewer-tools";
import { shotFile } from "../../src/v1/shots";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library, type StoredRun } from "../../src/v1/store";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "bao-run-view-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = new Library(path.join(root, "library"));
  const workflow: WorkflowV2 = fixtureDoc({
    schema: "bao.workflow/v4", version: 2, id: "fixture", name: "Preview report", startUrl: "https://example.test/", createdAt: 1,
    inputs: [fixtureInput({ name: "password", type: "secret" }), fixtureInput({ name: "attachment", type: "file" })],
    steps: [fixtureStep({ id: "preview", index: 0, action: "click", label: "Preview report", surface: "dom", identity: { surface: "dom", role: "button", name: "Preview", path: [] }, timeoutMs: 1000 })],
  });
  const reason = "The report needs review: private-value";
  const run: StoredRun = {
    id: "run-fixture", workflowId: workflow.id, at: 1_700_000_001_000, videoStartedAt: 1_700_000_000_000, status: "paused",
    steps: [{ id: "preview", status: "paused", startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_100, reason, readBack: "private-value", snapshot: { ax: "raw snapshot" } }],
    receipts: [{ kind: "read-back", ts: 1, runId: "run-fixture", workflowId: workflow.id, stepId: "preview", source: "text", expected: "private-value", actual: "private-value", pass: true }],
    failure: { stepId: "preview", reason },
    envelope: { status: "needs_human", step: "preview", reason, ask: "Review private-value", deadline: "2030-01-01", resume_token: "resume-fixture" },
    heals: [],
  };
  library.save(workflow);
  library.saveRun(run);
  const shots = path.join(library.root, "shots", "runs", run.id);
  mkdirSync(shots, { recursive: true });
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  for (const phase of ["before", "after"]) writeFileSync(path.join(shots, `preview-${phase}.png`), png);
  return { root, library, workflow, run, shots, png, reason };
}

function assertEvidence(library: Library, run: StoredRun, reason: string): void {
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.reason, reason);
  assert.equal(detail.steps[0]?.reason, reason);
  assert.equal(detail.steps[0]?.result, "Read back text: expected private-value, saw private-value. matches.");
  assert.equal(detail.steps[0]?.picturesAllowed, true);
  assert.equal(detail.handoff?.ask, "Review private-value");
  assert.equal(detail.handoff?.reason, reason);
  assert.equal(detail.steps[0]?.durationMs, 100);
  assert.equal(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures.length, 2);
  const reply = callViewerTool(library, "inspect_run", { run_id: run.id });
  assert.deepEqual(reply._meta.baoViewer, detail);
  assert.deepEqual(JSON.parse(reply.content[0]!.text), JSON.parse(JSON.stringify(detail)));
}

test("history and receipt read Library data without inventing model counts", (t) => {
  const { library, run, reason } = fixture(t);
  assertEvidence(library, run, reason);
  assert.equal(listRunViews(library, {}).runs[0]?.name, "Preview report");
  assert.equal(inspectRunView(library, { run_id: run.id }).run.modelCalls, null);
  library.saveRun({ ...run, modelCalls: 0 });
  assert.equal(inspectRunView(library, { run_id: run.id }).run.modelCalls, 0);
  library.saveRun({ ...run, modelCalls: -1 });
  assert.equal(listRunViews(library, {}).runs[0]?.modelCalls, null);
});

test("secret, file, sensitive, nested, and unknown bindings do not hide stored evidence", (t) => {
  const { library, workflow, run, reason } = fixture(t);
  for (const patch of [
    { sensitive: true }, { input: "password" }, { input: "attachment" },
    { readBack: { source: "text" as const, match: "{{password}}", timeoutMs: 0 } },
    { expect: { kind: "text" as const, match: "{{missing}}", timeoutMs: 0 } },
    { identity: { ...projectStep(workflow.steps[0]!).identity!, inputType: "password", autocomplete: "current-password" } },
  ]) {
    library.save(fixtureDoc({ ...workflow, steps: [{ ...workflow.steps[0]!, ...patch }] }));
    assertEvidence(library, run, reason);
  }
  library.save({ ...workflow, readBack: { source: "text", match: "{{password}}", timeoutMs: 0 } });
  assertEvidence(library, run, reason);
  library.save(fixtureDoc({ ...workflow, version: 3, inputs: [...workflow.inputs, fixtureInput({ name: "rows", type: "table" })], steps: [fixtureStep({
    ...workflow.steps[0]!, action: "for_each", forEach: { over: { kind: "input", name: "rows" }, steps: [{ ...workflow.steps[0]!, id: "nested", sensitive: true }] },
  })] }));
  assertEvidence(library, run, reason);
});

test("workflow edits, missing definitions, and missing timing never hide historical evidence", (t) => {
  const { library, workflow, run, reason } = fixture(t);
  const file = path.join(library.root, "workflows", `${workflow.id}.json`);
  for (const modified of [0, run.videoStartedAt!, run.at + 500]) {
    utimesSync(file, modified / 1000, modified / 1000);
    assertEvidence(library, run, reason);
  }
  library.save(fixtureDoc({ ...workflow, steps: [] }));
  assertEvidence(library, run, reason);
  library.saveRun({ ...run, videoStartedAt: undefined });
  assertEvidence(library, run, reason);
  writeFileSync(file, "not JSON");
  assertEvidence(library, run, reason);
  assert.equal(inspectRunView(library, { run_id: run.id }).workflow, null);
  rmSync(file);
  assertEvidence(library, run, reason);
});

test("viewer does not scrub a stored read-back against today's workflow", (t) => {
  const { library, workflow, run } = fixture(t);
  library.save(fixtureDoc({ ...workflow, inputs: [fixtureInput({ name: "password", type: "secret" })], steps: [withStep(workflow.steps[0]!, { input: "password" })] }));
  writeFileSync(path.join(library.root, "runs", `${run.id}.json`), JSON.stringify({ ...run, receipts: [], inputs: { password: "stored-password" }, steps: [{ id: "preview", status: "passed", readBack: "stored-password" }] }));
  assert.equal(inspectRunView(library, { run_id: run.id }).steps[0]?.result, "stored-password");
});

test("workflow snapshots bind parsed contents to the checked file time", (t) => {
  const { library, workflow } = fixture(t);
  const file = path.join(library.root, "workflows", `${workflow.id}.json`);
  utimesSync(file, 1000, 1000);
  const snapshot = library.readWorkflowSnapshot(workflow.id, { maxBytes: VIEW_RECORD_BYTES });
  assert.equal(snapshot.modifiedAtMs, 1_000_000);
  assert.equal(snapshot.workflow.name, "Preview report");
  assert.equal((snapshot.workflow.steps[0] == null ? undefined : projectStep(snapshot.workflow.steps[0]).label), "Preview report");
});

test("workflow snapshot reads reject a replacement between the read and final check", (t) => {
  const { library, workflow } = fixture(t);
  const file = path.join(library.root, "workflows", `${workflow.id}.json`);
  const replacement = path.join(library.root, "replacement.json");
  writeFileSync(replacement, JSON.stringify({ ...workflow, name: "New snapshot" }));
  const inode = statSync(file).ino;
  const read = fs.readSync;
  let swapped = false;
  const hook = mock.method(fs, "readSync", (...args: unknown[]) => {
    const size = Reflect.apply(read, fs, args) as number;
    if (!swapped && fstatSync(args[0] as number).ino === inode) {
      swapped = true;
      renameSync(replacement, file);
    }
    return size;
  });
  t.after(() => hook.mock.restore());
  assert.throws(() => library.readWorkflowSnapshot(workflow.id, { maxBytes: VIEW_RECORD_BYTES }), /changed during read/);
  assert.equal(swapped, true);
});

test("viewer text preserves slash separators, web paths, and local paths", (t) => {
  const { library, run, workflow } = fixture(t);
  for (const value of ["Invoice / March", "/orders/1042", "Home / Orders / 1042", "ENOENT open '/Users/O'Brien/secret.txt'", "C:\\Users\\Owner Name\\report.csv", "https://example.test/export-/report.csv"]) {
    library.save(fixtureDoc({ ...workflow, name: value, steps: [withStep(workflow.steps[0]!, { label: value })] }));
    library.saveRun({ ...run, receipts: [], steps: [{ id: "preview", status: "failed", reason: value, readBack: value }], failure: { reason: value }, envelope: { status: "failed", reason: value, ask: value } });
    const detail = inspectRunView(library, { run_id: run.id });
    assert.equal(detail.run.name, value);
    assert.equal(detail.steps[0]?.label, value);
    assert.equal(detail.steps[0]?.reason, value);
    assert.equal(detail.steps[0]?.result, value);
    assert.equal(detail.reason, value);
    assert.equal(detail.handoff?.ask, value);
    assert.equal(listRunViews(library, {}).runs[0]?.name, value);
  }
});

test("receipt projects every read-back with its outcome or uses the recorded step read-back", (t) => {
  const { library, run } = fixture(t);
  library.saveRun({ ...run, receipts: [
    { stepId: "preview", source: "text", expected: "Ready", actual: "Ready", pass: true },
    { stepId: "preview", source: "text", expected: "Done", actual: "Pending", pass: false },
    { stepId: "other", source: "text", expected: "Unrelated", actual: "Unrelated", pass: true },
  ] });
  assert.equal(inspectRunView(library, { run_id: run.id }).steps[0]?.result, "Read back text: expected Ready, saw Ready. matches.\nRead back text: expected Done, saw Pending. does not match.");
  library.saveRun({ ...run, receipts: [] });
  assert.equal(inspectRunView(library, { run_id: run.id }).steps[0]?.result, "private-value");
});

test("failure and stopped-step reasons remain available without an envelope or workflow", (t) => {
  const { library, run, reason } = fixture(t);
  for (const source of ["failure", "step"]) {
    library.saveRun({ ...run, workflowId: "missing", envelope: undefined, failure: source === "failure" ? { reason } : undefined,
      steps: [{ id: "unknown", status: "failed", reason: source === "step" ? reason : undefined }] });
    assert.equal(inspectRunView(library, { run_id: run.id }).reason, reason);
  }
});

test("capture runs open recorded pictures without a saved workflow", (t) => {
  const { library, run, shots, png } = fixture(t);
  writeFileSync(path.join(shots, "0-after.png"), png);
  library.saveRun({ ...run, kind: "capture", workflowId: "agent-browser", receipts: [], steps: [{ id: "command-1", status: "passed", reason: "Filled the field", afterShot: "0-after.png", native: { command: "fill", args: ["@e1", "value"], results: [{ stdout: "Done" }] } }] });
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.run.name, "Browser capture");
  assert.equal(detail.run.modelCalls, null);
  assert.equal(detail.steps[0]?.label, "fill");
  assert.equal(detail.steps[0]?.reason, "Filled the field");
  assert.equal(detail.steps[0]?.picturesAllowed, true);
  assert.equal(detail.workflow, null);
  assert.equal(openStepPictures(library, { run_id: run.id, step_id: "command-1" }).pictures.length, 1);
});

test("history, run steps, and workflow steps page independently with bounded text", (t) => {
  const { library, run, workflow } = fixture(t);
  const steps = Array.from({ length: 43 }, (_, index) => (withStep(workflow.steps[0]!, { id: `step-${index}`, index, label: "x".repeat(1000) })));
  library.save(fixtureDoc({ ...workflow, steps }));
  library.saveRun({ ...run, steps: steps.map((step) => ({ id: step.id, status: "passed", reason: "y".repeat(10_000) })) });
  for (let index = 0; index < 11; index++) library.saveRun({ ...run, id: `run-page-${index}` });
  let next: number | null = 0;
  const ids: string[] = [];
  while (next !== null) {
    const page = listRunViews(library, { offset: next });
    assert.ok(page.runs.length <= 5);
    ids.push(...page.runs.map((item) => item.id)); next = page.nextOffset;
  }
  assert.equal(new Set(ids).size, 12);
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.steps.length, 20);
  assert.equal(detail.steps[0]?.label?.length, 160);
  assert.equal(detail.steps[0]?.reason?.length, 500);
  assert.equal(detail.nextStepOffset, 20);
  const last = inspectRunView(library, { run_id: run.id, step_offset: 40, workflow_offset: 20 });
  assert.equal(last.steps.length, 3);
  assert.equal(last.nextStepOffset, null);
  assert.equal(last.workflow?.steps.length, 20);
  assert.equal(last.workflow?.nextOffset, 40);
});

test("viewer validates record IDs and page offsets before deriving paths", (t) => {
  const { library, run } = fixture(t);
  for (const id of ["", ".", "../run-fixture", "/tmp/run", "x/y", "x\\y", "..", "x..y", "x\u0000y", "a".repeat(129), 123, null]) {
    assert.throws(() => inspectRunView(library, { run_id: id }), /Invalid viewer id/);
    assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: id }), /Invalid viewer id/);
  }
  for (const offset of [-1, 0.5, "1", Infinity, 1_000_001, null]) {
    assert.throws(() => listRunViews(library, { offset }), /Invalid viewer page/);
    assert.throws(() => inspectRunView(library, { run_id: run.id, step_offset: offset }), /Invalid viewer page/);
  }
});

test("stored dotted and other supported Library IDs work across history, tools, and pictures", (t) => {
  const { library, run, workflow, shots, png } = fixture(t);
  const ajv = new Ajv();
  const inspectSchema = ajv.compile(VIEWER_TOOLS.find((tool) => tool.name === "inspect_run")!.inputSchema);
  const pictureSchema = ajv.compile(VIEWER_TOOLS.find((tool) => tool.name === "open_step_pictures")!.inputSchema);
  for (const id of ["wf-my.flow", "saved report", "%2e%2e"]) {
    const stepId = `${id}-step.1`;
    library.save(fixtureDoc({ ...workflow, id, steps: [{ ...workflow.steps[0]!, id: stepId }] }));
    library.saveRun({ ...run, workflowId: id, steps: [{ id: stepId, status: "passed" }] });
    writeFileSync(path.join(shots, shotFile(stepId, "after")), png);
    assert.equal(inspectSchema({ run_id: run.id }), true);
    assert.equal(pictureSchema({ run_id: run.id, step_id: stepId }), true);
    assert.ok(listRunViews(library, {}).runs.some((item) => item.workflowId === id && item.name === workflow.name));
    const detail = inspectRunView(library, { run_id: run.id });
    assert.equal(detail.workflow?.id, id);
    assert.equal(detail.steps[0]?.label, "Preview report");
    assert.equal(openStepPictures(library, { run_id: run.id, step_id: stepId }).pictures.length, 1);
  }
});

test("oversized run records are skipped without ending history pagination", (t) => {
  const { library, run } = fixture(t);
  truncateSync(path.join(library.root, "runs", `${run.id}.json`), VIEW_RECORD_BYTES + 1);
  assert.throws(() => inspectRunView(library, { run_id: run.id }), /too large/);
  assert.equal(listRunViews(library, {}).skipped, 1);
});

test("unreadable workflow links do not hide run evidence while linked run and image reads stay invalid", (t) => {
  const { root, library, run, workflow, shots, png, reason } = fixture(t);
  const outside = path.join(root, "outside.json"); writeFileSync(outside, JSON.stringify(run));
  const runFile = path.join(library.root, "runs", `${run.id}.json`); rmSync(runFile); symlinkSync(outside, runFile);
  assert.throws(() => inspectRunView(library, { run_id: run.id }), /links/);
  assert.equal(listRunViews(library, {}).runs.length, 0);
  rmSync(runFile); library.saveRun(run);
  const workflowFile = path.join(library.root, "workflows", `${workflow.id}.json`); rmSync(workflowFile); symlinkSync(outside, workflowFile);
  assert.equal(inspectRunView(library, { run_id: run.id }).workflow, null);
  assertEvidence(library, run, reason);
  const image = path.join(root, "outside.png"); writeFileSync(image, png);
  for (const phase of ["before", "after"]) { const file = path.join(shots, `preview-${phase}.png`); rmSync(file); symlinkSync(image, file); }
  assert.deepEqual(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures, []);
  rmSync(shots, { recursive: true }); symlinkSync(root, shots);
  assert.deepEqual(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures, []);
});

test("pictures honor stored filenames, format and size bounds, and recorded step membership", (t) => {
  const { library, run, shots, png } = fixture(t);
  const reply = callViewerTool(library, "open_step_pictures", { run_id: run.id, step_id: "preview" });
  assert.equal(reply._meta.baoPictures?.pictures.length, 2);
  assert.match(reply.content[0]!.text, /host app/);
  assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "not-recorded" }), /Step not found/);
  for (const phase of ["before", "after"]) rmSync(path.join(shots, `preview-${phase}.png`));
  writeFileSync(path.join(shots, "0-before.png"), png);
  writeFileSync(path.join(shots, "0-after.png"), png);
  library.saveRun({ ...run, steps: [{ id: "preview", status: "passed", beforeShot: "0-before.png", afterShot: "0-after.png" }] });
  assert.equal(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures.length, 2);
  truncateSync(path.join(shots, "0-before.png"), VIEW_PICTURE_BYTES + 1);
  writeFileSync(path.join(shots, "0-after.png"), "not an image");
  assert.deepEqual(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures, []);
  for (const name of ["../0-after.png", "nested/0-after.png", "nested\\0-after.png", ".", "..", ""]) {
    library.saveRun({ ...run, steps: [{ id: "preview", status: "passed", beforeShot: name, afterShot: name }] });
    assert.deepEqual(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures, []);
  }
  writeFileSync(path.join(shots, "preview-after.png"), png);
  assert.equal(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures.length, 1);
});
