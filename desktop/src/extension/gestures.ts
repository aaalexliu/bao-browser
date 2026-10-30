// Replay timing comes from the recording. Empty key gaps mean the field was filled at once.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Gesture } from "./protocol";

export const CONSUMING_ACTIONS = new Set([
  "click",
  "type",
  "key",
  "upload",
  "drop",
  "check",
  "select",
  "navigate",
]);

export function emptyGesture(): Gesture {
  return { dwellMs: 0, pointer: [], keyGaps: [] };
}

/** A positive cap shortens a recording. Unset means the recorded times are used as they are. */
export function gestureCapFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.BAO_GESTURE_MAX_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function clampGesture(gesture: Gesture, maxMs: number | undefined): Gesture {
  if (maxMs == null || !(maxMs > 0)) {
    const { maxMs: _drop, ...rest } = gesture;
    return rest;
  }
  return {
    dwellMs: Math.min(Math.max(0, gesture.dwellMs || 0), maxMs),
    pointer: (gesture.pointer || []).map((sample) => ({
      dt: Math.min(Math.max(0, sample.dt || 0), maxMs),
      x: sample.x,
      y: sample.y,
    })),
    keyGaps: (gesture.keyGaps || []).map((gap) => Math.min(Math.max(0, gap), maxMs)),
    maxMs,
  };
}

export function dwellBetween(previous: number | undefined, at: number): number {
  if (previous == null || at < previous) return 0;
  return Math.round(at - previous);
}

/**
 * One gesture per step that replay will actually perform.
 * Confirm, extract, and verify do not consume one: they do not click or type.
 */
export function gestureQueue(
  steps: readonly { action: string }[],
  groups: readonly { id: string; op: string }[][],
  byEvent: ReadonlyMap<string, Gesture>,
): Gesture[] {
  const out: Gesture[] = [];
  steps.forEach((step, index) => {
    if (!CONSUMING_ACTIONS.has(step.action)) return;
    const group = groups[index] || [];
    const act = [...group].reverse().find((event) => CONSUMING_ACTIONS.has(event.op)) || group[0];
    out.push(act ? byEvent.get(act.id) || emptyGesture() : emptyGesture());
  });
  return out;
}

export function writeGestures(home: string, workflowId: string, steps: readonly Gesture[]): void {
  const dir = path.join(home, "gestures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${workflowId}.json`), `${JSON.stringify({ version: 1, steps }, null, 2)}\n`);
}

export function readGestures(home: string, workflowId: string): Gesture[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(home, "gestures", `${workflowId}.json`), "utf8")) as { steps?: Gesture[] };
    return Array.isArray(parsed.steps) ? parsed.steps : [];
  } catch {
    return [];
  }
}

/** No recorded gaps means one assignment. A cadence uses the gaps the recording stored. */
export function fillPlan(text: string, keyGaps: readonly number[] | undefined): { mode: "once" | "cadence"; gaps: number[] } {
  if (!text || !keyGaps || keyGaps.length === 0) return { mode: "once", gaps: [] };
  return { mode: "cadence", gaps: [...keyGaps] };
}
