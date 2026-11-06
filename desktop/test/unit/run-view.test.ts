import assert from "node:assert/strict";
import fs, { fstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import Ajv from "ajv";
import { inspectRunView, listRunViews, openStepPictures, VIEW_PICTURE_BYTES, VIEW_RECORD_BYTES } from "../../src/mcp/run-view";
import { callViewerTool, VIEWER_TOOLS } from "../../src/mcp/viewer-tools";
import { ReceiptLog } from "../../src/v1/receipt";
import { getRun } from "../../src/mcp/catalog";
import { shotFile } from "../../src/v1/shots";
import { composeV3Schema, downloadFileName, renderTemplate } from "../../src/v1/files-dates";
import { usesFilesDates } from "../../src/v1/files-dates-check";
import { expectedText } from "../../src/v1/replay";
import { validateWorkflow } from "../../src/v1/schema";
import type { WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { Library, type StoredRun } from "../../src/v1/store";

const RUN_START = 1_700_000_000_000;
const WORKFLOW_TIME = RUN_START - 10_000;

function saveWorkflow(library: Library, workflow: WorkflowV2): void {
  library.save(workflow);
  utimesSync(path.join(library.root, "workflows", `${workflow.id}.json`), WORKFLOW_TIME / 1000, WORKFLOW_TIME / 1000);
}

function saveRun(library: Library, run: StoredRun): void {
  library.saveRun({ ...run, steps: run.steps.map((step) => ({ startedAt: RUN_START, ...step as object })) });
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "bao-run-view-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = new Library(path.join(root, "library"));
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2", version: 2, id: "fixture", name: "Preview report", startUrl: "https://example.test/", createdAt: 1,
    inputs: [{ name: "password", type: "secret" }],
    steps: [{ id: "preview", index: 0, action: "click", label: "Preview report", surface: "dom", identity: { surface: "dom", role: "button", name: "Preview", path: [] }, timeoutMs: 1000 }],
  };
  const receipts = new ReceiptLog();
  receipts.append({ kind: "read-back", ts: 1, runId: "run-fixture", workflowId: workflow.id, stepId: "preview", source: "text", expected: "Preview ready", actual: "Preview ready", pass: true });
  const run: StoredRun = { id: "run-fixture", workflowId: workflow.id, at: RUN_START + 1000, videoStartedAt: RUN_START, status: "passed", steps: [{ id: "preview", status: "passed", startedAt: RUN_START, endedAt: RUN_START + 100, snapshot: { ax: "raw private snapshot" }, beforeShot: "/private/raw.png" }], receipts: receipts.entries, heals: [] };
  saveWorkflow(library, workflow); saveRun(library, run);
  const shots = path.join(library.root, "shots", "runs", run.id); mkdirSync(shots, { recursive: true });
  const png = Buffer.alloc(32); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  for (const phase of ["before", "after"]) writeFileSync(path.join(shots, `preview-${phase}.png`), png);
  return { root, library, run, workflow, shots, png };
}

test("history and receipt share Library data, keep unknown model counts, and exclude raw records", (t) => {
  const { library, run } = fixture(t);
  const history = listRunViews(library, {});
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0]?.name, "Preview report");
  assert.equal(history.runs[0]?.modelCalls, null);
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.run.modelCalls, null);
  assert.equal(detail.steps[0]?.result, "Read back text: expected Preview ready, saw Preview ready. matches.");
  assert.equal(detail.workflow?.steps[0]?.label, "Preview report");
  assert.equal(detail.steps[0]?.picturesAllowed, true);
  assert.doesNotMatch(JSON.stringify(detail), /raw private|private\/raw|base64|png|resume_token/);
  saveRun(library, { ...run, modelCalls: 0 });
  assert.equal(inspectRunView(library, { run_id: run.id }).run.modelCalls, 0);
  saveRun(library, { ...run, modelCalls: -1 });
  assert.equal(listRunViews(library, {}).runs[0]?.modelCalls, null);
});

