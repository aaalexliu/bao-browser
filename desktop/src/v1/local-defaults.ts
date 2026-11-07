import { INPUT_BINDING } from "../../../shared/bindings";
import { hasStrippedSecret, NEEDS_SECRET_VALUE, oneTimeCodeInput, stepNeedsSecretValue } from "../../../shared/saved-secrets";
import { stripUnsafe } from "../../../shared/sync-guard";
import type { WorkflowStep, WorkflowV2 } from "./schema";

export function retainLocalDefaults(doc: WorkflowV2, local?: WorkflowV2): WorkflowV2 {
  const projected = local ? stripUnsafe(local) as WorkflowV2 : undefined;
  const inputs = new Map(local?.inputs.map((input) => [input.name, input]));
  const projectedInputs = new Map(projected?.inputs.map((input) => [input.name, input]));
  for (const input of doc.inputs) {
    if (input.type === "file" || oneTimeCodeInput(doc, input.name)) continue;
    const saved = inputs.get(input.name);
    const stripped = projectedInputs.get(input.name);
    if (saved?.type !== input.type || saved.default === undefined || !stripped) continue;
    if (input.default === stripped.default) input.default = saved.default;
  }
  const steps = new Map<string, WorkflowStep>();
  const projectedSteps = new Map<string, WorkflowStep>();
  const remember = (items: WorkflowStep[], target: Map<string, WorkflowStep>): void => {
    for (const step of items) {
      target.set(step.id, step);
      if (step.forEach) remember(step.forEach.steps, target);
    }
  };
  remember(local?.steps ?? [], steps);
  remember(projected?.steps ?? [], projectedSteps);
  const defaults = Object.fromEntries(doc.inputs.flatMap((input) => input.default === undefined ? [] : [[input.name, input.default] as const]));
  const restore = (items: WorkflowStep[]): void => {
    for (const step of items) {
      const saved = steps.get(step.id);
      const stripped = projectedSteps.get(step.id);
      for (const field of ["value", "key"] as const) {
        const value = saved?.[field];
        if (stripped && step[field] === stripped[field]
          && (hasStrippedSecret(step[field]) || step[field] === undefined)
          && value !== undefined && !hasStrippedSecret(value) && !value.includes("{{")) {
          step[field] = value;
        }
      }
      const bound = new Set([...(step.input ? [step.input] : []),
        ...[...(step.value ?? "").matchAll(INPUT_BINDING)].map((match) => match[1]!),
        ...(step.forEach?.over.kind === "input" ? [step.forEach.over.name] : [])]);
      if (step.unresolved?.reason === NEEDS_SECRET_VALUE
        && (step.value !== undefined || step.key !== undefined || bound.size > 0)
        && [...bound].every((name) => defaults[name] !== undefined && defaults[name] !== "")
        && !stepNeedsSecretValue({ ...step, unresolved: undefined }, doc, defaults)) {
        if (stripped?.unresolved?.reason === NEEDS_SECRET_VALUE && saved?.unresolved
          && saved.unresolved.reason !== NEEDS_SECRET_VALUE) step.unresolved = saved.unresolved;
        else delete step.unresolved;
      }
      if (step.forEach) restore(step.forEach.steps);
    }
  };
  restore(doc.steps);
  return doc;
}
