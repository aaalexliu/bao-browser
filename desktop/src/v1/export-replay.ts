// One-way export to a Chrome DevTools Recorder / puppeteer-replay JSON file.
// Anchor locators have no selector in that format, so they are left out.

import { stepLocators, stepValueTemplate, stepKey, stepCheck, stepForEach, subst, type ReplayArgs, type StepLocator, type WorkflowStep, type WorkflowV2 } from "./schema";
import { hasStrippedSecret, NEEDS_SECRET_VALUE, stepNeedsSecretValue } from "../../../shared/saved-secrets";

export interface PuppeteerReplayFile {
  title: string;
  steps: Record<string, unknown>[];
}

export function toPuppeteerReplay(workflow: WorkflowV2, args: ReplayArgs = {}): PuppeteerReplayFile {
  const steps: Record<string, unknown>[] = [
    {
      type: "setViewport",
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      isLandscape: false,
    },
  ];
  if (workflow.startUrl) {
    steps.push({
      type: "navigate",
      url: workflow.startUrl,
      assertedEvents: [{ type: "navigation" }],
    });
  }
  const needsValue = (step: WorkflowStep): boolean => {
    if (stepNeedsSecretValue(step, workflow, args)) return true;
    const source = stepForEach(step)?.over;
    if (source?.kind === "input" && [args[source.name], workflow.inputs.find((input) => input.name === source.name)?.default].some(hasStrippedSecret)) return true;
    return stepForEach(step)?.steps.some(needsValue) ?? false;
  };
  for (const step of workflow.steps) {
    if (needsValue(step)) throw new Error(NEEDS_SECRET_VALUE);
    const selectors = selectorChains(stepLocators(step));
    if (step.action === "navigate") continue;
    if (step.action === "click" || step.action === "check") {
      // @puppeteer/replay 4.0.2 always forwards offsetX/offsetY. Puppeteer 25
      // treats an undefined offset as a point it never reaches, so the click
      // waits until timeout. One pixel in from the top left still hits the node.
      if (selectors.length) steps.push({ type: "click", selectors, offsetX: 1, offsetY: 1 });
    } else if (step.action === "type" || step.action === "select") {
      const value = subst(stepValueTemplate(step) || "", args);
      if (selectors.length) steps.push({ type: "change", selectors, value });
    } else if (step.action === "key" && stepKey(step)) {
      steps.push({ type: "keyDown", key: stepKey(step) });
      steps.push({ type: "keyUp", key: stepKey(step) });
    }
    const held = stepCheck(step);
    const match = held && "match" in held ? held.match : undefined;
    if (!held || !match || step.action === "type") continue;
    const text = subst(match, args);
    if (!text) continue;
    const url = held?.kind === "url";
    steps.push({
      type: "waitForExpression",
      expression: url
        ? `location.href.includes(${JSON.stringify(text)})`
        : `document.body && document.body.innerText.includes(${JSON.stringify(text)})`,
    });
  }
  return { title: workflow.name, steps };
}

function selectorChains(locators: StepLocator[] | undefined): string[][] {
  const out: string[][] = [];
  for (const locator of locators ?? []) {
    const selector = toSelector(locator);
    if (selector) out.push([selector]);
  }
  return out;
}

function toSelector(locator: StepLocator): string | undefined {
  switch (locator.kind) {
    case "role":
      // Chrome DevTools Recorder stores the accessible name after aria/.
      if (!locator.name) return undefined;
      return `aria/${locator.name.replace(/[\n\r]/g, " ")}`;
    case "text":
      if (!locator.value) return undefined;
      return `text/${locator.value}`;
    case "testid":
      if (!locator.value) return undefined;
      return `[data-testid="${locator.value.replace(/"/g, '\\"')}"]`;
    case "css":
      if (!locator.value) return undefined;
      return locator.value;
    case "xpath":
      if (!locator.value) return undefined;
      return locator.value.startsWith("xpath/") ? locator.value : `xpath/${locator.value}`;
    case "anchor":
      return undefined;
  }
}
