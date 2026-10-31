// Which Chrome a live session drives, and how bao connects to it.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { liveChromeBlock } from "../helper-capabilities";
import { AxUnavailable, checkboxState, chromeHelper, type ChromeAx } from "./ax";
import { checkboxReach } from "./consent";
import { connectAndAllow } from "./connect";
import { adoptLiveWindow, openLiveWindow, type CdpLiveDriver } from "./driver";
import { DEVTOOLS_ACTIVE_PORT, listenPid, readDevToolsActivePort, type DevToolsEndpoint } from "./endpoint";
import { setRemoteDebugging } from "./remote-debugging";
import { connectCdp, type CdpSocket } from "./socket";

/** The daily Chrome profile directory a session opens in. Chrome names its first profile Default. */
export const DAILY_PROFILE = "Default";

/**
 * The Chrome a live session drives.
 * - daily: the person's own Chrome, with remote debugging turned on at chrome://inspect.
 *   Chrome asks before each connection, and BaoOSHelper presses Allow.
 * - bao: the Chrome Bao launched on its own profile.
 * - throwaway: a Chrome started with --remote-debugging-port and its own --user-data-dir, such as a test browser.
 * Only the daily Chrome shows the Allow dialog.
 */
export type LiveTarget =
  | { kind: "daily"; portFile: string; profile: string }
  | { kind: "bao" | "throwaway"; portFile: string };

export const LIVE_TARGET_USAGE = "daily, daily:<profile directory>, bao, or throwaway:<absolute DevToolsActivePort path>";

function portFileOk(file: string): boolean {
  return path.isAbsolute(file) && path.basename(file) === "DevToolsActivePort";
}

function profileDirOk(name: string): boolean {
  return !!name && name.length <= 80 && name !== "." && name !== ".." && !/[\\/]/.test(name);
}

/** `bao serve --live-target` or BAO_LIVE_TARGET. Empty means daily. */
export function parseLiveTarget(spec: string | undefined, baoProfile: string, dailyPortFile = DEVTOOLS_ACTIVE_PORT): LiveTarget {
  const text = (spec || "").trim();
  if (!text || text === "daily") return { kind: "daily", portFile: dailyPortFile, profile: DAILY_PROFILE };
  if (text.startsWith("daily:")) {
    const profile = text.slice("daily:".length).trim();
    if (!profileDirOk(profile)) throw new Error("live target daily: needs a Chrome profile directory, such as Default or Profile 1");
    return { kind: "daily", portFile: dailyPortFile, profile };
  }
  if (text === "bao") return { kind: "bao", portFile: path.join(baoProfile, "DevToolsActivePort") };
  if (text.startsWith("throwaway:")) {
    const portFile = text.slice("throwaway:".length).trim();
    if (!portFileOk(portFile)) throw new Error("live target throwaway: needs an absolute DevToolsActivePort path");
    return { kind: "throwaway", portFile };
  }
  throw new Error(`unknown live target ${text}. Use ${LIVE_TARGET_USAGE}`);
}

/** A caller may still name a DevToolsActivePort. The configured target's file keeps its profile; the daily Chrome's own file keeps the Allow press. */
export function targetForPortFile(portFile: string, configured: LiveTarget, dailyPortFile = DEVTOOLS_ACTIVE_PORT): LiveTarget {
  if (!portFileOk(portFile)) throw new Error("port file must be an absolute DevToolsActivePort path");
  if (path.resolve(portFile) === path.resolve(configured.portFile)) return configured;
  if (path.resolve(portFile) === path.resolve(dailyPortFile)) return { kind: "daily", portFile, profile: DAILY_PROFILE };
  return { kind: "throwaway", portFile };
}

/** Only the daily Chrome asks before a connection. A Chrome started with a debugging port does not. */
export function asksToAllow(target: LiveTarget): boolean {
  return target.kind === "daily";
}

export interface ProfileWindowAsk {
  /** The Chrome listening on the DevTools port. */
  pid: number;
  userDataDir: string;
  profile: string;
  /** A marker page, so the session drives the window it asked for and no other. */
  url: string;
}

/** Asks the running Chrome to open one window in a named profile. */
export type OpenProfileWindow = (ask: ProfileWindowAsk) => Promise<void>;

export function profileWindowUrl(nonce: string): string {
  return `data:text/html,<title>Bao</title><!--bao-live-${nonce}-->`;
}

