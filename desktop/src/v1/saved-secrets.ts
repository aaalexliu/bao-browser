import { bindingTokens, INPUT_BINDING, ROW_BINDING } from "./bindings";
import { canonicalKey, KEY_EVENTS, keyMayInsertText } from "../cdp-live/keys";
import { mapCsv, parseTable, sanitizeName } from "./data-steps";
import type { ReplayArgs, WorkflowStep, WorkflowV2 } from "./schema";

export const STRIPPED_SECRET = "[secret stripped]";
export const NEEDS_SECRET_VALUE = "This step needs a value. Its saved value was stripped because it may contain a secret.";

const ENTRY = new Set(["type", "input", "fill", "key", "keypress", "digits"]);
const MEDIA = new Set(["screenshot", "png", "base64", "image", "video"]);
const STRUCTURE = new Set(["schema", "id", "toolCallId", "op", "action", "kind", "type", "role", "inputType", "autocomplete", "surface", "input", "parameter", "as", "workflowId", "runId", "stepId", "sessionId", "eventId", "versionId", "hash", "prev", "version", "index", "n", "ts", "at", "createdAt", "updatedAt", "timeoutMs", "stepIndex", "stepCount", "filesDates", "tag", "subrole", "changed", "ref", "identifier", "testId", "nameAttr", "bundleId", "label", "intent", "match", "url", "startUrl", "beforeUrl", "afterUrl", "requestedUrl", "href", "src", "selector", "query", "cssPath", "xpath", "fileInput", "fileFrom", "fromOutput", "endInput"]);
const ENUMS = new Map(Object.entries({
  status: "running passed failed paused pending skipped needs_human idle completed timed-out stopped provisional promoted reverted",
  outcome: "ok needs_human needs_signin needs_approval failed",
  phase: "wait_for find action expect auth start end closed",
  driver: "playwright extension cdp-live",
  heal: "auto approve ask never",
  class: "bot_wall login_wall clutter changed",
  mode: "auto approve element list",
  decision: "keep revert",
  repair: "wait overlay label anchor reveal",
  timing: "lt1s lt10s lt60s slower",
  by: "name title text value",
  relation: "below above right left",
  state: "checked unchecked enabled disabled visible",
  gate: "login confirm",
  confidence: "low",
  optional: "dismiss",
  target: "url file",
  space: "viewport image screen",
  read: "text href src value title rating",
  pausedKind: "signin confirm wall",
  pageEngine: "old agent-browser",
  drift: "pending passed failed",
  dialogType: "alert confirm prompt",
  dialogDecision: "accept dismiss",
  valueMode: "full",
  via: "ax cdp",
  cleared: "email name path phone ssn",
  source: "value text url file recorded heal revert rollback saved edit restore conflict dom iframe header cookie title status",
  adapter: "playwright extension cdp-live",
  agent: "live-model",
  vendor: "bao",
}).map(([key, values]) => [key, new Set(values.split(" "))] as const));
const TOKENS = /^(?:(?:sk-|gh[pousr]_|github_pat_|xox[a-z]-|AKIA|GOCSPX-)[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})$/;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function boundSteps(steps: unknown[], rowInput?: string | null): { step: RecordValue; inputs: Set<string>; rows: Set<string>; row: boolean }[] {
  return steps.flatMap((item) => {
    const step = record(item);
    const loop = record(step.forEach);
    const over = record(loop.over);
    const source = over.kind === "input" && typeof over.name === "string" ? over.name : undefined;
    const inputs = new Set<string>();
    const rows = new Set<string>();
    if (typeof step.input === "string") inputs.add(step.input);
    if (source) rows.add(source);
    if (typeof step.value === "string") {
      for (const match of step.value.matchAll(INPUT_BINDING)) {
        if (rowInput === undefined || match[1] !== "row_index") inputs.add(match[1]!);
      }
      if (rowInput && [...step.value.matchAll(ROW_BINDING)].length) rows.add(rowInput);
    }
    for (const name of inputs) rows.delete(name);
    for (const name of rows) inputs.add(name);
    return [{ step, inputs, rows, row: rowInput !== undefined }, ...(Array.isArray(loop.steps) ? boundSteps(loop.steps, source ?? null) : [])];
  });
}

