// Workflow contract v2. Replay reads this document and nothing else.
// Extension workflows stay version 1. migrate() is the only door in.

import { isSensitiveField, isSensitiveValue } from "../../../src/mask";
import { canonical } from "./canonical";

export const WORKFLOW_SCHEMA_ID = "bao.workflow/v2";

export type InputType = "text" | "secret" | "number" | "choice" | "file";
export type HealMode = "auto" | "approve";
export type Surface = "dom" | "ax" | "atspi";
export type StepAction = "click" | "type" | "key" | "upload" | "drop" | "digits" | "check" | "confirm" | "login" | "verify";

export interface WorkflowInput {
  name: string;
  type: InputType;
  label?: string;
  required?: boolean;
  /** Never a secret, and never an absolute path. */
  default?: string;
  choices?: string[];
  multiple?: boolean;
  accept?: string;
}

export interface PathSeg {
  role: string;
  name?: string;
}

/** Identity only. Coordinates are not a field. */
export interface Identity {
  surface: Surface;
  role: string;
  subrole?: string;
  identifier?: string;
  name?: string;
  title?: string;
  description?: string;
  /** Static text. Not a typed secret. */
  value?: string;
  testId?: string;
  id?: string;
  nameAttr?: string;
  tag?: string;
  label?: string;
  text?: string;
  cssPath?: string;
  windowTitle?: string;
  bundleId?: string;
  app?: string;
  path: PathSeg[];
  siblingIndex?: number;
}

export interface SelectionRule {
  by: "name" | "title" | "text" | "value";
  input: string;
}

export interface Postcondition {
  kind: "url" | "text" | "value" | "element" | "absent";
  match?: string;
  identity?: Identity;
  timeoutMs: number;
}

/** Re-read after the action. A verify step has no action of its own. */
export interface Expectation {
  kind: "text" | "url" | "state";
  match?: string;
  state?: "checked" | "unchecked" | "enabled" | "disabled" | "visible";
  identity?: Identity;
  timeoutMs: number;
}

/** Where the target sits relative to a stable element. Coordinates are not stored. */
export interface Anchor {
  identity: Identity;
  relation: "below" | "above" | "right" | "left";
}

export interface WorkflowStep {
  id: string;
  index: number;
  action: StepAction;
  label: string;
  surface: "dom" | "os";
  identity?: Identity;
  selection?: SelectionRule;
  /** A template such as "{{username}}". Literals are not secrets and not paths. */
  value?: string;
  input?: string;
  key?: string;
  checked?: boolean;
  sensitive?: boolean;
  /** A confirm or login step is done by the person. Replay does not click or type it. */
  human?: boolean;
  /** Recorded purpose of the step. Repairs compare this to the live label. */
  intent?: string;
  postcondition?: Postcondition;
  expect?: Expectation;
  anchor?: Anchor;
  timeoutMs: number;
  provenance?: { x: number; y: number; space: "viewport" | "image" | "screen" };
  unresolved?: { reason: string };
}

export interface WorkflowV2 {
  schema: typeof WORKFLOW_SCHEMA_ID;
  version: 2;
  id: string;
  name: string;
  startUrl: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt?: number;
  /** Absent means the global setting, whose default is auto. */
  heal?: HealMode;
  /** False means the workflow has not been replayed. */
  replayed?: boolean;
}

export interface ReplayArgs {
  [name: string]: string | number | FileArg | FileArg[];
}

