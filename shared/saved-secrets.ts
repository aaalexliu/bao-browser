import { INPUT_BINDING } from "./bindings";
import type { ReplayArgs, WorkflowV2, WorkflowStep } from "../desktop/src/v1/schema";

export const STRIPPED_SECRET = "[secret stripped]";
export const NEEDS_SECRET_VALUE = "This step needs a value. Its saved value was stripped because it may contain a secret.";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export function isSealedArtifact(value: unknown): boolean {
  if (typeof value === "string") return /^sha256:[a-f0-9]{64}$/.test(value);
  const node = record(value);
  return node.kind === "read-back" && typeof node.hash === "string" && node.hash.length > 0
    || typeof node.documentHash === "string" && node.documentHash.length > 0 && record(node.document).schema === "bao.workflow/v2";
}

export function secretSavedField(value: unknown): boolean {
  const field = record(value);
  if ([field.type, field.inputType, field.role].some((item) => typeof item === "string" && item.toLowerCase() === "password")) return true;
  return typeof field.autocomplete === "string" && field.autocomplete.toLowerCase().split(/\s+/).some((token) =>
    token === "current-password" || token === "new-password" || token === "one-time-code" || token.startsWith("cc-"));
}

export function fixedSavedChoice(value: unknown): boolean {
  const node = record(value);
  const choiceField = (value: unknown): boolean => {
    const field = record(value);
    return [field.type, field.inputType, field.role, field.tag, field.kind].some((item) => typeof item === "string" && ["select", "radio", "checkbox", "option"].includes(item.toLowerCase()));
  };
  return [node.action, node.op].some((action) => action === "select" || action === "check") || choiceField(node) || choiceField(node.identity) || choiceField(node.field);
}

export function hasStrippedSecret(value: unknown): boolean {
  return Array.isArray(value) ? value.some(hasStrippedSecret) : typeof value === "string" && value.includes(STRIPPED_SECRET);
}

export function stepNeedsSecretValue(step: WorkflowStep, workflow: WorkflowV2, args: ReplayArgs): boolean {
  const reason = step.unresolved?.reason;
  if (reason === "redacted key" || hasStrippedSecret(step.key)) return true;
  const override = step.input && args[step.input] != null && ["type", "digits", "select"].includes(step.action);
  if (!override && hasStrippedSecret(step.value)) return true;
  const inputs = new Set<string>();
  if (step.input) inputs.add(step.input);
  if (typeof step.value === "string") for (const match of step.value.matchAll(INPUT_BINDING)) inputs.add(match[1]!);
  const source = step.forEach?.over;
  const tableName = source?.kind === "input" ? source.name : undefined;
  if (tableName) inputs.add(tableName);
  if ([...inputs].some((name) => {
    const input = workflow.inputs.find((input) => input.name === name);
    const value = args[name] ?? input?.default;
    return input?.type === "table" && tableName === name ? typeof value === "string" && value.trim() === STRIPPED_SECRET : hasStrippedSecret(value);
  })) return true;
  return reason === NEEDS_SECRET_VALUE && (!inputs.size || [...inputs].some((name) => args[name] == null || args[name] === ""));
}
