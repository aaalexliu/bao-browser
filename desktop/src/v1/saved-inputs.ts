// Owner-saved workflow inputs. An absent import marker means the owner recorded
// the workflow. An imported copy keeps author defaults required until he saves
// his own value for that input.

import { hasStrippedSecret, oneTimeCodeInput } from "../../../shared/saved-secrets";
import type { ReplayArgs, WorkflowInput, WorkflowV2 } from "./schema";

export function ownerSavedValue(workflow: WorkflowV2, input: WorkflowInput): string | number | undefined {
  if (input.type === "file" || oneTimeCodeInput(workflow, input.name)) return undefined;
  if (workflow.imported === true && input.ownerSaved !== true) return undefined;
  if (input.default === undefined || input.default === "" || hasStrippedSecret(input.default)) return undefined;
  if (input.type === "number") {
    const value = Number(input.default);
    return Number.isFinite(value) ? value : undefined;
  }
  return input.default;
}

/** Inputs whose used value is the owner's saved value. Secrets never include the value. */
export function savedValueLine(workflow: WorkflowV2, used: ReplayArgs): string {
  const parts: string[] = [];
  for (const input of workflow.inputs) {
    const saved = ownerSavedValue(workflow, input);
    if (saved === undefined) continue;
    const value = used[input.name];
    if (value === undefined || value === "" || String(value) !== String(saved)) continue;
    const shown = input.type === "secret" ? "saved password" : String(saved);
    parts.push(`${input.name}: ${shown}`);
  }
  return parts.length ? `Saved values used: ${parts.join(" · ")}` : "";
}

/** Write values the owner submitted in the app onto an imported workflow. */
export function adoptOwnerValues(workflow: WorkflowV2, args: ReplayArgs): WorkflowV2 | undefined {
  if (workflow.imported !== true) return undefined;
  let changed = false;
  const inputs = workflow.inputs.map((input) => {
    if (input.type === "file" || oneTimeCodeInput(workflow, input.name)) return input;
    const value = args[input.name];
    if (typeof value !== "string" && typeof value !== "number") return input;
    const text = typeof value === "number" ? String(value) : value;
    if (!text.trim() || hasStrippedSecret(text)) return input;
    if (input.ownerSaved === true && input.default === text) return input;
    changed = true;
    return { ...input, default: text, ownerSaved: true as const };
  });
  if (!changed) return undefined;
  return { ...workflow, inputs, updatedAt: Date.now() };
}
