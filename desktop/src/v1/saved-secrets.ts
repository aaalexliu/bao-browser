import { bindingTokens, INPUT_BINDING, onlyBindings, ROW_BINDING } from "./bindings";
import { keyMayInsertText } from "../cdp-live/keys";
import { mapCsv, parseTable, sanitizeName } from "./data-steps";
import type { ReplayArgs, WorkflowStep, WorkflowV2 } from "./schema";

export const STRIPPED_SECRET = "[secret stripped]";
export const NEEDS_SECRET_VALUE = "This step needs a value. Its saved value was stripped because it may contain a secret.";

const ENTRY = new Set(["type", "input", "fill", "key", "keypress", "digits"]);
const MEDIA = new Set(["screenshot", "png", "base64", "image", "video"]);
const STRUCTURE = new Set(["schema", "id", "toolCallId", "op", "action", "kind", "type", "role", "inputType", "autocomplete", "surface", "input", "parameter", "as", "workflowId", "runId", "stepId", "sessionId", "eventId", "versionId", "version", "index", "n", "ts", "at", "createdAt", "updatedAt", "timeoutMs", "stepIndex", "stepCount", "filesDates", "tag", "subrole", "changed", "ref", "identifier", "testId", "nameAttr", "bundleId"]);
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
const TOKENS = /(?<![A-Za-z0-9_-])(?:(?:sk-|gh[pousr]_|github_pat_|xox[a-z]-|AKIA|GOCSPX-)[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])/g;

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

function redactSavedText(value: string): string {
  if (/^\s*\d{3}-?\d{2}-?\d{4}\s*$/.test(value)) return STRIPPED_SECRET;
  return value.replace(TOKENS, STRIPPED_SECRET)
    .replace(/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, STRIPPED_SECRET)
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (number) => {
      // A card may be followed by an expiry date in the same string.
      for (let end = number.length; end >= 13; end -= 1) {
        if (end < number.length && number[end] !== " " && number[end] !== "-") continue;
        const digits = number.slice(0, end).replace(/[ -]/g, "");
        if (digits.length < 13) break;
        let sum = 0;
        for (let i = digits.length - 1; i >= 0; i -= 1) {
          let digit = Number(digits[i]);
          if ((digits.length - 1 - i) % 2) { digit *= 2; if (digit > 9) digit -= 9; }
          sum += digit;
        }
        if (sum % 10 === 0) return `${STRIPPED_SECRET}${number.slice(end)}`;
      }
      return number;
    });
}

export interface SavedContext {
  workflow?: Pick<WorkflowV2, "inputs" | "steps">;
  args?: Record<string, unknown> | Record<string, unknown>[];
}

