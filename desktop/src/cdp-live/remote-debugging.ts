// Turns the daily Chrome's remote debugging on or off the way a person does. BaoOSHelper opens
// chrome://inspect/#remote-debugging in a new tab (openInspect in ax.ts: an Apple Event to that pid),
// then presses the checkbox "Allow remote debugging for this browser instance" in that Chrome,
// found by pid. Chrome drops chrome:// urls given on its command line, so a window handoff cannot
// open the page. No debugging switch and no Chrome preference file. The only profile file read is
// DevToolsActivePort.

import { execFile } from "node:child_process";
import path from "node:path";
import { logAx, type ChromeAx, chromeTree, CHROME_BUNDLE, INSPECT_URL } from "./ax";
import { checkboxOn, REMOTE_CHECKBOX } from "./consent";
import { listenPid, readDevToolsActivePort, type DevToolsEndpoint } from "./endpoint";

/** The executable of Google Chrome's browser process on a Mac. */
const CHROME_EXE = /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/;

/**
 * Browser processes of Google Chrome on this user-data dir, from `ps -axww -o pid=,args=`.
 * A renderer or helper has `--type=`. A headless Chrome, or one on another
 * --user-data-dir, such as a test or an agent's own Chrome, is not the daily Chrome.
 */
export function chromePidsFromPs(text: string, userDataDir: string, defaultDir: string): number[] {
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[2] as string;
    const exe = args.split(" --")[0]?.trim() || "";
    if (!CHROME_EXE.test(exe) || /\s--type=/.test(args) || /\s--headless\b/.test(args)) continue;
    const named = /\s--user-data-dir=(.+?)(?=\s--|$)/.exec(args)?.[1]?.trim();
    const dir = named ? path.resolve(named) : defaultDir;
    if (path.resolve(dir) !== path.resolve(userDataDir)) continue;
    pids.push(Number(match[1]));
  }
  return pids;
}

export function dailyChromePids(userDataDir: string, defaultDir = userDataDir): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("ps", ["-axww", "-o", "pid=,args="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : chromePidsFromPs(String(stdout || ""), userDataDir, defaultDir));
    });
  });
}

export interface RemoteDebuggingDeps {
  helper: Pick<ChromeAx, "nodes" | "press">;
  /** The DevToolsActivePort of the daily Chrome. Its folder is the user-data dir. */
  portFile: string;
  axLog: string;
  /** Opens the inspect page in the Chrome pid. Returns the script window id when it has one. */
  openInspect: (pid: number) => Promise<void | { windowId?: string; frame?: number[] }>;
  /** True when the screen is locked. Checked before any key, so a lock does not hang. */
  screenLocked?: () => Promise<boolean>;
  /** Closes the inspect tab this call opened. Omitted in unit tests. */
  closeOpenedTab?: (pid: number) => Promise<void>;
  /** Clicks the checkbox when it has no AXPress, which Chrome 155's inspect box does not list. */
  clickCheckbox?: (pid: number) => Promise<void>;
  /** Browser pids of the Chrome on that user-data dir. Default: from ps. */
  findChrome?: (userDataDir: string) => Promise<number[]>;
  /** Pid listening on a port. Default: lsof. */
  listener?: (port: number) => Promise<number | undefined>;
  readPort?: (file: string) => Promise<DevToolsEndpoint>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface RemoteDebuggingResult {
  pid: number;
  /** True when Bao pressed the checkbox. False when it was already as asked. */
  pressed: boolean;
  /** True when Bao opened the inspect page. */
  opened: boolean;
  /** The port Chrome listens on once on. Null once off. */
  port: number | null;
  /** True when the port was already in the asked state, so Bao changed nothing. */
  already: boolean;
}

export const SCREEN_LOCKED = "The screen is locked. Unlock it, then try again.";
export const CHROME_NOT_OPEN = "Chrome is not open. Open Google Chrome, then try again";
export const ACCESSIBILITY_MISSING = "BaoOSHelper accessibility is not granted. Turn it on for BaoOSHelper in System Settings > Privacy & Security > Accessibility, then try again.";

/** True when a session that found debugging off should turn it off again at the end. */
export function shouldRestoreRemoteDebugging(wasListening: boolean): boolean {
  return !wasListening;
}

/** Null when the checkbox value does not say on or off. An empty value is not off. */
export function checkboxKnown(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  return null;
}

export function explainRemoteDebuggingError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/screen is locked/i.test(message)) return new Error(SCREEN_LOCKED);
  if (/accessibility is not granted/i.test(message)) return new Error(ACCESSIBILITY_MISSING);
  if (/helper asked for a permission prompt/i.test(message)) {
    return new Error("BaoOSHelper asked for a permission prompt. Grant Accessibility, then try again.");
  }
  if (/Chrome is not open/.test(message)) return new Error(CHROME_NOT_OPEN);
  if (/not allowed to control Google Chrome/.test(message)) return new Error(message);
  if (/expected one process/.test(message)) {
    return new Error(`BaoOSHelper cannot type into Chrome while another Chrome process runs from the same app, such as a headless Chrome a tool started (${message}). Quit that Chrome, then try again`);
  }
  return err instanceof Error ? err : new Error(message);
}

type FastHelper = { exec?: (args: string[], timeoutMs?: number) => Promise<{ value?: string; found?: boolean; error?: string }> };

function checkboxArgs(pid: number, frame: number[] | undefined, extra: string[]): string[] {
  const args = ["--pid", String(pid), "--name", REMOTE_CHECKBOX, ...extra];
  if (frame && frame.length === 4) {
    args.push("--frame-x", String(frame[0]), "--frame-y", String(frame[1]), "--frame-w", String(frame[2]), "--frame-h", String(frame[3]));
  }
  return args;
}

