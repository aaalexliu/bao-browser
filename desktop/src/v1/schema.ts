// Workflow contract. Replay reads this document and nothing else.
// A file with any other schema id is not loaded.

import { canonical } from "./canonical";
import { INPUT_BINDING } from "./bindings";
import { validateDataSteps, type ExtractSpec, type ForEachSpec, type WorkflowOutput } from "./data-steps";
import { filesDatesErrors } from "./files-dates-check";

export const WORKFLOW_SCHEMA_ID = "bao.workflow/v4";
export const RUN_SCHEMA_ID = "bao.run/v4";

export type InputType = "text" | "secret" | "number" | "choice" | "file" | "date" | "table";
export type HealMode = "auto" | "approve";
export type Surface = "dom" | "ax" | "atspi";
export type CitationSource = "text" | "name" | "label" | "aria-label" | "placeholder" | "alt" | "title";

export class UnsupportedWorkflow extends Error {
  constructor(readonly schemaId: string) {
    super(`unsupported workflow schema ${schemaId}`);
    this.name = "UnsupportedWorkflow";
  }
}

export interface WorkflowReceipt {
  id: string;
  status: string;
  readBack: string;
}

export interface WorkflowInput {
  name: string;
  type: InputType;
  label: string;
  /** saved: a non-secret default is stored and the run may omit it. must: the run supplies the value. */
  supply: "saved" | "must";
  default?: string;
  askOnImport?: boolean;
  example?: string;
  choices?: string[];
  multiple?: boolean;
  accept?: string;
  format?: string;
  relative?: string;
  zone?: string;
  fromOutput?: string;
}

export interface PathSeg {
  role: string;
  name?: string;
}

