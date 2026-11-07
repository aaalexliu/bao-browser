import { findNodeAtLocation, parseTree } from "jsonc-parser";
import { readLibraryFile, readLibraryPrefix } from "../v1/library-read";
import type { WorkflowV2 } from "../v1/schema";
import { shotFile, shotFormat } from "../v1/shots";
import { Library, type StoredRun } from "../v1/store";

export const VIEW_RECORD_BYTES = 2 * 1024 * 1024;
export const VIEW_PICTURE_BYTES = 512 * 1024;
export const BROWSER_PICTURE_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 5;
const STEP_PAGE_SIZE = 20;
const bounded = { maxBytes: VIEW_RECORD_BYTES };

export const VIEWER_ID_PATTERN = "^(?![\\s\\S]*\\.\\.)(?!\\.$)[^/\\\\\\u0000]{1,128}$";
const idPattern = new RegExp(VIEWER_ID_PATTERN);

function isViewerId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && idPattern.test(value);
}

export function viewerId(value: unknown): string {
  if (!isViewerId(value)) throw new Error("Invalid viewer id");
  return value;
}

function offset(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > 1_000_000) throw new Error("Invalid viewer page");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit = 500): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function workflowFor(library: Library, run: StoredRun): WorkflowV2 | undefined {
  if (run.kind === "capture") return undefined;
  try { return library.readWorkflowSnapshot(viewerId(run.workflowId), bounded).workflow; }
  catch { return undefined; }
}

function summary(run: StoredRun, workflow?: WorkflowV2) {
  return {
    id: viewerId(run.id), workflowId: text(run.workflowId, 128),
    name: text(workflow?.name, 120) || (run.kind === "capture" ? "Browser capture" : "Workflow unavailable"),
    status: text(run.envelope?.status || run.status, 60),
    at: Number.isFinite(run.at) ? run.at : null, kind: run.kind === "capture" ? "capture" : "replay",
    stepCount: run.steps.length, modelCalls: count(run.modelCalls), healCount: run.heals.length,
  };
}

export function listRunViews(library: Library, args: Record<string, unknown>) {
  const page = offset(args.offset);
  const { runs, nextOffset, skipped } = library.readRunPage(page, PAGE_SIZE, bounded);
  return { view: "history", runs: runs.map((run) => summary(run, workflowFor(library, run))), offset: page, nextOffset, skipped, order: "recently updated" };
}

function readViewerRun(library: Library, runId: string): StoredRun {
  const header = parseTree(readLibraryPrefix(library.root, ["runs", `${runId}.json`], 4096).toString("utf8"));
  const capture = header !== undefined && findNodeAtLocation(header, ["kind"])?.value === "capture";
  return library.readRun(runId, capture ? { maxBytes: Number.MAX_SAFE_INTEGER } : bounded);
}

export function inspectRunView(library: Library, args: Record<string, unknown>) {
  const run = readViewerRun(library, viewerId(args.run_id));
  const workflow = workflowFor(library, run);
  const stepOffset = offset(args.step_offset);
  const workflowOffset = offset(args.workflow_offset);
  const recording = run.kind === "capture" && (run.envelope?.status || run.status) === "recording";
  const failure = record(recording ? undefined : run.failure);
  const stopped = recording ? undefined : run.steps.map(record).find((step) => ["paused", "failed", "timeout", "timed-out"].includes(String(step.status)));
  const results = (run.receipts || []).map(record);
  const steps = run.steps.slice(stepOffset, stepOffset + STEP_PAGE_SIZE).map((item, index) => {
    const step = record(item);
    const definition = workflow?.steps.find((candidate) => candidate.id === step.id);
    const native = record(step.native);
    const readBacks = results.filter((result) => result.stepId === step.id).map((receipt) =>
      `Read back ${text(receipt.source, 60) || "value"}: expected ${text(receipt.expected) || ""}, saw ${text(receipt.actual) || ""}. ${receipt.pass ? "matches" : "does not match"}.`);
    return {
      id: text(step.id, 128), index: stepOffset + index + 1,
      label: text(definition?.label, 160) || (run.kind === "capture" ? text(native.command, 40) || "Captured command" : text(step.id, 128)),
      action: text(definition?.action, 40), status: text(step.status, 60) || "unknown",
      reason: text(step.reason),
      result: readBacks.length ? readBacks.join("\n") : text(step.readBack),
      durationMs: typeof step.startedAt === "number" && typeof step.endedAt === "number" ? Math.max(0, step.endedAt - step.startedAt) : null,
      picturesAllowed: isViewerId(step.id),
    };
  });
  return {
    view: "receipt", run: summary(run, workflow),
    reason: recording ? undefined : text(run.envelope?.reason) || text(failure.reason) || text(stopped?.reason),
    handoff: !recording && run.envelope ? { status: text(run.envelope.status, 60), ask: text(run.envelope.ask), reason: text(run.envelope.reason), deadline: text(run.envelope.deadline, 80) } : null,
    steps, stepOffset, nextStepOffset: stepOffset + STEP_PAGE_SIZE < run.steps.length ? stepOffset + STEP_PAGE_SIZE : null,
    workflow: workflow ? {
      id: viewerId(workflow.id), name: text(workflow.name, 120), stepCount: workflow.steps.length,
      steps: workflow.steps.slice(workflowOffset, workflowOffset + STEP_PAGE_SIZE).map((step, index) => ({
        index: workflowOffset + index + 1, action: text(step.action, 40),
        label: text(step.label, 160),
      })),
      offset: workflowOffset, nextOffset: workflowOffset + STEP_PAGE_SIZE < workflow.steps.length ? workflowOffset + STEP_PAGE_SIZE : null,
    } : null,
  };
}

function readPicture(library: Library, runId: string, name: string, maxBytes: number) {
  try {
    const bytes = readLibraryFile(library.root, ["shots", "runs", runId, name], maxBytes);
    const format = shotFormat(bytes);
    if (format) return { mimeType: format === "png" ? "image/png" : "image/jpeg", data: bytes.toString("base64") };
  } catch {}
  return undefined;
}

export function openBrowserPicture(library: Library, args: Record<string, unknown>) {
  const runId = viewerId(args.run_id);
  const stepId = viewerId(args.step_id);
  const phase = args.phase;
  if (phase !== "before" && phase !== "after") throw new Error("Invalid picture phase");
  for (const format of ["jpg", "png"] as const) {
    const picture = readPicture(library, runId, shotFile(stepId, phase, format), BROWSER_PICTURE_BYTES);
    if (picture) return { runId, stepId, pictures: [{ phase, ...picture }] };
  }
  return { runId, stepId, pictures: [] };
}

export function openStepPictures(library: Library, args: Record<string, unknown>) {
  const runId = viewerId(args.run_id);
  const stepId = viewerId(args.step_id);
  const run = readViewerRun(library, runId);
  const recorded = run.steps.map(record).find((item) => item.id === stepId);
  if (!recorded) throw new Error("Step not found in this run");
  const pictures: { phase: string; mimeType: string; data: string }[] = [];
  for (const phase of ["before", "after"] as const) {
    const names = [recorded[`${phase}Shot`], shotFile(stepId, phase, "png"), shotFile(stepId, phase, "jpg")];
    for (const name of names) {
      if (typeof name !== "string") continue;
      const picture = readPicture(library, runId, name, run.kind === "capture" ? BROWSER_PICTURE_BYTES : VIEW_PICTURE_BYTES);
      if (picture) { pictures.push({ phase, ...picture }); break; }
    }
  }
  return { runId, stepId, pictures };
}
