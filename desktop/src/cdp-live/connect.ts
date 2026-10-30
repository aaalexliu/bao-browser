import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MacOsHelper } from "../proxy/os-macos";
import { ALLOW_CLICK_WINDOW_MS, mayClickAllow, type AxSummary } from "./consent";
import type { DevToolsEndpoint } from "./endpoint";
import { AxUnavailable, chromeTree, pressAllow } from "./ax";
import { connectCdp, type CdpSocket } from "./socket";

export async function clearInbox(file: string, held: boolean): Promise<void> {
  if (!held) throw new Error("inbox clear requires the cdp lock");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
}

/** Connect, wait for Allow, and press Allow once. Callers keep their own checkbox policy. */
export async function connectAndAllow(opts: {
  helper: MacOsHelper;
  endpoint: DevToolsEndpoint;
  dialogPresentBeforeConnect: boolean;
  axLog: string;
  pid?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<{ cdp: CdpSocket; clickedAt?: number; allowWindow: string; connectToAllowMs: number | null }> {
  const log = opts.log || (() => undefined);
  const timeoutMs = opts.timeoutMs ?? 200_000;
  const abort = new AbortController();
  const connectionStartedAt = Date.now();
  let opened = false;
  const pending = connectCdp(opts.endpoint.port, opts.endpoint.browserPath, { timeoutMs, signal: abort.signal })
    .then((socket) => {
      opened = true;
      return socket;
    });
  pending.catch(() => undefined);
  let last: AxSummary | undefined;
  let clickedAt: number | undefined;
  let allowWindow = "";
  const deadline = connectionStartedAt + Math.min(ALLOW_CLICK_WINDOW_MS, timeoutMs);
  while (Date.now() < deadline && !opened) {
    log("reading AX for the Allow dialog");
    const tree = await chromeTree(opts.helper, opts.pid);
    last = tree.summary;
    if (opened) break;
    if (mayClickAllow({
      openedByBao: true,
      connectionStartedAt,
      now: Date.now(),
      dialogPresentBeforeConnect: opts.dialogPresentBeforeConnect,
      dialog: tree.summary.dialog,
    })) {
      if (opened) break;
      log("pressing Allow");
      const pressed = await pressAllow(opts.helper, opts.pid, opts.axLog);
      clickedAt = pressed.at;
      allowWindow = pressed.window;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (clickedAt == null && !opened) {
    abort.abort();
    await pending.catch(() => undefined);
    if (!last) {
      last = (await chromeTree(opts.helper, opts.pid)).summary;
    }
    throw new AxUnavailable("BaoOSHelper cannot see the Allow remote debugging dialog", last);
  }
  const cdp = await pending;
  const connectToAllowMs = clickedAt == null ? null : clickedAt - connectionStartedAt;
  return { cdp, clickedAt, allowWindow, connectToAllowMs };
}