/** A live page or AX node. Not stored on a step. */
export interface Identity {
  surface: Surface;
  role: string;
  subrole?: string;
  identifier?: string;
  name?: string;
  title?: string;
  description?: string;
  value?: string;
  testId?: string;
  id?: string;
  nameAttr?: string;
  placeholder?: string;
  tag?: string;
  inputType?: string;
  autocomplete?: string;
  label?: string;
  text?: string;
  cssPath?: string;
  xpath?: string;
  href?: string;
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

export interface StepCaption {
  /** Plain sentence. Never an @e ref. */
  text: string;
  citation?: { text: string; source: CitationSource };
  targetBox?: TargetBox;
}

export interface TargetBox {
  x: number;
  y: number;
  width: number;
  height: number;
  viewport: { width: number; height: number };
}

/** Fields the matcher reads that a locator does not carry. */
export interface TargetHint {
  label?: string;
  nameAttr?: string;
  role?: string;
  surface?: Surface;
  path?: PathSeg[];
}

export interface AnchorRef {
  role: string;
  name?: string;
  text?: string;
  testId?: string;
  id?: string;
}

export interface RoleLocator {
  kind: "role";
  role: string;
  name: string;
}

export interface ValueLocator {
  kind: "text" | "testid" | "css" | "xpath";
  value: string;
}

export interface AnchorLocator {
  kind: "anchor";
  relation: "below" | "above" | "right" | "left";
  role?: string;
  anchor: AnchorRef;
}

export type StepLocator = RoleLocator | ValueLocator | AnchorLocator;
export type LocatorKind = StepLocator["kind"];

export interface HealChange {
  id: string;
  at: number;
  source: "recorded" | "heal" | "revert" | "rollback";
  runId?: string;
  score?: number;
  changed: string[];
  locators: StepLocator[];
  hint?: TargetHint;
}

export interface Target {
  locators: StepLocator[];
  hint?: TargetHint;
  reveal?: StepLocator;
  history?: HealChange[];
}

export type Check =
  | { kind: "text" | "url" | "value"; match: string; timeoutMs: number }
  | { kind: "element" | "absent"; locators: StepLocator[]; hint?: TargetHint; timeoutMs: number }
  | { kind: "state"; state: "checked" | "unchecked" | "enabled" | "disabled" | "visible"; locators: StepLocator[]; timeoutMs: number }
  | { kind: "settled"; timeoutMs: number };

export interface ReadBack {
  source: "value" | "text" | "url" | "file";
  match: string;
  locators?: StepLocator[];
  hint?: TargetHint;
  fileInput?: string;
  timeoutMs: number;
}

export interface StepWhen {
  input?: string;
  value?: string;
  present?: string;
  absent?: string;
  anyCount?: boolean;
}

export interface Precondition {
  kind: "url";
  match: string;
  phase: "auth";
}

export type TextOf = { input: string } | { literal: string };
export type FileOf = { input: string } | { fromOutput: string };

interface StepBase {
  id: string;
  index: number;
  caption: StepCaption;
  timeoutMs: number;
  when?: StepWhen;
  heal?: "auto" | "ask" | "never";
  readBack?: ReadBack;
}

export type WorkflowStep =
  | StepBase & { action: "click"; target: Target; check?: Check; optional?: "dismiss"; selection?: SelectionRule; dialog?: { input: string } }
  | StepBase & { action: "type"; target: Target; text: TextOf; sensitive?: boolean; check?: Check }
  | StepBase & { action: "key"; key: string; target?: Target; check?: Check }
  | StepBase & { action: "check"; target: Target; checked: boolean; check?: Check }
  | StepBase & { action: "select"; target: Target; text: TextOf; check?: Check }
  | StepBase & { action: "navigate"; url: string; check?: Check }
  | StepBase & { action: "verify"; check: Check }
  | StepBase & { action: "login"; check?: Check }
  | StepBase & { action: "upload" | "drop"; target: Target; file: FileOf; check?: Check }
  | StepBase & { action: "extract"; extract: ExtractSpec; heal?: "never" }
  | StepBase & { action: "for_each"; forEach: ForEachSpec }
  | StepBase & { action: "note"; text: string }
  | StepBase & { action: "download"; download: { output: string; name: string; url?: string }; check?: Check }
  | StepBase & { action: "open"; open: { target: "url"; url: string } | { target: "file"; file: string; app?: string }; check?: Check }
  | StepBase & { action: "digits"; text: TextOf; target?: Target; check?: Check }
  | StepBase & { action: "pickDate"; date: { input: string; endInput?: string }; target?: Target; check?: Check }
  | StepBase & { action: "wait"; reason: string; ms?: number }
  | StepBase & { action: "finish"; reason?: string };

export type StepAction = WorkflowStep["action"];

export interface WorkflowV2 {
  schema: typeof WORKFLOW_SCHEMA_ID;
  id: string;
  name: string;
  startUrl: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt?: number;
  provenance?: "fixture";
  outputs?: WorkflowOutput[];
  heal?: HealMode;
  replayed?: boolean;
  readBack?: ReadBack;
  precondition?: Precondition;
  summary?: string;
  intent?: string;
  inference?: WorkflowInference;
  driver?: "playwright" | "extension";
}

export interface WorkflowInference {
  at: number;
  provider: string;
  model: string;
  status: "ok" | "skipped";
}

export interface ReplayArgs {
  [name: string]: string | number | FileArg | FileArg[];
}

export interface FileArg {
  name: string;
  path: string;
}

export interface RunStep {
  id: string;
  action: string;
  status: string;
  caption: StepCaption;
  beforeShot?: string;
  afterShot?: string;
  startedAt?: number;
  endedAt?: number;
  reason?: string;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const CITATION_SOURCES = new Set<CitationSource>(["text", "name", "label", "aria-label", "placeholder", "alt", "title"]);

export function subst(template: string, args: ReplayArgs): string {
  return template.replace(INPUT_BINDING, (_all, name: string) => {
    const value = args[name];
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (value && typeof value === "object" && !Array.isArray(value) && "name" in value) return value.name;
    return "";
  });
}

export function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || /^[A-Za-z]:\\/.test(value);
}

export function popupDismissName(identity: Identity | undefined): string {
  const name = identity?.name ?? identity?.text ?? identity?.label ?? "";
  return identity?.surface === "dom" && identity.role === "button" && /^(?:close|x|no thanks|not now|dismiss)$/i.test(name) ? name : "";
}

export function stepTitle(step: { caption?: StepCaption; action?: string; id?: string }): string {
  const text = step.caption?.text?.trim();
  const cite = step.caption?.citation?.text?.trim();
  if (!text) return step.action || step.id || "Step";
  if (!cite) return text;
  const quoted = `"${cite}"`;
  if (text.includes(quoted)) return text;
  const at = text.indexOf(cite);
  if (at >= 0) return `${text.slice(0, at)}${quoted}${text.slice(at + cite.length)}`;
  return `${text} (${quoted})`;
}

export function stepTarget(step: WorkflowStep): Target | undefined {
  switch (step.action) {
    case "click":
    case "type":
    case "check":
    case "select":
    case "upload":
    case "drop":
      return step.target;
    case "key":
    case "digits":
    case "pickDate":
      return step.target;
    default:
      return undefined;
  }
}

export function stepLocators(step: WorkflowStep): StepLocator[] | undefined {
  const target = stepTarget(step);
  return target?.locators?.length ? target.locators : undefined;
}

export function stepCheck(step: WorkflowStep): Check | undefined {
  return "check" in step ? step.check : undefined;
}

export function stepInputName(step: WorkflowStep): string | undefined {
  switch (step.action) {
    case "type":
    case "select":
    case "digits":
      return "input" in step.text ? step.text.input : undefined;
    case "upload":
    case "drop":
      return "input" in step.file ? step.file.input : undefined;
    case "click":
      return step.dialog?.input ?? step.selection?.input;
    case "pickDate":
      return step.date.input;
    default:
      return undefined;
  }
}

export function stepLiteral(step: WorkflowStep): string | undefined {
  switch (step.action) {
    case "type":
    case "select":
    case "digits":
      return "literal" in step.text ? step.text.literal : undefined;
    case "navigate":
      return step.url;
    case "note":
      return step.text;
    default:
      return undefined;
  }
}

/** A literal, or a {{input}} template, for readers that substitute at replay. */
export function stepValueTemplate(step: WorkflowStep): string | undefined {
  const literal = stepLiteral(step);
  if (literal !== undefined && step.action !== "navigate" && step.action !== "note") return literal;
  const input = stepInputName(step);
  if (input && step.action !== "click") return `{{${input}}}`;
  if (step.action === "click" && step.dialog) return `{{${step.dialog.input}}}`;
  if (step.action === "navigate") return step.url;
  return undefined;
}

export function stepKey(step: WorkflowStep): string | undefined {
  return step.action === "key" ? step.key : undefined;
}

export function queryFromTarget(target: Target | undefined): Identity | undefined {
  if (!target) return undefined;
  const role = target.locators.find((item) => item.kind === "role");
  const text = target.locators.find((item) => item.kind === "text");
  const testid = target.locators.find((item) => item.kind === "testid");
  const css = target.locators.find((item) => item.kind === "css");
  const xpath = target.locators.find((item) => item.kind === "xpath");
  const id = css?.kind === "css" && css.value.startsWith("#") ? css.value.slice(1).replace(/\\(.)/g, "$1") : undefined;
  return {
    surface: target.hint?.surface ?? "dom",
    role: (role?.kind === "role" ? role.role : target.hint?.role) || "unknown",
    name: role?.kind === "role" ? role.name : undefined,
    text: text?.kind === "text" ? text.value : undefined,
    testId: testid?.kind === "testid" ? testid.value : undefined,
    cssPath: css?.kind === "css" ? css.value : undefined,
    xpath: xpath?.kind === "xpath" ? xpath.value : undefined,
    label: target.hint?.label,
    nameAttr: target.hint?.nameAttr,
    id,
    path: target.hint?.path ?? [],
  };
}

export function stepQuery(step: WorkflowStep): Identity | undefined {
  return queryFromTarget(stepTarget(step));
}

/** Read-only view. Not stored. Display text is the quoted caption. */
export interface StepProjection {
  id: string;
  index: number;
  action: StepAction;
  caption: StepCaption;
  timeoutMs: number;
  label: string;
  identity?: Identity;
  locators?: StepLocator[];
  value?: string;
  input?: string;
  key?: string;
  checked?: boolean;
  sensitive?: boolean;
  check?: Check;
  expect?: FlatCheck;
  postcondition?: FlatCheck;
  target?: Target;
  surface: Surface;
  human: boolean;
  when?: StepWhen;
  heal?: "auto" | "ask" | "never";
  readBack?: ReadBack;
  optional?: "dismiss";
  selection?: SelectionRule;
  reveal?: StepLocator;
  history?: HealChange[];
  download?: { output: string; name: string; url?: string };
  open?: { target: "url"; url: string } | { target: "file"; file: string; app?: string };
  extract?: ExtractSpec;
  forEach?: ForEachSpec;
  datePicker?: { input: string; endInput?: string };
  fileFrom?: string;
  text?: TextOf;
  url?: string;
  dialog?: { input: string };
  intent?: string;
  waitFor?: Check;
  gone?: Check;
  unresolved?: { reason: string };
  provenance?: TargetBox;
  confirm?: undefined;
  gate?: "login";
  anchor?: undefined;
  confidence?: undefined;
}

export interface FlatCheck {
  kind: Check["kind"];
  match?: string;
  state?: "checked" | "unchecked" | "enabled" | "disabled" | "visible";
  timeoutMs: number;
  locators?: StepLocator[];
  identity?: Identity;
}

export function projectStep(step: WorkflowStep): StepProjection {
  const target = stepTarget(step);
  const check = stepCheck(step);
  const input = stepInputName(step);
  return {
    id: step.id,
    index: step.index,
    action: step.action,
    caption: step.caption,
    timeoutMs: step.timeoutMs,
    label: stepTitle(step),
    identity: stepQuery(step),
    locators: target?.locators,
    value: stepValueTemplate(step),
    input,
    key: stepKey(step),
    checked: step.action === "check" ? step.checked : undefined,
    sensitive: step.action === "type" ? step.sensitive : undefined,
    check,
    expect: flatCheck(check),
    postcondition: flatCheck(check),
    target,
    surface: target?.hint?.surface ?? "dom",
    human: step.action === "login",
    when: step.when,
    heal: step.heal,
    readBack: step.readBack,
    optional: step.action === "click" ? step.optional : undefined,
    selection: step.action === "click" ? step.selection : undefined,
    reveal: target?.reveal,
    history: target?.history,
    download: step.action === "download" ? step.download : undefined,
    open: step.action === "open" ? step.open : undefined,
    extract: step.action === "extract" ? step.extract : undefined,
    forEach: step.action === "for_each" ? step.forEach : undefined,
    datePicker: step.action === "pickDate" ? step.date : undefined,
    fileFrom: step.action === "upload" || step.action === "drop" ? ("fromOutput" in step.file ? step.file.fromOutput : undefined) : undefined,
    text: step.action === "type" || step.action === "select" || step.action === "digits" ? step.text : undefined,
    url: step.action === "navigate" ? step.url : undefined,
    dialog: step.action === "click" ? step.dialog : undefined,
    intent: step.caption.text,
    provenance: step.caption.targetBox,
    gate: step.action === "login" ? "login" : undefined,
  };
}

function flatCheck(check: Check | undefined): FlatCheck | undefined {
  if (!check) return undefined;
  return {
    kind: check.kind,
    timeoutMs: check.timeoutMs,
    match: "match" in check ? check.match : undefined,
    state: "state" in check ? check.state : undefined,
    locators: "locators" in check ? check.locators : undefined,
    identity: "locators" in check ? queryFromTarget({ locators: check.locators }) : undefined,
  };
}

export function hintFromIdentity(node: Identity | undefined): TargetHint | undefined {
  if (!node) return undefined;
  const hint: TargetHint = {};
  if (node.label) hint.label = node.label;
  if (node.nameAttr) hint.nameAttr = node.nameAttr;
  if (node.role && node.role !== "unknown") hint.role = node.role;
  if (node.surface) hint.surface = node.surface;
  if (node.path?.length) hint.path = node.path.map((seg) => ({ role: seg.role, name: seg.name }));
  return Object.keys(hint).length ? hint : undefined;
}

export function anchorRef(node: Identity): AnchorRef {
  return {
    role: node.role,
    name: node.name,
    text: node.text,
    testId: node.testId,
    id: node.id,
  };
}

export function toJson(doc: WorkflowV2): string {
  return canonical(doc);
}

export function parseWorkflow(raw: unknown): WorkflowV2 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UnsupportedWorkflow("missing");
  const schemaId = (raw as { schema?: unknown }).schema;
  if (schemaId !== WORKFLOW_SCHEMA_ID) throw new UnsupportedWorkflow(typeof schemaId === "string" ? schemaId : "missing");
  const errors = validateWorkflow(raw as WorkflowV2);
  if (errors.length) throw new Error(errors.join(", "));
  return raw as WorkflowV2;
}

