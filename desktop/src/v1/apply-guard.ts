// Credit-freeze stops before Apply. A click on Apply needs a human confirm event.

import type { Identity, WorkflowV2 } from "./schema";

export interface RunTrailEvent {
  kind: "auth" | "human-confirm" | "click";
  stepId: string;
  phase?: "auth";
  reason?: string;
  target?: string;
}

export interface ApplyGate {
  workflow: WorkflowV2;
  trail: RunTrailEvent[];
}

export function isApplyTarget(node: Identity | undefined): boolean {
  if (!node) return false;
  const bits = [node.testId, node.id, node.text, node.name, node.label, node.nameAttr]
    .filter((bit): bit is string => typeof bit === "string" && bit.length > 0);
  return bits.some((bit) => /(^|[^a-z0-9])apply([^a-z0-9]|$)/i.test(bit));
}

/** Workflows that confirm and do not themselves click Apply. */
export function guardsApply(workflow: WorkflowV2): boolean {
  const confirms = workflow.steps.some((step) => step.action === "confirm");
  const clicksApply = workflow.steps.some((step) => step.action === "click" && isApplyTarget(step.identity));
  return confirms && !clicksApply;
}

export function applyAllowed(workflow: WorkflowV2, trail: readonly RunTrailEvent[], node: Identity): boolean {
  if (!guardsApply(workflow)) return true;
  if (!isApplyTarget(node)) return true;
  return trail.some((event) => event.kind === "human-confirm");
}
