// The owner's running Chrome, reached through the Bao app's relay and the Bao extension. No debugging port and no
// macOS permission: the extension drives Bao's own grouped tabs with chrome.debugger. Gated off by the runningChromeExtension setting.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DevToolsEndpoint } from "../cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";

export const RUNNING_CHROME_NEEDS_APP = "Running Chrome needs the Bao app. Open Bao, then try again.";
export const RUNNING_CHROME_EXTENSION_OFF = "Running Chrome through the Bao extension is off. browser=current uses Chrome remote debugging unless runningChromeExtension is true in the Library's settings.json.";

export interface RunningChrome {
  /** CDP endpoint of this run's lease. Clients on it see only the tabs the lease opened. */
  endpoint: DevToolsEndpoint;
  /** Bao's own connection to the lease. When every connection closes, tabs still open become the owner's. */
  cdp: CdpSocket;
  closed: Promise<void>;
  isClosed(): boolean;
  detach(): void;
}

function appPort(home: string): number | undefined {
  try {
    const port = Number((JSON.parse(readFileSync(path.join(home, "server.json"), "utf8")) as { port?: unknown }).port);
    return Number.isSafeInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

export async function openRunningChrome(options: { home: string; signal?: AbortSignal }): Promise<RunningChrome> {
  const port = appPort(options.home);
  if (!port) throw new Error(RUNNING_CHROME_NEEDS_APP);
  const endpoint = { port, browserPath: `/devtools/browser/${randomUUID()}` };
  let cdp: CdpSocket;
  try {
    cdp = await connectCdp(port, endpoint.browserPath, { timeoutMs: 10_000, signal: options.signal });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const refusal = /handshake status 503 (.+)$/s.exec(text)?.[1];
    throw new Error(refusal ?? (/ECONNREFUSED|handshake status/.test(text) ? RUNNING_CHROME_NEEDS_APP : text), { cause: error });
  }
  return { endpoint, cdp, closed: cdp.disconnected, isClosed: () => !cdp.isOpen, detach: () => cdp.close() };
}
