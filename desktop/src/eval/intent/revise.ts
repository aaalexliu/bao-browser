// Prompt and validator for the model condenser.
// Three rules, applied to whatever trail the model saw:
// a later step keeps the earlier step whose effect it uses,
// a click with no remaining effect is not login or confirm,
// and a backspaced value keeps only the replacement.
// Nothing here names a fixture.

import type { TrailEvent } from "../../v1/interpret";
import type { WorkflowStep } from "../../v1/schema";

export interface HumanMark {
  id: string;
  gate: "login" | "confirm";
}

export interface ModelDecision {
  keep: string[];
  human: HumanMark[];
  secrets: string[];
}

const NOISE = new Set([
  "screenshot", "move", "wait", "zoom", "cursor", "mousedown", "mouseup",
  "dom", "ax", "navigate", "scroll",
]);

const RULES = [
  "Never drop a step whose effect a later step depends on. Keep the click that opened the page a later step uses, the click whose control contains a later step, and the type whose value a later key or submit uses. Keep the last click, type, or key that still has an effect.",
  "Never mark a click as login or confirm when it changed nothing. A click undone by Back has no effect: drop it, and do not mark it login or confirm. Login is a password, a pin, or a Log in or Sign in click. Confirm is a Confirm click.",
  "When Backspace wipes a typed value and a later type on the same field replaces it, keep only the final value.",
];

export function modelCondensePrompt(events: readonly TrailEvent[]): string {
  const lines = events.map((event) => {
    const target = event.identity?.testId || event.identity?.id || event.identity?.name || event.identity?.nameAttr || "-";
    return [event.id, event.kind, event.op, target, event.value || "-", event.key || "-"].join(" ");
  });
  return [
    "Condense this UI trail into the intended workflow.",
    "Drop reads, scrolls, a value that was wiped with Backspace, a repeated click, a Help click, and a Coupon path that ends at Cancel.",
    "Keep the actions that finish the task, in order.",
    ...RULES,
    "Password and pin events are secrets.",
    "Reply with JSON only: {\"keep\":[\"id\"],\"human\":[{\"id\":\"id\",\"gate\":\"login\"}],\"secrets\":[\"id\"]}",
    "Events, one per line: id kind op target value key",
    ...lines,
  ].join("\n");
}

/** Same gate rule the model-only prompt enforces, for the hybrid human list. */
export const HYBRID_GATE_RULE = RULES[1]!;

export function reviseDecision(events: readonly TrailEvent[], decision: ModelDecision): ModelDecision {
  const known = new Set(events.map((event) => event.id));
  const keep = new Set(decision.keep.filter((id) => known.has(id)));
  const { drop, groups } = typoGroups(events);
  for (const group of groups) {
    const mentioned = group.drop.some((id) => keep.has(id)) || (group.final != null && keep.has(group.final));
    for (const id of group.drop) keep.delete(id);
    if (mentioned && group.final) keep.add(group.final);
  }
  const undone = undoneClicks(events);
  for (const index of undone) keep.delete(events[index]!.id);
  for (const event of events) if (event.op === "back") keep.delete(event.id);

  const last = lastEffect(events, undone, drop);
  if (last != null) keep.add(events[last]!.id);

  const indexOf = new Map(events.map((event, index) => [event.id, index]));
  for (let guard = 0; guard < events.length; guard++) {
    let added = false;
    for (const id of [...keep]) {
      const later = indexOf.get(id);
      if (later == null) continue;
      for (let earlier = 0; earlier < later; earlier++) {
        const event = events[earlier]!;
        if (keep.has(event.id) || drop.has(event.id) || undone.has(earlier)) continue;
        if (!depends(events, earlier, later, undone)) continue;
        keep.add(event.id);
        added = true;
      }
    }
    if (!added) break;
  }

  const ordered = withoutEmptyClicks(events, [...keep], indexOf);
  const human = decision.human.filter((mark) => {
    const index = indexOf.get(mark.id);
    return index != null && allowGate(events, index, mark.gate, undone);
  });
  const secrets = decision.secrets.filter((id) => known.has(id));
  return { keep: ordered, human, secrets };
}

export function reviseStepGates(steps: readonly WorkflowStep[], human: readonly HumanMark[]): HumanMark[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return human.filter((mark) => {
    const step = byId.get(mark.id);
    return !!step && allowStepGate(step, mark.gate);
  });
}