export function secretSavedField(value: unknown): boolean {
  const field = record(value);
  if ([field.type, field.inputType, field.role].some((item) => typeof item === "string" && item.toLowerCase() === "password")) return true;
  return typeof field.autocomplete === "string" && field.autocomplete.toLowerCase().split(/\s+/).some((token) =>
    token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"));
}

function secretNode(node: RecordValue): boolean {
  return node.sensitive === true || secretSavedField(node) || secretSavedField(node.identity) || secretSavedField(node.field);
}

function choiceField(value: unknown): boolean {
  const field = record(value);
  return [field.type, field.inputType, field.role, field.tag, field.kind].some((item) => typeof item === "string" && ["select", "radio", "checkbox", "option"].includes(item.toLowerCase()));
}

export function fixedSavedChoice(value: unknown): boolean {
  const node = record(value);
  return [node.action, node.op].some((action) => action === "select" || action === "check") || choiceField(node) || choiceField(node.identity) || choiceField(node.field);
}

function payloadField(key: string, value: unknown): boolean {
  return ["value", "text", "valueBefore", "valueAfter", "publicInputs", "args"].includes(key) || (key === "inputs" && !Array.isArray(value));
}

export function hasStrippedSecret(value: unknown): boolean {
  return Array.isArray(value) ? value.some(hasStrippedSecret) : typeof value === "string" && value.includes(STRIPPED_SECRET);
}

function missingBoundValue(value: unknown, table: boolean): boolean {
  return table ? typeof value === "string" && value.trim() === STRIPPED_SECRET : hasStrippedSecret(value);
}

export function stepNeedsSecretValue(step: WorkflowStep, workflow: WorkflowV2, args: ReplayArgs): boolean {
  const reason = step.unresolved?.reason;
  if (reason === NEEDS_SECRET_VALUE || reason === "redacted key") return true;
  if ([step.value, step.key].some(hasStrippedSecret)) return true;
  const { inputs, rows } = boundSteps([step])[0]!;
  return [...inputs].some((name) => {
    const input = workflow.inputs.find((input) => input.name === name);
    return [args[name], input?.default].some((value) => missingBoundValue(value, input?.type === "table" && rows.has(name)));
  });
}

function redactSavedValue(value: string): string {
  if (value === STRIPPED_SECRET) return value;
  if (TOKENS.test(value) || /^\s*\d{3}-?\d{2}-?\d{4}\s*$/.test(value) || /^\d{3}[- ]\d{2}[- ]\d{4}$/.test(value)) return STRIPPED_SECRET;
  if (!/^\d(?:[ -]?\d){12,18}$/.test(value)) return value;
  const digits = value.replace(/[ -]/g, "");
  let sum = 0;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if ((digits.length - 1 - i) % 2) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0 ? STRIPPED_SECRET : value;
}

export interface SavedContext {
  workflow?: Pick<WorkflowV2, "inputs" | "steps">;
  args?: Record<string, unknown> | Record<string, unknown>[];
  secrets?: readonly string[];
}

/** Copy only: dispatch and the caller's live values never change. */
export function scrubSaved<T>(value: T, context: SavedContext = {}): T {
  const secrets = new Set<string>();
  const tables = new WeakMap<object, Map<string, Set<string>>>();
  type StepScope = { names: Set<string>; row: boolean; secret: boolean };
  const steps = new WeakMap<object, StepScope>();
  const copies = new Map<string, StepScope>();
  const fields = new WeakMap<object, Map<string, boolean>>();
  const secretInputs = new WeakSet<object>();
  const rootData = context.args === value || (Array.isArray(context.args) && context.args.some((args) => args === value));
  const preserve = (owner: object, keys: string[], data = false): void => {
    const kept = fields.get(owner) ?? new Map<string, boolean>();
    keys.forEach((key) => kept.set(key, data || kept.get(key) === true));
    fields.set(owner, kept);
  };
  const kept = (owner: object, key: string, data: boolean): boolean => fields.get(owner)?.has(key) === true && (!data || fields.get(owner)?.get(key) === true);
  const remember = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(remember); return; }
    if (item && typeof item === "object") { Object.values(item).forEach(remember); return; }
    if (typeof item === "number" && Number.isFinite(item)) item = String(item);
    if (typeof item === "string" && item && item !== STRIPPED_SECRET) secrets.add(item);
  };
  const collectBindings = (workflow: RecordValue, args: RecordValue = {}, data = false): void => {
    if (!Array.isArray(workflow.steps) || !Array.isArray(workflow.inputs)) return;
    const bound = boundSteps(workflow.steps);
    const declared = workflow.inputs.map(record);
    const names = new Set(declared.flatMap((input) => typeof input.name === "string" ? [input.name] : []));
    if (!data) {
      for (const output of Array.isArray(workflow.outputs) ? workflow.outputs : []) preserve(record(output), ["from"]);
      for (const { step, row, inputs } of bound) {
        const secret = secretNode(step) || declared.some((input) => input.type === "secret" && typeof input.name === "string" && inputs.has(input.name));
        const scope = { names, row, secret };
        steps.set(step, scope);
        if (workflow === context.workflow && typeof step.id === "string") copies.set(step.id, scope);
        const when = record(step.when);
        if (declared.some((input) => input.type === "choice" && input.name === when.input)) preserve(when, ["value"]);
      }
    }
    for (const input of declared) {
      const name = input.name;
      if (typeof name !== "string") continue;
      const targets = bound.filter(({ inputs }) => inputs.has(name));
      const consumers = targets.filter(({ step }) => secretNode(step));
      const secret = input.type === "secret" || consumers.length > 0;
      if (!data && !secret && (input.type === "choice" || (targets.length > 0 && targets.every(({ step }) => fixedSavedChoice(step))))) {
        preserve(input, ["default", "choices"], true);
        preserve(args, [name], true);
      }
      if (!secret) continue;
      secretInputs.add(input);
      for (const [owner, key] of [[input, "default"], [args, name]] as const) {
        const value = owner[key];
        if (input.type !== "table") { remember(value); continue; }
        const columns = new Set<string>();
        for (const { step, rows } of consumers) {
          if (!rows.has(name)) {
            for (const row of parseTable(value)) for (const column of Object.keys(row)) columns.add(column);
          }
          if (typeof step.value !== "string") continue;
          for (const match of step.value.matchAll(ROW_BINDING)) columns.add(match[1]!);
        }
        if (!columns.size) continue;
        const fields = tables.get(owner) ?? new Map<string, Set<string>>();
        fields.set(key, columns);
        tables.set(owner, fields);
        for (const row of parseTable(value)) for (const column of columns) remember(row[column]);
      }
    }
  };
  const collect = (item: unknown, data = false): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach((child) => collect(child, data)); return; }
    const node = record(item);
    collectBindings(node, {}, data);
    const scope = !data ? steps.get(node) ?? (typeof node.action === "string" && typeof node.id === "string" ? copies.get(node.id) : undefined) : undefined;
    const structural = scope?.secret || secretNode(node);
    if (!data) {
      if (scope) {
        if (bindingTokens(node.value, scope.names, scope.row).size) preserve(node, ["value"]);
        preserve(record(node.download), ["name", "url", "output"]);
        preserve(record(node.open), ["url", "file"]);
      }
      for (const key of ["identity", "field"]) preserve(record(node[key]), ["name", "text", "title", "description"]);
      if (["css", "xpath", "text", "testid", "role"].includes(String(node.kind))) preserve(node, ["value", "name"]);
      if (typeof node.key === "string") {
        const name = canonicalKey(node.key).split("+").at(-1) || "";
        if ((name.length === 1 || KEY_EVENTS[name]) && !keyMayInsertText(node.key)) preserve(node, ["key"]);
      }
      if (node.role === "input" && typeof node.name === "string") preserve(node, ["name"]);
      if (fixedSavedChoice(node) && !structural) preserve(node, ["value", "valueBefore", "valueAfter"], true);
      if (node.type === "choice") preserve(node, secretInputs.has(node) ? ["choices"] : ["default", "choices"], true);
      if (Array.isArray(node.options)) for (const option of node.options) preserve(record(option), ["value", "label"], true);
    }
    if (structural) {
      remember(record(node.identity).value);
      for (const key of ["value", "text", "valueBefore", "valueAfter"]) if (!kept(node, key, data)) remember(node[key]);
      if (typeof node.key === "string" && keyMayInsertText(node.key)) remember(node.key);
    }
    if (node.type === "secret") remember(node.default);
    if (context.workflow) {
      for (const key of ["inputs", "publicInputs", "args"]) collectBindings(context.workflow as unknown as RecordValue, record(node[key]));
    }
    for (const [key, child] of Object.entries(node)) if (!MEDIA.has(key) && !kept(node, key, data)) collect(child, data || payloadField(key, child));
  };
  context.secrets?.forEach(remember);
  if (context.workflow) {
    collect(context.workflow);
    for (const args of Array.isArray(context.args) ? context.args : [context.args]) {
      collectBindings(context.workflow as unknown as RecordValue, args);
    }
  }
  collect(value, rootData);
  const cleanScalar = (item: string | number): string | number => {
    if (item === STRIPPED_SECRET) return item;
    const text = String(item);
    return secrets.has(text) || redactSavedValue(text) === STRIPPED_SECRET ? STRIPPED_SECRET : item;
  };
  const cleanTable = (item: unknown, columns: Set<string>): unknown => {
    if (typeof item === "string") {
      return mapCsv(item, (value, column) => columns.has(column) && value ? STRIPPED_SECRET : redactSavedValue(value));
    }
    if (Array.isArray(item)) return item.map((row) => Object.fromEntries(Object.entries(record(row)).map(([key, value]) => {
      if (columns.has(sanitizeName(key, 0)) && String(value ?? "")) return [key, STRIPPED_SECRET];
      if (value && typeof value === "object") return [key, clean(value, true)];
      const scalar = (typeof value === "string" || typeof value === "number") && redactSavedValue(String(value)) === STRIPPED_SECRET ? STRIPPED_SECRET : value;
      return [key, scalar];
    })));
    return item;
  };
  const clean = (item: unknown, data = false): unknown => {
    if (typeof item === "string" || typeof item === "number") return cleanScalar(item);
    if (Array.isArray(item)) return item.map((child) => clean(child, data));
    if (!item || typeof item !== "object") return item;
    const raw = record(item);
    const node = Object.fromEntries(Object.entries(raw).map(([key, child]) => {
      // Keep enum values and binding names intact even when someone typed that same word.
      const bindingName = key === "name" && (typeof raw.type === "string" || typeof raw.kind === "string");
      const columns = tables.get(raw)?.get(key);
      const payload = data || payloadField(key, child);
      if (columns) return [key, cleanTable(child, columns)];
      const metadata = !data && (STRUCTURE.has(key) || bindingName || (typeof child === "string" && ENUMS.get(key)?.has(child)));
      return [key, MEDIA.has(key) || kept(raw, key, data) || metadata ? child : clean(child, payload)];
    }));
    if (ENTRY.has(String(node.action || "")) && [node.value, node.key].some(hasStrippedSecret)) {
      node.unresolved = { reason: NEEDS_SECRET_VALUE };
    }
    if (Array.isArray(node.steps) && Array.isArray(node.inputs)) {
      for (const { step, inputs, rows } of boundSteps(node.steps)) {
        if (node.inputs.map(record).some((input) => typeof input.name === "string" && inputs.has(input.name) && missingBoundValue(input.default, input.type === "table" && rows.has(input.name)))) {
          step.unresolved = { reason: NEEDS_SECRET_VALUE };
        }
      }
    }
    return node;
  };
  return clean(value, rootData) as T;
}
