// Deterministic interpret. Same trail, same workflow bytes.
// Secrets become inputs. File paths are dropped. No model is required.

import { isSensitiveField, isSensitiveValue } from "../../../src/mask";
import { locatorsFromIdentity } from "./locators";
import type { Identity, StepLocator, WorkflowInput, WorkflowStep, WorkflowV2 } from "./schema";
import { WORKFLOW_SCHEMA_ID } from "./schema";

export interface TrailEvent {
  id: string;
  ts: number;
  kind: "read" | "act";
  op: string;
  /** live-model marks a person or model driving MCP. Scripted drivers use another label. */
  source?: { agent: string; vendor: string; adapter: string };
  unresolved?: { reason: string };
  sensitive?: boolean;
  value?: string;
  key?: string;
  pageLevel?: boolean;
  checked?: boolean;
  provenance?: WorkflowStep["provenance"];
  identity?: Identity;
  locators?: StepLocator[];
  beforeUrl?: string;
  afterUrl?: string;
  afterText?: string;
  /** Basename only. A path here is stripped, not stored. */
  fileName?: string;
  rawPath?: string;
}

export interface InterpretMeta {
  id: string;
  name?: string;
  startUrl: string;
  /** Extra exact strings that must not survive into the workflow. */
  secrets?: string[];
}

const NOISE = new Set([
  "screenshot", "move", "wait", "zoom", "cursor", "mousedown", "mouseup", "dom", "ax", "navigate",
]);

const DIGIT = /^[0-9]$/;
const OP = new Set(["+", "-", "*", "/", "×", "÷", "="]);

export function interpret(events: readonly TrailEvent[], meta: InterpretMeta): WorkflowV2 {
  const kept = events.filter(keep);
  const merged = mergeTyping(kept);
  const inputs: WorkflowInput[] = [];
  let steps = merged.map((event, index) => toStep(event, index, meta, inputs));
  steps = parameterizeDigits(steps, inputs);
  steps = steps.map((step, index) => ({ ...step, index, id: `${meta.id}-${index}` }));
  const doc: WorkflowV2 = {
    schema: WORKFLOW_SCHEMA_ID,
    version: 2,
    id: meta.id,
    name: meta.name || "Untitled workflow",
    startUrl: meta.startUrl,
    inputs,
    steps,
    createdAt: events[0]?.ts ?? 0,
  };
  assertClean(doc, meta.secrets ?? []);
  return doc;
}

function keep(event: TrailEvent): boolean {
  if (event.kind === "read") return false;
  if (NOISE.has(event.op)) return false;
  if (event.unresolved) return false;
  return true;
}