test("receipt projects every persisted read-back with its expected value and outcome", (t) => {
  const { library, run } = fixture(t);
  const receipts = new ReceiptLog();
  for (const body of [
    { expected: "Status: none", actual: "Status: none", pass: true },
    { expected: "Workflow done", actual: "Workflow pending", pass: false },
  ]) receipts.append({ kind: "read-back", ts: 2, runId: run.id, workflowId: run.workflowId, stepId: "preview", source: "text", ...body });
  receipts.append({ kind: "read-back", ts: 3, runId: run.id, workflowId: run.workflowId, stepId: "another-step", source: "text", expected: "unrelated", actual: "unrelated", pass: true });
  saveRun(library, { ...run, receipts: receipts.entries });
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.steps[0]?.result, "Read back text: expected Status: none, saw Status: none. matches.\nRead back text: expected Workflow done, saw Workflow pending. does not match.");
  saveRun(library, { ...run, receipts: [], steps: [{ id: "preview", status: "passed", readBack: "Preview ready" }] });
  assert.equal(inspectRunView(library, { run_id: run.id }).steps[0]?.result, "Preview ready");
});

test("sealed read-backs bound to secrets never leave the shared privacy boundary", (t) => {
  const { library, run, workflow } = fixture(t);
  const receipts = new ReceiptLog();
  receipts.append({ kind: "read-back", ts: 1, runId: run.id, workflowId: workflow.id, stepId: "preview", source: "text", expected: "private-value", actual: "private-value", pass: true });
  saveRun(library, { ...run, receipts: receipts.entries });
  for (const scope of ["step", "workflow"]) {
    const readBack = { source: "text" as const, match: "{{password}}", timeoutMs: 1000 };
    saveWorkflow(library, scope === "step" ? { ...workflow, steps: [{ ...workflow.steps[0]!, readBack }] } : { ...workflow, readBack });
    const detail = inspectRunView(library, { run_id: run.id });
    assert.equal(detail.steps[0]?.picturesAllowed, false);
    assert.doesNotMatch(JSON.stringify(detail), /private-value|password/);
    assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  }
});

test("private failed read-backs withhold every viewer reason but preserve get_run text", (t) => {
  const { library, run, workflow } = fixture(t);
  const reason = 'read-back expected "private-value", read "page private-value text"';
  for (const scope of ["step", "workflow"]) {
    const readBack = { source: "text" as const, match: "{{password}}", timeoutMs: 1000 };
    saveWorkflow(library, scope === "step" ? { ...workflow, steps: [{ ...workflow.steps[0]!, readBack }] } : { ...workflow, readBack });
    for (const source of ["failure", "step", "envelope"]) {
      saveRun(library, {
        ...run, status: "failed", receipts: [],
        failure: source === "failure" ? { stepId: "preview", reason } : undefined,
        steps: [{ id: "preview", status: "failed", reason: source === "step" ? reason : undefined }],
        envelope: source === "envelope" ? { status: "failed", step: "preview", reason, ask: reason } : undefined,
      });
      const detail = inspectRunView(library, { run_id: run.id });
      assert.equal(detail.reason, undefined);
      assert.doesNotMatch(JSON.stringify(detail), /private-value/);
      assert.equal(detail.steps[0]?.picturesAllowed, false);
      assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
      assert.equal(getRun(library, run.id).reason, reason);
    }
  }
});

test("workflow edits cannot make historical secret read-back steps public", (t) => {
  const { library, run, workflow } = fixture(t);
  const readBack = { source: "text" as const, match: "{{password}}", timeoutMs: 1000 };
  saveWorkflow(library, { ...workflow, readBack, steps: [...workflow.steps, { ...workflow.steps[0]!, id: "later", index: 1 }] });
  for (const source of ["receipt", "failure", "step"]) {
    const receipts = new ReceiptLog();
    if (source === "receipt") receipts.append({ kind: "read-back", ts: 1, runId: run.id, workflowId: workflow.id, stepId: "preview", source: "text", expected: "private-value", actual: "page private-value text", pass: true });
    saveRun(library, { ...run, receipts: receipts.entries, failure: source === "failure" ? { stepId: "preview", reason: "page private-value text" } : undefined,
      steps: source === "step" ? [{ id: "preview", status: "failed", reason: "page private-value text" }] : run.steps });
    const detail = inspectRunView(library, { run_id: run.id });
    assert.equal(detail.steps[0]?.picturesAllowed, false);
    assert.doesNotMatch(JSON.stringify(detail), /private-value/);
    assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  }
});

