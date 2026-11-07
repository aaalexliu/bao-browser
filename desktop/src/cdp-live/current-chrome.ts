import path from "node:path";
import { chromeHelper, INSPECT_URL, logAx, type ChromeAx } from "./ax";
import { REMOTE_CHECKBOX } from "./consent";
import { listenPid, readDevToolsActivePort, type DevToolsEndpoint } from "./endpoint";
import { dailyChromePids } from "./remote-debugging";
import { connectCdp, type CdpSocket } from "./socket";
import { remoteDebuggingBlock } from "../helper-capabilities";

interface CurrentChromeDeps {
  helper: Pick<ChromeAx, "exec" | "permissions" | "screenLocked">;
  findChrome: (root: string) => Promise<number[]>;
  readPort: typeof readDevToolsActivePort;
  listener: typeof listenPid;
  connect: typeof connectCdp;
}

export interface CurrentChrome {
  pid: number;
  endpoint: DevToolsEndpoint;
  cdp: CdpSocket;
  closed: Promise<void>;
  isClosed(): boolean;
  detach(): void;
  withConsent<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

async function withConsent<T>(helper: CurrentChromeDeps["helper"], pid: number, axLog: string,
  operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const signal = parent ?? new AbortController().signal;
  const deadline = Date.now() + 25_000;
  signal.throwIfAborted();
  let finished = false;
  const pending = operation(signal).finally(() => { finished = true; });
  void pending.catch(() => undefined);
  while (!finished && Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const hit = await helper.exec(["debug-allow", "--pid", String(pid), "--press"], 5000);
      if (hit.pressed) await logAx(axLog, { what: "AXPress", role: "AXButton", name: "Allow", window: "Allow remote debugging?", at: new Date().toISOString(), via: "BaoOSHelper" });
    } catch { break; }
    if (!finished) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return pending;
}

export async function openCurrentChrome(options: {
  root: string;
  defaultRoot: string;
  axLog: string;
  signal?: AbortSignal;
}, overrides: Partial<CurrentChromeDeps> = {}): Promise<CurrentChrome> {
  if (process.platform !== "darwin" && !overrides.helper) throw new Error("Current Chrome control needs BaoOSHelper on a Mac");
  const deps: CurrentChromeDeps = {
    helper: overrides.helper ?? chromeHelper(),
    findChrome: (root) => dailyChromePids(root, options.defaultRoot),
    readPort: readDevToolsActivePort,
    listener: listenPid,
    connect: connectCdp,
    ...overrides,
  };
  const blocked = remoteDebuggingBlock(await deps.helper.permissions(false));
  if (blocked) throw new Error(blocked);
  if (await deps.helper.screenLocked()) throw new Error("The screen is locked. Unlock it, then try again.");
  options.signal?.throwIfAborted();
  const pids = await deps.findChrome(options.root);
  if (pids.length !== 1) throw new Error(pids.length ? "More than one Chrome runs on this profile root" : "Chrome is not open. Open Google Chrome, then try again");
  const pid = pids[0]!;
  const portFile = path.join(options.root, "DevToolsActivePort");
  const endpointForChrome = async () => {
    const endpoint = await deps.readPort(portFile).catch(() => undefined);
    return endpoint && await deps.listener(endpoint.port) === pid ? endpoint : undefined;
  };
  let endpoint = await endpointForChrome();
  let openedInspect = false;
  if (!endpoint) {
    const helper = deps.helper;
    options.signal?.throwIfAborted();
    await helper.exec(["inspect-open-ax", "--pid", String(pid)], 30_000);
    openedInspect = true;
    const deadline = Date.now() + 60_000;
    for (;;) {
      options.signal?.throwIfAborted();
      const box = await helper.exec(["checkbox-read", "--pid", String(pid), "--name", REMOTE_CHECKBOX], Math.max(1, Math.min(30_000, deadline - Date.now())));
      if (box.found) break;
      if (Date.now() >= deadline) throw new Error("Chrome's remote-debugging checkbox did not appear");
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
  const consent = <T>(operation: (signal: AbortSignal) => Promise<T>, signal = options.signal) =>
    withConsent(deps.helper, pid, options.axLog, operation, signal);
  const cdp = await consent(async (parent) => {
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
  });
  try {
    if (openedInspect) {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets", {}, undefined, 5000);
      const inspect = targetInfos.filter((target) => target.url === INSPECT_URL);
      if (inspect.length === 1) await cdp.send("Target.closeTarget", { targetId: inspect[0]!.targetId }, undefined, 5000);
    }
    return { pid, endpoint, cdp, closed: cdp.disconnected, isClosed: () => !cdp.isOpen,
      detach: () => cdp.close(), withConsent: consent };
  } catch (error) {
    cdp.close();
    throw error;
  }
}