function allowStepGate(step: WorkflowStep, gate: "login" | "confirm"): boolean {
  if (step.gate === gate) return true;
  if (noEffectStep(step)) return false;
  if (gate === "login") return step.sensitive === true || credentialText(stepText(step)) || loginText(stepText(step));
  return confirmText(stepText(step));
}

function noEffectStep(step: WorkflowStep): boolean {
  if (step.action !== "click") return false;
  if (step.postcondition) return false;
  return !step.expect || step.expect.kind === "settled";
}

function stepText(step: WorkflowStep): string {
  const id = step.identity;
  return [id?.name, id?.text, id?.label, id?.nameAttr, id?.id, id?.testId, step.label].filter(Boolean).join(" ");
}

interface TypoGroup {
  drop: string[];
  final: string | null;
}

function typoGroups(events: readonly TrailEvent[]): { drop: Set<string>; groups: TypoGroup[] } {
  const acts = events.filter((event) => event.kind !== "read" && !NOISE.has(event.op));
  const drop = new Set<string>();
  const groups: TypoGroup[] = [];
  for (let i = 0; i < acts.length; i++) {
    const event = acts[i]!;
    if (!isType(event) || event.sensitive || event.gate) continue;
    let j = i + 1;
    let backs = 0;
    while (j < acts.length && acts[j]!.op === "key" && acts[j]!.key === "Backspace") {
      backs++;
      j++;
    }
    const next = acts[j];
    const wrong = event.value || "";
    const replaced = !!(next && isType(next) && sameTarget(event, next) && backs > 0);
    const wiped = backs >= wrong.length && backs > 0 && !replaced;
    if (!replaced && !wiped) continue;
    const gone = [event.id];
    for (let k = i + 1; k < j; k++) gone.push(acts[k]!.id);
    for (const id of gone) drop.add(id);
    groups.push({ drop: gone, final: replaced && next ? next.id : null });
    i = j - 1;
  }
  return { drop, groups };
}

function undoneClicks(events: readonly TrailEvent[]): Set<number> {
  const undone = new Set<number>();
  const surviving: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind === "read" || NOISE.has(event.op)) continue;
    if (event.op === "back") {
      const prev = surviving[surviving.length - 1];
      if (prev != null && events[prev]!.op === "click") {
        surviving.pop();
        undone.add(prev);
      }
      continue;
    }
    surviving.push(i);
  }
  return undone;
}

function lastEffect(events: readonly TrailEvent[], undone: ReadonlySet<number>, drop: ReadonlySet<string>): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === "read" || NOISE.has(event.op) || event.op === "back") continue;
    if (drop.has(event.id) || undone.has(i)) continue;
    if (event.op === "click") {
      if (clickChangedState(event)) return i;
      continue;
    }
    if (isType(event)) return i;
    if ((event.op === "key" || event.op === "keypress") && event.key && !isModifier(event.key)) return i;
    if (event.op === "upload" || event.op === "drop" || event.op === "check" || event.op === "select") return i;
  }
  return null;
}

function isModifier(key: string): boolean {
  return /^(backspace|tab|shift|control|alt|meta|escape|arrow(?:up|down|left|right))$/i.test(key);
}

function depends(events: readonly TrailEvent[], earlier: number, later: number, undone: ReadonlySet<number>): boolean {
  if (undone.has(earlier)) return false;
  const left = events[earlier]!;
  const right = events[later]!;
  if (left.kind === "read" || NOISE.has(left.op) || left.op === "back") return false;
  if (isType(left) && usesTypedValue(events, earlier, later)) return true;
  if (left.op === "click" && clickChangedState(left) && pageOpenedBy(left, right)) return true;
  if (left.op === "click" && containsControl(left, right)) return true;
  if (left.op === "click" && (typeof left.checked === "boolean" || valueChanged(left)) && submits(right) && samePage(events, earlier, later)) {
    return true;
  }
  return false;
}

function usesTypedValue(events: readonly TrailEvent[], earlier: number, later: number): boolean {
  const typed = events[earlier]!;
  const next = events[later]!;
  if (sameTarget(typed, next)) return true;
  if (submits(next) && samePage(events, earlier, later)) return true;
  const url = `${next.beforeUrl || ""} ${next.afterUrl || ""}`;
  return urlUses(url, typed.value);
}

