// Scripted record + CDP replay for spike 1. Selectors are read from the live
// page (installPageHelpers). Replay clicks go through Input.dispatchMouseEvent
// so the page sees isTrusted. File upload is intercepted on record and applied
// with setInputFiles on replay — the workflow stores the basename only.

import type { BrowserContext, Page } from "playwright";
import type { FrameRef, Step, Target, Workflow } from "../../src/types";
import { installPageHelpers, type Described } from "./page-fns";

const ORIGIN = "https://the-internet.herokuapp.com";
export const START_URL = `${ORIGIN}/`;
const PACE_MS = 2900;

export interface RecordedSession {
  steps: Step[];
  durationMs: number;
  checked: boolean;
  inputValue: string;
}

export interface ReplayOutcome {
  checked: boolean;
  inputValue: string;
  secondUrl: string;
  uploadText: string;
  trusted: boolean | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function frameFor(page: Page, index: number, openerIndex?: number): FrameRef {
  const url = page.url();
  let origin: string | undefined;
  try {
    origin = new URL(url).origin;
  } catch { /* about:blank */ }
  return { url, origin, top: true, tab: { index, openerIndex, urlPattern: pathname(url) } };
}

async function describe(page: Page, selector: string): Promise<Described> {
  const d = await page.evaluate((sel) => {
    const w = window as unknown as { __baoDescribe?: (el: Element) => Described };
    const el = document.querySelector(sel);
    if (!el || !w.__baoDescribe) return null;
    return w.__baoDescribe(el);
  }, selector);
  if (!d) throw new Error(`Could not describe ${selector} on ${page.url()}`);
  return d;
}

function targetOf(d: Described): Target {
  return { selectors: d.selectors, reach: d.reach, unique: d.unique, text: d.text.slice(0, 120) };
}

let seq = 0;
function baseStep(action: Step["action"], label: string, page: Page, index: number): Step {
  const now = Date.now();
  return {
    action,
    label,
    ts: now,
    seq: `s${++seq}`,
    frame: frameFor(page, index),
    meta: { viewport: { w: 1280, h: 720 }, recordedAt: now },
  };
}

async function dispatchClick(page: Page, x: number, y: number): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1,
    });
  } finally {
    await client.detach().catch(() => {});
  }
}

async function trustedClick(page: Page, step: Step): Promise<string> {
  const selectors = step.target!.selectors;
  const via = await page.evaluate((sels) => {
    const w = window as unknown as { __baoResolve?: (s: typeof sels) => string | null };
    if (!w.__baoResolve) return null;
    return w.__baoResolve(sels);
  }, selectors);
  if (!via) throw new Error(`Could not find: ${step.label}`);
  const loc = page.locator("[data-bao-hit='1']");
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`No box for: ${step.label}`);
  await dispatchClick(page, box.x + box.width / 2, box.y + box.height / 2);
  return via;
}

async function readTrusted(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as unknown as { __baoLastTrusted?: boolean }).__baoLastTrusted);
}

export function toWorkflow(steps: Step[], startUrl: string): Workflow {
  const id = `wf-spike1-${Date.now().toString(36)}`;
  const desktop = steps.some((s) => s.surface === "browser" || s.surface === "os");
  return {
    id,
    name: "Spike 1 — the-internet",
    version: desktop ? 2 : 1,
    startUrl,
    variables: [],
    createdAt: Date.now(),
    steps: steps.map((s, i) => ({ ...s, id: `${id}-${i}`, index: i })),
  };
}

