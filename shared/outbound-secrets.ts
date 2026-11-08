import { bindingTokens, INPUT_BINDING, ROW_BINDING } from "./bindings";
import { canonicalKey, KEY_EVENTS, keyMayInsertText } from "./keys";
import { isSensitiveField, type FieldHint } from "./mask";
import { mapCsv, parseTable, sanitizeName } from "./table";
import { fixedSavedChoice, isSealedArtifact, secretSavedField, STRIPPED_SECRET } from "./saved-secrets";
import { stepForEach, stepQuery, stepSensitive } from "../desktop/src/v1/schema";
import type { WorkflowInput, WorkflowReceipt, WorkflowStep, WorkflowV2 } from "../desktop/src/v1/schema";
import type { TrailEvent } from "../desktop/src/v1/interpret";
import type { ReceiptBody } from "../desktop/src/v1/receipt";

const ENTRY = new Set(["type", "input", "fill", "key", "keypress", "digits", "osType", "osSetValue", "osKey"]);
const TOKENS = /^(?:(?:sk-|gh[pousr]_|github_pat_|xox[a-z]-|AKIA|GOCSPX-)[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})$/;

type ValueFields = {
  step: readonly string[];
  event: readonly (keyof (TrailEvent & { text?: string }))[];
  effect: readonly (keyof TrailEvent)[];
  dialog: readonly (keyof TrailEvent)[];
  input: readonly (keyof WorkflowInput)[];
  field: readonly "value"[];
  receipt: readonly (keyof ReceiptBody)[];
  result: readonly (keyof WorkflowReceipt)[];
  runtime: readonly ("inputs" | "publicInputs" | "args" | "raw")[];
  table: readonly "rows"[];
  output: readonly "value"[];
  teaching: readonly "secrets"[];
  replay: readonly ("texts" | "secret")[];
};
const USER_VALUE_FIELDS = {
  step: ["value", "key"],
  event: ["value", "text", "key", "valueBefore", "valueAfter", "endValue", "dialogValue"],
  effect: ["valueBefore", "valueAfter", "endValue"],
  dialog: ["dialogValue"],
  input: ["default"],
  field: ["value"],
  receipt: ["expected", "actual"],
  result: ["readBack"],
  runtime: ["inputs", "publicInputs", "args", "raw"],
  table: ["rows"],
  output: ["value"],
  teaching: ["secrets"],
  replay: ["texts", "secret"],
} as const satisfies ValueFields;

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

function secretNode(node: RecordValue): boolean {
  return node.sensitive === true || secretSavedField(node) || secretSavedField(node.identity) || secretSavedField(node.field);
}

