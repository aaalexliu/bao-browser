import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import type { OsTarget } from "../../../src/types";
import { forbidScreenRecording } from "../helper-capabilities";
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

/** The BaoOSHelper calls a live session makes on the daily Chrome. Tests pass a fake. */
export type ChromeAx = Pick<MacOsHelper, "permissions" | "nodes" | "press">;

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
  return forbidScreenRecording(new MacOsHelper(bin));
}

export async function logAx(file: string, event: AxClick): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`);
}

function target(role: string, name: string): OsTarget {
  return { platform: "macos", app: CHROME_BUNDLE, role, name, path: [] };
}

function windowOf(node: AxNode | undefined): string {
  const named = node?.path?.find((seg) => seg.role === "AXWindow")?.name || "";
  return publishWindow(named);
}

export async function chromeTree(helper: Pick<ChromeAx, "nodes">, pid?: number): Promise<{ pid?: number; summary: AxSummary }> {
  const hit = await helper.nodes(CHROME_BUNDLE, pid);
  return { pid: hit.pid || pid, summary: summarizeAx(hit.nodes || []) };
}

async function note(file: string, event: Omit<AxClick, "at" | "via">): Promise<void> {
  await logAx(file, { ...event, at: new Date().toISOString(), via: "BaoOSHelper" });
}

export const INSPECT_URL = "chrome://inspect/#remote-debugging";

const openedTabs = new Map<number, { tabId: string; windowId?: string; frame?: number[]; restored?: number; frontPid?: number }>();

async function frontPid(helper: MacOsHelper): Promise<number | undefined> {
  const hit = await helper.exec(["frontmost"], 10_000).catch(() => undefined);
  return typeof hit?.pid === "number" ? hit.pid : undefined;
}

async function putFrontBack(helper: MacOsHelper, front: number | undefined, chrome: number): Promise<void> {
  const now = await frontPid(helper);
  if (front && now === chrome && front !== chrome) {
    await helper.exec(["activate", "--pid", String(front)], 10_000);
  }
}

/**
 * Opens chrome://inspect/#remote-debugging in a new tab of this Chrome pid.
 * An Apple Event inside BaoOSHelper, addressed by pid, not by bundle id.
 * Remembers the new tab id so closeInspectTab closes only that tab.
 */
export async function openInspect(helper: MacOsHelper, logFile: string, pid?: number): Promise<{ windowId?: string; frame?: number[] }> {
  if (pid == null) throw new Error("Bao needs the Chrome process id to open remote debugging");
  const front = await frontPid(helper);
  const hit = await helper.exec(["ae-open", "--pid", String(pid)], 20_000);
  const tabId = hit.tabId;
  if (!tabId) throw new Error("Bao opened the inspect page but Chrome did not return a tab id");
  const raw = hit as unknown as { windowId?: unknown; frame?: number[] };
  const windowId = typeof raw.windowId === "string" ? raw.windowId : undefined;
  const frame = Array.isArray(raw.frame) && raw.frame.length === 4 ? raw.frame : undefined;
  await putFrontBack(helper, front, pid);
  openedTabs.set(pid, { tabId, windowId, frame, restored: hit.restored, frontPid: front });
  await note(logFile, { what: "ae-open", name: INSPECT_URL, window: "Inspect with Chrome Developer Tools" });
  return { windowId, frame };
}

/** Chrome 155's inspect checkbox lists no AXPress. Click the box we already found by name. */
export async function clickRemoteCheckbox(helper: MacOsHelper, pid: number): Promise<void> {
  const hit = await helper.nodes(CHROME_BUNDLE, pid);
  const box = (hit.nodes || []).find((node) => node.role === "AXCheckBox" && node.name === REMOTE_CHECKBOX);
  if (!box?.frame) throw new Error("BaoOSHelper cannot see the remote-debugging checkbox to click");
  const x = box.frame.x + box.frame.w / 2;
  const y = box.frame.y + box.frame.h / 2;
  await helper.exec(["click", "--pid", String(pid), "--x", String(x), "--y", String(y)]);
}

/** Closes only the inspect tab this run opened, by tab id. Does not raise Chrome. */
export async function closeInspectTab(helper: MacOsHelper, logFile: string, pid: number): Promise<void> {
  const opened = openedTabs.get(pid);
  if (!opened) throw new Error("Bao has no inspect tab id to close for that Chrome");
  const args = ["ae-close", "--pid", String(pid), "--id", opened.tabId];
  if (opened.restored != null) args.push("--restore", String(opened.restored));
  await helper.exec(args, 20_000);
  await putFrontBack(helper, opened.frontPid, pid);
  openedTabs.delete(pid);
  await note(logFile, { what: "ae-close", name: opened.tabId, window: "Inspect with Chrome Developer Tools" });
}

/** Read the checkbox. Does not type and does not press. */
export async function checkboxState(helper: Pick<ChromeAx, "nodes">, pid?: number): Promise<{ pid?: number; summary: AxSummary; on: boolean | null }> {
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
    await openInspect(helper, logFile, tree.pid);
    tree = await chromeTree(helper, tree.pid);
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
  tree = await chromeTree(helper, tree.pid);
  if (!tree.summary.checkbox.found || !checkboxOn(tree.summary.checkbox.value)) {
    throw new AxUnavailable("remote-debugging checkbox stayed off", tree.summary);
  }
  return { pid: tree.pid, summary: tree.summary, pressed: true };
}

export async function pressAllow(helper: Pick<ChromeAx, "press">, pid: number | undefined, logFile: string): Promise<{ at: number; window: string }> {
  const hit = await helper.press(target("AXButton", ALLOW_BUTTON), pid);
  const window = windowOf(hit.element) || "Allow remote debugging?";
  await note(logFile, { what: "AXPress", role: "AXButton", name: ALLOW_BUTTON, window });
  return { at: Date.now(), window };
}
