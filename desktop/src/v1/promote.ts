// A model heal stays provisional until the drift suite passes and N later
// real runs pass. The default N is 3. The live workflow changes when that draft is promoted.

export const DEFAULT_PROMOTE_AFTER = 3;

import type { HealProposal } from "./heal";
import type { WorkflowStep } from "./schema";

export type PromotionStatus = "provisional" | "promoted" | "reverted";

export interface Promotion {
  healId: string;
  workflowId: string;
  stepId: string;
  status: PromotionStatus;
  drift: "pending" | "passed" | "failed";
  replays: number;
  patch: HealProposal["patch"];
  before: WorkflowStep;
  reason?: string;
  /** Real runs required before promote. Absent means the default of 3. */
  need?: number;
}

export interface PromotionEvent {
  kind: "promotion";
  ts: number;
  healId: string;
  workflowId: string;
  stepId: string;
  status: PromotionStatus;
  drift: Promotion["drift"];
  replays: number;
  reason?: string;
}

export function openProvisional(input: Omit<Promotion, "status" | "drift" | "replays">): Promotion {
  return { ...input, status: "provisional", drift: "pending", replays: 0 };
}

export function noteDrift(promotion: Promotion, passed: boolean): Promotion {
  if (promotion.status !== "provisional") return promotion;
  if (!passed) return { ...promotion, drift: "failed", status: "reverted", reason: "drift" };
  return { ...promotion, drift: "passed", reason: undefined };
}

export function noteReplay(promotion: Promotion, passed: boolean, required?: number): Promotion {
  if (promotion.status !== "provisional") return promotion;
  if (!passed) return { ...promotion, status: "reverted", reason: "replay" };
  const replays = promotion.replays + 1;
  const need = required ?? promotion.need ?? DEFAULT_PROMOTE_AFTER;
  if (promotion.drift === "passed" && replays >= need) {
    return { ...promotion, replays, status: "promoted", reason: undefined };
  }
  return { ...promotion, replays };
}

export function promotionEvent(promotion: Promotion, ts: number): PromotionEvent {
  return {
    kind: "promotion",
    ts,
    healId: promotion.healId,
    workflowId: promotion.workflowId,
    stepId: promotion.stepId,
    status: promotion.status,
    drift: promotion.drift,
    replays: promotion.replays,
    reason: promotion.reason,
  };
}
