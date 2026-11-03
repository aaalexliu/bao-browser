import { keyMayInsertText } from "../cdp-live/keys";
import { mapCsv, parseTable, sanitizeName } from "./data-steps";
import type { ReplayArgs, WorkflowStep, WorkflowV2 } from "./schema";

export const STRIPPED_SECRET = "[secret stripped]";
export const NEEDS_SECRET_VALUE = "This step needs a value. Its saved value was stripped because it may contain a secret.";

const ENTRY = new Set(["type", "input", "fill", "key", "keypress", "digits", "select"]);
const MEDIA = new Set(["screenshot", "png", "base64", "image", "video"]);
const STRUCTURE = new Set(["schema", "id", "toolCallId", "op", "action", "kind", "type", "role", "inputType", "autocomplete", "surface", "input", "parameter", "as", "workflowId", "runId", "stepId", "sessionId", "eventId", "versionId", "version", "index", "n", "ts", "at", "createdAt", "updatedAt", "timeoutMs", "stepIndex", "stepCount"]);
const TOKENS = /(?<![A-Za-z0-9_-])(?:(?:sk-|gh[pousr]_|github_pat_|xox[a-z]-|AKIA|GOCSPX-)[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])/g;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function boundSteps(steps: unknown[], rowInput?: string | null): { step: RecordValue; inputs: Set<string>; rows: Set<string> }[] {
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
      for (const match of step.value.matchAll(/\{\{([^}]+)\}\}/g)) {
        if (rowInput !== undefined && /^\s*row\.[A-Za-z][A-Za-z0-9_]*\s*$/.test(match[1]!)) {
          if (rowInput) rows.add(rowInput);
        } else if (rowInput === undefined || !/^\s*row_index\s*$/.test(match[1]!)) {
          inputs.add(match[1]!);
        }
      }
    }
    for (const name of inputs) rows.delete(name);
    for (const name of rows) inputs.add(name);
    return [{ step, inputs, rows }, ...(Array.isArray(loop.steps) ? boundSteps(loop.steps, source ?? null) : [])];
  });
}

export function secretSavedField(value: unknown): boolean {
  const field = record(value);
  if ([field.type, field.inputType, field.role].some((item) => typeof item === "string" && item.toLowerCase() === "password")) return true;
  return typeof field.autocomplete === "string" && field.autocomplete.toLowerCase().split(/\s+/).some((token) =>
    token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"));
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
  const remember = (item: unknown, template = false): void => {
    if (Array.isArray(item)) { item.forEach((child) => remember(child, template)); return; }
    if (item && typeof item === "object") { Object.values(item).forEach((child) => remember(child, template)); return; }
    if (typeof item === "number" && Number.isFinite(item)) item = String(item);
    if (typeof item === "string" && item && item !== STRIPPED_SECRET && !(template && item.includes("{{"))) secrets.add(item);
  };
  const collectBindings = (workflow: RecordValue, args: RecordValue = {}): void => {
    if (!Array.isArray(workflow.steps) || !Array.isArray(workflow.inputs)) return;
    const bound = boundSteps(workflow.steps);
    for (const input of workflow.inputs.map(record)) {
      const name = input.name;
      if (typeof name !== "string") continue;
      const consumers = bound.filter(({ step, inputs }) => inputs.has(name) && (step.sensitive === true || secretSavedField(step.identity)));
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
          for (const match of step.value.matchAll(/\{\{\s*row\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)) columns.add(match[1]!);
        }
        if (!columns.size) continue;
        const fields = tables.get(owner) ?? new Map<string, Set<string>>();
        fields.set(key, columns);
        tables.set(owner, fields);
        for (const row of parseTable(value)) for (const column of columns) remember(row[column]);
      }
    }
  };
  const collect = (item: unknown): void => {
    if (typeof item === "string") {
      if (redactSavedText(item) === STRIPPED_SECRET) remember(item);
      return;
    }
    if (Array.isArray(item)) { item.forEach(collect); return; }
    const node = record(item);
    const structural = node.sensitive === true || secretSavedField(node) || secretSavedField(node.identity) || secretSavedField(node.field);
    if (structural) {
      remember(record(node.identity).value);
      for (const key of ["value", "text", "valueBefore", "valueAfter"]) remember(node[key], key === "value" && typeof node.action === "string");
      if (typeof node.key === "string" && keyMayInsertText(node.key)) remember(node.key);
    }
    if (node.type === "secret") remember(node.default);
    collectBindings(node);
    if (context.workflow) {
      for (const key of ["inputs", "publicInputs", "args"]) collectBindings(context.workflow as unknown as RecordValue, record(node[key]));
    }
    for (const [key, child] of Object.entries(node)) if (!MEDIA.has(key)) collect(child);
  };
  if (context.workflow) {
    collect(context.workflow);
    for (const args of Array.isArray(context.args) ? context.args : [context.args]) {
      collectBindings(context.workflow as unknown as RecordValue, args);
    }
  }
  collect(value);
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  const cleanText = (text: string, template: boolean): string => {
    if (!template && secrets.has(text)) return STRIPPED_SECRET;
    return (template ? text.split(/(\{\{[^}]+\}\})/g) : [text]).map((part) => {
      if (template && part.startsWith("{{") && part.endsWith("}}")) return part;
      for (const secret of ordered) {
        if (part === secret) part = STRIPPED_SECRET;
        else if (secret.length >= 4) part = part.split(secret).join(STRIPPED_SECRET);
      }
      return redactSavedText(part);
    }).join("");
  };
  const cleanTable = (item: unknown, columns: Set<string>): unknown => {
    if (typeof item === "string") {
      return mapCsv(item, (value, column) => columns.has(column) && value ? STRIPPED_SECRET : redactSavedText(value));
    }
    if (Array.isArray(item)) return item.map((row) => Object.fromEntries(Object.entries(record(row)).map(([key, value]) => [key, columns.has(sanitizeName(key, 0)) && String(value ?? "") ? STRIPPED_SECRET : value && typeof value === "object" ? clean(value, false, true) : typeof value === "string" ? redactSavedText(value) : value])));
    return item;
  };
  const clean = (item: unknown, template = false, data = false): unknown => {
    if (typeof item === "string") return cleanText(item, template);
    if (typeof item === "number") return secrets.has(String(item)) ? STRIPPED_SECRET : item;
    if (Array.isArray(item)) return item.map((child) => clean(child, false, data));
    if (!item || typeof item !== "object") return item;
    const raw = record(item);
    const node = Object.fromEntries(Object.entries(raw).map(([key, child]) => {
      // Keep enum values and binding names intact even when someone typed that same word.
      const bindingName = key === "name" && (typeof raw.type === "string" || typeof raw.kind === "string");
      const columns = tables.get(raw)?.get(key);
      const payload = data || ["value", "text", "valueBefore", "valueAfter", "publicInputs", "args"].includes(key) || (key === "inputs" && !Array.isArray(child));
      if (columns) return [key, cleanTable(child, columns)];
      return [key, MEDIA.has(key) || (!data && (STRUCTURE.has(key) || bindingName || (key === "source" && typeof child === "string"))) ? child : clean(child, typeof raw.action === "string" && (key === "value" || key === "label"), payload)];
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
  return clean(value, false, context.args === value || (Array.isArray(context.args) && context.args.includes(value as Record<string, unknown>))) as T;
}