/** Copy only: dispatch and the caller's live values never change. */
export function scrubSaved<T>(value: T, context: SavedContext = {}): T {
  const secrets = new Set<string>();
  const tables = new WeakMap<object, Map<string, Set<string>>>();
  const templates = new WeakMap<object, Set<string>>();
  const options = new WeakMap<object, Set<string>>();
  const rootData = context.args === value || (Array.isArray(context.args) && context.args.some((args) => args === value));
  const preserve = (owner: object, ...keys: string[]) => {
    const fields = options.get(owner) ?? new Set<string>();
    keys.forEach((key) => fields.add(key));
    options.set(owner, fields);
  };
  const remember = (item: unknown, tokens?: ReadonlySet<string>): void => {
    if (Array.isArray(item)) { item.forEach((child) => remember(child)); return; }
    if (item && typeof item === "object") { Object.values(item).forEach((child) => remember(child)); return; }
    if (typeof item === "number" && Number.isFinite(item)) item = String(item);
    if (typeof item === "string" && item && item !== STRIPPED_SECRET && !(tokens && onlyBindings(item, tokens))) secrets.add(item);
  };
  const collectBindings = (workflow: RecordValue, args: RecordValue = {}, data = false): void => {
    if (!Array.isArray(workflow.steps) || !Array.isArray(workflow.inputs)) return;
    const bound = boundSteps(workflow.steps);
    const declared = workflow.inputs.map(record);
    const names = new Set(declared.flatMap((input) => typeof input.name === "string" ? [input.name] : []));
    if (!data) for (const { step, row } of bound) {
      templates.set(step, bindingTokens(step.value, names, row));
      const when = record(step.when);
      if (declared.some((input) => input.type === "choice" && input.name === when.input)) preserve(when, "value");
    }
    for (const input of declared) {
      const name = input.name;
      if (typeof name !== "string") continue;
      const targets = bound.filter(({ inputs }) => inputs.has(name));
      if (!data && (input.type === "choice" || (targets.length > 0 && targets.every(({ step }) => fixedSavedChoice(step))))) {
        preserve(input, "default", "choices");
        preserve(args, name);
      }
      const consumers = targets.filter(({ step }) => !fixedSavedChoice(step) && (step.sensitive === true || secretSavedField(step.identity)));
      if (input.type !== "secret" && !consumers.length) continue;
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
    if (typeof item === "string") {
      if (redactSavedText(item) === STRIPPED_SECRET) remember(item);
      return;
    }
    if (Array.isArray(item)) { item.forEach((child) => collect(child, data)); return; }
    const node = record(item);
    collectBindings(node, {}, data);
    if (!data) {
      if (!templates.has(node) && typeof node.action === "string" && typeof node.input === "string") {
        templates.set(node, bindingTokens(node.value, new Set([node.input])));
      }
      if (fixedSavedChoice(node)) preserve(node, "value", "valueBefore", "valueAfter");
      if (node.type === "choice") preserve(node, "default", "choices");
      if (Array.isArray(node.options)) for (const option of node.options) preserve(record(option), "value", "label");
    }
    const structural = node.sensitive === true || secretSavedField(node) || secretSavedField(node.identity) || secretSavedField(node.field);
    if (structural && (data || !fixedSavedChoice(node))) {
      remember(record(node.identity).value);
      for (const key of ["value", "text", "valueBefore", "valueAfter"]) remember(node[key], key === "value" ? templates.get(node) : undefined);
      if (typeof node.key === "string" && keyMayInsertText(node.key)) remember(node.key);
    }
    if (node.type === "secret") remember(node.default);
    if (context.workflow) {
      for (const key of ["inputs", "publicInputs", "args"]) collectBindings(context.workflow as unknown as RecordValue, record(node[key]));
    }
    for (const [key, child] of Object.entries(node)) if (!MEDIA.has(key) && !options.get(node)?.has(key)) collect(child, data || payloadField(key, child));
  };
  if (context.workflow) {
    collect(context.workflow);
    for (const args of Array.isArray(context.args) ? context.args : [context.args]) {
      collectBindings(context.workflow as unknown as RecordValue, args);
    }
  }
  collect(value, rootData);
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  const cleanText = (text: string, tokens?: ReadonlySet<string>): string => {
    if (tokens && onlyBindings(text, tokens)) return text;
    if (secrets.has(text)) return STRIPPED_SECRET;
    for (const secret of ordered) if (secret.length >= 4) text = text.split(secret).join(STRIPPED_SECRET);
    return redactSavedText(text);
  };
  const cleanTable = (item: unknown, columns: Set<string>): unknown => {
    if (typeof item === "string") {
      return mapCsv(item, (value, column) => columns.has(column) && value ? STRIPPED_SECRET : redactSavedText(value));
    }
    if (Array.isArray(item)) return item.map((row) => Object.fromEntries(Object.entries(record(row)).map(([key, value]) => [key, columns.has(sanitizeName(key, 0)) && String(value ?? "") ? STRIPPED_SECRET : value && typeof value === "object" ? clean(value, undefined, true) : typeof value === "string" ? redactSavedText(value) : value])));
    return item;
  };
  const clean = (item: unknown, tokens?: ReadonlySet<string>, data = false): unknown => {
    if (typeof item === "string") return cleanText(item, tokens);
    if (typeof item === "number") return secrets.has(String(item)) ? STRIPPED_SECRET : item;
    if (Array.isArray(item)) return item.map((child) => clean(child, undefined, data));
    if (!item || typeof item !== "object") return item;
    const raw = record(item);
    const node = Object.fromEntries(Object.entries(raw).map(([key, child]) => {
      // Keep enum values and binding names intact even when someone typed that same word.
      const bindingName = key === "name" && (typeof raw.type === "string" || typeof raw.kind === "string");
      const columns = tables.get(raw)?.get(key);
      const payload = data || payloadField(key, child);
      if (columns) return [key, cleanTable(child, columns)];
      const metadata = !data && (STRUCTURE.has(key) || bindingName || (typeof child === "string" && ENUMS.get(key)?.has(child)));
      const binding = !data && key === "value" ? templates.get(raw) : undefined;
      return [key, MEDIA.has(key) || options.get(raw)?.has(key) || metadata ? child : clean(child, binding, payload)];
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
  return clean(value, undefined, rootData) as T;
}
