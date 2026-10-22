// Record held-out trails on public pages. This file does not import the condenser.
// Ground truth is the keep flags on the task, written out with the trail.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { dumpPage, type DomDump } from "../../v1/dom-page";
import { leafTexts, smallestChange } from "../../v1/recorder";
import type { TrailEvent } from "../../v1/interpret";
import type { Identity } from "../../v1/schema";
import { launchOwnedChrome } from "../../launch";
import { HELD_TASKS, type HeldStep, type HeldTask, type Oracle } from "./tasks";

export interface HeldTruth {
  id: string;
  name: string;
  startUrl: string;
  keep: string[];
  secrets: string[];
  secretIds: string[];
  human: { id: string; gate: "login" | "confirm" }[];
  replays: HeldTask["replays"];
  oracle: Oracle;
  secret?: string;
  invalid?: HeldTask["invalid"];
}

export async function captureHeldout(dir: string, tasks: readonly HeldTask[] = HELD_TASKS): Promise<HeldTruth[]> {
  mkdirSync(dir, { recursive: true });
  const truths: HeldTruth[] = [];
  for (const task of tasks) {
    const result = await captureTask(task);
    const file = path.join(dir, `${task.id}.json`);
    writeFileSync(file, JSON.stringify(result.events, null, 2));
    truths.push(result.truth);
    console.log(`${task.id} events ${result.events.length} keep ${result.truth.keep.join(",")}`);
  }
  writeFileSync(path.join(dir, "truth.json"), JSON.stringify(truths, null, 2));
  return truths;
}

async function captureTask(task: HeldTask): Promise<{ events: TrailEvent[]; truth: HeldTruth }> {
  const profile = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join("/tmp", "bao-held-")));
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  const events: TrailEvent[] = [];
  const keep: string[] = [];
  const secretIds: string[] = [];
  const human: HeldTruth["human"] = [];
  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);
    let dialogNote: { type: "alert" | "confirm" | "prompt"; message: string; decision: "accept" | "dismiss" } | undefined;
    page.on("dialog", (dialog) => {
      const type = dialog.type();
      const message = dialog.message().replace(/\s+/g, " ").trim().slice(0, 180) || "dialog";
      if (type === "alert" || type === "confirm" || type === "prompt") {
        dialogNote = { type, message, decision: "accept" };
      }
      dialog.accept().catch(() => undefined);
    });
    const takeDialog = () => {
      const note = dialogNote;
      dialogNote = undefined;
      return note;
    };
    await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    let cursor = 0;
    for (const step of task.steps) {
      let produced: TrailEvent[];
      try {
        produced = await runStep(page, step, cursor, page.url(), takeDialog);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`${task.id} step ${cursor} ${step.do} ${step.selector || step.op || ""}: ${detail}`);
      }
      for (const event of produced) {
        events.push(event);
        if (step.keep) keep.push(event.id);
        if (step.secret) secretIds.push(event.id);
        if (step.human) human.push({ id: event.id, gate: step.human });
      }
      cursor += produced.length;
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  const blob = JSON.stringify(events);
  if (task.secret && blob.includes(task.secret)) {
    throw new Error(`${task.id} stored the secret in the trail`);
  }
  if (keep.length === 0) throw new Error(`${task.id} kept nothing`);
  return {
    events,
    truth: {
      id: task.id,
      name: task.name,
      startUrl: task.url,
      keep,
      secrets: task.secret ? [task.secret] : [],
      secretIds,
      human,
      replays: task.replays,
      oracle: task.oracle,
      secret: task.secret,
      invalid: task.invalid,
    },
  };
}