function mergeTyping(events: TrailEvent[]): TrailEvent[] {
  const out: TrailEvent[] = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    if (prev && isType(prev) && isType(event) && sameTarget(prev, event) && !event.sensitive && !prev.sensitive) {
      prev.value = (prev.value || "") + (event.value || "");
      prev.afterUrl = event.afterUrl || prev.afterUrl;
      prev.afterText = event.afterText || prev.afterText;
      prev.ts = event.ts;
      continue;
    }
    if (prev && isType(prev) && isType(event) && sameTarget(prev, event)) {
      prev.value = event.sensitive ? undefined : event.value;
      prev.sensitive = prev.sensitive || event.sensitive;
      prev.afterUrl = event.afterUrl || prev.afterUrl;
      prev.ts = event.ts;
      continue;
    }
    out.push({ ...event });
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

function toStep(event: TrailEvent, index: number, meta: InterpretMeta, inputs: WorkflowInput[]): WorkflowStep {
  const surface = event.identity?.surface === "dom" || !event.identity ? "dom" : "os";
  const identity = stripSecretValue(event.identity, meta.secrets ?? []);
  const step: WorkflowStep = {
    id: `${meta.id}-${index}`,
    index,
    action: "click",
    label: event.op,
    surface,
    identity,
    locators: scrubLocators(event.locators?.length ? event.locators : locatorsFromIdentity(identity), meta.secrets ?? []),
    timeoutMs: 8000,
    provenance: event.provenance,
  };
  if (event.op === "login" || event.op === "confirm") {
    return {
      id: `${meta.id}-${index}`,
      index,
      action: event.op,
      label: event.op === "login"
        ? "ensure logged in (import from chrome, else wait for user)"
        : "confirm before applying",
      surface: "dom",
      human: true,
      timeoutMs: 8000,
      postcondition: post(event, undefined, meta.secrets ?? []),
    };
  }
  if (event.op === "verify") {
    const read = post(event, undefined, meta.secrets ?? []);
    const match = scrub(event.afterText, meta.secrets ?? []);
    return {
      id: `${meta.id}-${index}`,
      index,
      action: "verify",
      label: "re-read the status",
      surface: "dom",
      timeoutMs: 8000,
      expect: match ? { kind: "text", match, timeoutMs: 8000 } : undefined,
      postcondition: read,
    };
  }
  if (event.op === "keypress" || event.op === "key") {
    return {
      ...step,
      action: "key",
      key: event.key || event.value,
      label: `Press ${event.key || event.value || "key"}`,
      postcondition: post(event, undefined, meta.secrets ?? []),
    };
  }
  if (event.op === "upload" || event.op === "drop") {
    const input = addInput(inputs, "file", event.op === "drop" ? "drop" : "file");
    return {
      ...step,
      action: event.op === "drop" ? "drop" : "upload",
      input: input.name,
      value: `{{${input.name}}}`,
      label: event.op === "drop" ? "Drop file" : "Upload file",
      postcondition: {
        kind: "text",
        match: event.op === "drop" ? `Dropped file: {{${input.name}}}` : `{{${input.name}}}`,
        timeoutMs: 4000,
      },
    };
  }
  if (isType(event)) {
    const secret = isSecret(event, meta.secrets ?? []);
    const kind = secret ? "secret" : numberLike(event.value) && surface === "os" ? "number" : "text";
    const input = addInput(inputs, kind, nameHint(event, secret));
    if (!secret && event.value && !event.rawPath) input.default = event.value;
    return {
      ...step,
      action: "type",
      input: input.name,
      value: `{{${input.name}}}`,
      sensitive: secret || undefined,
      label: secret ? "Type secret" : `Type {{${input.name}}}`,
      postcondition: post(event, secret ? undefined : input.name, meta.secrets ?? []),
    };
  }
  if (typeof event.checked === "boolean") {
    return {
      ...step,
      action: "check",
      checked: event.checked,
      label: event.checked ? "Check" : "Uncheck",
      postcondition: post(event, undefined, meta.secrets ?? []),
    };
  }
  const name = event.identity?.name || event.identity?.text || event.identity?.label;
  return {
    ...step,
    action: "click",
    label: name ? `Click "${name}"` : "Click",
    postcondition: post(event, undefined, meta.secrets ?? []),
  };
}

function post(event: TrailEvent, input: string | undefined, secrets: string[]): WorkflowStep["postcondition"] {
  if (event.afterUrl && event.beforeUrl && event.afterUrl !== event.beforeUrl) {
    const cleaned = scrub(event.afterUrl, secrets);
    if (cleaned) {
      const url = new URL(cleaned, "https://bao.local");
      return { kind: "url", match: url.pathname, timeoutMs: 8000 };
    }
  }
  if (input) return { kind: "value", match: `{{${input}}}`, timeoutMs: 4000 };
  const text = scrub(event.afterText, secrets);
  if (text) return { kind: "text", match: text, timeoutMs: 4000 };
  if (event.identity) return { kind: "element", identity: stripSecretValue(event.identity, secrets), timeoutMs: 4000 };
  return undefined;
}

function scrub(value: string | undefined, secrets: string[]): string | undefined {
  if (!value) return value;
  let out = value;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("");
  }
  return out.trim() ? out : undefined;
}

function isSecret(event: TrailEvent, secrets: string[]): boolean {
  if (event.sensitive) return true;
  if (event.value && secrets.includes(event.value)) return true;
  if (event.value && isSensitiveValue(event.value)) return true;
  const id = event.identity;
  return isSensitiveField({
    type: id?.role === "password" ? "password" : undefined,
    name: id?.nameAttr,
    id: id?.id,
    ariaLabel: id?.label || id?.name,
    value: event.value,
  });
}

function numberLike(value: string | undefined): boolean {
  return !!value && /^-?\d+(\.\d+)?$/.test(value);
}

