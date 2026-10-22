// Drop the noise around a trail, then interpret what is left.
// Reads, scrolls, a typo that was backspaced, a repeated click, and a
// Coupon-to-Cancel detour do not become steps. A click that is not undone stays.

import { interpret, type InterpretMeta, type TrailEvent } from "./interpret";
import type { WorkflowV2 } from "./schema";

const DROP_OP = new Set([
  "screenshot", "move", "wait", "zoom", "cursor", "mousedown", "mouseup",
  "dom", "ax", "navigate", "scroll",
]);

export function condense(events: readonly TrailEvent[], meta: InterpretMeta): WorkflowV2 {
  const dropped = events.filter((event) => event.kind !== "read" && !DROP_OP.has(event.op));
  const aborted = dropAborted(dropped);
  const typed = collapseTypos(aborted);
  const retried = collapseRetries(typed);
  return interpret(retried, meta);
}

function label(event: TrailEvent): string {
  return event.identity?.name || event.identity?.text || event.identity?.label || "";
}

const ABORT_OPENER = new Set(["Coupon", "Shipping"]);

function dropAborted(events: TrailEvent[]): TrailEvent[] {
  const out = events.slice();
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.op !== "click" || label(out[i]!) !== "Cancel") continue;
    let start = i;
    while (start > 0 && !ABORT_OPENER.has(label(out[start]!))) start--;
    if (!ABORT_OPENER.has(label(out[start]!))) continue;
    out.splice(start, i - start + 1);
    i = start - 1;
  }
  return out;
}

function collapseTypos(events: TrailEvent[]): TrailEvent[] {
  const out: TrailEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (!isType(event) || event.sensitive || event.gate) {
      out.push(event);
      continue;
    }
    let j = i + 1;
    let backs = 0;
    while (j < events.length && events[j]!.op === "key" && events[j]!.key === "Backspace") {
      backs++;
      j++;
    }
    const next = events[j];
    const wrong = event.value || "";
    if (next && isType(next) && sameTarget(event, next) && backs >= wrong.length && backs > 0) {
      i = j - 1;
      continue;
    }
    out.push(event);
  }
  return out;
}

function collapseRetries(events: TrailEvent[]): TrailEvent[] {
  const out: TrailEvent[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && prev.op === "click" && event.op === "click" && sameTarget(prev, event)) continue;
    out.push(event);
  }
  return out;
}

function isType(event: TrailEvent): boolean {
  return event.op === "type" || event.op === "input" || event.op === "osType" || event.op === "osSetValue";
}

function sameTarget(a: TrailEvent, b: TrailEvent): boolean {
  const left = a.identity;
  const right = b.identity;
  if (!left || !right) return false;
  return (left.id != null && left.id === right.id)
    || (left.testId != null && left.testId === right.testId)
    || (left.nameAttr != null && left.nameAttr === right.nameAttr)
    || (left.identifier != null && left.identifier === right.identifier)
    || (left.name != null && left.name === right.name && left.role === right.role && left.app === right.app);
}
