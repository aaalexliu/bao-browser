// The hold process is the only writer of this claim. It records that Bao turned the switch on.
// There is no lease file and no switch lock: a session is a connection to that process, and a crash cannot leave a lock.

import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { logAx, type ChromeAx } from "./ax";
import { REMOTE_CHECKBOX } from "./consent";
import { checkboxKnown } from "./remote-debugging";

const CLAIM = "switch.json";

export interface SwitchClaim {
  /** True when Bao turned the switch on and has not turned it off since. */
  owned: boolean;
}

export function testProcess(): boolean {
  return process.env.BAO_LANE === "hermetic" || process.env.BAO_LANE === "integration"
    || process.env.BAO_TEST_BROWSER !== undefined || process.env.BAO_LIVE_TESTS === "1";
}

function readText(file: string): string | undefined {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readFileSync(fd, "utf8"); }
    finally { closeSync(fd); }
  } catch {
    return undefined;
  }
}

function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, text); }
  finally { closeSync(fd); }
  renameSync(tmp, file);
}

export function readClaim(dir: string): SwitchClaim | undefined {
  const text = readText(path.join(dir, CLAIM));
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { owned?: unknown };
    if (typeof parsed.owned !== "boolean") return undefined;
    return { owned: parsed.owned };
  } catch {
    return undefined;
  }
}

export function claimOwned(dir: string): boolean {
  return readClaim(dir)?.owned === true;
}

/** Writes the claim exactly. A false observation must not be stored as owned. */
export function writeClaim(dir: string, owned: boolean): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(path.join(dir, CLAIM), JSON.stringify({ owned }));
}

export function clearClaim(dir: string): void {
  try { unlinkSync(path.join(dir, CLAIM)); }
  catch { /* already gone */ }
}

/**
 * What to record before any press. Undefined means the checkbox has not been read and nothing is listening:
 * a missing endpoint is not a claim. A listener, or a checkbox that is already on, keeps an earlier claim and
 * does not start a new one. A checkbox that reads off is Bao's to turn on, so the claim is written before the press.
 */
export function claimForEnable(prior: boolean, checkboxOn: boolean | undefined, listenerUp: boolean): boolean | undefined {
  if (listenerUp) return prior;
  if (checkboxOn === undefined) return undefined;
  if (checkboxOn) return prior ? true : false;
  return true;
}

/** Clears the claim only when the off finished. A dead Chrome or a failed press leaves the claim for the next start. */
export async function finishOwnedSwitch(
  dir: string,
  off: () => Promise<"done" | "unavailable" | "failed">,
): Promise<void> {
  if (!claimOwned(dir)) return;
  let result: "done" | "unavailable" | "failed";
  try { result = await off(); }
  catch { result = "failed"; }
  if (result === "done") clearClaim(dir);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function closeInspect(helper: Pick<ChromeAx, "exec">, pid: number): Promise<void> {
  try {
    const tree = await helper.exec(["nodes", "--bundle", "com.google.Chrome", "--pid", String(pid)], 30_000);
    const { inspectTabCloseArgs } = await import("./current-chrome");
    const args = inspectTabCloseArgs(tree.nodes || [], pid);
    if (args) await helper.exec(args, 15_000);
  } catch {
    // The switch result stands. A later start can close a leftover inspect tab.
  }
}

/**
 * Turns the checkbox by pid through Accessibility. Never opens Chrome by Apple Event.
 * Done only when a checkbox read matches. A dead pid is unavailable and must not clear the claim.
 */
export async function setSwitchByAx(
  helper: Pick<ChromeAx, "exec">,
  pid: number,
  on: boolean,
  axLog: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<"done" | "unavailable" | "failed"> {
  if (!alive(pid)) return "unavailable";
  try {
    await helper.exec(["inspect-open-ax", "--pid", String(pid)], 30_000);
  } catch {
    return alive(pid) ? "failed" : "unavailable";
  }
  const deadline = Date.now() + 8_000;
  let value = "";
  for (;;) {
    if (!alive(pid)) return "unavailable";
    let box: { found?: boolean; value?: string };
    try {
      box = await helper.exec(["checkbox-read", "--pid", String(pid), "--name", REMOTE_CHECKBOX], 30_000);
    } catch {
      return alive(pid) ? "failed" : "unavailable";
    }
    if (box.found) {
      value = String(box.value ?? "");
      if (checkboxKnown(value) === null) {
        await closeInspect(helper, pid);
        return "failed";
      }
      break;
    }
    if (Date.now() >= deadline) {
      await closeInspect(helper, pid);
      return "failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (checkboxKnown(value) === on) {
    await closeInspect(helper, pid);
    return "done";
  }
  let pressed = false;
  try {
    const set = await helper.exec(
      ["checkbox-set", "--pid", String(pid), "--name", REMOTE_CHECKBOX, "--value", on ? "1" : "0"],
      30_000,
    );
    if (!set.found) {
      await closeInspect(helper, pid);
      return alive(pid) ? "failed" : "unavailable";
    }
    pressed = set.pressed === true;
  } catch {
    await closeInspect(helper, pid);
    return alive(pid) ? "failed" : "unavailable";
  }
  if (pressed) {
    await logAx(axLog, {
      what: "AXPress", role: "AXCheckBox", name: REMOTE_CHECKBOX,
      window: "Inspect with Chrome Developer Tools", at: new Date().toISOString(), via: "BaoOSHelper",
    });
  }
  if (!alive(pid)) return "unavailable";
  try {
    const after = await helper.exec(["checkbox-read", "--pid", String(pid), "--name", REMOTE_CHECKBOX], 30_000);
    await closeInspect(helper, pid);
    if (!after.found) return "failed";
    const known = checkboxKnown(String(after.value ?? ""));
    if (known === null) return "failed";
    return known === on ? "done" : "failed";
  } catch {
    await closeInspect(helper, pid);
    return alive(pid) ? "failed" : "unavailable";
  }
}

/** The hold calls this. A test process throws before any platform check, on every platform. */
export async function turnSwitchOff(
  pid: number,
  axLog: string,
  helper?: Pick<ChromeAx, "exec">,
): Promise<"done" | "unavailable" | "failed"> {
  if (testProcess()) throw new Error("tests never change Chrome's debugging switch");
  if (process.platform !== "darwin") return "unavailable";
  const { chromeHelper } = await import("./ax");
  return setSwitchByAx(helper ?? chromeHelper(), pid, false, axLog);
}