function nameHint(event: TrailEvent, secret: boolean): string {
  const hay = [event.identity?.nameAttr, event.identity?.id, event.identity?.label, event.identity?.name]
    .filter(Boolean)
    .join(" ");
  if (secret || /pass/i.test(hay)) return "password";
  if (/user|email|login/i.test(hay)) return "username";
  if (event.identity?.nameAttr && /^[A-Za-z][A-Za-z0-9_]*$/.test(event.identity.nameAttr)) return event.identity.nameAttr;
  if (event.identity?.id && /^[A-Za-z][A-Za-z0-9_]*$/.test(event.identity.id)) return event.identity.id;
  return secret ? "secret" : "text";
}

function addInput(inputs: WorkflowInput[], type: WorkflowInput["type"], hint: string): WorkflowInput {
  let name = hint || "text";
  let n = 2;
  while (inputs.some((item) => item.name === name)) name = `${hint}${n++}`;
  const input: WorkflowInput = { name, type, required: true, label: name };
  inputs.push(input);
  return input;
}

function scrubLocators(list: StepLocator[] | undefined, secrets: string[]): StepLocator[] | undefined {
  if (!list || list.length === 0) return undefined;
  const out = list.flatMap((locator) => {
    const blob = `${locator.name || ""} ${locator.value || ""}`;
    if (secrets.some((secret) => secret && blob.includes(secret))) return [];
    return [locator];
  });
  return out.length ? out : undefined;
}

function stripSecretValue(identity: Identity | undefined, secrets: string[]): Identity | undefined {
  if (!identity) return undefined;
  const copy = { ...identity, path: identity.path.map((seg) => ({ ...seg })) };
  if (copy.value && (secrets.includes(copy.value) || isSensitiveValue(copy.value))) delete copy.value;
  return copy;
}

/** 7, 7, +, 5, =  becomes digits {{a}}, click +, digits {{b}}, click = with a numeric postcondition. */
function parameterizeDigits(steps: WorkflowStep[], inputs: WorkflowInput[]): WorkflowStep[] {
  const out: WorkflowStep[] = [];
  let i = 0;
  while (i < steps.length) {
    const run = digitRun(steps, i);
    if (run.length === 0) {
      out.push(steps[i]!);
      i += 1;
      continue;
    }
    const sample = steps[i]!;
    const input = addInput(inputs, "number", inputs.some((item) => item.name === "a") ? "b" : "a");
    input.default = run.map((step) => step.identity?.name).join("");
    input.label = input.name;
    out.push({
      ...sample,
      action: "digits",
      input: input.name,
      value: `{{${input.name}}}`,
      label: `Enter {{${input.name}}}`,
      identity: sample.identity ? { ...sample.identity, name: undefined, text: undefined, title: undefined } : undefined,
      locators: undefined,
      postcondition: { kind: "element", timeoutMs: 4000 },
    });
    i += run.length;
  }
  return attachExpr(out);
}

function digitRun(steps: WorkflowStep[], start: number): WorkflowStep[] {
  const run: WorkflowStep[] = [];
  for (let i = start; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.action !== "click" || step.surface !== "os") break;
    if (!step.identity?.name || !DIGIT.test(step.identity.name)) break;
    run.push(step);
  }
  return run;
}

function attachExpr(steps: WorkflowStep[]): WorkflowStep[] {
  const nums = steps.filter((step) => step.action === "digits");
  if (nums.length < 2) return steps;
  const left = nums[0]!;
  const right = nums[1]!;
  const leftAt = steps.indexOf(left);
  const rightAt = steps.indexOf(right);
  const op = steps.slice(leftAt + 1, rightAt).find((step) => step.action === "click" && OP.has(step.identity?.name || ""));
  const equals = steps.slice(rightAt + 1).find((step) => step.identity?.name === "=");
  if (!op || !equals || !left.input || !right.input) return steps;
  const symbol = op.identity?.name === "×" ? "*" : op.identity?.name === "÷" ? "/" : op.identity?.name;
  equals.postcondition = { kind: "value", match: `{{${left.input}}}${symbol}{{${right.input}}}`, timeoutMs: 4000 };
  return steps;
}

function assertClean(doc: WorkflowV2, secrets: string[]): void {
  const blob = JSON.stringify(doc);
  for (const secret of secrets) {
    if (secret && blob.includes(secret)) {
      throw new Error("interpret kept a secret");
    }
  }
  for (const step of doc.steps) {
    if (step.value && step.value.startsWith("/") && !step.value.includes("{{")) {
      throw new Error("interpret kept a file path");
    }
  }
}
