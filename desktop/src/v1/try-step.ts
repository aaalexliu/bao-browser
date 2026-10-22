// Try looks a step up on the live window. It does not click, type, or call a model.

import type { HealProvider } from "./heal";
import { lookup } from "./identity";
import type { Driver } from "./replay";
import { identityView } from "./run-trace";
import type { IdentityView } from "../app/view-types";
import type { WorkflowStep } from "./schema";

export interface TryOutcome {
  matched: boolean;
  /** Clicks, typing, keys, uploads, drops, and checks. Tree and outline are not actions. */
  actions: number;
  modelCalls: number;
  identity?: IdentityView;
  reason?: string;
}

export async function tryStep(step: WorkflowStep, driver: Driver, heal?: HealProvider): Promise<TryOutcome> {
  void heal;
  if (!step.identity) {
    return { matched: false, actions: 0, modelCalls: 0, reason: "no identity" };
  }
  const tree = await driver.tree();
  const hit = lookup(step.identity, tree.nodes);
  const identity = identityView(step.identity, tree.nodes, hit);
  const node = hit.ok && hit.index != null ? tree.nodes[hit.index] : undefined;
  if (node) {
    try {
      await driver.outline?.(node);
    } catch { /* the score still stands */ }
  }
  return {
    matched: hit.ok,
    actions: 0,
    modelCalls: 0,
    identity,
    reason: hit.ok ? undefined : (hit.reason || "lookup miss"),
  };
}