export function validateWorkflow(doc: WorkflowV2): string[] {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object") return ["schema"];
  if (doc.schema !== WORKFLOW_SCHEMA_ID) errors.push("schema");
  if (!doc.id) errors.push("id");
  if (!doc.name) errors.push("name");
  if (doc.provenance !== undefined && doc.provenance !== "fixture") errors.push("provenance");
  if (doc.driver && doc.driver !== "playwright" && doc.driver !== "extension") errors.push("driver");
  if (!Array.isArray(doc.inputs) || !Array.isArray(doc.steps)) {
    errors.push("steps");
    return errors;
  }
  const names = new Set<string>();
  for (const input of doc.inputs) {
    if (!input || !NAME_RE.test(input.name || "")) errors.push(`input name ${input?.name}`);
    if (names.has(input.name)) errors.push(`duplicate input ${input.name}`);
    names.add(input.name);
    if (input.supply !== "saved" && input.supply !== "must") errors.push(`supply ${input.name}`);
    if (input.supply === "saved") {
      if (input.type === "secret" || input.type === "file" || !input.default) errors.push(`supply ${input.name}`);
    }
    if (input.supply === "must" && input.default) errors.push(`supply ${input.name}`);
    if (input.type === "file" && input.default && looksLikePath(input.default)) errors.push(`file path default ${input.name}`);
    if (input.type === "choice" && (!input.choices || input.choices.length === 0)) errors.push(`choice ${input.name}`);
    if (!input.label) errors.push(`input label ${input.name}`);
  }
  if (doc.readBack) errors.push(...readBackErrors(doc.readBack, "workflow", names));
  if (doc.precondition) {
    if (doc.precondition.kind !== "url" || !doc.precondition.match) errors.push("precondition");
    if (doc.precondition.phase !== "auth") errors.push("precondition phase");
  }
  doc.steps.forEach((step, i) => errors.push(...stepErrors(step, i, names)));
  errors.push(...filesDatesErrors(doc));
  errors.push(...validateDataSteps(doc));
  return errors;
}