export async function recordSession(ctx: BrowserContext, fixturePath: string): Promise<RecordedSession> {
  await ctx.addInitScript(installPageHelpers);
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const steps: Step[] = [];
  const pages: Page[] = [page];
  const started = Date.now();

  const pace = async () => { await sleep(PACE_MS); };

  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await pace();

  // Checkboxes, from the home list.
  {
    const d = await describe(page, "a[href='/checkboxes']");
    const step = baseStep("click", `Click "${d.text || "Checkboxes"}"`, page, 0);
    step.target = targetOf(d);
    step.urlAfter = `${ORIGIN}/checkboxes`;
    steps.push(step);
    await page.locator("a[href='/checkboxes']").click();
    await page.waitForURL("**/checkboxes", { timeout: 15000 });
    await pace();
  }

  {
    const sel = "#checkboxes input:nth-of-type(1)";
    const d = await describe(page, sel);
    await page.locator(sel).click();
    const checked = await page.locator(sel).isChecked();
    const step = baseStep("setChecked", `Set "${d.text || "checkbox"}"`, page, 0);
    step.target = targetOf(d);
    step.checked = checked;
    steps.push(step);
    await pace();
  }

  // Inputs.
  {
    const step = baseStep("navigate", "Navigate to /inputs", page, 0);
    step.url = `${ORIGIN}/inputs`;
    step.wait = { type: "navigation" };
    steps.push(step);
    await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pace();
    const sel = "input[type='number']";
    const d = await describe(page, sel);
    await page.locator(sel).fill("42");
    const value = await page.locator(sel).inputValue();
    const input = baseStep("input", `Type into "${d.text || "number"}"`, page, 0);
    input.target = targetOf(d);
    input.value = value;
    steps.push(input);
    await pace();
  }

  // Second tab via /windows.
  {
    const step = baseStep("navigate", "Navigate to /windows", page, 0);
    step.url = `${ORIGIN}/windows`;
    step.wait = { type: "navigation" };
    steps.push(step);
    await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pace();
    const d = await describe(page, "a[href='/windows/new']");
    const click = baseStep("click", `Click "${d.text || "Click Here"}"`, page, 0);
    click.target = targetOf(d);
    steps.push(click);
    const [popup] = await Promise.all([
      ctx.waitForEvent("page"),
      page.locator("a[href='/windows/new']").click(),
    ]);
    pages[1] = popup;
    await popup.waitForLoadState("domcontentloaded");
    const sw = baseStep("switchTab", "Switch to tab 2", popup, 1);
    sw.surface = "browser";
    sw.frame = frameFor(popup, 1, 0);
    steps.push(sw);
    await pace();
    const h3 = await describe(popup, "h3");
    const onSecond = baseStep("click", `Click "${h3.text || "New Window"}"`, popup, 1);
    onSecond.target = targetOf(h3);
    onSecond.frame = frameFor(popup, 1, 0);
    steps.push(onSecond);
    await popup.locator("h3").click();
    await pace();
  }

  // Back to the first tab for the upload.
  {
    const back = baseStep("switchTab", "Switch to tab 1", page, 0);
    back.surface = "browser";
    back.frame = frameFor(page, 0);
    steps.push(back);
    await page.bringToFront();
    const nav = baseStep("navigate", "Navigate to /upload", page, 0);
    nav.url = `${ORIGIN}/upload`;
    nav.wait = { type: "navigation" };
    nav.frame = frameFor(page, 0);
    steps.push(nav);
    await page.goto(nav.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pace();

    const d = await describe(page, "#file-upload");
    const chooserP = page.waitForEvent("filechooser", { timeout: 8000 });
    await page.locator("#file-upload").click();
    const chooser = await chooserP;
    await chooser.setFiles(fixturePath);
    const upload = baseStep("uploadFile", `Upload "${fixtureName(fixturePath)}"`, page, 0);
    upload.surface = "browser";
    upload.requires = "fileUpload";
    upload.upload = { name: fixtureName(fixturePath) };
    upload.target = targetOf(d);
    upload.frame = frameFor(page, 0);
    steps.push(upload);
    await pace();

    const submitD = await describe(page, "#file-submit");
    const submit = baseStep("click", `Click "${submitD.text || "Upload"}"`, page, 0);
    submit.target = targetOf(submitD);
    submit.wait = { type: "navigation" };
    submit.frame = frameFor(page, 0);
    steps.push(submit);
    await page.locator("#file-submit").click();
    await page.waitForLoadState("domcontentloaded");
    await pace();
  }

  const checked = steps.find((s) => s.action === "setChecked")?.checked === true;
  const inputValue = steps.find((s) => s.action === "input")?.value ?? "";
  return { steps, durationMs: Date.now() - started, checked, inputValue };
}

function fixtureName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export async function replaySession(
  ctx: BrowserContext,
  workflow: Workflow,
  assets: Map<string, string>,
  shot: (name: string, page: Page) => Promise<void>
): Promise<ReplayOutcome> {
  await ctx.addInitScript(installPageHelpers);
  const page0 = ctx.pages()[0] ?? await ctx.newPage();
  const pages: Page[] = [page0];
  const opened: Page[] = [];
  ctx.on("page", (p) => { opened.push(p); });

  await page0.goto(workflow.startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await shot("spike1_replay_before_home", page0);

  let trusted: boolean | undefined;
  let checked = false;
  let inputValue = "";
  let secondUrl = "";
  let uploadText = "";

  for (const step of workflow.steps) {
    const index = step.frame?.tab?.index ?? 0;
    if (step.action === "switchTab") {
      if (!pages[index]) {
        const fresh = opened.find((p) => !pages.includes(p));
        if (!fresh) throw new Error(`switchTab: no page for index ${index}`);
        pages[index] = fresh;
      }
      const tab = pages[index];
      const pattern = step.frame?.tab?.urlPattern;
      if (pattern) {
        await tab.waitForURL((u) => u.pathname === pattern || u.href.includes(pattern), { timeout: 15000 });
      }
      await tab.bringToFront();
      await sleep(300);
      continue;
    }

    const page = pages[index];
    if (!page) throw new Error(`No page for tab ${index} (${step.label})`);

    if (step.action === "navigate") {
      await page.goto(step.url || "", { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(300);
      continue;
    }

    if (step.action === "uploadFile") {
      const name = step.upload?.name;
      const file = name ? assets.get(name) : undefined;
      if (!file) throw new Error(`No asset for upload ${name}`);
      const via = await page.evaluate((selectors) => {
        const w = window as unknown as { __baoResolve?: (s: NonNullable<Step["target"]>["selectors"]) => string | null };
        return w.__baoResolve ? w.__baoResolve(selectors) : null;
      }, step.target!.selectors);
      if (!via) throw new Error(`Could not find file input: ${step.label}`);
      await page.locator("[data-bao-hit='1']").setInputFiles(file);
      await sleep(300);
      continue;
    }

    if (step.action === "click" || step.action === "setChecked") {
      await trustedClick(page, step);
      if (step.action === "setChecked") {
        trusted = await readTrusted(page);
        if (step.urlAfter) await page.waitForURL(`**${pathname(step.urlAfter)}`, { timeout: 15000 });
        const sel = "#checkboxes input:nth-of-type(1)";
        await page.waitForSelector(sel, { timeout: 10000 });
        checked = await page.locator(sel).isChecked();
        await shot("spike1_replay_after_checkbox", page);
      } else if (step.urlAfter) {
        await page.waitForURL((u) => u.href.startsWith(step.urlAfter!) || u.pathname === pathname(step.urlAfter!), { timeout: 15000 });
      } else if (step.wait?.type === "navigation") {
        await page.waitForLoadState("domcontentloaded");
      } else {
        await sleep(250);
      }
      if ((step.frame?.tab?.index ?? 0) === 1) {
        secondUrl = page.url();
        await shot("spike1_replay_after_second_tab", page);
      }
      await sleep(200);
      continue;
    }

    if (step.action === "input") {
      await trustedClick(page, step);
      await page.keyboard.press("Control+A");
      await page.keyboard.insertText(step.value ?? "");
      inputValue = await page.locator("input[type='number']").inputValue();
      await shot("spike1_replay_after_input", page);
      await sleep(300);
      continue;
    }

    throw new Error(`Replay has no branch for ${step.action}`);
  }

  const uploadPage = pages[0];
  uploadText = await uploadPage.locator("body").innerText();
  await shot("spike1_replay_after_upload", uploadPage);

  return { checked, inputValue, secondUrl, uploadText, trusted };
}
