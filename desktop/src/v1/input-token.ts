// One description of an input. The step token and the run form both read it.

import { validateWorkflow, type InputType, type WorkflowV2 } from "./schema";

export interface TokenInput {
  name: string;
  type?: string;
  label?: string;
  default?: string;
  required?: boolean;
  choices?: string[];
  multiple?: boolean;
}

export interface TokenFields {
  label: string;
  type: string;
  /** Empty for a secret. A secret default is never shown or stored. */
  default: string;
  required: boolean;
  masked: boolean;
}

const TYPES: readonly InputType[] = ["text", "secret", "number", "choice", "file"];

export function tokenFields(input: TokenInput): TokenFields {
  const type = input.type || "text";
  const masked = type === "secret";
  return {
    label: input.label || input.name,
    type,
    default: masked ? "" : (input.default || ""),
    required: input.required === true,
    masked,
  };
}

export function editInput(
  doc: WorkflowV2,
  edit: { name: string; label?: string; type?: string; default?: string; required?: boolean },
): { doc?: WorkflowV2; error?: string } {
  const current = doc.inputs.find((input) => input.name === edit.name);
  if (!current) return { error: "no input" };
  if (edit.type && !TYPES.includes(edit.type as InputType)) return { error: "type" };
  const nextInput = { ...current };
  if (edit.type) nextInput.type = edit.type as InputType;
  if (typeof edit.label === "string") {
    const label = edit.label.trim();
    if (label) nextInput.label = label;
    else delete nextInput.label;
  }
  if (edit.required === true) nextInput.required = true;
  else if (edit.required === false) delete nextInput.required;
  if (nextInput.type === "secret") delete nextInput.default;
  else if (typeof edit.default === "string") {
    const value = edit.default.trim();
    if (value) nextInput.default = value;
    else delete nextInput.default;
  }
  const next: WorkflowV2 = {
    ...doc,
    inputs: doc.inputs.map((input) => input.name === edit.name ? nextInput : input),
    updatedAt: Date.now(),
  };
  const errors = validateWorkflow(next);
  if (errors.length) return { error: errors.join(", ") };
  return { doc: next };
}
