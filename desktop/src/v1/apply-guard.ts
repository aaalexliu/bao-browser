import type { WorkflowV2 } from "./schema";

export interface RunTrailEvent {
  kind: "auth" | "human-confirm" | "click" | "handoff";
  stepId: string;
  phase?: "auth" | "start" | "end";
  reason?: string;
  target?: string;
  /** Local-zone clock is already in `text`. `ts` is the same moment. */
  ts?: number;
  text?: string;
}

export interface ApplyGate {
  workflow: WorkflowV2;
  trail: RunTrailEvent[];
  /** Person-wait from Settings. Absent uses the step timeout. */
  actTimeoutMs?: number;
  /** The run that is waiting, so a restart can find the prompt. */
  runId?: string;
  /** Return as soon as a person must sign in or confirm. Replay does not click. */
  yieldHuman?: boolean;
  /** The person already acted. Confirm is observed and never pressed. */
  humanReady?: boolean;
  /** Step screenshots stay off while the person has the page. */
  shotsPaused?: boolean;
}