function stepErrors(step: WorkflowStep, index: number, names: Set<string>): string[] {
  const errors: string[] = [];
  if (!step) return ["index"];
  if (step.index !== index) errors.push(`index ${step.id}`);
  if (!step.caption?.text?.trim()) errors.push(`caption ${step.id}`);
  if (step.caption?.citation && (!step.caption.citation.text || !CITATION_SOURCES.has(step.caption.citation.source))) {
    errors.push(`citation ${step.id}`);
  }
  if (step.caption?.targetBox && !boxOk(step.caption.targetBox)) errors.push(`target box ${step.id}`);
  const input = stepInputName(step);
  if (input && !names.has(input)) errors.push(`unknown input ${input}`);
  const literal = stepLiteral(step);
  if (literal && looksLikePath(literal) && !literal.includes("{{")) errors.push(`path baked into ${step.id}`);
  switch (step.action) {
    case "click":
      errors.push(...targetErrors(step.target, step.id));
      if (step.optional !== undefined && (step.optional !== "dismiss" || !dismissName(step))) errors.push(`optional ${step.id}`);
      if (step.check) errors.push(...checkErrors(step.check, step.id));
      break;
    case "type":
    case "select":
    case "digits":
      if (step.action !== "digits") errors.push(...targetErrors(step.target, step.id));
      else if (step.target) errors.push(...targetErrors(step.target, step.id));
      if (!textOk(step.text)) errors.push(`text ${step.id}`);
      if (step.check) errors.push(...checkErrors(step.check, step.id));
      break;
    case "key":
      if (!step.key) errors.push(`key ${step.id}`);
      if (step.target) errors.push(...targetErrors(step.target, step.id));
      if (step.check) errors.push(...checkErrors(step.check, step.id));
      break;
    case "check":
      errors.push(...targetErrors(step.target, step.id));
      if (typeof step.checked !== "boolean") errors.push(`checked ${step.id}`);
      if (step.check) errors.push(...checkErrors(step.check, step.id));
      break;
    case "navigate":
      if (!step.url) errors.push(`url ${step.id}`);
      if (step.check) errors.push(...checkErrors(step.check, step.id));
      if (step.caption?.targetBox || step.caption?.citation) errors.push(`caption ${step.id}`);
      break;
    case "verify":
      errors.push(...checkErrors(step.check, step.id));
      break;
    case "login":
    case "wait":
    case "finish":
    case "note":
      if (step.caption?.targetBox || step.caption?.citation) errors.push(`caption ${step.id}`);
      if (step.action === "wait" && !step.reason) errors.push(`wait ${step.id}`);
      if (step.action === "note" && !step.text) errors.push(`note ${step.id}`);
      if (step.action === "login" && step.check) errors.push(...checkErrors(step.check, step.id));
      break;
    case "upload":
    case "drop":
      errors.push(...targetErrors(step.target, step.id));
      if (!("input" in step.file ? step.file.input : step.file.fromOutput)) errors.push(`file ${step.id}`);
      if (step.check) errors.push(...checkErrors(step.check, step.id));
      break;
    case "extract":
      if (!step.extract?.as) errors.push(`extract ${step.id}`);
      break;
    case "for_each":
      if (!step.forEach?.steps?.length) errors.push(`for_each ${step.id}`);
      break;
    case "download":
      if (!step.download?.output || !step.download.name) errors.push(`download ${step.id}`);
      if (step.check) errors.push(...checkErrors(step.check, step.id));
      break;
    case "open":
      if (step.open.target === "url" ? !step.open.url : !step.open.file) errors.push(`open ${step.id}`);
      if (step.check) errors.push(...checkErrors(step.check, step.id));
      break;
    case "pickDate":
      if (!step.date?.input) errors.push(`pickDate ${step.id}`);
      if (step.target) errors.push(...targetErrors(step.target, step.id));
      if (step.check) errors.push(...checkErrors(step.check, step.id));
      break;
    default:
      errors.push(`action ${(step as { id?: string }).id}`);
  }
  if (step.heal && step.heal !== "auto" && step.heal !== "ask" && step.heal !== "never") errors.push(`heal ${step.id}`);
  if (step.when) errors.push(...whenErrors(step, names));
  if (step.readBack) errors.push(...readBackErrors(step.readBack, step.id, names));
  for (const locator of stepTarget(step)?.locators ?? []) errors.push(...locatorErrors(locator, step.id));
  return errors;
}

