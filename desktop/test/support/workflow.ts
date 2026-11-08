// v4 workflow values for tests.

import { locatorsFromIdentity } from "../../src/v1/locators";
import { hintFromIdentity, stepTarget, WORKFLOW_SCHEMA_ID, type Identity, type Target, type TextOf, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";

/** A workflow with test defaults. Steps are numbered by position. */
export function testWorkflow(doc: Partial<WorkflowV2>): WorkflowV2 {
  return {
    schema: WORKFLOW_SCHEMA_ID,
    id: "wf",
    name: "Workflow",
    startUrl: "https://example.test/",
    createdAt: 1,
    inputs: [],
    ...doc,
    steps: (doc.steps ?? []).map((step, index) => ({ ...step, index })),
  };
}

/** The target the recorder stores for a live node. */
export function targetFor(node: Identity): Target {
  const hint = hintFromIdentity(node);
  return { locators: locatorsFromIdentity(node) ?? [], ...(hint ? { hint } : {}) };
}

/** The text a type, select or digits step enters. */
export function stepText(step: WorkflowStep | undefined): TextOf | undefined {
  return step?.action === "type" || step?.action === "select" || step?.action === "digits" ? step.text : undefined;
}

export function targetOf(step: WorkflowStep | undefined): Target | undefined {
  return step && stepTarget(step);
}