/**
 * Arguments for Chrome's own binary. A second Chrome process hands them to the
 * running one and exits, and the running one opens a window in that profile.
 * CDP cannot do this: Target.createTarget opens in whichever profile was used last.
 */
export function profileWindowArgs(ask: Pick<ProfileWindowAsk, "userDataDir" | "profile" | "url">): string[] {
  return [`--user-data-dir=${ask.userDataDir}`, `--profile-directory=${ask.profile}`, "--new-window", ask.url];
}

/** The binary of the Chrome process that owns the DevTools port. */
export function chromeExecutable(pid: number, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform === "linux") return readlink(`/proc/${pid}/exe`);
  return new Promise((resolve, reject) => {
    execFile("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 5000 }, (err, stdout) => {
      const exe = String(stdout || "").trim();
      if (err || !path.isAbsolute(exe)) reject(new Error("cannot find the Chrome that owns the DevTools port"));
      else resolve(exe);
    });
  });
}

/** Runs the binary of the Chrome that owns the port. That process hands its command line over and exits 0. */
export const openChromeProfileWindow: OpenProfileWindow = async (ask) => {
  const exe = await chromeExecutable(ask.pid);
  const child = spawn(exe, profileWindowArgs(ask), { stdio: "ignore" });
  const code = await new Promise<number | string | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, 15_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve("error");
    });
    child.once("exit", (exit, signal) => {
      clearTimeout(timer);
      resolve(exit ?? signal);
    });
  });
  if (code !== 0) throw new Error(`Chrome did not open a window in profile ${ask.profile}`);
};

function markerTarget(cdp: CdpSocket, marker: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Error("Chrome did not open the profile window"));
    }, timeoutMs);
    timer.unref?.();
    const seen = (params: Record<string, unknown>): void => {
      const info = params.targetInfo as { type?: string; targetId?: string; url?: string } | undefined;
      if (done || info?.type !== "page" || !info.targetId || !(info.url || "").includes(marker)) return;
      done = true;
      clearTimeout(timer);
      resolve(info.targetId);
    };
    cdp.on("Target.targetCreated", undefined, seen);
    cdp.on("Target.targetInfoChanged", undefined, seen);
  });
}

/** Opens a window in one profile of the daily Chrome and drives only that window. */
export async function openProfileWindow(
  cdp: CdpSocket,
  hosts: readonly string[],
  ask: Omit<ProfileWindowAsk, "url">,
  open: OpenProfileWindow,
  timeoutMs = 15_000,
): Promise<CdpLiveDriver> {
  const nonce = randomBytes(8).toString("hex");
  const found = markerTarget(cdp, `bao-live-${nonce}`, timeoutMs);
  found.catch(() => undefined);
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await open({ ...ask, url: profileWindowUrl(nonce) });
  const targetId = await found;
  try {
    return await adoptLiveWindow(cdp, hosts, targetId);
  } catch (err) {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    throw err;
  }
}

export interface PreparedTarget {
  target: LiveTarget;
  endpoint: DevToolsEndpoint;
  /** Set only for the daily Chrome. */
  chromePid: number;
  helper: ChromeAx | null;
  /** True when this call turned debugging on, so the end of the session should turn it off. */
  turnedOn: boolean;
}

function missingPortReason(target: LiveTarget, err: unknown): string {
  if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
    return err instanceof Error ? err.message : "cannot read DevToolsActivePort";
  }
  if (target.kind === "daily") {
    return "Chrome remote debugging is off. Open chrome://inspect/#remote-debugging and check Allow remote debugging for this browser instance";
  }
  if (target.kind === "bao") return "Bao's Chrome is not open";
  return "the live target has no DevToolsActivePort";
}