async function runStep(
  page: Page,
  step: HeldStep,
  index: number,
  before: string,
  takeDialog: () => { type: "alert" | "confirm" | "prompt"; message: string; decision: "accept" | "dismiss" } | undefined,
): Promise<TrailEvent[]> {
  const ts = Date.now();
  if (step.do === "read") {
    await page.waitForTimeout(40);
    return [{ id: `e${index}`, ts, kind: "read", op: step.op || "screenshot" }];
  }
  if (step.do === "scroll") {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(30);
    return [{ id: `e${index}`, ts, kind: "act", op: "scroll", beforeUrl: before, afterUrl: page.url() }];
  }
  if (step.do === "jitter") {
    const deltas = [120, -70, 40, -90, 160, -30];
    const out: TrailEvent[] = [];
    for (let i = 0; i < deltas.length; i++) {
      await page.mouse.wheel(i % 2 === 0 ? 15 : -15, deltas[i]!);
      await page.waitForTimeout(16);
      out.push({ id: `e${index + i}`, ts: Date.now(), kind: "act", op: "scroll", beforeUrl: before, afterUrl: page.url() });
    }
    return out;
  }
  if (step.do === "tab") {
    // Extra tab. The condenser already drops navigate, and the main page url stays put.
    const extra = await page.context().newPage();
    try {
      await extra.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
      await extra.waitForTimeout(40);
    } finally {
      await extra.close().catch(() => undefined);
    }
    return [{ id: `e${index}`, ts, kind: "act", op: "navigate", beforeUrl: before, afterUrl: page.url() }];
  }
  if (step.do === "back") {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(50);
    return [{ id: `e${index}`, ts, kind: "act", op: "back", beforeUrl: before, afterUrl: page.url() }];
  }
  if (step.do === "backs") {
    const count = step.count || 1;
    if (step.selector) await page.locator(step.selector).first().focus({ timeout: 3000 }).catch(() => undefined);
    const out: TrailEvent[] = [];
    for (let i = 0; i < count; i++) {
      await page.keyboard.press("Backspace");
      out.push({
        id: `e${index + i}`,
        ts: Date.now(),
        kind: "act",
        op: "key",
        key: "Backspace",
        beforeUrl: before,
        afterUrl: page.url(),
      });
    }
    return out;
  }
  if (step.do === "key") {
    const focused = page.locator(":focus");
    const identity = await actIdentity(page, ":focus").catch(() => undefined);
    const beforeFx = await readEffect(focused);
    await page.keyboard.press(step.key || "Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(250);
    const afterFx = await readEffect(focused);
    const dialog = takeDialog();
    return [{
      id: `e${index}`,
      ts,
      kind: "act",
      op: "key",
      key: step.key || "Enter",
      identity,
      dialog: dialog?.message,
      dialogType: dialog?.type,
      dialogDecision: dialog?.decision,
      subtreeBefore: beforeFx.subtree,
      subtreeAfter: afterFx.missing ? "" : afterFx.subtree,
      valueBefore: beforeFx.value,
      valueAfter: afterFx.missing ? undefined : afterFx.value,
      beforeUrl: before,
      afterUrl: page.url(),
    }];
  }
  if (step.do === "upload") {
    const fileName = step.file || "note.txt";
    const filePath = path.join("/tmp", fileName);
    writeFileSync(filePath, "held out\n");
    const selector = step.selector || "input[type=file]";
    const identity = await actIdentity(page, selector);
    if (!identity) throw new Error(`no identity for ${selector}`);
    await page.locator(selector).first().setInputFiles(filePath);
    await page.waitForTimeout(50);
    return [{ id: `e${index}`, ts, kind: "act", op: "upload", fileName, identity, beforeUrl: before, afterUrl: page.url() }];
  }
  if (step.do === "type") {
    const secret = !!step.secret;
    const selector = step.selector || "input";
    const locator = page.locator(selector).first();
    const identity = await actIdentity(page, selector);
    if (!identity) throw new Error(`no identity for ${selector}`);
    if (secret && identity.value) delete identity.value;
    await locator.fill("");
    await locator.type(step.text || "", { delay: 10 });
    await page.waitForTimeout(30);
    return [{
      id: `e${index}`,
      ts,
      kind: "act",
      op: "type",
      value: secret ? undefined : step.text,
      sensitive: secret || undefined,
      gate: step.human,
      identity,
      beforeUrl: before,
      afterUrl: page.url(),
    }];
  }
  const selector = step.selector || "button";
  const locator = page.locator(selector).first();
  const identity = await actIdentity(page, selector);
  if (!identity) throw new Error(`no identity for ${selector}`);
  const beforeFx = await readEffect(locator);
  const leavesBefore = await page.evaluate(leafTexts).catch(() => ({}));
  await locator.click({ timeout: 15000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  const afterFx = await readEffect(locator);
  const leavesAfter = await page.evaluate(leafTexts).catch(() => ({}));
  const appeared = smallestChange(leavesBefore, leavesAfter);
  const checked = await locator.isChecked().catch(() => undefined);
  const subtreeAfter = appeared ? appeared.after : afterFx.missing ? (beforeFx.subtree === "" ? "\u0000" : "") : afterFx.subtree;
  const dialog = takeDialog();
  return [{
    id: `e${index}`,
    ts,
    kind: "act",
    op: "click",
    identity,
    gate: step.human,
    checked: typeof checked === "boolean" ? checked : undefined,
    subtreeBefore: appeared ? appeared.before : beforeFx.subtree,
    subtreeAfter,
    valueBefore: beforeFx.value,
    valueAfter: afterFx.missing ? undefined : afterFx.value,
    dialog: dialog?.message,
    dialogType: dialog?.type,
    dialogDecision: dialog?.decision,
    beforeUrl: before,
    afterUrl: page.url(),
  }];
}

async function readEffect(locator: import("playwright").Locator): Promise<{ subtree: string; value?: string; missing?: boolean }> {
  try {
    return await locator.evaluate((el) => {
      const node = el as HTMLElement;
      const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
      const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        ? el.value
        : undefined;
      return { subtree: text, value: input };
    });
  } catch {
    return { subtree: "", missing: true };
  }
}

async function actIdentity(page: Page, selector: string): Promise<Identity | undefined> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "attached", timeout: 10000 });
  const dump = await page.evaluate(dumpPage);
  const handle = await locator.evaluate((el) => el.getAttribute("data-bao-i") || "").catch(() => "");
  if (!handle) return undefined;
  const node = dump.nodes.find((item) => item.handle === handle);
  return node ? toIdentity(node) : undefined;
}

function toIdentity(node: DomDump): Identity {
  return {
    surface: "dom",
    role: node.role,
    name: node.name,
    testId: node.testId,
    id: node.id,
    nameAttr: node.nameAttr,
    tag: node.tag,
    label: node.label,
    text: node.text,
    cssPath: node.cssPath,
    path: node.path,
  };
}