function dismissName(step: Extract<WorkflowStep, { action: "click" }>): string {
  const query = queryFromTarget(step.target);
  return popupDismissName(query);
}

function textOk(text: TextOf | undefined): boolean {
  if (!text) return false;
  if ("input" in text) return NAME_RE.test(text.input);
  return typeof text.literal === "string";
}

function targetErrors(target: Target | undefined, id: string): string[] {
  if (!target?.locators?.length && !target?.hint?.role && !target?.hint?.label && !target?.hint?.nameAttr) return [`target ${id}`];
  return [];
}

function boxOk(box: TargetBox): boolean {
  const nums = [box.x, box.y, box.width, box.height, box.viewport?.width, box.viewport?.height];
  return nums.every((n) => typeof n === "number" && Number.isFinite(n)) && box.viewport.width > 0 && box.viewport.height > 0;
}

function locatorErrors(locator: StepLocator, id: string): string[] {
  switch (locator?.kind) {
    case "role":
      if (!locator.role || locator.name == null) return [`role locator ${id}`];
      return [];
    case "anchor":
      if (!locator.relation || !locator.anchor?.role) return [`anchor locator ${id}`];
      return [];
    case "text":
    case "testid":
    case "css":
    case "xpath":
      if (!locator.value) return [`locator value ${id}`];
      return [];
    default:
      return [`locator value ${id}`];
  }
}

