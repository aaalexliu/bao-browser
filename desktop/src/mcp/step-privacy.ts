import { bindingTokens, ROW_BINDING } from "../../../shared/bindings";
import { secretSavedField } from "../../../shared/saved-secrets";
import type { WorkflowStep, WorkflowV2 } from "../v1/schema";
import type { StoredRun } from "../v1/store";

/** Shared by marketplace evidence and the MCP viewer. Unknown capture steps are not shareable. */
export function privateStep(workflow: WorkflowV2, step: WorkflowStep, run: Pick<StoredRun, "receipts" | "failure" | "envelope" | "steps">): boolean {
  const secrets = new Set(workflow.inputs.filter((input) => input.type === "secret").map((input) => input.name));
  const names = new Set(workflow.inputs.map((input) => input.name));
  type Source = NonNullable<WorkflowStep["forEach"]>["over"];
  const scopes: { step: WorkflowStep; row?: Source }[] = [];
  const walk = (steps: WorkflowStep[], row?: Source): void => {
    for (const item of steps) {
      scopes.push({ step: item, row });
      if (item.forEach) walk(item.forEach.steps, item.forEach.over);
    }
  };
  walk(workflow.steps);
  const structural = (item: WorkflowStep): boolean => item.sensitive === true || secretSavedField(item) || secretSavedField(item.identity)
    || secretSavedField(item.readBack?.identity) || secretSavedField(item.expect?.identity) || secretSavedField(item.postcondition?.identity);
  const fields = (item: WorkflowStep) => [item.value, item.readBack?.match, item.expect?.match, item.postcondition?.match];
  const columns = new Map<string, Set<string>>();
  for (const { step: item, row } of scopes) {
    if (!structural(item)) continue;
    if (item.input) secrets.add(item.input);
    for (const value of fields(item)) {
      for (const token of bindingTokens(value, names)) secrets.add(token.slice(2, -2));
      if (row && typeof value === "string") {
        const key = `${row.kind}:${row.name}`;
        const hidden = columns.get(key) || new Set<string>();
        for (const match of value.matchAll(ROW_BINDING)) hidden.add(match[1]!);
        columns.set(key, hidden);
      }
    }
  }
  const bound = (value: unknown, row?: Source): boolean => {
    if (bindingTokens(value, secrets).size) return true;
    if (!row || typeof value !== "string") return false;
    return [...value.matchAll(ROW_BINDING)].some((match) =>
      (row.kind === "input" && secrets.has(row.name)) || columns.get(`${row.kind}:${row.name}`)?.has(match[1]!));
  };
  const hidden = (item: WorkflowStep, row?: Source): boolean => structural(item)
    || Boolean(item.input && secrets.has(item.input))
    || fields(item).some((value) => bound(value, row))
    || Boolean(item.forEach?.steps.some((child) => hidden(child, item.forEach!.over)));
  const recorded = [...(run.receipts || []), run.failure].some((item) =>
    item !== null && typeof item === "object" && "stepId" in item && item.stepId === step.id)
    || run.steps.some((item) => item !== null && typeof item === "object" && "id" in item && item.id === step.id
      && ("readBack" in item || ("status" in item && ["paused", "failed", "timeout", "timed-out"].includes(String(item.status)))));
  return hidden(step, scopes.find((scope) => scope.step === step)?.row)
    || ((recorded || run.envelope?.step === step.id || workflow.steps.at(-1)?.id === step.id)
      && bindingTokens(workflow.readBack?.match, secrets).size > 0);
}
