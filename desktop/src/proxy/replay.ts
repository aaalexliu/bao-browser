import type { Page } from "playwright";
import type { Step, Workflow } from "../../../src/types";
import { clickViewport } from "./input";

export interface ReplayClick {
  label: string;
  x: number;
  y: number;
}

/**
 * Replay resolved steps from their selectors. Unresolved steps are skipped.
 * The point passed to the CDP click is the live element's center, read after
 * resolution. step.provenance is not an input to that point.
 */
export async function replayWorkflow(page: Page, workflow: Workflow): Promise<ReplayClick[]> {
  const clicks: ReplayClick[] = [];
  for (const step of workflow.steps) {
    if (step.unresolved) continue;
    clicks.push(await replayResolved(page, step));
  }
  return clicks;
}

async function replayResolved(page: Page, step: Step): Promise<ReplayClick> {
  if (step.unresolved) throw new Error(`refusing unresolved step: ${step.label}`);
  const selectors = step.target?.selectors;
  if (!selectors || selectors.length === 0) {
    throw new Error(`resolved step has no selector: ${step.label}`);
  }
  const via = await page.evaluate((sels) => {
    const w = window as unknown as { __baoResolve?: (s: typeof sels) => string | null };
    return w.__baoResolve ? w.__baoResolve(sels) : null;
  }, selectors);
  if (!via) throw new Error(`selector missed on replay: ${step.label}`);
  const loc = page.locator("[data-bao-hit='1']");
  if (step.action === "setChecked" && typeof step.checked === "boolean") {
    const current = await loc.isChecked();
    if (current === step.checked) {
      const box = await loc.boundingBox();
      if (!box) throw new Error(`no box for ${step.label}`);
      return { label: step.label, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
  }
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no box for ${step.label}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await clickViewport(page, x, y);
  return { label: step.label, x, y };
}