async function inspectPageOpen(deps: RemoteDebuggingDeps, pid: number): Promise<boolean> {
  const exec = (deps.helper as FastHelper).exec;
  if (!exec) return (await readCheckbox(deps, pid)).found;
  try {
    const hit = await exec.call(deps.helper, ["ae-url", "--pid", String(pid)], 8_000) as { url?: string };
    return hit.url === INSPECT_URL;
  } catch {
    return false;
  }
}

async function readCheckbox(deps: RemoteDebuggingDeps, pid: number, frame?: number[]): Promise<{ found: boolean; value: string }> {
  const exec = (deps.helper as FastHelper).exec;
  if (exec) {
    try {
      const hit = await exec.call(deps.helper, ["checkbox-read", ...checkboxArgs(pid, frame, [])], 20_000);
      if (hit.found === false) return { found: false, value: "" };
      return { found: true, value: String(hit.value ?? "") };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found|exceeded|no accessibility window/.test(message)) return { found: false, value: "" };
      throw err;
    }
  }
  const seen = (await chromeTree(deps.helper, pid)).summary.checkbox;
  return { found: seen.found, value: seen.value };
}

async function setCheckbox(deps: RemoteDebuggingDeps, pid: number, on: boolean, frame?: number[]): Promise<void> {
  const exec = (deps.helper as FastHelper).exec;
  if (exec) {
    const hit = await exec.call(deps.helper, ["checkbox-set", ...checkboxArgs(pid, frame, ["--value", on ? "1" : "0"])], 20_000);
    if (hit.found === false) throw new Error(hit.error || "inspect checkbox was not found");
    return;
  }
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await deps.helper.press({ platform: "macos", app: CHROME_BUNDLE, role: "AXCheckBox", name: REMOTE_CHECKBOX, path: [] }, pid);
      return;
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      if (/no AXPress/.test(message) && deps.clickCheckbox) {
        await deps.clickCheckbox(pid);
        return;
      }
      if (!/no AXPress|lookup missed|did not become frontmost/.test(message) || attempt === 3) throw err;
      await sleep(400);
    }
  }
  throw last;
}

async function within<T>(deps: RemoteDebuggingDeps, what: string, read: () => Promise<T | undefined>): Promise<T> {
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (deps.timeoutMs ?? 60_000);
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/**
 * Sets the remote-debugging checkbox of the running daily Chrome, then waits until Chrome
 * listens on its DevTools port (on) or stops listening (off). Refuses when that Chrome is
 * not running, or when more than one browser process runs on its user-data dir.
 */
export async function setRemoteDebugging(on: boolean, deps: RemoteDebuggingDeps): Promise<RemoteDebuggingResult> {
  const userDataDir = path.dirname(deps.portFile);
  const pids = await (deps.findChrome || dailyChromePids)(userDataDir);
  if (await deps.screenLocked?.()) throw new Error(SCREEN_LOCKED);
  if (pids.length === 0) throw new Error(CHROME_NOT_OPEN);
  if (pids.length > 1) throw new Error(`more than one Chrome runs on ${userDataDir}`);
  const pid = pids[0] as number;
  const listener = deps.listener || listenPid;
  const readPort = deps.readPort || readDevToolsActivePort;
  const listening = async (): Promise<number | null> => {
    const endpoint = await readPort(deps.portFile).catch(() => null);
    return endpoint && (await listener(endpoint.port)) === pid ? endpoint.port : null;
  };

  const before = await listening();
  if (on === (before !== null)) return { pid, pressed: false, opened: false, port: before, already: true };

  let opened = false;
  let frame: number[] | undefined;
  const alreadyInspect = await inspectPageOpen(deps, pid);
  if (!alreadyInspect) {
    const open = async () => {
      const info = await deps.openInspect(pid);
      if (info && typeof info === "object" && info.frame) frame = info.frame;
    };
    await open().catch(async (err: unknown) => {
      await (deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(500);
      await open().catch((again: unknown) => {
        throw explainRemoteDebuggingError(again instanceof Error ? again : err);
      });
    });
    opened = true;
  }
  const box = await within(deps, "the remote-debugging checkbox", async () => {
    const seen = await readCheckbox(deps, pid, frame);
    return seen.found ? seen : undefined;
  });
  let pressed = false;
  const known = checkboxKnown(box.value);
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const portState = async (): Promise<number | null | undefined> => {
    const now = await listening();
    if (on) return now ?? undefined;
    return now === null ? null : undefined;
  };
  let port: number | null | undefined;
  if (known !== on) {
    for (let attempt = 0; attempt < 4 && port === undefined; attempt++) {
      await setCheckbox(deps, pid, on, frame);
      pressed = true;
      for (let beat = 0; beat < 8 && port === undefined; beat++) {
        port = await portState();
        if (port !== undefined) break;
        await sleep(200);
      }
    }
    await logAx(deps.axLog, { what: "AXPress", role: "AXCheckBox", name: REMOTE_CHECKBOX, window: "Inspect with Chrome Developer Tools", at: new Date().toISOString(), via: "BaoOSHelper" });
    if (port === undefined) {
      port = await within(deps, on ? "Chrome to listen on its DevTools port" : "Chrome to close its DevTools port", portState);
    }
  } else {
    port = await within(deps, on ? "Chrome to listen on its DevTools port" : "Chrome to close its DevTools port", portState);
  }
  if (opened && deps.closeOpenedTab) await deps.closeOpenedTab(pid);
  return { pid, pressed, opened, port, already: false };
}