function submits(event: TrailEvent): boolean {
  if ((event.op === "key" || event.op === "keypress") && /^(enter|return)$/i.test(event.key || "")) return true;
  if (event.op !== "click") return false;
  return /\b(search|submit|go|log\s*in|login|sign\s*in|signin)\b/i.test(controlText(event));
}

function pageOpenedBy(click: TrailEvent, later: TrailEvent): boolean {
  if (!click.beforeUrl || !click.afterUrl || click.beforeUrl === click.afterUrl) return false;
  return later.beforeUrl === click.afterUrl && later.beforeUrl !== click.beforeUrl;
}

function containsControl(click: TrailEvent, later: TrailEvent): boolean {
  const outer = click.identity?.cssPath;
  const inner = later.identity?.cssPath;
  if (!outer || !inner || inner === outer) return false;
  return inner.startsWith(`${outer} >`) || inner.startsWith(`${outer}>`) || inner.startsWith(`${outer} `);
}

function samePage(events: readonly TrailEvent[], earlier: number, later: number): boolean {
  const left = events[earlier]!;
  const right = events[later]!;
  if (left.afterUrl && right.beforeUrl) return left.afterUrl === right.beforeUrl;
  if (left.beforeUrl && right.beforeUrl) return left.beforeUrl === right.beforeUrl;
  for (let i = earlier + 1; i < later; i++) {
    const event = events[i]!;
    if (event.op === "click" && event.beforeUrl && event.afterUrl && event.beforeUrl !== event.afterUrl) return false;
  }
  return true;
}

function urlUses(url: string, value: string | undefined): boolean {
  if (!value || value.length < 2) return false;
  const forms = [value, encodeURIComponent(value), value.replace(/ /g, "+")];
  return forms.some((form) => {
    if (!form) return false;
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[?&=/])${escaped}(?:$|[?&=/#])`).test(url);
  });
}

/** A click the trail saw sit still is not a step once some other kept step has an effect. */
function withoutEmptyClicks(events: readonly TrailEvent[], ids: readonly string[], indexOf: ReadonlyMap<string, number>): string[] {
  const ordered = events.filter((event) => ids.includes(event.id)).map((event) => event.id);
  const empty = new Set(ordered.filter((id) => {
    const event = events[indexOf.get(id)!]!;
    return event.op === "click" && !clickChangedState(event) && observedStill(event);
  }));
  if (empty.size === 0 || empty.size === ordered.length) return ordered;
  return ordered.filter((id) => !empty.has(id));
}

function allowGate(events: readonly TrailEvent[], index: number, gate: "login" | "confirm", undone: ReadonlySet<number>): boolean {
  const event = events[index]!;
  if (undone.has(index)) return false;
  if (event.op === "click" && !clickChangedState(event) && observedStill(event)) return false;
  if (gate === "confirm") return confirmText(controlText(event));
  return isCredential(event) || loginText(controlText(event));
}

function clickChangedState(event: TrailEvent): boolean {
  if (event.dialog) return true;
  if (event.beforeUrl && event.afterUrl && event.beforeUrl !== event.afterUrl) return true;
  if (typeof event.checked === "boolean") return true;
  if (valueChanged(event)) return true;
  if (event.subtreeBefore != null && event.subtreeAfter != null && event.subtreeBefore !== event.subtreeAfter) return true;
  if (event.afterText) return true;
  return false;
}

function valueChanged(event: TrailEvent): boolean {
  return event.valueBefore != null && event.valueAfter != null && event.valueBefore !== event.valueAfter;
}

function observedStill(event: TrailEvent): boolean {
  return !!event.beforeUrl && !!event.afterUrl && event.beforeUrl === event.afterUrl;
}

function isCredential(event: TrailEvent): boolean {
  if (event.sensitive) return true;
  if (event.identity?.role === "password") return true;
  return credentialText(controlText(event));
}

function controlText(event: TrailEvent): string {
  const id = event.identity;
  return [id?.name, id?.text, id?.label, id?.nameAttr, id?.id, id?.testId].filter(Boolean).join(" ");
}

function credentialText(text: string): boolean {
  return /\b(password|passcode|pin)\b/i.test(text);
}

function loginText(text: string): boolean {
  return /\b(log\s*in|login|sign\s*in|signin)\b/i.test(text);
}

function confirmText(text: string): boolean {
  return /\bconfirm\b/i.test(text);
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
