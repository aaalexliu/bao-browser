import { scrubSaved } from "../../../shared/saved-secrets";
import { readLibraryFile } from "../v1/library-read";
import type { WorkflowV2 } from "../v1/schema";
import { shotFile, shotFormat } from "../v1/shots";
import { Library, type StoredRun } from "../v1/store";
import { privateStep } from "./step-privacy";

export const VIEW_RECORD_BYTES = 2 * 1024 * 1024;
export const VIEW_PICTURE_BYTES = 512 * 1024;
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

function workflowFor(library: Library, run: StoredRun): { workflow?: WorkflowV2; trusted: boolean } {
  try {
    const { workflow, modifiedAtMs } = library.readWorkflowSnapshot(viewerId(run.workflowId), bounded);
    const startedAt = run.videoStartedAt;
    const firstStepAt = record(run.steps[0]).startedAt;
    const trusted = workflow.id === run.workflowId && typeof startedAt === "number" && Number.isSafeInteger(startedAt) && startedAt > 0
      && typeof firstStepAt === "number" && Number.isSafeInteger(firstStepAt) && startedAt <= firstStepAt
      && Number.isFinite(run.at) && firstStepAt <= run.at && run.at <= Date.now()
      && Number.isFinite(modifiedAtMs) && modifiedAtMs > 0 && Math.ceil(modifiedAtMs) < startedAt;
    return { workflow, trusted };
  } catch { return { trusted: false }; }
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
  return { view: "history", runs: runs.map((run) => summary(run, workflowFor(library, run).workflow)), offset: page, nextOffset, skipped, order: "recently updated" };
}

export function inspectRunView(library: Library, args: Record<string, unknown>) {
  const run = library.readRun(viewerId(args.run_id), bounded);
  const { workflow, trusted } = workflowFor(library, run);
  const safe = scrubSaved(run, { workflow });
  const stepOffset = offset(args.step_offset);
  const workflowOffset = offset(args.workflow_offset);
  const failure = record(safe.failure);
  const stopped = safe.steps.map(record).find((step) => ["paused", "failed", "timeout", "timed-out"].includes(String(step.status)));
  const results = (safe.receipts || []).map(record);
  const publicStep = (id: unknown): boolean => {
    const definition = workflow?.steps.find((candidate) => candidate.id === id);
    return Boolean(trusted && workflow && definition && !privateStep(workflow, definition, run));
  };
  const handoffPublic = publicStep(safe.envelope?.step ?? failure.stepId ?? stopped?.id);
  const steps = safe.steps.slice(stepOffset, stepOffset + STEP_PAGE_SIZE).map((item, index) => {
    const step = record(item);
    const definition = workflow?.steps.find((candidate) => candidate.id === step.id);
    const hidden = !publicStep(step.id);
    const native = record(step.native);
    const readBacks = hidden ? [] : results.filter((result) => result.stepId === step.id).map((receipt) =>
      `Read back ${text(receipt.source, 60) || "value"}: expected ${text(receipt.expected) || ""}, saw ${text(receipt.actual) || ""}. ${receipt.pass ? "matches" : "does not match"}.`);
    return {
      id: text(step.id, 128), index: stepOffset + index + 1,
      label: !trusted && run.kind !== "capture" ? text(definition?.label, 160) || text(step.id, 128)
        : hidden ? (run.kind === "capture" ? text(native.command, 40) || "Captured command" : "Private or unavailable step") : text(definition?.label, 160) || text(step.id, 128),
      action: text(definition?.action, 40), status: text(step.status, 60) || "unknown",
      reason: hidden ? undefined : text(step.reason),
      result: !trusted ? undefined : hidden ? "Detailed evidence stays in the Bao desktop app." : readBacks.length ? readBacks.join("\n") : text(step.readBack),
      durationMs: typeof step.startedAt === "number" && typeof step.endedAt === "number" ? Math.max(0, step.endedAt - step.startedAt) : null,
      picturesAllowed: !hidden && isViewerId(step.id),
    };
  });
  return {
    view: "receipt", run: summary(run, workflow),
    detailsHidden: trusted ? undefined : "Details are hidden because the workflow changed after this run or could not be verified.",
    reason: (handoffPublic ? text(safe.envelope?.reason) : undefined)
      || (publicStep(failure.stepId) ? text(failure.reason) : undefined)
      || (publicStep(stopped?.id) ? text(stopped?.reason) : undefined),
    handoff: safe.envelope ? { status: text(safe.envelope.status, 60), ask: handoffPublic ? text(safe.envelope.ask) : undefined, reason: handoffPublic ? text(safe.envelope.reason) : undefined, deadline: text(safe.envelope.deadline, 80) } : null,
    steps, stepOffset, nextStepOffset: stepOffset + STEP_PAGE_SIZE < safe.steps.length ? stepOffset + STEP_PAGE_SIZE : null,
    workflow: workflow ? {
      id: viewerId(workflow.id), name: text(workflow.name, 120), stepCount: workflow.steps.length,
      steps: workflow.steps.slice(workflowOffset, workflowOffset + STEP_PAGE_SIZE).map((step, index) => ({
        index: workflowOffset + index + 1, action: text(step.action, 40),
        label: trusted && privateStep(workflow, step, run) ? "Private step" : text(step.label, 160),
      })),
      offset: workflowOffset, nextOffset: workflowOffset + STEP_PAGE_SIZE < workflow.steps.length ? workflowOffset + STEP_PAGE_SIZE : null,
    } : null,
  };
}

export function openStepPictures(library: Library, args: Record<string, unknown>) {
  const runId = viewerId(args.run_id);
  const stepId = viewerId(args.step_id);
  const run = library.readRun(runId, bounded);
  const { workflow, trusted } = workflowFor(library, run);
  const step = workflow?.steps.find((item) => item.id === stepId);
  const recorded = run.steps.map(record).find((item) => item.id === stepId);
  if (!trusted || !workflow || !step || privateStep(workflow, step, run) || !recorded) throw new Error("Pictures withheld for this step");
  const pictures: { phase: string; mimeType: string; data: string }[] = [];
  for (const phase of ["before", "after"] as const) {
    const names = [recorded[`${phase}Shot`], shotFile(stepId, phase, "png"), shotFile(stepId, phase, "jpg")];
    for (const name of names) {
      if (typeof name !== "string") continue;
      try {
        const bytes = readLibraryFile(library.root, ["shots", "runs", runId, name], VIEW_PICTURE_BYTES);
        const format = shotFormat(bytes);
        if (!format) continue;
        pictures.push({ phase, mimeType: format === "png" ? "image/png" : "image/jpeg", data: bytes.toString("base64") });
        break;
      } catch { /* Missing, linked, malformed, or oversized evidence is never exported. */ }
    }
  }
  return { runId, stepId, pictures };
}
