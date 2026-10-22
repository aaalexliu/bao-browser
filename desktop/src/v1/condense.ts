// Drop the noise around a trail, then interpret what is left.
// Reads, scrolls, a typo that was backspaced, a repeated click, a click
// undone by Back, and a Coupon-to-Cancel detour do not become steps.
// A click with no observed effect is dropped when its css path was recorded
// and nothing later sits inside that subtree. A button, tab, radio, or checkbox
// with no css path stays when a later step uses another control.
// A click that changed the url, a checked state, a value, or the target
// subtree stays. A JS dialog (Page.javascriptDialogOpening) stays.
// A login or confirm gate stays. A Help click stays so the hybrid pass can drop it.

import { interpret, type InterpretMeta, type TrailEvent } from "./interpret";
import type { WorkflowV2 } from "./schema";

const DROP_OP = new Set([
  "screenshot", "move", "wait", "zoom", "cursor", "mousedown", "mouseup",
  "dom", "ax", "navigate", "scroll",
]);

export function condense(events: readonly TrailEvent[], meta: InterpretMeta): WorkflowV2 {
  return interpret(prepare(events), meta);
}

/** Click ids removed by the effect filter, after the other deterministic drops. */
export function droppedNoEffectIds(events: readonly TrailEvent[]): string[] {
  const prepared = events.filter((event) => event.kind !== "read" && !DROP_OP.has(event.op));
  const before = collapseRetries(collapseTypos(dropAborted(dropBack(prepared))));
  const kept = new Set(dropNoEffect(before).map((event) => event.id));
  return before.filter((event) => event.op === "click" && !kept.has(event.id)).map((event) => event.id);
}

function prepare(events: readonly TrailEvent[]): TrailEvent[] {
  const dropped = events.filter((event) => event.kind !== "read" && !DROP_OP.has(event.op));
  const undone = dropBack(dropped);
  const aborted = dropAborted(undone);
  const typed = collapseTypos(aborted);
  const retried = collapseRetries(typed);
  return dropNoEffect(retried);
}

function dropNoEffect(events: TrailEvent[]): TrailEvent[] {
  const drop = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.op !== "click") continue;
    if (event.gate === "login" || event.gate === "confirm") continue;
    if (isHelp(event)) continue;
    if (clickChangedState(event)) continue;
    if (!observedStill(event)) continue;
    if (laterDepends(events, i)) continue;
    drop.add(i);
  }
  return events.filter((_, index) => !drop.has(index));
}

function isHelp(event: TrailEvent): boolean {
  return /\bhelp\b/i.test(label(event));
}

function clickChangedState(event: TrailEvent): boolean {
  if (event.dialog) return true;
  if (event.beforeUrl && event.afterUrl && event.beforeUrl !== event.afterUrl) return true;
  if (typeof event.checked === "boolean") return true;
  if (event.valueBefore != null && event.valueAfter != null && event.valueBefore !== event.valueAfter) return true;
  if (event.subtreeBefore != null && event.subtreeAfter != null && event.subtreeBefore !== event.subtreeAfter) return true;
  if (event.afterText) return true;
  return false;
}

/** Both urls were recorded and they match, so the click did not navigate. */
function observedStill(event: TrailEvent): boolean {
  return !!event.beforeUrl && !!event.afterUrl && event.beforeUrl === event.afterUrl;
}

function laterDepends(events: TrailEvent[], index: number): boolean {
  const path = events[index]!.identity?.cssPath;
  // The driver fixture records no css path. A tab or radio click still reveals
  // the next control. A click that only focuses the field about to be typed does not.
  if (!path) return revealsLaterTarget(events, index);
  for (let j = index + 1; j < events.length; j++) {
    const later = events[j]!;
    if (later.kind === "read" || DROP_OP.has(later.op) || later.op === "back") continue;
    const laterPath = later.identity?.cssPath;
    if (!laterPath || laterPath === path) continue;
    if (laterPath.startsWith(`${path} >`) || laterPath.startsWith(`${path}>`) || laterPath.startsWith(`${path} `)) {
      return true;
    }
  }
  return false;
}

/** A button, tab, radio, or checkbox with no css path stays when a later step uses another control. */
function revealsLaterTarget(events: TrailEvent[], index: number): boolean {
  const event = events[index]!;
  const role = event.identity?.role || "";
  if (!/^(button|radio|checkbox|tab|switch)$/i.test(role)) return false;
  const next = nextAct(events, index);
  if (next && (next.op === "type" || next.op === "key") && sameControl(event, next)) return false;
  for (let j = index + 1; j < events.length; j++) {
    const later = events[j]!;
    if (later.kind === "read" || DROP_OP.has(later.op) || later.op === "back") continue;
    if (!sameControl(event, later)) return true;
  }
  return false;
}

function nextAct(events: TrailEvent[], index: number): TrailEvent | undefined {
  for (let j = index + 1; j < events.length; j++) {
    const later = events[j]!;
    if (later.kind === "read" || DROP_OP.has(later.op)) continue;
    return later;
  }
  return undefined;
}

function sameControl(a: TrailEvent, b: TrailEvent): boolean {
  const left = a.identity?.id || a.identity?.testId;
  const right = b.identity?.id || b.identity?.testId;
  return !!left && left === right;
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

function dropBack(events: TrailEvent[]): TrailEvent[] {
  const out: TrailEvent[] = [];
  for (const event of events) {
    if (event.op !== "back") {
      out.push(event);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.op === "click") out.pop();
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
    const replaced = !!(next && isType(next) && sameTarget(event, next) && backs > 0);
    const wiped = backs >= wrong.length && backs > 0 && !replaced;
    if (replaced || wiped) {
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
    || (left.name != null && left.name === right.name && left.role === right.role && left.app === right.app)
    || (left.cssPath != null && left.cssPath === right.cssPath);
}
