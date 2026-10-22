// The filmstrip is action time. A gap longer than 3 seconds is collapsed
// so a pause between steps does not stretch the strip or the replay video.

export interface FilmStep {
  id: string;
  startedAt?: number;
  endedAt?: number;
  /** login and confirm waits are idle inside the step, not only between steps. */
  action?: string;
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

export type IdleKind = "gap" | "login" | "handoff";

export interface PlaybackSkip extends IdleSkip {
  kind: IdleKind;
}

/** A login or confirm wait keeps this much of the step start visible. */
const WAIT_LEAD_MS = 500;

export interface HandoffTrail {
  kind?: string;
  phase?: string;
  stepId?: string;
  ts?: number;
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

/** Pair handoff start and end on the same step. An open handoff is not a finished wait. */
export function handoffSpans(trail: HandoffTrail[] | undefined): Map<string, { start: number; end: number }> {
  const open = new Map<string, number>();
  const done = new Map<string, { start: number; end: number }>();
  for (const event of trail || []) {
    if (event.kind !== "handoff" || !event.stepId || typeof event.ts !== "number") continue;
    if (event.phase === "start") open.set(event.stepId, event.ts);
    if (event.phase === "end") {
      const start = open.get(event.stepId);
      if (typeof start === "number" && event.ts > start) done.set(event.stepId, { start, end: event.ts });
    }
  }
  return done;
}

/**
 * Stretches the replay video jumps. Gaps over 3s, a login or confirm wait
 * after its first half-second, and a recorded handoff.
 */
export function playbackSkips(steps: FilmStep[], origin: number, trail?: HandoffTrail[], idleMs = IDLE_GAP_MS): PlaybackSkip[] {
  const gaps: PlaybackSkip[] = idleSkips(steps, origin, idleMs).map((item) => ({ ...item, kind: "gap" }));
  const hands = handoffSpans(trail);
  const waits: PlaybackSkip[] = [];
  for (const step of steps) {
    const hand = hands.get(step.id);
    let fromMs: number | undefined;
    let toMs: number | undefined;
    let kind: IdleKind = "handoff";
    if (hand) {
      fromMs = hand.start;
      toMs = hand.end;
      kind = "handoff";
    } else if ((step.action === "login" || step.action === "confirm") && typeof step.startedAt === "number" && typeof step.endedAt === "number" && step.endedAt - step.startedAt > idleMs) {
      fromMs = step.startedAt + WAIT_LEAD_MS;
      toMs = step.endedAt;
      kind = step.action === "login" ? "login" : "handoff";
    }
    if (typeof fromMs !== "number" || typeof toMs !== "number" || toMs - fromMs < WAIT_LEAD_MS) continue;
    const ms = toMs - fromMs;
    waits.push({
      from: Math.max(0, (fromMs - origin) / 1000),
      to: Math.max(0, (toMs - origin) / 1000),
      ms,
      kind,
      label: kind === "login" ? "login wait" : "handoff",
    });
  }
  return mergeSkips([...gaps, ...waits]);
}

function mergeSkips(items: PlaybackSkip[]): PlaybackSkip[] {
  const sorted = items.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const out: PlaybackSkip[] = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last && item.from <= last.to + 0.05) {
      last.to = Math.max(last.to, item.to);
      last.ms = Math.round((last.to - last.from) * 1000);
      if (item.kind !== "gap") {
        last.kind = item.kind;
        last.label = item.label;
      } else if (last.kind === "gap") last.label = skipLabel(last.ms);
      continue;
    }
    out.push({ ...item });
  }
  return out;
}

/** Milliseconds from the video origin through the last step. At least 1. */
export function videoSpanMs(steps: FilmStep[], origin: number): number {
  let end = origin;
  for (const step of steps) {
    if (typeof step.endedAt === "number") end = Math.max(end, step.endedAt);
    else if (typeof step.startedAt === "number") end = Math.max(end, step.startedAt);
  }
  return Math.max(1, end - origin);
}

export interface MarkerPoint {
  id: string;
  /** Seconds from the video origin. */
  videoSec: number;
  /** Percent along the same timeline the video uses. */
  left: number;
}

/** Markers sit on the video clock. A collapsed filmstrip must not place them. */
export function markerPoints(steps: FilmStep[], origin: number): MarkerPoint[] {
  const span = videoSpanMs(steps, origin);
  return steps.flatMap((step) => {
    if (typeof step.startedAt !== "number") return [];
    return [{
      id: step.id,
      videoSec: (step.startedAt - origin) / 1000,
      left: ((step.startedAt - origin) / span) * 100,
    }];
  });
}

/** Worst gap, in seconds, between a marker's place on the timeline and that step's video time. */
export function markerDriftSeconds(steps: FilmStep[], origin: number): number {
  const spanSec = videoSpanMs(steps, origin) / 1000;
  let worst = 0;
  for (const point of markerPoints(steps, origin)) {
    const placed = (point.left / 100) * spanSec;
    worst = Math.max(worst, Math.abs(placed - point.videoSec));
  }
  return worst;
}