test("nested secret read-backs keep their parent reasons and pictures private", (t) => {
  const { library, run, workflow } = fixture(t);
  const nested: WorkflowStep = { ...workflow.steps[0]!, id: "nested", readBack: { source: "text", match: "{{password}}", timeoutMs: 0 } };
  saveWorkflow(library, { ...workflow, version: 3, inputs: [...workflow.inputs, { name: "rows", type: "table" }], steps: [{ ...workflow.steps[0]!, action: "for_each", forEach: { over: { kind: "input", name: "rows" }, steps: [nested] } }] });
  const reason = 'read-back expected "private-value", read "page private-value text"';
  saveRun(library, { ...run, status: "failed", failure: { stepId: "preview", reason }, steps: [{ id: "preview", status: "failed", reason }], envelope: { status: "failed", step: "preview", reason, ask: reason } });
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.detailsHidden, undefined);
  assert.doesNotMatch(JSON.stringify(detail), /private-value/);
  assert.equal(detail.steps[0]?.picturesAllowed, false);
  assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  assert.equal(getRun(library, run.id).reason, reason);
});

test("secret expect bindings keep step, summary, and handoff evidence private", (t) => {
  const { library, run, workflow } = fixture(t);
  saveWorkflow(library, { ...workflow, steps: [{ ...workflow.steps[0]!, expect: { kind: "text", match: "{{password}}", timeoutMs: 0 } }] });
  const reason = "expected private-value";
  saveRun(library, { ...run, status: "failed", failure: { stepId: "preview", reason }, steps: [{ id: "preview", status: "failed", reason }], envelope: { status: "failed", step: "preview", reason, ask: reason } });
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.detailsHidden, undefined);
  assert.doesNotMatch(JSON.stringify(detail), /private-value/);
  assert.equal(detail.steps[0]?.picturesAllowed, false);
  assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  assert.equal(getRun(library, run.id).reason, reason);
});

test("secret row discovery and classification cover the same binding fields", (t) => {
  const { library, run, workflow } = fixture(t);
  const patches: Partial<WorkflowStep>[] = [
    { value: "{{row.password}}" },
    { readBack: { source: "text", match: "{{row.password}}", timeoutMs: 0 } },
    { expect: { kind: "text", match: "{{row.password}}", timeoutMs: 0 } },
    { postcondition: { kind: "text", match: "{{row.password}}", timeoutMs: 0 } },
  ];
  for (const source of patches) {
    const entry: WorkflowStep = { ...workflow.steps[0]!, id: "entry", sensitive: true, ...source };
    const secretLoop: WorkflowStep = { ...workflow.steps[0]!, id: "secret-loop", action: "for_each", forEach: { over: { kind: "input", name: "rows" }, steps: [entry] } };
    for (const sink of patches) {
      const child: WorkflowStep = { ...workflow.steps[0]!, id: "check", ...sink };
      saveWorkflow(library, { ...workflow, version: 3, inputs: [...workflow.inputs, { name: "rows", type: "table" }], steps: [secretLoop, { ...workflow.steps[0]!, index: 1, action: "for_each", forEach: { over: { kind: "input", name: "rows" }, steps: [child] } }] });
      const reason = "expected private-row-value";
      saveRun(library, { ...run, status: "failed", receipts: [], failure: { stepId: "preview", reason }, steps: [{ id: "preview", status: "failed", reason }], envelope: { status: "failed", step: "preview", reason, ask: reason } });
      const detail = inspectRunView(library, { run_id: run.id });
      assert.equal(detail.detailsHidden, undefined);
      assert.doesNotMatch(JSON.stringify(detail), /private-row-value/);
      assert.equal(detail.steps[0]?.picturesAllowed, false);
      assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
      assert.equal(getRun(library, run.id).reason, reason);
    }
    const publicChild: WorkflowStep = { ...workflow.steps[0]!, id: "check", expect: { kind: "text", match: "{{row.public}}", timeoutMs: 0 } };
    saveWorkflow(library, { ...workflow, version: 3, inputs: [...workflow.inputs, { name: "rows", type: "table" }], steps: [secretLoop, { ...workflow.steps[0]!, index: 1, action: "for_each", forEach: { over: { kind: "input", name: "rows" }, steps: [publicChild] } }] });
    saveRun(library, run);
    assert.equal(inspectRunView(library, { run_id: run.id }).steps[0]?.picturesAllowed, true);
    assert.equal(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures.length, 2);
  }
});

