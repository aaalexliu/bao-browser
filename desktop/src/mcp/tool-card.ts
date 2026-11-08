import type { OwnerPage } from "../cdp-live/owner-wait";
import { describeStep, ownerOutcome, type OwnerHandoff, type StepSummary, type SummaryPart } from "../engines/agent-browser-describe";
import type { AgentBrowserCommandResult } from "../engines/agent-browser-proxy";
import type { RecordedAgentBrowserCommand } from "../engines/agent-browser-record";
import type { StoredRun } from "../v1/store";

type Target = NonNullable<RecordedAgentBrowserCommand["target"]>;

export type CardPicture = { kind: "captured"; stepId?: string; phase: "before" | "after"; target?: Target }
  | { kind: "unavailable"; reason: string };

export interface FinishSummary {
  outcome: string;
  reason: string;
  task?: string;
  done: string[];
  steps: number;
  durationMs: number | null;
  pageLoads: number;
  reads: number;
  clicks: number;
  typed: number;
  failedSteps: number;
}

export interface BrowserToolCard {
  command: string;
  status: "complete" | "failed" | "waiting";
  /** frame: the page with the target boxed. pair: last seen and now, for a failed step. wait: the owner's turn. finish: the run's result. text: the sentence only. */
  style: "frame" | "pair" | "wait" | "finish" | "text";
  caption: string;
  parts: SummaryPart[];
  mark?: string;
  page?: OwnerPage;
  runId: string | null;
  stepId: string | null;
  picture: CardPicture;
  /** For a failed step: the latest earlier picture, boxed only when Bao measured the target. */
  lastSeen?: CardPicture;
  error?: string;
  owner?: OwnerHandoff & { waitedMs?: number };
  finish?: FinishSummary;
}

export interface StepEvidence {
  runId: string;
  step: RecordedAgentBrowserCommand;
  steps?: readonly RecordedAgentBrowserCommand[];
  lastPicture?: { stepId: string; phase: "before" | "after" };
}

export const BROWSER_RESULT_SCHEMA = {
  type: "object", required: ["command", "status", "run_id", "step_id"],
  properties: {
    command: { type: "string" }, status: { type: "string", enum: ["complete", "failed", "waiting"] },
    run_id: { type: ["string", "null"] }, step_id: { type: ["string", "null"] }, error: { type: "string" },
  },
};

const unavailable = (reason: string): CardPicture => ({ kind: "unavailable", reason });

function latestPicture(steps: readonly Partial<RecordedAgentBrowserCommand>[], end: number): CardPicture | undefined {
  for (let i = Math.min(end, steps.length) - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (!step.id) continue;
    if (step.afterShot) return { kind: "captured", stepId: step.id, phase: "after" };
    if (step.beforeShot) return { kind: "captured", stepId: step.id, phase: "before" };
  }
  return undefined;
}

/** The card for one recorded step. The same function serves the tool result and the app's later read. */
export function stepCard(runId: string | null, step: RecordedAgentBrowserCommand | undefined, options: {
  command: string; args?: readonly string[]; results: readonly AgentBrowserCommandResult[]; error?: string; owner?: OwnerPage;
  steps?: readonly Partial<RecordedAgentBrowserCommand>[]; lastPicture?: StepEvidence["lastPicture"];
}): BrowserToolCard {
  const { command, results } = options;
  const failed = options.error !== undefined || results.some((result) => result.exitCode !== 0);
  const outcome = ownerOutcome(results);
  const summary: StepSummary = step?.summary ?? describeStep({ command, args: options.args ?? step?.native.args ?? [], results, error: options.error, owner: options.owner });
  const status = outcome === "halted" || outcome === "waiting" ? "waiting" : failed ? "failed" : "complete";
  const base = { command, status, caption: summary.text, parts: summary.parts, runId, stepId: step?.id ?? null,
    ...(summary.mark ? { mark: summary.mark } : {}), ...(summary.page ? { page: summary.page } : {}) } as const;
  if (outcome) {
    const owner = summary.owner ? { ...summary.owner, ...(command === "wait_for_owner" && step?.endedAt ? { waitedMs: Math.max(0, step.endedAt - step.startedAt) } : {}) } : undefined;
    return { ...base, style: outcome === "closed" ? "text" : "wait", picture: unavailable("Bao keeps no picture of sign-in and check pages."), ...(owner ? { owner } : {}) };
  }
  const steps = options.steps ?? [];
  const index = step ? steps.findIndex((candidate) => candidate.id === step.id) : -1;
  const before = index >= 0 ? index : steps.length;
  if (command === "close") {
    const last = latestPicture(steps, steps.length) ?? (options.lastPicture ? { kind: "captured" as const, ...options.lastPicture } : undefined);
    return { ...base, style: last ? "frame" : "text", picture: last ?? unavailable(step?.afterShotError || "No page picture is available for this call.") };
  }
  if (!step) return { ...base, style: "text", picture: unavailable("No page picture is available for this call."), ...(failed ? { error: summary.error } : {}) };
  if (failed) {
    const now: CardPicture = step.afterShot ? { kind: "captured", phase: "after" } : unavailable(step.afterShotError || "No picture was taken after the failure.");
    const lastSeen = step.beforeShot && step.target ? { kind: "captured" as const, phase: "before" as const, target: step.target } : latestPicture(steps, before);
    return { ...base, style: "pair", picture: now, ...(lastSeen ? { lastSeen } : {}), error: summary.error ?? "The command failed." };
  }
  if ((command === "click" || command === "fill") && step.beforeShot && step.target) {
    return { ...base, style: "frame", picture: { kind: "captured", phase: "before", target: step.target } };
  }
  if (step.afterShot) {
    return { ...base, style: "frame", picture: { kind: "captured", phase: "after", ...(step.afterTarget ? { target: step.afterTarget } : {}) } };
  }
  return { ...base, style: "frame", picture: unavailable(step.afterShotError || "No page picture is available for this call.") };
}

