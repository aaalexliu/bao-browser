// The filmstrip is action time. A gap longer than 3 seconds is collapsed
// so a pause between steps does not stretch the strip or the replay video.

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

/** Idle longer than this is collapsed. A 2s pause stays. A 12s pause becomes "skipped 12s". */
export const IDLE_GAP_MS = 3000;

export function skipLabel(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `skipped ${seconds}s`;
}

export interface IdleSkip {
  /** Seconds from the video origin. */
  from: number;
  to: number;
  label: string;
  ms: number;
}

/** Gaps the video player jumps. Times are seconds in the replay video. */
export function idleSkips(steps: FilmStep[], origin: number, idleMs = IDLE_GAP_MS): IdleSkip[] {
  let prevEnd: number | undefined;
  const out: IdleSkip[] = [];
  for (const step of steps) {
    const start = step.startedAt;
    const end = step.endedAt;
    if (typeof prevEnd === "number" && typeof start === "number" && start - prevEnd > idleMs) {
      const ms = start - prevEnd;
      out.push({
        from: Math.max(0, (prevEnd - origin) / 1000),
        to: Math.max(0, (start - origin) / 1000),
        label: skipLabel(ms),
        ms,
      });
    }
    if (typeof end === "number") prevEnd = end;
    else if (typeof start === "number") prevEnd = start;
  }
  return out;
}

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
