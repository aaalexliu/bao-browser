// Live Automation status for Google Chrome, and the one button that asks for it.
// The check is an Apple Event permission call to the daily Chrome pid. It never uses a bundle id.

import { spawn } from "node:child_process";
import path from "node:path";
import { AUTOMATION_DENIED, AUTOMATION_PROMPT, dailyChromePids } from "./remote-debugging";
import { DEVTOOLS_ACTIVE_PORT } from "./endpoint";

export type AutomationState = "granted" | "not-asked" | "denied" | "closed" | "unavailable";

export interface AutomationReport {
  state: AutomationState;
  message: string;
  pid?: number;
  opened?: boolean;
}

export interface AutomationDeps {
  helper: { exec(args: string[], timeoutMs?: number): Promise<{ permitted?: boolean; denied?: boolean; wouldPrompt?: boolean; error?: string }> };
  findChrome?: (userDataDir: string) => Promise<number[]>;
  openChrome?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  portFile?: string;
  onNotice?: (message: string) => void;
  timeoutMs?: number;
}

const CHROME_APP = "/Applications/Google Chrome.app";
const CLOSED = "Chrome is not open. Allow opens Google Chrome, then asks.";
const NOT_ASKED = "not yet asked";
const GRANTED = "allowed";

function report(hit: { permitted?: boolean; denied?: boolean; wouldPrompt?: boolean }, pid: number, opened: boolean): AutomationReport {
  if (hit.permitted) return { state: "granted", message: GRANTED, pid, opened };
  if (hit.denied) return { state: "denied", message: AUTOMATION_DENIED, pid, opened };
  if (hit.wouldPrompt) return { state: "not-asked", message: NOT_ASKED, pid, opened };
  return { state: "unavailable", message: "Could not read Automation permission for Google Chrome.", pid, opened };
}

async function chromePid(deps: AutomationDeps): Promise<{ pid?: number; error?: string }> {
  const dir = path.dirname(deps.portFile || DEVTOOLS_ACTIVE_PORT);
  const find = deps.findChrome || dailyChromePids;
  const pids = await find(dir);
  if (pids.length > 1) return { error: `more than one Chrome runs on ${dir}` };
  return { pid: pids[0] };
}

/** Reads the grant. Does not ask, and does not open Chrome. */
export async function readAutomation(deps: AutomationDeps): Promise<AutomationReport> {
  const found = await chromePid(deps);
  if (found.error) return { state: "unavailable", message: found.error };
  if (found.pid == null) return { state: "closed", message: CLOSED };
  const hit = await deps.helper.exec(["ae-permission", "--pid", String(found.pid)], 15_000);
  return report(hit, found.pid, false);
}

/** Opens Google Chrome with LaunchServices and no flags when it is closed, then asks that pid. */
export function openGoogleChrome(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-a", CHROME_APP], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`open -a Google Chrome failed (${code})`));
    });
  });
}

export async function askAutomation(deps: AutomationDeps): Promise<AutomationReport> {
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let opened = false;
  let found = await chromePid(deps);
  if (found.error) return { state: "unavailable", message: found.error };
  if (found.pid == null) {
    await (deps.openChrome || openGoogleChrome)();
    opened = true;
    const deadline = Date.now() + (deps.timeoutMs ?? 30_000);
    for (;;) {
      found = await chromePid(deps);
      if (found.error) return { state: "unavailable", message: found.error, opened };
      if (found.pid != null) break;
      if (Date.now() >= deadline) return { state: "closed", message: CLOSED, opened };
      await sleep(400);
    }
  }
  const pid = found.pid as number;
  const before = await deps.helper.exec(["ae-permission", "--pid", String(pid)], 15_000);
  if (before.wouldPrompt) deps.onNotice?.(AUTOMATION_PROMPT);
  const hit = await deps.helper.exec(["ae-permission", "--pid", String(pid), "--ask"], 180_000);
  const result = report(hit, pid, opened);
  if (opened && result.state === "granted") {
    result.message = "Google Chrome was not open. Bao opened it, then asked. Automation for Google Chrome is allowed.";
  } else if (opened && result.state === "denied") {
    result.message = `Google Chrome was not open. Bao opened it, then asked. ${AUTOMATION_DENIED}`;
  } else if (opened && result.state === "not-asked") {
    result.message = "Google Chrome was not open. Bao opened it, then asked. Automation permission for Google Chrome is still undetermined.";
  }
  return result;
}
