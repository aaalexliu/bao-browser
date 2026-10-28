import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import type { OsTarget } from "../../../src/types";
import { MacOsHelper, type AxNode } from "../proxy/os-macos";
import {
  ALLOW_BUTTON,
  REMOTE_CHECKBOX,
  checkboxOn,
  checkboxReach,
  publishWindow,
  summarizeAx,
  type AxSummary,
} from "./consent";

export const CHROME_BUNDLE = "com.google.Chrome";
export const HELPER_APP = "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app";

export interface AxClick {
  at: string;
  what: string;
  role?: string;
  name?: string;
  window?: string;
  via: "BaoOSHelper";
}

export class AxUnavailable extends Error {
  constructor(message: string, readonly summary: AxSummary) {
    super(message);
    this.name = "AxUnavailable";
  }
}

export function helperBin(): string {
  const fromEnv = process.env.BAO_OS_HELPER;
  if (fromEnv && fromEnv.endsWith(".app") && existsSync(fromEnv)) return fromEnv;
  return HELPER_APP;
}

export function chromeHelper(): MacOsHelper {
  const bin = helperBin();
  if (!bin.endsWith(".app")) throw new Error("BaoOSHelper must be launched as an app bundle");
  return new MacOsHelper(bin);
}

export async function logAx(file: string, event: AxClick): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function target(role: string, name: string): OsTarget {
  return { platform: "macos", app: CHROME_BUNDLE, role, name, path: [] };
}

function windowOf(node: AxNode | undefined): string {
  const named = node?.path?.find((seg) => seg.role === "AXWindow")?.name || "";
  return publishWindow(named);
}

export async function chromeTree(helper: MacOsHelper, pid?: number): Promise<{ pid?: number; summary: AxSummary }> {
  const hit = await helper.nodes(CHROME_BUNDLE, pid);
  return { pid: hit.pid || pid, summary: summarizeAx(hit.nodes || []) };
}

async function note(file: string, event: Omit<AxClick, "at" | "via">): Promise<void> {
  await logAx(file, { ...event, at: new Date().toISOString(), via: "BaoOSHelper" });
}

export async function openInspect(helper: MacOsHelper, logFile: string): Promise<void> {
  await helper.cgKey(CHROME_BUNDLE, "cmd+t");
  await note(logFile, { what: "cg-key", name: "cmd+t", window: "New Tab" });
  await sleep(700);
  await helper.raiseWindow(CHROME_BUNDLE, "New Tab - Google Chrome");
  await note(logFile, { what: "raise-window", name: "New Tab - Google Chrome", window: "New Tab" });
  await helper.cgKey(CHROME_BUNDLE, "cmd+l");
  await note(logFile, { what: "cg-key", name: "cmd+l", window: "New Tab" });
  await sleep(250);
  await helper.cgType(CHROME_BUNDLE, "chrome://inspect/");
  await note(logFile, { what: "cg-type", name: "chrome://inspect/", window: "New Tab" });
  await helper.cgKey(CHROME_BUNDLE, "shift+3");
  await note(logFile, { what: "cg-key", name: "shift+3", window: "New Tab" });
  await helper.cgType(CHROME_BUNDLE, "remote-debugging");
  await note(logFile, { what: "cg-type", name: "remote-debugging", window: "New Tab" });
  await helper.cgKey(CHROME_BUNDLE, "return");
  await note(logFile, { what: "cg-key", name: "return", window: "New Tab" });
  await sleep(900);
}

/** Read the checkbox. Does not type and does not press. */
export async function checkboxState(helper: MacOsHelper, pid?: number): Promise<{ pid?: number; summary: AxSummary; on: boolean | null }> {
  const tree = await chromeTree(helper, pid);
  if (!tree.summary.checkbox.found) return { pid: tree.pid, summary: tree.summary, on: null };
  return { pid: tree.pid, summary: tree.summary, on: checkboxOn(tree.summary.checkbox.value) };
}

export async function ensureRemoteDebugging(helper: MacOsHelper, logFile: string): Promise<{ pid?: number; summary: AxSummary; pressed: boolean }> {
  let tree = await chromeTree(helper);
  const reach = checkboxReach(tree.summary);
  if (reach === "stop") {
    throw new AxUnavailable("BaoOSHelper cannot see a Chrome window", tree.summary);
  }
  if (reach === "open-inspect") {
    await openInspect(helper, logFile);
    tree = await chromeTree(helper);
  }
  if (!tree.summary.checkbox.found) {
    throw new AxUnavailable("BaoOSHelper cannot see the remote-debugging checkbox", tree.summary);
  }
  if (checkboxOn(tree.summary.checkbox.value)) {
    return { pid: tree.pid, summary: tree.summary, pressed: false };
  }
  const hit = await helper.press(target("AXCheckBox", REMOTE_CHECKBOX), tree.pid);
  await note(logFile, {
    what: "AXPress",
    role: "AXCheckBox",
    name: REMOTE_CHECKBOX,
    window: windowOf(hit.element),
  });
  tree = await chromeTree(helper);
  if (!tree.summary.checkbox.found || !checkboxOn(tree.summary.checkbox.value)) {
    throw new AxUnavailable("remote-debugging checkbox stayed off", tree.summary);
  }
  return { pid: tree.pid, summary: tree.summary, pressed: true };
}

export async function pressAllow(helper: MacOsHelper, pid: number | undefined, logFile: string): Promise<{ at: number; window: string }> {
  const hit = await helper.press(target("AXButton", ALLOW_BUTTON), pid);
  const window = windowOf(hit.element) || "Allow remote debugging?";
  await note(logFile, { what: "AXPress", role: "AXButton", name: ALLOW_BUTTON, window });
  return { at: Date.now(), window };
}
