// The filmstrip is action time. A gap longer than the idle budget is dropped
// so a pause between steps does not stretch the strip.

export interface FilmStep {
  id: string;
  startedAt?: number;
  endedAt?: number;
}

export interface FilmSpan {
  id: string;
  /** Relative width. At least 1. */
  flex: number;
  /** Milliseconds of idle dropped before this step. */
  skippedMs: number;
}

export const IDLE_GAP_MS = 1000;

export function filmstripSpans(steps: FilmStep[], idleMs = IDLE_GAP_MS): FilmSpan[] {
  let prevEnd: number | undefined;
  return steps.map((step) => {
    const start = step.startedAt;
    const end = step.endedAt;
    const dur = typeof start === "number" && typeof end === "number" && end >= start ? Math.max(end - start, 1) : 1;
    let skippedMs = 0;
    if (typeof prevEnd === "number" && typeof start === "number" && start - prevEnd > idleMs) {
      skippedMs = start - prevEnd;
    }
    if (typeof end === "number") prevEnd = end;
    else if (typeof start === "number") prevEnd = start;
    return { id: step.id, flex: dur, skippedMs };
  });
}

export function idleSkippedMs(steps: FilmStep[], idleMs = IDLE_GAP_MS): number {
  return filmstripSpans(steps, idleMs).reduce((sum, span) => sum + span.skippedMs, 0);
}
