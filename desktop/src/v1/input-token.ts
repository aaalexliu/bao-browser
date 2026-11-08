// One description of an input. The step token and the run form both read it.

import { hasStrippedSecret, oneTimeCodeInput } from "../../../shared/saved-secrets";
import { finishInput, validateWorkflow, type InputType, type WorkflowV2 } from "./schema";

export interface TokenInput {
  name: string;
  type?: string;
  label?: string;
  default?: string;
  required?: boolean;
  choices?: string[];
  multiple?: boolean;
  format?: string;
  relative?: string;
  zone?: string;
  fromOutput?: string;
  supply?: "saved" | "must";
  /** Label of the download step this file is filled from. */
  boundStep?: string;
  fresh?: boolean;
}

export interface TokenFields {
  label: string;
  type: string;
  default: string;
  required: boolean;
  masked: boolean;
}

const TYPES: readonly InputType[] = ["text", "secret", "number", "choice", "file", "date", "table"];

export function tokenFields(input: TokenInput): TokenFields {
  const type = input.type || "text";
  const masked = type === "secret";
  return {
    label: input.label || input.name,
    type,
    default: input.fresh || hasStrippedSecret(input.default) ? "" : input.default || "",
    required: input.supply ? input.supply === "must" : input.required === true,
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
  }
  if (typeof edit.default === "string") {
    const value = nextInput.type === "secret" ? edit.default : edit.default.trim();
    if (value) {
      nextInput.default = value;
      if (doc.imported && value !== current.default) nextInput.ownerSaved = true;
    } else {
      delete nextInput.default;
      delete nextInput.ownerSaved;
    }
  }
  if (edit.required === true || oneTimeCodeInput(doc, nextInput.name)) delete nextInput.default;
  Object.assign(nextInput, finishInput(nextInput));
  const next: WorkflowV2 = {
    ...doc,
    inputs: doc.inputs.map((input) => input.name === edit.name ? nextInput : input),
    updatedAt: Date.now(),
  };
  const errors = validateWorkflow(next);
  if (errors.length) return { error: errors.join(", ") };
  return { doc: next };
}
