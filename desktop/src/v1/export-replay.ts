// One-way export to a Chrome DevTools Recorder / puppeteer-replay JSON file.
// Anchor locators have no selector in that format, so they are left out.

import { subst, type ReplayArgs, type StepLocator, type WorkflowV2 } from "./schema";

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
  for (const step of workflow.steps) {
    const selectors = selectorChains(step.locators);
    if (step.action === "navigate") continue;
    if (step.action === "click" || step.action === "check") {
      // @puppeteer/replay 4.0.2 always forwards offsetX/offsetY. Puppeteer 25
      // treats an undefined offset as a point it never reaches, so the click
      // waits until timeout. One pixel in from the top left still hits the node.
      if (selectors.length) steps.push({ type: "click", selectors, offsetX: 1, offsetY: 1 });
    } else if (step.action === "type" || step.action === "select") {
      const value = subst(step.value || "", args);
      if (selectors.length) steps.push({ type: "change", selectors, value });
    } else if (step.action === "key" && step.key) {
      steps.push({ type: "keyDown", key: step.key });
      steps.push({ type: "keyUp", key: step.key });
    }
    const held = step.expect || step.postcondition;
    const match = step.expect?.match || step.postcondition?.match;
    if (!held || !match || step.action === "type") continue;
    const text = subst(match, args);
    if (!text) continue;
    const url = (step.expect?.kind || step.postcondition?.kind) === "url";
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
  if (locator.kind === "role" && locator.name) {
    // Chrome DevTools Recorder stores the accessible name after aria/.
    return `aria/${locator.name.replace(/[\n\r]/g, " ")}`;
  }
  if (locator.kind === "text" && locator.value) return `text/${locator.value}`;
  if (locator.kind === "testid" && locator.value) return `[data-testid="${locator.value.replace(/"/g, '\\"')}"]`;
  if (locator.kind === "css" && locator.value) return locator.value;
  if (locator.kind === "xpath" && locator.value) {
    return locator.value.startsWith("xpath/") ? locator.value : `xpath/${locator.value}`;
  }
  return undefined;
}
