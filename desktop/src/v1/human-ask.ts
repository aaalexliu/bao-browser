// Copy for a step that waits on the person. Replay does not click or type these.

import { siteName } from "./page-class";
import { formatClock } from "./time";
import { isLoopbackHost, publicSite } from "./visible-copy";

export type AskKind = "login" | "confirm" | "wall";

/** A person has two hours unless Settings names another wait. */
export const DEFAULT_ACT_TIMEOUT_MS = 120 * 60 * 1000;

/** Settings win when they name a wait. Otherwise the step's own timeout, including zero. */
export function actWaitMs(stepTimeout: number | undefined, configured?: number): number {
  if (typeof configured === "number" && configured > 0) return configured;
  if (typeof stepTimeout === "number") return Math.max(0, stepTimeout);
  return DEFAULT_ACT_TIMEOUT_MS;
}

export interface HumanAsk {
  kind: AskKind;
  workflowId: string;
  workflowName: string;
  stepId: string;
  /** 1-based. */
  stepIndex: number;
  stepCount: number;
  label: string;
  /** Confirm only: the site control the person presses. */
  button?: string;
  /** Hostname the person is acting on. */
  site: string;
  windowName: string;
  instruction: string;
  startedAt: number;
  deadline: number | null;
  timeoutMs: number;
  /** Set while a replay is waiting, so the prompt can find its run after a restart. */
  runId?: string;
}

export function confirmButton(step: { label: string; identity?: { name?: string; text?: string } }): string {
  const named = step.identity?.name || step.identity?.text;
  if (named && named.trim()) return named.trim();
  const quoted = step.label.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  return "the button";
}

/** Host only. The path and any query stay off the ask. Loopback is the fixture. */
export function siteHost(url: string | undefined): string {
  if (!url) return "the site";
  try {
    const host = new URL(url).hostname;
    if (!host) return "the site";
    if (isLoopbackHost(host)) return "the fixture";
    return host;
  } catch {
    return "the site";
  }
}

/** Bot check or a session that expired. The person finishes it in the Bao window. */
export function wallInstruction(site: string, kind: "bot" | "login"): string {
  const name = siteName(site);
  if (kind === "bot") return `${name} is showing a bot check. Complete the check in the Bao window, then press Continue.`;
  return "Sign in in the Bao window, then press Continue.";
}

export function actAskLine(ask: { kind: AskKind; site?: string; button?: string; instruction?: string }): string {
  const site = publicSite(ask.site || "the site");
  if (ask.kind === "wall") return ask.instruction || wallInstruction(site, "bot");
  if (ask.kind === "confirm") return `Press ${ask.button || "the button"} on ${site} in the Bao window`;
  return `Sign in to ${site} in the Bao window`;
}

/** Time left, then the local clock with its zone. A notification can quote this once. */
export function actDeadlineLine(deadline: number | null, now = Date.now()): string {
  if (!deadline) return "No timeout";
  const remain = Math.max(0, deadline - now);
  const total = Math.ceil(remain / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `Waiting ${minutes}:${String(seconds).padStart(2, "0")} · times out at ${formatClock(deadline)}`;
}

/** The notification and the Dock tooltip use this exact string. */
export function actSurfaceText(ask: Pick<HumanAsk, "kind" | "site" | "button" | "deadline">, now = Date.now()): string {
  return `${actAskLine(ask)}. ${actDeadlineLine(ask.deadline, now)}`;
}

/** The notification and the Dock tooltip for a live session's idle warning, in the same shape as an act. */
export function liveIdleSurfaceText(warning: { host: string; saveAt: number }, now = Date.now()): string {
  return `Press Keep open in the Bao window to keep the live session on ${publicSite(warning.host)}. ${actDeadlineLine(warning.saveAt, now)}`;
}

export function confirmInstruction(button: string, site = "the site"): string {
  return actAskLine({ kind: "confirm", site, button });
}

export function loginInstruction(site = "the site"): string {
  return actAskLine({ kind: "login", site });
}

export function makeAsk(input: {
  kind: AskKind;
  workflowId: string;
  workflowName: string;
  stepId: string;
  stepIndex: number;
  stepCount: number;
  label: string;
  button?: string;
  site?: string;
  /** Wall only: bot check or an expired session. */
  wall?: "bot" | "login";
  timeoutMs: number;
  now?: number;
  windowName?: string;
  runId?: string;
}): HumanAsk {
  const now = input.now ?? Date.now();
  const windowName = input.windowName || "Bao window";
  const site = publicSite(input.site || "the site");
  const timeoutMs = input.timeoutMs > 0 ? input.timeoutMs : 0;
  const button = input.kind === "confirm" ? (input.button || confirmButton({ label: input.label })) : undefined;
  const instruction = input.kind === "wall"
    ? wallInstruction(site, input.wall === "login" ? "login" : "bot")
    : input.kind === "confirm"
      ? confirmInstruction(button || "the button", site)
      : loginInstruction(site);
  return {
    kind: input.kind,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    stepId: input.stepId,
    stepIndex: input.stepIndex,
    stepCount: input.stepCount,
    label: input.label,
    button,
    site,
    windowName,
    instruction,
    startedAt: now,
    deadline: timeoutMs > 0 ? now + timeoutMs : null,
    timeoutMs,
    runId: input.runId,
  };
}

export function formatWait(now: number, deadline: number | null, effect: string): string {
  if (!deadline) return `Waiting · no timeout (${effect})`;
  const remain = Math.max(0, deadline - now);
  const total = Math.ceil(remain / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `Waiting ${minutes}:${String(seconds).padStart(2, "0")} · times out ${formatClock(deadline)} (${effect})`;
}

export function pendingHealCount(runs: { heals?: { id?: string }[]; decisions?: { healId: string }[] }[]): number {
  let count = 0;
  for (const run of runs) {
    const decided = new Set((run.decisions || []).map((item) => item.healId));
    for (const heal of run.heals || []) {
      if (heal.id && !decided.has(heal.id)) count += 1;
    }
  }
  return count;
}

export function attentionCount(input: {
  ask?: { kind: string } | null;
  importPhase?: string | null;
  pendingHeals: number;
  reviews?: number;
  /** A live session that saves soon unless the person keeps it open. */
  liveIdle?: boolean;
}): number {
  let count = input.pendingHeals + (input.reviews || 0);
  if (input.ask) count += 1;
  if (input.liveIdle) count += 1;
  const phase = input.importPhase;
  if (phase === "confirm" || phase === "pick" || phase === "running" || phase === "error") count += 1;
  return count;
}
