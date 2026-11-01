import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import type { OsTarget } from "../../../src/types";
import { forbidScreenRecording } from "../helper-capabilities";
import { MacOsHelper, type AxNode } from "../proxy/os-macos";
import {
  ALLOW_BUTTON,
  checkboxOn,
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
export type ChromeAx = Pick<MacOsHelper, "permissions" | "nodes" | "press" | "exec" | "screenLocked">;

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

class LiveChromeHelper extends MacOsHelper {
  override exec(args: string[], timeoutMs?: number) {
    const command = args[0];
    if (command === "nodes") {
      const flags = args.filter((arg) => arg === "--bundle");
      const bundle = args[args.indexOf("--bundle") + 1];
      if (flags.length !== 1 || bundle !== CHROME_BUNDLE) {
        return Promise.reject(new Error("live Chrome helper refuses nodes: target bundle must be com.google.Chrome"));
      }
    }
    if (command === "windows" || (command === "permissions" && args.includes("--prompt"))) {
      return Promise.reject(new Error(`live Chrome helper refuses ${command}: Screen Recording is not used`));
    }
    // A distinct command makes old helpers fail closed instead of ignoring a new flag.
    if (command === "permissions") args = ["permissions-ax"];
    return super.exec(args, timeoutMs);
  }
}

export function chromeHelper(): MacOsHelper {
  const bin = helperBin();
  if (!bin.endsWith(".app")) throw new Error("BaoOSHelper must be launched as an app bundle");
  return forbidScreenRecording(new LiveChromeHelper(bin));
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

const openedTabs = new Map<number, { tabId: string; windowId?: string; restored?: number }>();

/**
 * Opens chrome://inspect/#remote-debugging in a new tab of this Chrome pid.
 * An Apple Event inside BaoOSHelper, addressed by pid, not by bundle id.
 * Remembers the new tab id so closeInspectTab closes only that tab.
 */
export async function openInspect(helper: Pick<MacOsHelper, "exec">, logFile: string, pid: number): Promise<{ windowId?: string; frame?: number[] }> {
  const hit = await helper.exec(["ae-open", "--pid", String(pid)], 40_000);
  const tabId = hit.tabId;
  if (!tabId) throw new Error("Bao opened the inspect page but Chrome did not return a tab id");
  const windowId = typeof hit.windowId === "string" ? hit.windowId : undefined;
  const frame = Array.isArray(hit.frame) && hit.frame.length === 4 ? hit.frame : undefined;
  openedTabs.set(pid, { tabId, windowId, restored: hit.restored });
  await note(logFile, { what: "ae-open", name: INSPECT_URL, window: "Inspect with Chrome Developer Tools" });
  return { windowId, frame };
}

/** Closes only the inspect tab this run opened, by tab id. Chrome may come forward; Bao gives focus back. */
export async function closeInspectTab(helper: Pick<MacOsHelper, "exec">, logFile: string, pid: number): Promise<void> {
  const opened = openedTabs.get(pid);
  if (!opened) throw new Error("Bao has no inspect tab id to close for that Chrome");
  const args = ["ae-close", "--pid", String(pid), "--id", opened.tabId];
  if (opened.restored != null) args.push("--restore", String(opened.restored));
  if (opened.windowId) args.push("--window-id", opened.windowId);
  await helper.exec(args, 20_000);
  openedTabs.delete(pid);
  await note(logFile, { what: "ae-close", name: opened.tabId, window: "Inspect with Chrome Developer Tools" });
}

/** Read the checkbox. Does not type and does not press. */
export async function checkboxState(helper: Pick<ChromeAx, "nodes">, pid?: number): Promise<{ pid?: number; summary: AxSummary; on: boolean | null }> {
  const tree = await chromeTree(helper, pid);
  if (!tree.summary.checkbox.found) return { pid: tree.pid, summary: tree.summary, on: null };
  return { pid: tree.pid, summary: tree.summary, on: checkboxOn(tree.summary.checkbox.value) };
}

export async function pressAllow(helper: Pick<ChromeAx, "press">, pid: number | undefined, logFile: string): Promise<{ at: number; window: string }> {
  const hit = await helper.press(target("AXButton", ALLOW_BUTTON), pid);
  const window = windowOf(hit.element) || "Allow remote debugging?";
  await note(logFile, { what: "AXPress", role: "AXButton", name: ALLOW_BUTTON, window });
  return { at: Date.now(), window };
}
