// Copy for a step that waits on the person. Replay does not click or type these.

export type AskKind = "login" | "confirm";

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
  windowName: string;
  instruction: string;
  startedAt: number;
  deadline: number | null;
  timeoutMs: number;
}

export function confirmButton(step: { label: string; identity?: { name?: string; text?: string } }): string {
  const named = step.identity?.name || step.identity?.text;
  if (named && named.trim()) return named.trim();
  const quoted = step.label.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  return "the button";
}

export function confirmInstruction(button: string, windowName = "Bao Chrome"): string {
  return `Press ${button} in the ${windowName} window. bao will not press it.`;
}

export function loginInstruction(windowName = "Bao Chrome"): string {
  return `Sign in in the ${windowName} window. bao is not recording keystrokes in password fields.`;
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
  timeoutMs: number;
  now?: number;
  windowName?: string;
}): HumanAsk {
  const now = input.now ?? Date.now();
  const windowName = input.windowName || "Bao Chrome";
  const timeoutMs = input.timeoutMs > 0 ? input.timeoutMs : 0;
  const button = input.kind === "confirm" ? (input.button || confirmButton({ label: input.label })) : undefined;
  return {
    kind: input.kind,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    stepId: input.stepId,
    stepIndex: input.stepIndex,
    stepCount: input.stepCount,
    label: input.label,
    button,
    windowName,
    instruction: input.kind === "confirm" ? confirmInstruction(button || "the button", windowName) : loginInstruction(windowName),
    startedAt: now,
    deadline: timeoutMs > 0 ? now + timeoutMs : null,
    timeoutMs,
  };
}

export function formatWait(now: number, deadline: number | null, effect: string): string {
  if (!deadline) return `Waiting · no timeout (${effect})`;
  const remain = Math.max(0, deadline - now);
  const total = Math.ceil(remain / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(deadline));
  return `Waiting ${minutes}:${String(seconds).padStart(2, "0")} · times out ${clock} (${effect})`;
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
}): number {
  let count = input.pendingHeals;
  if (input.ask) count += 1;
  const phase = input.importPhase;
  if (phase === "confirm" || phase === "pick" || phase === "running" || phase === "error") count += 1;
  return count;
}