test("schema string fields rendered with secrets cannot export evidence", (t) => {
  const { library, run, workflow } = fixture(t);
  type Schema = { $ref?: string; type?: string; const?: unknown; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema; oneOf?: Schema[] };
  const schema = composeV3Schema() as unknown as { $defs: Record<string, Schema> };
  const resolve = (node: Schema): Schema => node.$ref ? schema.$defs[node.$ref.split("/").at(-1)!]! : node;
  const seed = (raw: Schema): unknown => {
    const node = resolve(raw);
    if (node.const !== undefined) return node.const;
    if (node.enum) return node.enum[0];
    if (node.oneOf) return seed(node.oneOf[0]!);
    if (node.type === "array") return [];
    if (node.properties) return Object.fromEntries((node.required || []).map((key) => [key, seed(node.properties![key]!)]));
    if (node.type === "number" || node.type === "integer") return 0;
    if (node.type === "boolean") return false;
    return "public";
  };
  function* variants(raw: Schema, template: string, seen = new Set(["#/$defs/step"])): Generator<{ path: string; value: unknown }> {
    if (raw.$ref && seen.has(raw.$ref)) return;
    const next = new Set(seen);
    if (raw.$ref) next.add(raw.$ref);
    const node = resolve(raw);
    if (node.const !== undefined || node.enum) return;
    if (node.oneOf) {
      for (const option of node.oneOf) yield* variants(option, template, next);
    } else if (node.type === "string") {
      yield { path: "", value: template };
    } else if (node.items) {
      for (const child of variants(node.items, template, next)) yield { path: `0${child.path ? `.${child.path}` : ""}`, value: [child.value] };
    } else if (node.properties) {
      for (const [key, property] of Object.entries(node.properties)) {
        for (const child of variants(property, template, next)) yield {
          path: `${key}${child.path ? `.${child.path}` : ""}`,
          value: { ...seed(node) as object, [key]: child.value },
        };
      }
    }
  }
  const secret = "private-template-value";
  const scope = { args: { password: secret }, run: { id: run.id, date: "2026-01-01" }, outputs: new Map() };
  for (const template of ["{{password}}", "{{ password }}"]) {
    const checked = new Set<string>();
    for (const candidate of variants(schema.$defs.step!, template)) {
      const step = { ...workflow.steps[0]!, ...candidate.value as object, action: "click" } as WorkflowStep;
      if (step.download) step.action = "download";
      if (step.open) {
        step.action = "open";
        step.open.target = candidate.path === "open.url" ? "url" : "file";
        if (step.open.target === "file" && !step.open.file) step.open.file = "public.txt";
      }
      const doc = { ...workflow, version: 3, steps: [step] };
      if (usesFilesDates(doc)) doc.filesDates = 1;
      if (validateWorkflow(doc).length) continue;
      saveWorkflow(library, doc);
      const value = candidate.path.split(".").reduce<unknown>((node, key) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, library.read(workflow.id).steps[0]);
      if (typeof value !== "string") continue;
      const rendered = renderTemplate(value, scope);
      if (rendered !== secret) continue;
      if (template === "{{password}}") assert.equal(expectedText(value, scope.args), secret);
      const reason = `rendered ${rendered}`;
      saveRun(library, { ...run, status: "failed", receipts: [], steps: [{ id: step.id, status: "failed", reason }], failure: { stepId: step.id, reason }, envelope: { status: "failed", step: step.id, reason, ask: reason } });
      const detail = inspectRunView(library, { run_id: run.id });
      assert.equal(detail.detailsHidden, undefined, candidate.path);
      assert.equal(detail.steps[0]?.picturesAllowed, false, candidate.path);
      assert.doesNotMatch(JSON.stringify(callViewerTool(library, "inspect_run", { run_id: run.id })), /private-template-value/, candidate.path);
      assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: step.id }), /withheld/, candidate.path);
      checked.add(candidate.path);
    }
    for (const path of ["download.name", "download.url", "open.url", "open.file", "waitFor.match", "waitFor.identity.name", "gone.match", "gone.identity.name", "readBack.match", "expect.match"]) assert.ok(checked.has(path), `${template}: ${path}`);
    t.diagnostic(`${template}: executed ${checked.size} schema string-field privacy cases`);
  }
});

