// Record held-out trails on public pages. This file does not import the condenser.
// Ground truth is the keep flags on the task, written out with the trail.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { dumpPage, type DomDump } from "../../v1/dom-page";
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
}

export async function captureHeldout(dir: string): Promise<HeldTruth[]> {
  mkdirSync(dir, { recursive: true });
  const truths: HeldTruth[] = [];
  for (const task of HELD_TASKS) {
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
    await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    let cursor = 0;
    for (const step of task.steps) {
      let produced: TrailEvent[];
      try {
        produced = await runStep(page, step, cursor, page.url());
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
    },
  };
}

async function runStep(page: Page, step: HeldStep, index: number, before: string): Promise<TrailEvent[]> {
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
    await page.keyboard.press(step.key || "Enter");
    await page.waitForTimeout(200);
    return [{ id: `e${index}`, ts, kind: "act", op: "key", key: step.key || "Enter", beforeUrl: before, afterUrl: page.url() }];
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
  const identity = await actIdentity(page, selector);
  if (!identity) throw new Error(`no identity for ${selector}`);
  await page.locator(selector).first().click({ timeout: 15000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  const checked = await page.locator(selector).first().isChecked().catch(() => undefined);
  return [{
    id: `e${index}`,
    ts,
    kind: "act",
    op: "click",
    identity,
    gate: step.human,
    checked: typeof checked === "boolean" ? checked : undefined,
    beforeUrl: before,
    afterUrl: page.url(),
  }];
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
