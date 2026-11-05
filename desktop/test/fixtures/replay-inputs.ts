import type { ReplayArgs, WorkflowV2 } from "../../src/v1/schema";

/** Supply saved public defaults to exercise replay's secret checks without a browser driver. */
export function recordedInputs(workflow: Pick<WorkflowV2, "inputs">, inputs: ReplayArgs): ReplayArgs {
  const defaults: ReplayArgs = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret" || input.type === "file" || !input.default) continue;
    defaults[input.name] = input.type === "number" ? Number(input.default) : input.default;
  }
  return { ...defaults, ...inputs };
}
