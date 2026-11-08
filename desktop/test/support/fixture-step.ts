// Builds a v4 step for tests. Not a reader of old workflow files.

import { citeIdentity, caption, clickSentence, openSentence, typeSentence } from "../../src/v1/caption";
import { locatorsFromIdentity } from "../../src/v1/locators";
import {
  hintFromIdentity,
  type Check,
  type Identity,
  type StepCaption,
  type StepLocator,
  type Target,
  type TargetBox,
  type TextOf,
  type WorkflowInput,
  type WorkflowStep,
  type WorkflowV2,
  WORKFLOW_SCHEMA_ID,
} from "../../src/v1/schema";

export interface FixtureDraft {
  id: string;
  action: WorkflowStep["action"];
  index?: number;
  timeoutMs?: number;
  label?: string;
  caption?: StepCaption;
  identity?: Identity;
  locators?: StepLocator[];
  value?: string;
  input?: string;
  key?: string;
  checked?: boolean;
  sensitive?: boolean;
  expect?: { kind?: string; match?: string; state?: string; timeoutMs?: number; identity?: Identity };
  postcondition?: { kind?: string; match?: string; timeoutMs?: number; identity?: Identity };
  check?: Check;
  targetBox?: TargetBox;
  url?: string;
  optional?: "dismiss";
  heal?: WorkflowStep["heal"];
  when?: WorkflowStep["when"];
  text?: string;
  reason?: string;
  ms?: number;
  literal?: boolean;
  download?: { output: string; name: string; url?: string };
  open?: { target: "url"; url: string } | { target: "file"; file: string; app?: string };
  extract?: Extract<WorkflowStep, { action: "extract" }>["extract"];
  forEach?: Extract<WorkflowStep, { action: "for_each" }>["forEach"];
  date?: { input: string; endInput?: string };
  fileFrom?: string;
  selection?: Extract<WorkflowStep, { action: "click" }>["selection"];
  reveal?: StepLocator;
}

export function fixtureStep(draft: FixtureDraft): WorkflowStep {
  const index = draft.index ?? 0;
  const timeoutMs = draft.timeoutMs ?? 8000;
  const target = targetOf(draft);
  const check = draft.check ?? checkOf(draft);
  const sentence = draft.caption?.text || draft.label || defaultSentence(draft);
  const cite = draft.caption?.citation ?? citeIdentity(draft.identity);
  const box = draft.caption?.targetBox ?? draft.targetBox;
  const base = {
    id: draft.id,
    index,
    timeoutMs,
    caption: draft.caption ?? caption(sentence, cite, box),
    ...(draft.when ? { when: draft.when } : {}),
    ...(draft.heal ? { heal: draft.heal } : {}),
  };
  switch (draft.action) {
    case "click":
      return { ...base, action: "click", target: target ?? { locators: [{ kind: "role", role: "button", name: draft.label || "Click" }] }, ...(check ? { check } : {}), ...(draft.optional ? { optional: draft.optional } : {}), ...(draft.selection ? { selection: draft.selection } : {}) };
    case "type":
    case "select":
      return { ...base, action: draft.action, target: target ?? { locators: [{ kind: "role", role: "textbox", name: draft.label || "Field" }] }, text: textOf(draft), ...(draft.sensitive ? { sensitive: true } : {}), ...(check ? { check } : {}) };
    case "key":
      return { ...base, action: "key", key: draft.key || "Enter", ...(target ? { target } : {}), ...(check ? { check } : {}) };
    case "check":
      return { ...base, action: "check", target: target ?? { locators: [{ kind: "role", role: "checkbox", name: draft.label || "Check" }] }, checked: draft.checked !== false, ...(check ? { check } : {}) };
    case "navigate":
      return { ...base, action: "navigate", url: draft.url || draft.value || "https://example.test/", caption: caption(sentence), ...(check ? { check } : {}) };
    case "verify":
      return { ...base, action: "verify", check: check ?? { kind: "settled", timeoutMs: 4000 }, caption: caption(sentence) };
    case "login":
      return { ...base, action: "login", caption: caption(draft.label || "Sign in"), ...(check ? { check } : {}) };
    case "upload":
    case "drop":
      return { ...base, action: draft.action, target: target ?? { locators: [{ kind: "css", value: "input[type=file]" }] }, file: draft.fileFrom ? { fromOutput: draft.fileFrom } : { input: draft.input || "file" }, ...(check ? { check } : {}) };
    case "extract":
      return { ...base, action: "extract", caption: caption(sentence), extract: draft.extract ?? { mode: "element", as: "item", locators: [{ kind: "css", value: "body" }], columns: [{ name: "text", type: "text", read: "text", locators: [{ kind: "css", value: "body" }] }] }, heal: "never" };
    case "for_each":
      return { ...base, action: "for_each", caption: caption(sentence), forEach: draft.forEach ?? { over: { kind: "extract", name: "item" }, steps: [] } };
    case "note":
      return { ...base, action: "note", text: draft.text || draft.label || "Note", caption: caption(sentence) };
    case "download":
      return { ...base, action: "download", caption: caption(sentence), download: draft.download ?? { output: "file", name: "file.txt" }, ...(check ? { check } : {}) };
    case "open":
      return { ...base, action: "open", caption: caption(sentence), open: draft.open ?? { target: "url", url: draft.url || "https://example.test/" }, ...(check ? { check } : {}) };
    case "digits":
      return { ...base, action: "digits", text: textOf(draft), ...(target ? { target } : {}), ...(check ? { check } : {}) };
    case "pickDate":
      return { ...base, action: "pickDate", date: draft.date ?? { input: draft.input || "date" }, ...(target ? { target } : {}), ...(check ? { check } : {}) };
    case "wait":
      return { ...base, action: "wait", reason: draft.reason || draft.label || "the page", caption: caption(sentence), ...(draft.ms ? { ms: draft.ms } : {}) };
    case "finish":
      return { ...base, action: "finish", caption: caption(sentence), ...(draft.reason ? { reason: draft.reason } : {}) };
    default:
      return { ...base, action: "note", text: draft.label || "Step", caption: caption(sentence) };
  }
}

