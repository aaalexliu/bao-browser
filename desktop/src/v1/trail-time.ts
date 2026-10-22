// Trail events carry `ts`. Older rows sometimes do not. Fill those in order.

/** Returns a copy. Missing or non-positive timestamps become last+1, starting at 1. */
export function ensureTrailTimes<T extends { ts?: number }>(events: readonly T[]): { events: T[]; filled: number } {
  let last = 0;
  let filled = 0;
  const next = events.map((event) => {
    if (typeof event.ts === "number" && event.ts > 0) {
      last = event.ts;
      return event;
    }
    filled += 1;
    last += 1;
    return { ...event, ts: last };
  });
  return { events: next, filled };
}
