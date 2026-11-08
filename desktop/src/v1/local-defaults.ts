import { hasStrippedSecret, oneTimeCodeInput } from "../../../shared/saved-secrets";
import { stripUnsafe } from "../../../shared/sync-guard";
import { finishInput, stepValueTemplate } from "./schema";
import type { WorkflowStep, WorkflowV2 } from "./schema";

export function retainLocalDefaults(doc: WorkflowV2, local?: WorkflowV2): WorkflowV2 {
  const projected = local ? stripUnsafe(local) as WorkflowV2 : undefined;
  const inputs = new Map(local?.inputs.map((input) => [input.name, input]));
  const projectedInputs = new Map(projected?.inputs.map((input) => [input.name, input]));
  for (const input of doc.inputs) {
    if (input.type === "file" || oneTimeCodeInput(doc, input.name)) continue;
    const saved = inputs.get(input.name);
    const stripped = projectedInputs.get(input.name);
    if (!saved || saved.type !== input.type || saved.default === undefined || !stripped) continue;
    if (input.default === stripped.default) {
      input.default = saved.default;
      const finished = finishInput(input);
      input.supply = finished.supply;
      if (finished.default === undefined) delete input.default;
      else input.default = finished.default;
    }
  }
  const steps = new Map<string, WorkflowStep>();
  const projectedSteps = new Map<string, WorkflowStep>();
  const remember = (items: WorkflowStep[], target: Map<string, WorkflowStep>): void => {
    for (const step of items) {
      target.set(step.id, step);
      if (step.action === "for_each") remember(step.forEach.steps, target);
    }
  };
  remember(local?.steps ?? [], steps);
  remember(projected?.steps ?? [], projectedSteps);
  const restore = (items: WorkflowStep[]): void => {
    for (const step of items) {
      restoreSecretText(step, steps.get(step.id), projectedSteps.get(step.id));
      if (step.action === "for_each") restore(step.forEach.steps);
    }
  };
  restore(doc.steps);
  return doc;
}

function restoreSecretText(step: WorkflowStep, saved: WorkflowStep | undefined, stripped: WorkflowStep | undefined): void {
  if (!saved || !stripped) return;
  if (step.action === "key" && saved.action === "key" && stripped.action === "key") {
    const next = keptSecret(step.key, stripped.key, saved.key);
    if (next !== undefined) step.key = next;
  }
  if (step.action === "type" || step.action === "select" || step.action === "digits") {
    const next = keptSecret(stepValueTemplate(step), stepValueTemplate(stripped), stepValueTemplate(saved));
    if (next !== undefined) step.text = { literal: next };
  }
}

function keptSecret(current: string | undefined, stripped: string | undefined, saved: string | undefined): string | undefined {
  if (current !== stripped) return undefined;
  if (!(hasStrippedSecret(current) || current === undefined)) return undefined;
  if (saved === undefined || hasStrippedSecret(saved) || saved.includes("{{")) return undefined;
  return saved;
}