function checkErrors(check: Check | undefined, id: string): string[] {
  if (!check || typeof check.timeoutMs !== "number") return [`check ${id}`];
  if (check.kind === "settled") return [];
  if (check.kind === "element" || check.kind === "absent") return check.locators?.length ? [] : [`check ${id}`];
  if (check.kind === "state") return check.locators?.length && check.state ? [] : [`check ${id}`];
  if (check.kind === "text" || check.kind === "url" || check.kind === "value") {
    if (!check.match) return [`check ${id}`];
  }
  return [];
}

function readBackErrors(read: ReadBack, id: string, names: Set<string>): string[] {
  const errors: string[] = [];
  if (!read.match) errors.push(`read-back match ${id}`);
  if (read.source === "file" && (!read.fileInput || !names.has(read.fileInput))) errors.push(`read-back file ${id}`);
  if (typeof read.timeoutMs !== "number") errors.push(`read-back timeout ${id}`);
  return errors;
}

function whenErrors(step: WorkflowStep, names: Set<string>): string[] {
  const when = step.when;
  if (!when) return [];
  const present = when.present?.trim();
  const absent = when.absent?.trim();
  if (when.anyCount !== undefined && !absent) return [`when ${step.id}`];
  if (present || absent) return present && absent ? [`when ${step.id}`] : [];
  if (!when.input || !names.has(when.input) || !when.value) return [`when ${step.id}`];
  return [];
}