export function redactSavedValue(value: string): string {
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

export function hasPrivatePictureInput(workflow: Pick<WorkflowV2, "inputs" | "steps">): boolean {
  const privateField = (hint: FieldHint): boolean => isSensitiveField(hint)
    || /\bcard\b|\bcc-/i.test([hint.name, hint.id, hint.autocomplete, hint.ariaLabel, hint.placeholder].filter(Boolean).join(" "));
  if (workflow.inputs.some((input) => input.type === "secret" || privateField({ name: input.name, ariaLabel: input.label }))) return true;
  const privateSteps = (steps: WorkflowStep[]): boolean => steps.some((step) => {
    const identity = stepQuery(step);
    const nested = stepForEach(step);
    const field = step.action === "type" || step.action === "digits" || identity && (identity.inputType || identity.autocomplete
      || ["input", "textarea", "select"].includes(identity.tag || "")
      || /^(input|textbox|searchbox|combobox|password|axtextfield|axsecuretextfield|axtextarea)$/i.test(identity.role));
    return !!field && (stepSensitive(step) || !!identity && privateField({
      type: identity.inputType || identity.role,
      autocomplete: identity.autocomplete,
      name: [identity.nameAttr, identity.name].filter(Boolean).join(" "),
      id: identity.id,
      ariaLabel: identity.label,
      placeholder: identity.placeholder,
    })) || !!nested && privateSteps(nested.steps);
  });
  return privateSteps(workflow.steps);
}

export interface SavedContext {
  workflow?: Pick<WorkflowV2, "inputs" | "steps">;
  args?: Record<string, unknown> | Record<string, unknown>[];
  secrets?: readonly string[];
}

type ValuePolicy = { secret?: boolean; choice?: boolean; columns?: Set<string>; arguments?: boolean };
type StepScope = { names: Set<string>; row: boolean; secret: boolean };

export function scrubSaved<T>(value: T, context: SavedContext = {}): T {
  const secrets = new Set<string>();
  const slots = new WeakMap<object, Map<string, ValuePolicy>>();
  const argumentsFor = new WeakMap<object, Map<string, ValuePolicy>>();
  const steps = new WeakMap<object, StepScope>();
  const copies = new Map<string, StepScope>();
  const workflows = new WeakSet<object>();
  const rootData = context.args === value || (Array.isArray(context.args) && context.args.some((args) => args === value));
  const remember = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(remember); return; }
    if (item && typeof item === "object") { Object.values(item).forEach(remember); return; }
    if (typeof item === "number" && Number.isFinite(item)) item = String(item);
    if (typeof item === "string" && item && item !== STRIPPED_SECRET) secrets.add(item);
  };
  const select = (node: RecordValue, owner: keyof ValueFields, policy: ValuePolicy = {}): void => {
    const fields = slots.get(node) ?? new Map<string, ValuePolicy>();
    for (const key of USER_VALUE_FIELDS[owner]) if (key in node) fields.set(key, policy);
    slots.set(node, fields);
  };
  const bind = (workflow: RecordValue, args?: RecordValue): void => {
    if (!Array.isArray(workflow.steps) || !Array.isArray(workflow.inputs)) return;
    const bound = boundSteps(workflow.steps);
    const declared = workflow.inputs.map(record);
    const names = new Set(declared.flatMap((input) => typeof input.name === "string" ? [input.name] : []));
    for (const { step, row, inputs } of bound) {
      const scope = { names, row, secret: secretNode(step) || declared.some((input) => input.type === "secret" && typeof input.name === "string" && inputs.has(input.name)) };
      steps.set(step, scope);
      if (workflow === context.workflow && typeof step.id === "string") copies.set(step.id, scope);
    }
    const policies = new Map<string, ValuePolicy>();
    for (const input of declared) {
      const name = input.name;
      if (typeof name !== "string") continue;
      const targets = bound.filter(({ inputs }) => inputs.has(name));
      const consumers = targets.filter(({ step }) => secretNode(step));
      const secret = input.type === "secret" || consumers.length > 0;
      const choice = !secret && (input.type === "choice" || (targets.length > 0 && targets.every(({ step }) => fixedSavedChoice(step))));
      const policy: ValuePolicy = { secret, choice };
      if (input.type === "table") {
        policy.columns = new Set<string>();
        for (const { step, rows } of consumers) {
          if (!rows.has(name)) {
            for (const row of [...parseTable(input.default), ...parseTable(args?.[name])]) for (const column of Object.keys(row)) policy.columns.add(column);
          }
          if (typeof step.value === "string") for (const match of step.value.matchAll(ROW_BINDING)) policy.columns.add(match[1]!);
        }
      }
      select(input, "input", policy);
      policies.set(name, policy);
    }
    if (args) argumentsFor.set(args, policies);
  };
  const tableSecrets = (item: unknown, columns: Set<string>): void => {
    for (const row of parseTable(item)) for (const column of columns) remember(row[column]);
  };
  const collectData = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(collectData); return; }
    const node = record(item);
    if (secretNode(node)) {
      for (const key of USER_VALUE_FIELDS.event) if (key !== "key" || typeof node.key === "string" && keyMayInsertText(node.key)) remember(node[key]);
      remember(record(node.identity).value);
    }
    Object.values(node).forEach(collectData);
  };
  const evidence = (item: unknown, policy: ValuePolicy): void => {
    if (policy.choice) return;
    if (policy.columns) tableSecrets(item, policy.columns);
    else if (policy.secret) remember(item);
    collectData(item);
  };
  const collectArgs = (args: RecordValue): void => {
    if (context.workflow) bind(context.workflow as unknown as RecordValue, args);
    if (!argumentsFor.has(args)) argumentsFor.set(args, new Map());
    collectData(args);
    for (const [name, item] of Object.entries(args)) evidence(item, argumentsFor.get(args)?.get(name) ?? {});
  };
  const field = (node: RecordValue): boolean => secretSavedField(node) || [node.role, node.tag].some((value) => typeof value === "string" && ["textbox", "input", "textarea", "select", "radio", "checkbox", "axtextfield", "axsecuretextfield", "axtextarea"].includes(value.toLowerCase()));
  const collect = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(collect); return; }
    const node = record(item);
    if (isSealedArtifact(node)) return;
    if ((node.schema === "bao.workflow/v4" || node === context.workflow) && Array.isArray(node.steps) && Array.isArray(node.inputs)) {
      workflows.add(node);
      bind(node);
    }
    const action = String(node.action || node.op || "");
    const scope = steps.get(node) ?? (typeof node.action === "string" && typeof node.id === "string" ? copies.get(node.id) : undefined);
    const event = typeof node.op === "string";
    const entry = ENTRY.has(action) || ["select", "check"].includes(action);
    const structural = scope?.secret || secretNode(node);
    if (event && field(record(node.identity))) select(node, "effect", { secret: structural, choice: fixedSavedChoice(node) && !structural });
    if (event && node.dialogType === "prompt") select(node, "dialog", { secret: structural });
    if (entry) {
      select(node, event ? "event" : "step", { secret: structural });
      const fields = slots.get(node)!;
      if (fixedSavedChoice(node) && !structural) for (const key of ["value", "valueBefore", "valueAfter"]) fields.delete(key);
      if (scope && bindingTokens(node.value, scope.names, scope.row).size) fields.delete("value");
      if (typeof node.key === "string") {
        const name = canonicalKey(node.key).split("+").at(-1) || "";
        if ((name.length === 1 || KEY_EVENTS[name]) && !keyMayInsertText(node.key)) fields.delete("key");
      }
    }
    const identity = record(node.identity);
    const form = field(identity) && ["dom", "ax", "atspi"].includes(String(identity.surface));
    const control = node.kind === "field" && field(record(node.field));
    if (entry || event || form || control) {
      for (const child of [identity, record(node.field)]) if (field(child)) select(child, "field", { secret: structural || secretNode(child), choice: fixedSavedChoice(node) && !structural });
      if (!entry && !event) select(node, "field", { secret: structural, choice: fixedSavedChoice(node) && !structural });
    }
    if (node.kind === "read-back") select(node, "receipt");
    const runtime = event || typeof node.workflowId === "string" || typeof node.runId === "string" || typeof record(node.ask).workflowId === "string";
    if (runtime) {
      select(node, "runtime", { arguments: true });
      for (const receipt of Array.isArray(node.receipts) ? node.receipts : []) {
        if (isSealedArtifact(receipt)) continue;
        select(record(receipt), "receipt");
        select(record(receipt), "result");
      }
      for (const output of Array.isArray(node.outputs) ? node.outputs : []) {
        const result = record(output);
        if (result.type === "table") select(result, "table");
        else if (result.type === "text" || result.type === "number") select(result, "output");
      }
    }
    if (event) select(record(node.list), "table");
    if (node.schema === "bao.intent-case/v1") {
      select(node, "teaching");
      for (const replay of Array.isArray(node.replays) ? node.replays : []) select(record(replay), "replay");
    }
    for (const [key, child] of Object.entries(node)) {
      const policy = slots.get(node)?.get(key);
      if (policy?.arguments && child && typeof child === "object" && !Array.isArray(child)) collectArgs(record(child));
      else if (policy) evidence(child, policy);
      else collect(child);
    }
  };
  context.secrets?.forEach(remember);
  if (context.workflow) collect(context.workflow);
  for (const args of Array.isArray(context.args) ? context.args : [context.args]) if (args) collectArgs(args);
  if (!rootData) collect(value);
  const scalar = (item: string | number, known = true): string | number => {
    if (item === STRIPPED_SECRET) return item;
    return (known && secrets.has(String(item))) || redactSavedValue(String(item)) === STRIPPED_SECRET ? STRIPPED_SECRET : item;
  };
  const data = (item: unknown): unknown => {
    if (typeof item === "string" || typeof item === "number") return scalar(item);
    if (Array.isArray(item)) return item.map(data);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, data(child)]));
    return item;
  };
  const table = (item: unknown, columns: Set<string>): unknown => {
    if (typeof item === "string") return mapCsv(item, (value, column) => columns.has(column) && value ? STRIPPED_SECRET : redactSavedValue(value));
    if (Array.isArray(item)) return item.map((row) => Object.fromEntries(Object.entries(record(row)).map(([key, child]) => {
      if (columns.has(sanitizeName(key, 0)) && child != null && child !== "") return [key, STRIPPED_SECRET];
      return [key, typeof child === "string" || typeof child === "number" ? scalar(child, false) : data(child)];
    })));
    return item;
  };
  const cleanArgs = (item: unknown): unknown => Array.isArray(item) ? item.map(cleanArgs) : Object.fromEntries(Object.entries(record(item)).map(([key, child]) => [key, cleanValue(child, argumentsFor.get(record(item))?.get(key) ?? {})]));
  const cleanValue = (item: unknown, policy: ValuePolicy): unknown => policy.choice ? structuredClone(item) : policy.columns ? table(item, policy.columns) : policy.arguments && item && typeof item === "object" && !Array.isArray(item) ? cleanArgs(item) : data(item);
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(clean);
    if (!item || typeof item !== "object") return item;
    const raw = record(item);
    if (isSealedArtifact(raw)) return structuredClone(raw);
    const node = Object.fromEntries(Object.entries(raw).map(([key, child]) => {
      const policy = slots.get(raw)?.get(key);
      return [key, policy ? cleanValue(child, policy) : clean(child)];
    }));
    return node;
  };
  return (rootData ? cleanArgs(value) : clean(value)) as T;
}