test("download rendering and direct input references share the privacy boundary", (t) => {
  const { library, run, workflow } = fixture(t);
  const secret = "private-download-name";
  const template = "{{ password }}.txt";
  const rendered = downloadFileName(template, { args: { password: secret }, run: { id: run.id, date: "2026-01-01" }, outputs: new Map() });
  assert.equal(rendered, `${secret}.txt`);
  const source: WorkflowStep = { ...workflow.steps[0]!, id: "source", sensitive: true, action: "download", download: { output: "report", name: template } };
  saveWorkflow(library, { ...workflow, version: 3, filesDates: 1, inputs: [{ name: "password", type: "text" }], steps: [source, { ...workflow.steps[0]!, index: 1, selection: { by: "name", input: "password" } }] });
  const reason = `selected ${rendered}`;
  saveRun(library, { ...run, receipts: [], steps: [{ id: "preview", status: "passed", reason }] });
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.detailsHidden, undefined);
  assert.equal(detail.steps[0]?.picturesAllowed, false);
  assert.doesNotMatch(JSON.stringify(detail), /private-download-name/);
  assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  for (const field of ["gone", "waitFor"] as const) {
    saveWorkflow(library, { ...workflow, steps: [{ ...workflow.steps[0]!, [field]: { kind: "element", identity: { ...workflow.steps[0]!.identity!, inputType: "password" }, timeoutMs: 0 } }] });
    assert.equal(inspectRunView(library, { run_id: run.id }).steps[0]?.picturesAllowed, false);
    assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  }
});

test("sensitive binding discovery covers every input-bearing evidence field", (t) => {
  const { library, run, workflow } = fixture(t);
  for (const source of [
    { value: "{{token}}" },
    { readBack: { source: "text" as const, match: "{{token}}", timeoutMs: 0 } },
    { expect: { kind: "text" as const, match: "{{token}}", timeoutMs: 0 } },
    { postcondition: { kind: "text" as const, match: "{{token}}", timeoutMs: 0 } },
  ]) {
    saveWorkflow(library, { ...workflow, inputs: [{ name: "token", type: "text" }], steps: [
      { ...workflow.steps[0]!, id: "source", sensitive: true, ...source },
      { ...workflow.steps[0]!, index: 1, expect: { kind: "text", match: "{{token}}", timeoutMs: 0 } },
    ] });
    const reason = "expected private-token-value";
    saveRun(library, { ...run, status: "failed", receipts: [], failure: { stepId: "preview", reason }, steps: [{ id: "preview", status: "failed", reason }], envelope: { status: "failed", step: "preview", reason, ask: reason } });
    const detail = inspectRunView(library, { run_id: run.id });
    assert.equal(detail.detailsHidden, undefined);
    assert.doesNotMatch(JSON.stringify(detail), /private-token-value/);
    assert.equal(detail.steps[0]?.picturesAllowed, false);
    assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  }
});

test("editing away a secret binding withholds the entire historical viewer receipt", (t) => {
  const { library, run, workflow } = fixture(t);
  const readBack = { source: "text" as const, match: "{{password}}", timeoutMs: 0 };
  saveWorkflow(library, { ...workflow, steps: [{ ...workflow.steps[0]!, readBack }] });
  const receipts = new ReceiptLog();
  receipts.append({ kind: "read-back", ts: RUN_START + 100, runId: run.id, workflowId: workflow.id, stepId: "preview", source: "text", expected: "private-value", actual: "page private-value text", pass: false });
  const reason = 'read-back expected "private-value", read "page private-value text"';
  saveRun(library, { ...run, status: "failed", receipts: receipts.entries, failure: { stepId: "preview", reason }, steps: [{ ...run.steps[0] as object, id: "preview", status: "failed", reason }], envelope: { status: "failed", step: "preview", reason, ask: reason } });
  assert.equal(inspectRunView(library, { run_id: run.id }).detailsHidden, undefined);
  library.save(workflow);
  const file = path.join(library.root, "workflows", `${workflow.id}.json`);
  utimesSync(file, (RUN_START + 500) / 1000, (RUN_START + 500) / 1000);
  const detail = inspectRunView(library, { run_id: run.id });
  assert.match(detail.detailsHidden!, /workflow changed after this run/);
  assert.equal(detail.steps[0]?.label, "Preview report");
  assert.equal(detail.steps[0]?.status, "failed");
  assert.equal(detail.steps[0]?.durationMs, 100);
  assert.equal(detail.steps[0]?.result, undefined);
  assert.equal(detail.steps[0]?.reason, undefined);
  assert.equal(detail.reason, undefined);
  assert.equal(detail.handoff?.ask, undefined);
  assert.equal(detail.handoff?.reason, undefined);
  assert.equal(detail.steps[0]?.picturesAllowed, false);
  assert.doesNotMatch(JSON.stringify(detail), /private-value/);
  assert.doesNotMatch(JSON.stringify(callViewerTool(library, "inspect_run", { run_id: run.id })), /private-value/);
  assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  assert.equal(getRun(library, run.id).reason, reason);
});

