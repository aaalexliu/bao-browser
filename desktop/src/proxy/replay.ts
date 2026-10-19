import type { Page } from "playwright";
import type { Step, Workflow } from "../../../src/types";
import { clickViewport } from "./input";

export interface ReplayClick {
  label: string;
  x: number;
  y: number;
}

export interface ReplayOptions {
  /** Values for sensitive steps, in order. Not read from the workflow. */
  secrets?: string[];
}

/**
 * Replay resolved steps from their selectors. Unresolved steps are skipped.
 * Clicks use the live element's center. Provenance is not an input.
 * A page-level key has no target and is pressed with no coordinate.
 */
export async function replayWorkflow(page: Page, workflow: Workflow, opts?: ReplayOptions): Promise<ReplayClick[]> {
  const clicks: ReplayClick[] = [];
  const secrets = [...(opts?.secrets ?? [])];
  for (const step of workflow.steps) {
    if (step.unresolved) continue;
    clicks.push(await replayResolved(page, step, secrets));
  }
  return clicks;
}

async function replayResolved(page: Page, step: Step, secrets: string[]): Promise<ReplayClick> {
  if (step.unresolved) throw new Error(`refusing unresolved step: ${step.label}`);
  if (step.action === "keypress" && !step.target) {
    if (!step.key) throw new Error(`page key missing on ${step.label}`);
    for (const key of step.key.split(",")) await page.keyboard.press(key);
    return { label: step.label, x: 0, y: 0 };
  }
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
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no box for ${step.label}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (step.action === "input") {
    const value = step.sensitive ? secrets.shift() : step.value;
    if (step.sensitive && value === undefined) throw new Error(`no secret supplied for ${step.label}`);
    await loc.fill(value ?? "");
    return { label: step.label, x, y };
  }
  if (step.action === "keypress") {
    if (!step.key) throw new Error(`key missing on ${step.label}`);
    await loc.focus();
    if (step.submits) {
      const nav = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
      for (const key of step.key.split(",")) await page.keyboard.press(key);
      await nav;
    } else {
      for (const key of step.key.split(",")) await page.keyboard.press(key);
    }
    return { label: step.label, x, y };
  }
  if (step.action === "setChecked" && typeof step.checked === "boolean") {
    const current = await loc.isChecked();
    if (current === step.checked) return { label: step.label, x, y };
  }
  await clickViewport(page, x, y);
  return { label: step.label, x, y };
}
