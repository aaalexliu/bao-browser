// The owner's running Chrome over remote debugging. BaoOSHelper turns on Chrome's remote-debugging setting and presses
// Chrome's Allow prompt with its Accessibility access. Chrome asks for every new connection, so Bao makes one and every other
// client shares it. Bao's task tab opens in a window of the Chrome profile the call chose.

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { ChromeFolderDenied, assertChromeReadable, chromeDenied } from "../chrome-access";
import { chromeProfilesRoot } from "../engines/chrome-profile-copy";
import { killCommandToken, LAUNCH_SERVICES_RESTART, launchServicesStalled, processesNaming } from "../launch";
import { chromeHelper, CHROME_BUNDLE, helperBin, INSPECT_URL, logAx, type ChromeAx } from "./ax";
import { REMOTE_CHECKBOX } from "./consent";
import type { AxNode } from "../proxy/os-macos";
import { listenPid, readDevToolsActivePort, type DevToolsEndpoint } from "./endpoint";
import { CHROME_APP_EXE, dailyChromePids } from "./remote-debugging";
import { shareConnection } from "./shared-connection";
import { connectCdp, type CdpSocket } from "./socket";
import { remoteDebuggingBlock } from "../helper-capabilities";

interface CurrentChromeDeps {
  helper: Pick<ChromeAx, "exec" | "permissions" | "screenLocked">;
  findChrome: (root: string) => Promise<number[]>;
  /** Starts the owner's Chrome app as he would, with no flags, when `root` is its own user data. False when Bao cannot. */
  startChrome: (root: string) => Promise<boolean>;
  /** The executable of the Chrome browser process. */
  executable: (pid: number) => string;
  readPort: typeof readDevToolsActivePort;
  listener: typeof listenPid;
  connect: typeof connectCdp;
}

export interface CurrentChrome {
  pid: number;
  /** The Chrome app's executable, which opens a tab in a chosen profile. */
  executable: string;
  /** Chrome's user-data-dir. */
  root: string;
  /** The endpoint for every other client of this Chrome. Its clients share `cdp`, so they raise no Allow prompt. */
  endpoint: DevToolsEndpoint;
  /** Bao's one connection to this Chrome, the one the owner's Allow approved. */
  cdp: CdpSocket;
  closed: Promise<void>;
  isClosed(): boolean;
  detach(): void;
}