test("unknown or ambiguous workflow and run times fail closed", (t) => {
  const { library, run, workflow } = fixture(t);
  const file = path.join(library.root, "workflows", `${workflow.id}.json`);
  for (const modified of [0, RUN_START, RUN_START + 500]) {
    utimesSync(file, modified / 1000, modified / 1000);
    const detail = inspectRunView(library, { run_id: run.id });
    assert.ok(detail.detailsHidden);
    assert.equal(detail.steps[0]?.picturesAllowed, false);
    assert.equal(detail.steps[0]?.result, undefined);
    assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  }
  saveWorkflow(library, workflow);
  library.saveRun({ ...run, videoStartedAt: undefined });
  assert.ok(inspectRunView(library, { run_id: run.id }).detailsHidden);
  library.saveRun({ ...run, steps: [{ id: "preview", status: "passed", reason: "private-unknown-time" }] });
  const unknown = inspectRunView(library, { run_id: run.id });
  assert.ok(unknown.detailsHidden);
  assert.doesNotMatch(JSON.stringify(unknown), /private-unknown-time/);
  saveRun(library, run);
  writeFileSync(file, "not JSON");
  assert.ok(inspectRunView(library, { run_id: run.id }).detailsHidden);
  rmSync(file);
  assert.ok(inspectRunView(library, { run_id: run.id }).detailsHidden);
});

test("an edit before the first step but after recording began still hides details", (t) => {
  const { library, run, workflow } = fixture(t);
  saveRun(library, { ...run, steps: [{ id: "preview", status: "passed", startedAt: RUN_START + 100, reason: "private-between-starts" }] });
  const modified = (RUN_START + 50) / 1000;
  utimesSync(path.join(library.root, "workflows", `${workflow.id}.json`), modified, modified);
  const detail = inspectRunView(library, { run_id: run.id });
  assert.ok(detail.detailsHidden);
  assert.doesNotMatch(JSON.stringify(detail), /private-between-starts/);
  assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
});

test("workflow snapshots bind parsed contents to the checked file time", (t) => {
  const { library, workflow } = fixture(t);
  const snapshot = library.readWorkflowSnapshot(workflow.id, { maxBytes: VIEW_RECORD_BYTES });
  assert.equal(snapshot.modifiedAtMs, WORKFLOW_TIME);
  assert.equal(snapshot.workflow.name, "Preview report");
  assert.equal(snapshot.workflow.steps[0]?.label, "Preview report");
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

test("public failure and stopped-step reasons remain available without an envelope", (t) => {
  const { library, run } = fixture(t);
  for (const source of ["failure", "step"]) {
    saveRun(library, { ...run, status: "failed", failure: source === "failure" ? { stepId: "preview", reason: "Preview not ready" } : undefined,
      steps: [{ id: "preview", status: "failed", reason: source === "step" ? "Preview not ready" : undefined }] });
    assert.equal(inspectRunView(library, { run_id: run.id }).reason, "Preview not ready");
  }
});

test("unclassified failure and stop reasons stay in the desktop app", (t) => {
  const { library, run } = fixture(t);
  saveRun(library, { ...run, workflowId: "missing", status: "failed", failure: { stepId: "unknown", reason: "private-value" }, steps: [{ id: "unknown", status: "failed", reason: "private-value" }] });
  assert.doesNotMatch(JSON.stringify(inspectRunView(library, { run_id: run.id })), /private-value/);
});

test("receipt explains a human stop without exposing the resume authority", (t) => {
  const { library, run } = fixture(t);
  saveRun(library, { ...run, status: "paused", failure: { reason: "confirm required", stepId: "preview" }, envelope: { status: "needs_human", ask: "Review the confirmation in Bao", reason: "confirm required", deadline: "2030-01-01", resume_token: "do-not-export" } });
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.run.status, "needs_human");
  assert.equal(detail.reason, "confirm required");
  assert.equal(detail.handoff?.ask, "Review the confirmation in Bao");
  assert.doesNotMatch(JSON.stringify(detail), /do-not-export/);
});

test("capture runs work without a workflow, never export native args or pictures, and do not invent model counts", (t) => {
  const { library, run } = fixture(t);
  saveRun(library, { ...run, kind: "capture", workflowId: "agent-browser", steps: [{ id: "command-1", label: "fill password-value", status: "passed", native: { command: "fill", args: ["password-value"], results: [{ stdout: "raw-output" }] } }] });
  const detail = inspectRunView(library, { run_id: run.id });
  assert.equal(detail.run.name, "Browser capture");
  assert.equal(detail.run.modelCalls, null);
  assert.equal(detail.steps[0]?.label, "fill");
  assert.equal(detail.steps[0]?.picturesAllowed, false);
  assert.equal(detail.workflow, null);
  assert.doesNotMatch(JSON.stringify(detail), /password-value|raw-output/);
  assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "command-1" }), /withheld/);
});

