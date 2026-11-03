import { keyMayInsertText } from "../cdp-live/keys";
import type { ReplayArgs, WorkflowStep, WorkflowV2 } from "./schema";

export const STRIPPED_SECRET = "[secret stripped]";
export const NEEDS_SECRET_VALUE = "This step needs a value. Its saved value was stripped because it may contain a secret.";

const ENTRY = new Set(["type", "input", "fill", "key", "keypress", "digits", "select"]);
const MEDIA = new Set(["screenshot", "png", "base64", "image", "video"]);
const STRUCTURE = new Set(["schema", "id", "toolCallId", "op", "action", "kind", "type", "role", "inputType", "autocomplete", "surface", "input", "parameter", "as"]);
const TOKENS = /(?<![A-Za-z0-9_-])(?:(?:sk-|gh[pousr]_|github_pat_|xox[a-z]-|AKIA|GOCSPX-)[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])/g;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function secretSavedField(value: unknown): boolean {
  const field = record(value);
  if ([field.type, field.inputType, field.role].some((item) => typeof item === "string" && item.toLowerCase() === "password")) return true;
  return typeof field.autocomplete === "string" && field.autocomplete.toLowerCase().split(/\s+/).some((token) =>
    token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"));
}

export function hasStrippedSecret(value: unknown): boolean {
  return typeof value === "string" && value.includes(STRIPPED_SECRET);
}

export function stepNeedsSecretValue(step: WorkflowStep, workflow: WorkflowV2, args: ReplayArgs): boolean {
  if (step.unresolved?.reason === NEEDS_SECRET_VALUE || step.unresolved?.reason === "redacted key") return true;
  if ([step.value, step.key].some(hasStrippedSecret)) return true;
  if (step.input && [args[step.input], workflow.inputs.find((input) => input.name === step.input)?.default].some(hasStrippedSecret)) return true;
  if (step.value?.replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => String(args[name] ?? "")).includes(STRIPPED_SECRET)) return true;
  return step.forEach?.steps.some((nested) => stepNeedsSecretValue(nested, workflow, args)) ?? false;
}

function redactSavedText(value: string): string {
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

/** Copy only: dispatch and the caller's live values never change. */
export function scrubSaved<T>(value: T): T {
  const secrets = new Set<string>();
  const remember = (item: unknown, template = false) => {
    if (typeof item === "string" && item && item !== STRIPPED_SECRET && !(template && item.includes("{{"))) secrets.add(item);
  };
  const collect = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(collect); return; }
    const node = record(item);
    const structural = node.sensitive === true || secretSavedField(node) || secretSavedField(node.identity) || secretSavedField(node.field);
    if (structural) {
      remember(record(node.identity).value);
      for (const key of ["value", "text", "valueBefore", "valueAfter"]) remember(node[key], key === "value" && typeof node.action === "string");
      if (typeof node.key === "string" && keyMayInsertText(node.key)) remember(node.key);
    }
    if (node.type === "secret") remember(node.default);
    if (Array.isArray(node.steps) && Array.isArray(node.inputs)) {
      for (const step of node.steps.map(record)) {
        if (!step.sensitive && !secretSavedField(step.identity)) continue;
        const input = node.inputs.map(record).find((input) => input.name === step.input);
        if (input) remember(input.default);
      }
    }
    for (const [key, child] of Object.entries(node)) if (!MEDIA.has(key)) collect(child);
  };
  collect(value);
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  const cleanText = (text: string, template: boolean): string => {
    if (secrets.has(text)) return STRIPPED_SECRET;
    return (template ? text.split(/(\{\{[^}]+\}\})/g) : [text]).map((part) => {
      if (template && part.startsWith("{{") && part.endsWith("}}")) return part;
      for (const secret of ordered) {
        if (part === secret) part = STRIPPED_SECRET;
        else if (secret.length >= 4) part = part.split(secret).join(STRIPPED_SECRET);
      }
      return redactSavedText(part);
    }).join("");
  };
  const clean = (item: unknown, template = false): unknown => {
    if (typeof item === "string") return cleanText(item, template);
    if (Array.isArray(item)) return item.map((child) => clean(child));
    if (!item || typeof item !== "object") return item;
    const raw = record(item);
    const node = Object.fromEntries(Object.entries(raw).map(([key, child]) => {
      // Keep enum values and binding names intact even when someone typed that same word.
      const bindingName = key === "name" && typeof raw.type === "string";
      return [key, MEDIA.has(key) || STRUCTURE.has(key) || bindingName ? child : clean(child, typeof raw.action === "string" && (key === "value" || key === "label"))];
    }));
    if (ENTRY.has(String(node.action || "")) && [node.value, node.key].some(hasStrippedSecret)) {
      node.unresolved = { reason: NEEDS_SECRET_VALUE };
    }
    if (Array.isArray(node.steps) && Array.isArray(node.inputs)) {
      for (const step of node.steps.map(record)) {
        const input = node.inputs.map(record).find((input) => input.name === step.input);
        if (input && hasStrippedSecret(input.default)) step.unresolved = { reason: NEEDS_SECRET_VALUE };
      }
    }
    return node;
  };
  return clean(value) as T;
}