export interface FileArg {
  name: string;
  /** Runtime only. Never written into a workflow. */
  path: string;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const TEMPLATE_RE = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

export function subst(template: string, args: ReplayArgs): string {
  return template.replace(TEMPLATE_RE, (_all, name: string) => {
    const value = args[name];
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (value && typeof value === "object" && !Array.isArray(value) && "name" in value) return value.name;
    return "";
  });
}

export function validateWorkflow(doc: WorkflowV2): string[] {
  const errors: string[] = [];
  if (doc.schema !== WORKFLOW_SCHEMA_ID) errors.push("schema");
  if (doc.version !== 2) errors.push("version");
  if (!doc.id) errors.push("id");
  if (!doc.name) errors.push("name");
  const names = new Set<string>();
  for (const input of doc.inputs) {
    if (!NAME_RE.test(input.name)) errors.push(`input name ${input.name}`);
    if (names.has(input.name)) errors.push(`duplicate input ${input.name}`);
    names.add(input.name);
    if (input.type === "secret" && input.default) errors.push(`secret default ${input.name}`);
    if (input.type === "file" && input.default && looksLikePath(input.default)) {
      errors.push(`file path default ${input.name}`);
    }
    if (input.type === "choice" && (!input.choices || input.choices.length === 0)) {
      errors.push(`choice ${input.name}`);
    }
  }
  doc.steps.forEach((step, i) => {
    if (step.index !== i) errors.push(`index ${step.id}`);
    if (step.input && !names.has(step.input)) errors.push(`unknown input ${step.input}`);
    if (step.value && looksLikePath(step.value) && !step.value.includes("{{")) {
      errors.push(`path baked into ${step.id}`);
    }
    if (step.sensitive && step.value && !step.value.includes("{{")) {
      errors.push(`secret literal ${step.id}`);
    }
    if (step.action === "confirm" && step.human !== true) errors.push(`confirm ${step.id}`);
    if ((step.action === "confirm" || step.action === "login") && step.provenance) {
      errors.push(`coordinates ${step.id}`);
    }
    if (step.action === "verify" && !step.expect && !step.postcondition) errors.push(`verify ${step.id}`);
  });
  return errors;
}

export function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || /^[A-Za-z]:\\/.test(value);
}

export function toJson(doc: WorkflowV2): string {
  return canonical(doc);
}

interface LooseStep {
  action?: string;
  label?: string;
  ts?: number;
  id?: string;
  value?: string;
  sensitive?: boolean;
  key?: string;
  checked?: boolean;
  submits?: boolean;
  url?: string;
  provenance?: WorkflowStep["provenance"];
  unresolved?: { reason: string };
  target?: { selectors?: { type?: string; value?: string }[]; text?: string };
  os?: {
    value?: string;
    target?: {
      platform?: string;
      app?: string;
      role?: string;
      name?: string;
      subrole?: string;
      title?: string;
      description?: string;
      identifier?: string;
      path?: PathSeg[];
    };
  };
  upload?: { name?: string; names?: string[] };
}

interface LooseWorkflow {
  schema?: string;
  version?: number;
  id?: string;
  name?: string;
  startUrl?: string;
  createdAt?: number;
  updatedAt?: number;
  heal?: HealMode;
  inputs?: WorkflowInput[];
  variables?: string[];
  steps?: LooseStep[];
}

/** Extension version 1, and the spike version-2 steps, both become this contract. */
export function migrate(raw: unknown): WorkflowV2 {
  const doc = (raw && typeof raw === "object" ? raw : {}) as LooseWorkflow;
  if (doc.schema === WORKFLOW_SCHEMA_ID && doc.version === 2 && Array.isArray(doc.inputs)) {
    return doc as WorkflowV2;
  }
  const id = doc.id || "wf-migrated";
  const inputs: WorkflowInput[] = [];
  const steps = (doc.steps ?? []).map((step, index) => migrateStep(step, index, id, inputs));
  return {
    schema: WORKFLOW_SCHEMA_ID,
    version: 2,
    id,
    name: doc.name || "Untitled workflow",
    startUrl: doc.startUrl || "",
    inputs,
    steps,
    createdAt: doc.createdAt ?? Date.now(),
    heal: doc.heal,
  };
}