test("history, run steps, and workflow steps page independently with bounded text", (t) => {
  const { library, run, workflow } = fixture(t);
  const steps = Array.from({ length: 43 }, (_, index) => ({ ...workflow.steps[0]!, id: `step-${index}`, index, label: "x".repeat(1000) }));
  saveWorkflow(library, { ...workflow, steps });
  saveRun(library, { ...run, steps: steps.map((step) => ({ id: step.id, status: "passed", reason: "y".repeat(10_000) })) });
  for (let index = 0; index < 11; index++) saveRun(library, { ...run, id: `run-page-${index}` });
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

test("viewer rejects traversal, invalid IDs and invalid offsets before deriving paths", (t) => {
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

test("stored dotted and other safe Library IDs work across history, tools, and pictures", (t) => {
  const { library, run, workflow, png } = fixture(t);
  const ajv = new Ajv();
  const inspectSchema = ajv.compile(VIEWER_TOOLS.find((tool) => tool.name === "inspect_run")!.inputSchema);
  const pictureSchema = ajv.compile(VIEWER_TOOLS.find((tool) => tool.name === "open_step_pictures")!.inputSchema);
  for (const id of ["wf-my.flow", "saved report", "%2e%2e"]) {
    const stepId = `${id}-step.1`;
    saveWorkflow(library, { ...workflow, id, steps: [{ ...workflow.steps[0]!, id: stepId }] });
    saveRun(library, { ...run, workflowId: id, steps: [{ id: stepId, status: "passed" }] });
    const shots = path.join(library.root, "shots", "runs", run.id);
    mkdirSync(shots, { recursive: true });
    writeFileSync(path.join(shots, shotFile(stepId, "after")), png);
    assert.equal(inspectSchema({ run_id: run.id }), true);
    assert.equal(pictureSchema({ run_id: run.id, step_id: stepId }), true);
    assert.ok(listRunViews(library, {}).runs.some((item) => item.workflowId === id && item.name === workflow.name));
    const detail = inspectRunView(library, { run_id: run.id });
    assert.equal(detail.workflow?.id, id);
    assert.equal(detail.steps[0]?.label, "Preview report");
    assert.equal(detail.steps[0]?.picturesAllowed, true);
    assert.equal(openStepPictures(library, { run_id: run.id, step_id: stepId }).pictures.length, 1);
  }
  for (const id of ["", ".", "..", "a..b", "x/y", "x\\y", "x\u0000y", "x".repeat(129)]) {
    assert.equal(inspectSchema({ run_id: id }), false);
    assert.equal(pictureSchema({ run_id: run.id, step_id: id }), false);
  }
});

test("oversized run records are skipped without ending history pagination", (t) => {
  const { library, run } = fixture(t);
  const file = path.join(library.root, "runs", `${run.id}.json`);
  truncateSync(file, VIEW_RECORD_BYTES + 1);
  assert.throws(() => inspectRunView(library, { run_id: run.id }), /too large/);
  assert.equal(listRunViews(library, {}).skipped, 1);
  assert.equal(listRunViews(library, {}).runs.length, 0);
});

test("linked run files, workflow files, picture files, and picture directories never leave the Library", (t) => {
  const { root, library, run, workflow, shots, png } = fixture(t);
  const outside = path.join(root, "outside.json"); writeFileSync(outside, JSON.stringify(run));
  const runFile = path.join(library.root, "runs", `${run.id}.json`); rmSync(runFile); symlinkSync(outside, runFile);
  assert.throws(() => inspectRunView(library, { run_id: run.id }), /links/);
  assert.equal(listRunViews(library, {}).runs.length, 0);
  rmSync(runFile); saveRun(library, run);
  const workflowFile = path.join(library.root, "workflows", `${workflow.id}.json`); rmSync(workflowFile); symlinkSync(outside, workflowFile);
  assert.equal(inspectRunView(library, { run_id: run.id }).workflow, null);
  assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  rmSync(workflowFile); saveWorkflow(library, workflow);
  const image = path.join(root, "outside.png"); writeFileSync(image, png);
  for (const phase of ["before", "after"]) { const file = path.join(shots, `preview-${phase}.png`); rmSync(file); symlinkSync(image, file); }
  assert.deepEqual(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures, []);
  rmSync(shots, { recursive: true }); symlinkSync(root, shots);
  assert.deepEqual(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures, []);
  const linked = path.join(root, "linked-library"); symlinkSync(library.root, linked);
  assert.throws(() => inspectRunView(new Library(linked), { run_id: run.id }), /links/);
  assert.throws(() => listRunViews(new Library(linked), {}), /links/);
});

test("live picture names use the same run boundary and guards as replay names", (t) => {
  const { root, library, run, shots, png } = fixture(t);
  for (const phase of ["before", "after"]) rmSync(path.join(shots, `preview-${phase}.png`));
  writeFileSync(path.join(shots, "0-before.png"), png);
  writeFileSync(path.join(shots, "0-after.png"), png);
  saveRun(library, { ...run, kind: "capture", steps: [{ id: "preview", status: "passed", beforeShot: "0-before.png", afterShot: "0-after.png" }] });
  assert.deepEqual(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures, [
    { phase: "before", mimeType: "image/png", data: png.toString("base64") },
    { phase: "after", mimeType: "image/png", data: png.toString("base64") },
  ]);
  const outside = path.join(root, "outside.png"); writeFileSync(outside, png);
  symlinkSync(outside, path.join(shots, "linked.png"));
  truncateSync(path.join(shots, "0-before.png"), VIEW_PICTURE_BYTES + 1);
  writeFileSync(path.join(shots, "invalid.png"), "not an image");
  for (const name of ["../0-after.png", outside, "nested/0-after.png", "nested\\0-after.png", "linked.png", "0-before.png", "invalid.png", ".", "..", ""]) {
    saveRun(library, { ...run, steps: [{ id: "preview", status: "passed", beforeShot: name, afterShot: name }] });
    assert.deepEqual(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures, []);
  }
  saveRun(library, { ...run, steps: [{ id: "preview", status: "passed", beforeShot: "missing.png", afterShot: "missing.png" }] });
  writeFileSync(path.join(shots, "preview-after.png"), png);
  assert.equal(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures.length, 1);
});

test("pictures use shared sensitive-step redaction, size caps, known steps, and UI-only metadata", (t) => {
  const { library, run, workflow, shots, png } = fixture(t);
  const reply = callViewerTool(library, "open_step_pictures", { run_id: run.id, step_id: "preview" });
  assert.equal(reply._meta.baoPictures?.pictures.length, 2);
  assert.doesNotMatch(JSON.stringify(reply.content), /image\/png|base64|iVBOR/);
  assert.match(reply.content[0]!.text, /host app/);
  truncateSync(path.join(shots, "preview-before.png"), VIEW_PICTURE_BYTES + 1);
  writeFileSync(path.join(shots, "preview-after.png"), "not an image");
  assert.deepEqual(openStepPictures(library, { run_id: run.id, step_id: "preview" }).pictures, []);
  assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "not-recorded" }), /withheld/);
  for (const patch of [{ sensitive: true }, { input: "password" }, { value: "{{password}}" }, { readBack: { source: "text" as const, match: "{{password}}", timeoutMs: 1000 } }]) {
    saveWorkflow(library, { ...workflow, steps: [{ ...workflow.steps[0]!, ...patch }] });
    writeFileSync(path.join(shots, "preview-before.png"), png);
    assert.equal(inspectRunView(library, { run_id: run.id }).steps[0]?.picturesAllowed, false);
    assert.throws(() => openStepPictures(library, { run_id: run.id, step_id: "preview" }), /withheld/);
  }
});