async function withConsent<T>(helper: CurrentChromeDeps["helper"], pid: number, axLog: string,
  operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const signal = parent ?? new AbortController().signal;
  signal.throwIfAborted();
  let finished = false;
  let pollError: unknown;
  const pending = operation(signal).finally(() => { finished = true; });
  void pending.catch(() => undefined);
  try {
    while (!finished) {
      signal.throwIfAborted();
      try {
        const hit = await helper.exec(["debug-allow", "--pid", String(pid), "--press"], 5000);
        if (hit.pressed) await logAx(axLog, { what: "AXPress", role: "AXButton", name: "Allow", window: "Allow remote debugging?", at: new Date().toISOString(), via: "BaoOSHelper" });
        pollError = undefined;
      } catch (error) { pollError = error; }
      if (!finished) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return await pending;
  } catch (error) {
    if (pollError !== undefined) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} (BaoOSHelper: ${pollError instanceof Error ? pollError.message : String(pollError)})`, { cause: error });
    }
    throw error;
  }
}

const INSPECT_TAB = "Inspect with Chrome Developer Tools";

function labeled(node: AxNode): string {
  return node.name || node.title || node.description || "";
}

function inspectTabs(nodes: AxNode[]): AxNode[] {
  return nodes.filter((node) => node.role === "AXRadioButton" && node.subrole === "AXTabButton" && labeled(node).includes(INSPECT_TAB));
}

/** Press arguments for the only inspect tab. No press when another inspect tab is open, and never the window close button. */
export function inspectTabCloseArgs(nodes: AxNode[], pid: number): string[] | undefined {
  const tabs = inspectTabs(nodes);
  if (tabs.length !== 1) return undefined;
  const label = labeled(tabs[0]!);
  const button = nodes.find((node) => node.role === "AXButton"
    && [node.name, node.title, node.description].includes("Close")
    && node.subrole !== "AXCloseButton"
    && node.path.some((seg) => seg.role === "AXRadioButton" && seg.name === label));
  if (!button?.path.length) return undefined;
  return ["press", "--bundle", CHROME_BUNDLE, "--pid", String(pid), "--role", "AXButton", "--name", "Close", "--path", JSON.stringify(button.path)];
}

async function closeOpenedInspect(helper: CurrentChromeDeps["helper"], pid: number): Promise<void> {
  try {
    const tree = await helper.exec(["nodes", "--bundle", CHROME_BUNDLE, "--pid", String(pid)], 30_000);
    const args = inspectTabCloseArgs(tree.nodes || [], pid);
    if (args) await helper.exec(args, 15_000);
  } catch {
    // The startup error stays the caller-visible error.
  }
}

type RunFile = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;

const runFile: RunFile = (file, args, env) => new Promise((resolve, reject) => execFile(file, args, { env }, (error) => error ? reject(error) : resolve()));

type ProbeRun = (args: string[]) => Promise<{ stderr: string }>;

/** `open` without `-W` exits 0 and prints nothing when LaunchServices stalls, so this asks `open -W` to start the signed helper first. The helper draws no window. A stall never reaches Chrome. */
export async function assertLaunchServicesReady(openProbe?: ProbeRun): Promise<void> {
  if (!openProbe && process.platform !== "darwin") return;
  const app = helperBin();
  if (!openProbe && !existsSync(app)) return;
  const dir = mkdtempSync(path.join(tmpdir(), "bao-ls-"));
  const token = path.join(dir, "result.json");
  const args = ["-n", "-W", "-g", "-a", app, "--args", "screen-locked", "--result", token];
  try {
    const result = await (openProbe ?? openHelperProbe)(args);
    if (await helperProbeStalled(result.stderr, token)) throw new Error(LAUNCH_SERVICES_RESTART);
  } finally {
    for (let i = 0; i < 10; i++) {
      killCommandToken(token);
      let left = false;
      try { left = processesNaming(token).some((row) => row.command.includes(token)); } catch { left = false; }
      if (!left) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function helperProbeStalled(stderr: string, token: string): Promise<boolean> {
  if (!launchServicesStalled(stderr)) return false;
  const deadline = Date.now() + 1_000;
  for (;;) {
    if (existsSync(token)) return false;
    if (Date.now() >= deadline) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function openHelperProbe(args: string[]): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let cap: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cap);
      if (error) reject(error);
      else resolve({ stderr });
    };
    const stop = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
    timer = setTimeout(stop, 3_000);
    cap = setTimeout(() => finish(), 3_500);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (launchServicesStalled(stderr)) stop();
    });
    child.on("error", (error) => finish(error));
    child.on("close", () => finish());
  });
}

/**
 * Starts the owner's Chrome app as he would, in the background, when `root` is his own Chrome user data; false otherwise, and off macOS unless `ownerRoot` is given. `-n`
 * starts his Chrome even while a Bao-owned Chrome of the same app runs, so LaunchServices never brings that window up instead.
 */
export async function startOwnerChrome(root: string, ownerRoot?: string, run: RunFile = runFile, confirmLaunchServices: () => Promise<void> = assertLaunchServicesReady): Promise<boolean> {
  if (ownerRoot === undefined && process.platform !== "darwin") return false;
  if (path.resolve(root) !== path.resolve(ownerRoot ?? chromeProfilesRoot())) return false;
  try {
    await confirmLaunchServices();
    await run("/usr/bin/open", ["-n", "-g", "-b", CHROME_BUNDLE], { ...process.env, HOME: userInfo().homedir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === LAUNCH_SERVICES_RESTART) throw new Error(LAUNCH_SERVICES_RESTART);
    throw new Error(`Bao could not start Google Chrome: ${message}`);
  }
  return true;
}

export async function openCurrentChrome(options: {
  root: string;
  axLog: string;
  signal?: AbortSignal;
}, overrides: Partial<CurrentChromeDeps> = {}): Promise<CurrentChrome> {
  if (process.platform !== "darwin" && !overrides.helper) throw new Error("Current Chrome control needs BaoOSHelper on a Mac");
  if (process.env.BAO_LANE === "hermetic" && !overrides.helper) throw new Error("Hermetic tests never drive the owner's running Chrome");
  const deps: CurrentChromeDeps = {
    helper: overrides.helper ?? chromeHelper(),
    findChrome: (root) => dailyChromePids(root, chromeProfilesRoot()),
    startChrome: (root) => startOwnerChrome(root),
    executable: (pid) => {
      const exe = processesNaming(CHROME_APP_EXE).find((row) => row.pid === pid)?.command.split(" --")[0]?.trim();
      if (!exe) throw new Error(`Bao could not read the Chrome app path of process ${pid}`);
      return exe;
    },
    readPort: readDevToolsActivePort,
    listener: listenPid,
    connect: connectCdp,
    ...overrides,
  };
  // Before the helper touches Chrome: without Files & Folders > Google Chrome, Bao turns remote debugging on and still cannot read its port.
  try { assertChromeReadable(options.root); }
  catch (error) { if (error instanceof ChromeFolderDenied) throw error; }
  const blocked = remoteDebuggingBlock(await deps.helper.permissions(false));
  if (blocked) throw new Error(blocked);
  if (await deps.helper.screenLocked()) throw new Error("The screen is locked. Unlock it, then try again.");
  options.signal?.throwIfAborted();
  let pids = await deps.findChrome(options.root);
  if (!pids.length && await deps.startChrome(options.root)) {
    for (const deadline = Date.now() + 30_000; !pids.length && Date.now() < deadline;) {
      options.signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 250));
      pids = await deps.findChrome(options.root);
    }
  }
  if (pids.length !== 1) throw new Error(pids.length ? "More than one Chrome runs on this profile root" : "Chrome is not open. Open Google Chrome, then try again");
  const pid = pids[0]!;
  const executable = deps.executable(pid);
  let openedInspect = false;
  try {
    const portFile = path.join(options.root, "DevToolsActivePort");
    const endpointForChrome = async () => {
      let endpoint: DevToolsEndpoint;
      try { endpoint = await deps.readPort(portFile); }
      catch (error) {
        // Missing or half written means remote debugging is not on yet. A refused read is not that.
        const denied = chromeDenied(error, options.root);
        if (denied) throw denied;
        return undefined;
      }
      return await deps.listener(endpoint.port) === pid ? endpoint : undefined;
    };
    let endpoint = await endpointForChrome();
    if (!endpoint) {
      const helper = deps.helper;
      options.signal?.throwIfAborted();
      await helper.exec(["inspect-open-ax", "--pid", String(pid)], 30_000);
      openedInspect = true;
      const deadline = Date.now() + 60_000;
      for (;;) {
        options.signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error("Chrome's remote-debugging checkbox did not appear");
        const box = await helper.exec(["checkbox-read", "--pid", String(pid), "--name", REMOTE_CHECKBOX], 30_000);
        if (box.found) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const checkbox = await helper.exec(["checkbox-set", "--pid", String(pid), "--name", REMOTE_CHECKBOX, "--value", "1"], 30_000);
      if (!checkbox.found) throw new Error("Chrome's remote-debugging checkbox was not found");
      if (checkbox.pressed) await logAx(options.axLog, { what: "AXPress", role: "AXCheckBox", name: REMOTE_CHECKBOX, window: "Inspect with Chrome Developer Tools", at: new Date().toISOString(), via: "BaoOSHelper" });
      const portDeadline = Date.now() + 10_000;
      for (;;) {
        options.signal?.throwIfAborted();
        endpoint = await endpointForChrome();
        if (endpoint) break;
        if (Date.now() >= portDeadline) throw new Error("Chrome did not open its debugging port");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const cdp = await withConsent(deps.helper, pid, options.axLog, async (parent) => {
      const signal = AbortSignal.any([parent, AbortSignal.timeout(25_000)]);
      const socket = await deps.connect(endpoint!.port, endpoint!.browserPath, { timeoutMs: 20_000, signal });
      const cancel = () => socket.close();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        await socket.send("Browser.getVersion", {}, undefined, 20_000);
        return socket;
      } catch (error) { socket.close(); throw error; }
      finally { signal.removeEventListener("abort", cancel); }
    }, options.signal);
    try {
      if (openedInspect) {
        const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets", {}, undefined, 5000);
        const inspect = targetInfos.filter((target) => target.url === INSPECT_URL);
        if (inspect.length === 1) await cdp.send("Target.closeTarget", { targetId: inspect[0]!.targetId }, undefined, 5000);
      }
      const shared = await shareConnection(cdp);
      return { pid, executable, root: options.root, endpoint: shared.endpoint, cdp, closed: cdp.disconnected, isClosed: () => !cdp.isOpen,
        detach: () => { shared.close(); cdp.close(); } };
    } catch (error) {
      cdp.close();
      throw error;
    }
  } catch (error) {
    if (openedInspect) await closeOpenedInspect(deps.helper, pid);
    throw error;
  }
}

function realpath(file: string): string | undefined {
  try { return realpathSync(file); } catch { return undefined; }
}

/** The profile folder of Chrome's default debugging context, read from a hidden chrome://version tab the owner never sees. */
async function defaultContextProfile(cdp: CdpSocket): Promise<string | undefined> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "chrome://version", background: true, hidden: true }, undefined, 5000);
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 5000);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { result } = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate",
        { expression: "document.getElementById('profile_path')?.textContent || ''", returnByValue: true }, sessionId, 2000);
      if (typeof result.value === "string" && result.value.trim()) return result.value.trim();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  } finally {
    await cdp.send("Target.closeTarget", { targetId }, undefined, 5000).catch(() => undefined);
  }
}

/**
 * Opens Bao's task tab in a window of this Chrome profile, and never in another one. Chrome's debugging protocol opens tabs only
 * in its default context, the profile the owner used last. When that is the chosen profile, the tab opens in the background.
 * Otherwise Chrome's own command line opens it with --profile-directory, in front, in a window of that profile.
 */
export async function openTaskTab(chrome: Pick<CurrentChrome, "cdp" | "executable" | "root">, directory: string,
  signal?: AbortSignal): Promise<{ targetId: string; background: boolean }> {
  const wanted = realpathSync(path.join(chrome.root, directory));
  const { defaultBrowserContextId } = await chrome.cdp.send<{ defaultBrowserContextId?: string }>("Target.getBrowserContexts", {}, undefined, 5000);
  const inDefault = await defaultContextProfile(chrome.cdp).catch(() => undefined);
  if (defaultBrowserContextId && inDefault && realpath(inDefault) === wanted) {
    const { targetId } = await chrome.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true }, undefined, 5000);
    const { targetInfo } = await chrome.cdp.send<{ targetInfo: { browserContextId?: string } }>("Target.getTargetInfo", { targetId }, undefined, 5000);
    if (targetInfo.browserContextId === defaultBrowserContextId) return { targetId, background: true };
    // The owner switched profiles in between. Close the stray tab and let Chrome open one in the right profile.
    await chrome.cdp.send("Target.closeTarget", { targetId }, undefined, 5000).catch(() => undefined);
  }
  const token = randomUUID();
  const opener = spawn(chrome.executable, [`--user-data-dir=${chrome.root}`, `--profile-directory=${directory}`, `data:text/html,<title>Bao</title>#bao-${token}`],
    { stdio: "ignore", detached: true, env: { ...process.env, HOME: userInfo().homedir } });
  opener.on("error", () => undefined);
  opener.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const { targetInfos } = await chrome.cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets", {}, undefined, 5000);
    const tab = targetInfos.find((target) => target.type === "page" && target.url.endsWith(`#bao-${token}`));
    if (tab) return { targetId: tab.targetId, background: false };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Bao could not open a tab in Chrome profile "${directory}" of ${chrome.root}, so it stopped. It did not use another profile.`);
}
