// A restored tab the agent switches to is not the window's selected tab. Focus emulation does not unthrottle that tab.
// Target.activateTarget and Page.bringToFront do, and both raise the window. chrome.tabs.update selects the tab and, per
// Chrome's tabs API, does not focus the window. CDP has no equivalent, so the copy loads this helper and Bao calls it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DevToolsEndpoint } from "../cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";

const HELPER_DIR = path.join(tmpdir(), "bao-background-tab-extension");
const WORKER = "bao-background-tab.js";
const PAGE = "page.html";

const FILES: Record<string, string> = {
  "manifest.json": `${JSON.stringify({
    manifest_version: 3,
    name: "Bao tab select",
    version: "1.0.0",
    permissions: ["tabs", "debugger"],
    background: { service_worker: WORKER },
  }, null, 2)}\n`,
  // The worker exists so Bao can read the extension id. The select runs in the hidden page, which stays up after the worker stops.
  [WORKER]: "chrome.runtime.onInstalled.addListener(() => undefined);\n",
  [PAGE]: "<!doctype html><title>bao-tab-select</title>\n",
};

/** Writes the helper if needed and returns its directory. The id follows this path, so the directory stays fixed. */
function backgroundTabExtensionDir(): string {
  mkdirSync(HELPER_DIR, { recursive: true });
  for (const [name, body] of Object.entries(FILES)) {
    const file = path.join(HELPER_DIR, name);
    try { if (readFileSync(file, "utf8") === body) continue; } catch { /* missing */ }
    writeFileSync(file, body, { mode: 0o644 });
  }
  return HELPER_DIR;
}

/**
 * Loads the helper and disables every other extension, including ones copied from the owner's profile.
 * `--disable-extensions` would disable the helper too.
 */
export function backgroundTabLaunchArgs(): string[] {
  const dir = backgroundTabExtensionDir();
  return [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`];
}

type EvalResult = { result?: { value?: unknown }; exceptionDetails?: { text?: string } };

/**
 * Selects one Chrome tab from a hidden extension page. `chrome.debugger.getTargets` maps a CDP target id to a tab id.
 * Matching by URL is wrong when two tabs share one. The helper never calls `chrome.debugger.attach`.
 */
export class BackgroundTabSelect {
  private cdp?: CdpSocket;
  private sessionId?: string;
  private extensionId?: string;
  private opening?: Promise<void>;

  constructor(private readonly endpoint: DevToolsEndpoint) {}

  async ready(): Promise<void> {
    if (this.sessionId && this.cdp?.isOpen) return;
    this.opening ??= this.open();
    try { await this.opening; }
    finally { this.opening = undefined; }
  }

  async select(targetId: string): Promise<void> {
    await this.ready();
    try {
      await this.activate(targetId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Bao could not select")) throw error;
      this.sessionId = undefined;
      await this.ready();
      await this.activate(targetId);
    }
  }

  close(): void {
    this.sessionId = undefined;
    this.cdp?.close();
    this.cdp = undefined;
  }

  private async open(): Promise<void> {
    if (!this.cdp?.isOpen) {
      this.cdp?.close();
      this.cdp = await connectCdp(this.endpoint.port, this.endpoint.browserPath, { timeoutMs: 8_000 });
    }
    const deadline = Date.now() + 8_000;
    while (!this.extensionId) {
      const { targetInfos } = await this.cdp.send<{ targetInfos: { url?: string }[] }>("Target.getTargets", {}, undefined, 8_000);
      const worker = targetInfos.find((target) => target.url?.endsWith(`/${WORKER}`));
      if (worker?.url) this.extensionId = new URL(worker.url).host;
      else if (Date.now() >= deadline) throw new Error("Bao's tab helper did not start");
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", {
      url: `chrome-extension://${this.extensionId}/${PAGE}`, hidden: true,
    }, undefined, 8_000);
    const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 8_000);
    this.sessionId = sessionId;
  }

  private async activate(targetId: string): Promise<void> {
    const expression = `chrome.debugger.getTargets().then((targets) => {
      const target = targets.find((item) => item.id === ${JSON.stringify(targetId)});
      if (!target || typeof target.tabId !== "number") return "missing";
      return chrome.tabs.update(target.tabId, { active: true }).then(() => "ok");
    })`;
    const sent = await this.cdp!.send<EvalResult>("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, this.sessionId, 8_000);
    if (sent.exceptionDetails) throw new Error(sent.exceptionDetails.text || "Bao's tab helper failed");
    if (sent.result?.value !== "ok") throw new Error(`Bao could not select tab ${targetId}`);
  }
}