function migrateStep(step: LooseStep, index: number, wf: string, inputs: WorkflowInput[]): WorkflowStep {
  const id = step.id || `${wf}-${index}`;
  const base: WorkflowStep = {
    id,
    index,
    action: "click",
    label: step.label || step.action || "Step",
    surface: step.os ? "os" : "dom",
    timeoutMs: 8000,
    provenance: step.provenance,
  };
  if (step.unresolved) {
    return { ...base, unresolved: step.unresolved };
  }
  if (step.action === "keypress" && step.key) {
    return { ...base, action: "key", key: step.key, identity: identityFromLoose(step) };
  }
  if (step.action === "navigate" && step.url) {
    return {
      ...base,
      action: "click",
      unresolved: { reason: "navigate is not a v2 action; open startUrl instead" },
    };
  }
  if (step.action === "uploadFile" || step.upload) {
    const input = addInput(inputs, "file", "file");
    return { ...base, action: "upload", input: input.name, value: `{{${input.name}}}`, identity: identityFromLoose(step) };
  }
  if (step.os?.target) {
    const identity = identityFromOs(step.os.target);
    if (step.action === "osSetValue" || step.action === "osType") {
      const secret = !!step.sensitive || isSensitiveValue(step.os.value || step.value || "");
      const input = addInput(inputs, secret ? "secret" : "text", secret ? "secret" : "text", identity);
      return {
        ...base,
        action: "type",
        identity,
        input: input.name,
        value: `{{${input.name}}}`,
        sensitive: secret || undefined,
      };
    }
    return { ...base, action: "click", identity };
  }
  const identity = identityFromLoose(step);
  if (step.action === "input" || (step.action === "type" && (step.value || step.sensitive))) {
    const secret = !!step.sensitive || isSensitiveValue(step.value || "") || isSensitiveField({
      name: identity?.nameAttr,
      id: identity?.id,
      ariaLabel: identity?.label,
      value: step.value,
    });
    const input = addInput(inputs, secret ? "secret" : "text", guessName(identity, secret), identity);
    if (!secret && step.value && !looksLikePath(step.value)) input.default = step.value;
    return {
      ...base,
      action: "type",
      identity,
      input: input.name,
      value: `{{${input.name}}}`,
      sensitive: secret || undefined,
    };
  }
  if (step.action === "setChecked") {
    return { ...base, action: "check", checked: !!step.checked, identity };
  }
  if (!identity && step.action !== "keypress") {
    return { ...base, unresolved: { reason: "no identity" } };
  }
  return { ...base, action: "click", identity };
}

function addInput(inputs: WorkflowInput[], type: InputType, hint: string, identity?: Identity): WorkflowInput {
  const base = type === "file" ? (hint || "file") : (identity ? guessName(identity, type === "secret") : hint);
  let name = base;
  let n = 2;
  while (inputs.some((item) => item.name === name)) name = `${base}${n++}`;
  const input: WorkflowInput = {
    name,
    type,
    required: true,
    label: name,
  };
  if (type === "secret") input.label = "Secret";
  inputs.push(input);
  return input;
}

function guessName(identity: Identity | undefined, secret: boolean): string {
  const hay = [identity?.nameAttr, identity?.id, identity?.label, identity?.name].filter(Boolean).join(" ");
  if (secret || /pass/i.test(hay)) return "password";
  if (/user|email|login/i.test(hay)) return "username";
  if (identity?.nameAttr && NAME_RE.test(identity.nameAttr)) return identity.nameAttr;
  if (identity?.id && NAME_RE.test(identity.id)) return identity.id;
  return secret ? "secret" : "text";
}

function identityFromLoose(step: LooseStep): Identity | undefined {
  if (step.os?.target) return identityFromOs(step.os.target);
  const selectors = step.target?.selectors ?? [];
  if (selectors.length === 0 && !step.target?.text) return undefined;
  const idSel = selectors.find((s) => s.type === "id")?.value;
  const testSel = selectors.find((s) => s.type === "testid")?.value;
  const css = selectors.find((s) => s.type === "css")?.value;
  const text = selectors.find((s) => s.type === "text")?.value || step.target?.text;
  return {
    surface: "dom",
    role: "unknown",
    id: attrFromSelector(idSel, "#"),
    testId: testIdFromSelector(testSel),
    cssPath: css,
    text,
    path: [],
  };
}

function identityFromOs(target: NonNullable<LooseStep["os"]>["target"]): Identity {
  const t = target || {};
  return {
    surface: t.platform === "macos" ? "ax" : "atspi",
    role: t.role || "unknown",
    subrole: t.subrole,
    identifier: t.identifier,
    name: t.name,
    title: t.title,
    description: t.description,
    app: t.app,
    path: t.path || [],
  };
}

function attrFromSelector(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return trimmed.replace(/\\/g, "") || undefined;
}

function testIdFromSelector(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/data-testid=(?:"([^"]+)"|'([^']+)')/);
  return match?.[1] || match?.[2] || value;
}
