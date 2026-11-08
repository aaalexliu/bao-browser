// One spelling for a saved run. Display reads this and does not invent "refused".

export const RUN_STATUSES = ["passed", "failed", "waiting-for-sign-in", "waiting", "recording"] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export function runRecordStatus(input: {
  outcome: "passed" | "failed" | "paused" | "recording";
  pausedKind?: "signin" | "confirm" | "wall";
}): RunStatus {
  if (input.outcome === "recording") return "recording";
  if (input.outcome === "paused" && input.pausedKind === "signin") return "waiting-for-sign-in";
  if (input.outcome === "paused") return "waiting";
  if (input.outcome === "failed") return "failed";
  return "passed";
}

export function runStatusWord(status: string): string {
  if (status === "waiting-for-sign-in" || status === "needs_signin" || status === "needs-sign-in") return "waiting for sign-in";
  if (status === "failed" || status === "timed-out" || status === "timeout" || status === "stopped") return "failed";
  if (status === "waiting" || status === "needs_human" || status === "paused") return "waiting";
  if (status === "recording") return "recording";
  if (status === "passed" || status === "ok" || status === "completed") return "passed";
  return "failed";
}
