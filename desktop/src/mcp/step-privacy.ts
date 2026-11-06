import { bindingTokens } from "../../../shared/bindings";
import { secretSavedField } from "../../../shared/saved-secrets";
import type { WorkflowStep, WorkflowV2 } from "../v1/schema";
import type { StoredRun } from "../v1/store";

/** Shared by marketplace evidence and the MCP viewer. Unknown capture steps are not shareable. */
export function privateStep(workflow: WorkflowV2, step: WorkflowStep, run: Pick<StoredRun, "receipts" | "failure" | "envelope" | "steps">): boolean {
  const secrets = new Set(workflow.inputs.filter((input) => input.type === "secret").map((input) => input.name));
  const recorded = [...(run.receipts || []), run.failure].some((item) =>
    item !== null && typeof item === "object" && "stepId" in item && item.stepId === step.id)
    || run.steps.some((item) => item !== null && typeof item === "object" && "id" in item && item.id === step.id
      && ("readBack" in item || ("status" in item && ["paused", "failed", "timeout", "timed-out"].includes(String(item.status)))));
  return step.sensitive === true || secretSavedField(step) || secretSavedField(step.identity)
    || Boolean(step.input && secrets.has(step.input)) || bindingTokens(step.value, secrets).size > 0
    || bindingTokens(step.readBack?.match, secrets).size > 0
    || ((recorded || run.envelope?.step === step.id || workflow.steps.at(-1)?.id === step.id)
      && bindingTokens(workflow.readBack?.match, secrets).size > 0);
}
