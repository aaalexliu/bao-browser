import { bindingTokens } from "../../../shared/bindings";
import { secretSavedField } from "../../../shared/saved-secrets";
import type { WorkflowStep, WorkflowV2 } from "../v1/schema";

/** Shared by marketplace evidence and the MCP viewer. Unknown capture steps are not shareable. */
export function privateStep(workflow: WorkflowV2, step: WorkflowStep): boolean {
  const secrets = new Set(workflow.inputs.filter((input) => input.type === "secret").map((input) => input.name));
  return step.sensitive === true || secretSavedField(step) || secretSavedField(step.identity)
    || Boolean(step.input && secrets.has(step.input)) || bindingTokens(step.value, secrets).size > 0;
}
