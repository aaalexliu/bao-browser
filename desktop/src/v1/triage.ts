// A miss is sorted before a model sees it. Only a real change is healed.
// A temporary blocker and an outage stop the run. A burst of failures opens
// the circuit and auto-heal stays off until the window clears.

export type FailureClass = "change" | "blocker" | "outage";

export interface ClassifiedFailure {
  phase?: string;
  reason?: string;
  brokenAttr?: string;
  identity?: { changed?: string };
}

const OUTAGE = /net::|ERR_|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|target closed|page closed|browser has been closed|navigation|status (?:500|502|503|504)|\b50[234]\b/i;
const BLOCKER = /\bwaiting\b|overlay|spinner|not stable|intercept|detached|animat|\bdisabled\b|^gone:/i;

export function classifyFailure(failure: ClassifiedFailure): FailureClass {
  const reason = failure.reason || "";
  if (OUTAGE.test(reason)) return "outage";
  if (failure.phase === "wait_for" || BLOCKER.test(reason)) return "blocker";
  return "change";
}

export const DEFAULT_CIRCUIT_LIMIT = 3;
export const DEFAULT_CIRCUIT_WINDOW_MS = 10 * 60 * 1000;

export interface RunStamp {
  status: string;
  at: number;
}

/** True when `limit` runs have already failed inside the window. */
export function circuitOpen(
  runs: RunStamp[],
  now: number,
  opts: { limit?: number; windowMs?: number } = {},
): boolean {
  const limit = opts.limit ?? DEFAULT_CIRCUIT_LIMIT;
  const windowMs = opts.windowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
  if (limit <= 0) return false;
  const failed = runs.filter((run) => run.status === "failed" && now - run.at <= windowMs && now >= run.at);
  return failed.length >= limit;
}