function duration(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/** The finished-run card: the agent's reason, its optional done list, and what the steps did. */
export function finishCard(run: StoredRun): BrowserToolCard {
  const steps = run.steps.filter((step): step is Partial<RecordedAgentBrowserCommand> => !!step && typeof step === "object");
  const commands = steps.map((step) => step.native?.command);
  const tally = (name: string) => commands.filter((command) => command === name).length;
  const ends = steps.map((step) => step.endedAt).filter((value): value is number => typeof value === "number");
  const status = run.envelope?.status || run.status;
  const reason = (run.envelope?.reason || "").trim();
  const done = Array.isArray(run.done) ? run.done.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const finish: FinishSummary = {
    outcome: status, reason, ...(run.task ? { task: run.task } : {}), done, steps: steps.length,
    durationMs: ends.length && Number.isFinite(run.at) ? Math.max(0, Math.max(...ends) - run.at) : null,
    pageLoads: tally("open"), reads: tally("snapshot"), clicks: tally("click"), typed: tally("fill"),
    failedSteps: steps.filter((step) => step.status === "failed").length,
  };
  const word = status === "passed" ? "Passed" : status === "failed" ? "Failed" : status === "recording" ? "Still recording" : status;
  const lead = reason ? `${word}: ${reason.replace(/\.$/, "")}` : word;
  const list = done.length ? ` Done: ${done.join("; ")}.` : "";
  const took = finish.durationMs === null ? "" : ` in ${duration(finish.durationMs)}`;
  const caption = `${lead}.${list} ${finish.steps} ${finish.steps === 1 ? "step" : "steps"}${took}.`;
  return {
    command: "finish_task", status: status === "passed" ? "complete" : status === "failed" ? "failed" : "waiting", style: "finish",
    caption, parts: [reason ? `${word}: ${reason.replace(/\.$/, "")}` : word], runId: run.id, stepId: null,
    picture: unavailable("A finished run has no single page picture."), finish,
  };
}

function cardKey(card: BrowserToolCard): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(card.style === "finish" ? { run_id: card.runId, card: "finish" } : { run_id: card.runId, step_id: card.stepId }) };
}

function nativeBlocks(results: readonly AgentBrowserCommandResult[]): { type: "text"; text: string }[] {
  return results.flatMap((result) => [result.stdout, result.stderr].filter((text) => text.length > 0).map((text) => ({ type: "text" as const, text })));
}

/** The sentence that leads every agent_browser result, in MCP Apps hosts and text-only clients alike. */
export function stepSentence(command: string, results: readonly AgentBrowserCommandResult[], evidence?: StepEvidence, error?: string,
  options: { args?: readonly string[]; owner?: OwnerPage } = {}): string {
  return evidence?.step.summary?.text ?? describeStep({ command, args: options.args ?? [], results, error, owner: options.owner }).text;
}

export function browserToolResult(command: string, results: AgentBrowserCommandResult[],
  evidence?: StepEvidence, activeRunId?: string, error?: string, options: { args?: readonly string[]; owner?: OwnerPage } = {}) {
  const runId = evidence?.runId ?? activeRunId ?? null;
  const card = stepCard(runId, evidence?.step, { command, args: options.args, results, error, owner: options.owner, steps: evidence?.steps, lastPicture: evidence?.lastPicture });
  return {
    content: [
      { type: "text", text: card.caption },
      ...nativeBlocks(results),
      ...(error === undefined ? [] : [{ type: "text", text: error }]),
      cardKey(card),
    ],
    structuredContent: { command, status: card.status, run_id: runId, step_id: card.stepId, ...(error === undefined ? {} : { error }) },
    _meta: { baoToolCard: card },
    isError: error !== undefined || results.some((result) => result.exitCode !== 0),
  };
}

export function finishToolContent(card: BrowserToolCard | undefined, receipt: unknown, ui: boolean) {
  const sentence = card?.caption ?? "No browser task was open.";
  return [
    { type: "text", text: sentence },
    { type: "text", text: JSON.stringify(receipt) },
    ...(ui && card ? [cardKey(card)] : []),
  ];
}