export function fixtureWorkflow(partial: Partial<WorkflowV2> & Pick<WorkflowV2, "id" | "name" | "steps">): WorkflowV2 {
  return {
    schema: WORKFLOW_SCHEMA_ID,
    startUrl: "https://example.test/",
    createdAt: 1,
    inputs: [],
    ...partial,
    steps: partial.steps.map((step, index) => ({ ...step, index })),
  };
}

export function fixtureInput(partial: Partial<WorkflowInput> & Pick<WorkflowInput, "name" | "type">): WorkflowInput {
  const saved = partial.supply === "saved" || (partial.supply !== "must" && !!partial.default && partial.type !== "secret" && partial.type !== "file");
  return {
    label: partial.label || partial.name,
    supply: saved ? "saved" : "must",
    ...partial,
    supply: partial.supply ?? (saved ? "saved" : "must"),
  };
}

function targetOf(draft: FixtureDraft): Target | undefined {
  const locators = draft.locators ?? locatorsFromIdentity(draft.identity);
  if (!locators?.length && !draft.identity) return undefined;
  const hint = hintFromIdentity(draft.identity);
  return {
    locators: locators ?? [],
    ...(hint ? { hint } : {}),
    ...(draft.reveal ? { reveal: draft.reveal } : {}),
  };
}

function textOf(draft: FixtureDraft): TextOf {
  if (draft.input && !draft.literal) return { input: draft.input };
  return { literal: draft.value ?? draft.text ?? "" };
}

function checkOf(draft: FixtureDraft): Check | undefined {
  const raw = draft.expect ?? draft.postcondition;
  if (!raw?.kind) return undefined;
  const timeoutMs = raw.timeoutMs ?? 4000;
  if (raw.kind === "settled") return { kind: "settled", timeoutMs };
  if (raw.kind === "state" && draft.expect?.state) {
    const locators = locatorsFromIdentity(raw.identity) ?? targetOf(draft)?.locators ?? [];
    return { kind: "state", state: draft.expect.state as "checked", locators, timeoutMs };
  }
  if (raw.kind === "element" || raw.kind === "absent") {
    return { kind: raw.kind, locators: locatorsFromIdentity(raw.identity) ?? [{ kind: "text", value: raw.match || "item" }], timeoutMs };
  }
  if (raw.kind === "text" || raw.kind === "url" || raw.kind === "value") return { kind: raw.kind, match: raw.match || "", timeoutMs };
  return undefined;
}

function defaultSentence(draft: FixtureDraft): string {
  if (draft.action === "navigate") return openSentence(draft.url || draft.value);
  if (draft.action === "type" || draft.action === "select") return typeSentence(draft.identity?.label || draft.identity?.name, draft.sensitive);
  if (draft.action === "click") return clickSentence(draft.identity?.name || draft.identity?.text || draft.identity?.label);
  if (draft.action === "key") return `Press ${draft.key || "Enter"}`;
  if (draft.action === "login") return "Sign in";
  if (draft.action === "wait") return `Wait ${draft.reason || "the page"}`;
  if (draft.action === "extract") return `Read ${draft.extract?.as || "the page"}`;
  if (draft.action === "finish") return draft.reason ? `Finish: ${draft.reason}` : "Finish";
  return draft.action;
}