/** Chrome quietly makes a new, empty profile for a name it does not know, so refuse one that is missing. */
async function requireProfile(userDataDir: string, profile: string): Promise<void> {
  const dirs = (await readdir(userDataDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (dirs.includes(profile)) return;
  const profiles = dirs.filter((name) => name === "Default" || /^Profile \d+$/.test(name));
  const known = profiles.length ? profiles.join(", ") : "none";
  throw new Error(`Chrome profile ${profile} does not exist in ${userDataDir}. Profiles there: ${known}`);
}

/** What prepareTarget needs to turn the daily Chrome's remote debugging on when it is off. */
export interface TurnOnDeps {
  /** Opens chrome://inspect/#remote-debugging in the daily Chrome: openInspect in ax.ts. */
  openInspect: (pid: number) => Promise<void | { windowId?: string }>;
  axLog: string;
  screenLocked?: () => Promise<boolean>;
  closeOpenedTab?: (pid: number) => Promise<void>;
}

/**
 * Checks before the CDP lock. Only the daily Chrome needs its pid and the helper's Accessibility
 * grant. With `turnOn`, a daily Chrome whose remote debugging is off gets it turned on by Bao,
 * as a person would at chrome://inspect/#remote-debugging.
 */
export async function prepareTarget(target: LiveTarget, helper: () => ChromeAx = () => chromeHelper(), turnOn?: TurnOnDeps): Promise<PreparedTarget> {
  if (!asksToAllow(target)) {
    try {
      return { target, endpoint: await readDevToolsActivePort(target.portFile), chromePid: 0, helper: null, turnedOn: false };
    } catch (err) {
      throw new Error(missingPortReason(target, err));
    }
  }
  if (target.kind === "daily") await requireProfile(path.dirname(target.portFile), target.profile);
  let endpoint: DevToolsEndpoint | undefined;
  let missing: unknown;
  try {
    endpoint = await readDevToolsActivePort(target.portFile);
  } catch (err) {
    missing = err;
  }
  // A port file outlives the server, so only a listening Chrome counts.
  let chromePid = endpoint ? await listenPid(endpoint.port) : undefined;
  if (!chromePid && !turnOn) throw new Error(endpoint ? "no Chrome is listening on the DevTools port" : missingPortReason(target, missing));
  const ax = helper();
  const block = liveChromeBlock(await ax.permissions(false));
  if (block) throw new Error(block);
  if (!chromePid && turnOn && target.kind === "daily") {
    const turned = await setRemoteDebugging(true, {
      helper: ax,
      portFile: target.portFile,
      axLog: turnOn.axLog,
      openInspect: turnOn.openInspect,
      screenLocked: turnOn.screenLocked,
      closeOpenedTab: turnOn.closeOpenedTab,
    });
    endpoint = await readDevToolsActivePort(target.portFile);
    chromePid = turned.pid;
    if (!endpoint || !chromePid) throw new Error("no Chrome is listening on the DevTools port");
    return { target, endpoint, chromePid, helper: ax, turnedOn: !turned.already };
  }
  if (!endpoint || !chromePid) throw new Error("no Chrome is listening on the DevTools port");
  return { target, endpoint, chromePid, helper: ax, turnedOn: false };
}

/**
 * Runs under the CDP lock. Connects and opens one window bao owns. The daily
 * Chrome needs the Allow press and opens the window in the target's profile.
 * A Chrome bao or a test launched accepts the socket with no dialog, so the
 * helper is not called at all.
 */
export async function connectTarget(
  prepared: PreparedTarget,
  hosts: readonly string[],
  deps: { openProfile: OpenProfileWindow; axLog: string; connectTimeoutMs?: number },
): Promise<{ cdp: CdpSocket; driver: CdpLiveDriver }> {
  const { target, endpoint } = prepared;
  let cdp: CdpSocket | undefined;
  try {
    if (target.kind === "daily") {
      const helper = prepared.helper;
      if (!helper) throw new Error("BaoOSHelper is required for the daily Chrome");
      const box = await checkboxState(helper, prepared.chromePid);
      if (checkboxReach(box.summary) === "stop") {
        throw new AxUnavailable("BaoOSHelper cannot see a Chrome window", box.summary);
      }
      const dialogPresentBeforeConnect = box.summary.dialog.present || box.summary.dialog.buttonCount > 0;
      if (dialogPresentBeforeConnect) throw new Error("Allow dialog was already up");
      const opened = await connectAndAllow({
        helper,
        endpoint,
        dialogPresentBeforeConnect,
        axLog: deps.axLog,
        pid: prepared.chromePid,
        timeoutMs: deps.connectTimeoutMs,
      });
      cdp = opened.cdp;
      const driver = await openProfileWindow(cdp, hosts, {
        pid: prepared.chromePid,
        userDataDir: path.dirname(target.portFile),
        profile: target.profile,
      }, deps.openProfile);
      return { cdp, driver };
    }
    cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: deps.connectTimeoutMs ?? 30_000 })
      .catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED") {
          throw new Error("no Chrome is listening on the DevTools port");
        }
        throw err;
      });
    return { cdp, driver: await openLiveWindow(cdp, hosts) };
  } catch (err) {
    cdp?.close();
    throw err;
  }
}
