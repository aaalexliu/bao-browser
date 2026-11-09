// A stand-in for the owner's running Chrome: Chrome for Testing on a throwaway profile with the unpacked Bao
// extension, linked to a Bao app on a throwaway home. The checks look through a raw CDP connection that attaches only
// to the extension's worker and, briefly, to read a page. The owner's tab has no emulation, so its own visibility and
// focus events are real.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { startApp } from "../../src/app/server";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { extensionOrigin } from "../../src/extension/protocol";
import { launchOwnedChromeEndpoint } from "../../src/launch";
import { applyHermeticApp } from "../runtime";

export interface StripTab { id: number; index: number; active: boolean; groupId: number; title: string; url: string }
export interface StripGroup { id: number; title: string; color: string; collapsed: boolean }
export interface Strip { tabs: StripTab[]; groups: StripGroup[] }

export interface OwnerChrome {
  app: Awaited<ReturnType<typeof startApp>>;
  home: string;
  base: string;
  /** The owner's own tab. */
  ownerTabId: number;
  ownerTargetId: string;
  /** The checks' own CDP connection on the debugging port. Attaching it to a tab shows as that tab being attached. */
  probe: CdpSocket;
  strip(): Promise<Strip>;
  /** Runs an expression in the Bao extension's service worker. */
  inWorker<T>(expression: string): Promise<T>;
  /** Runs an expression in a page, attached only for that call. */
  inPage<T>(targetId: string, expression: string): Promise<T>;
  /** Visibility changes and blurs the owner's page saw since it loaded. */
  ownerEvents(): Promise<string[]>;
  /** What the owner does with his mouse: make a tab active. */
  ownerClicks(tabId: number): Promise<void>;
  /** Target id of the first page whose URL ends with `suffix`. */
  targetOf(suffix: string): Promise<string>;
}

const OWNER = `<!doctype html><title>Owner</title><h1>Owner tab</h1><script>window.ownerEvents = [];
document.addEventListener('visibilitychange', () => ownerEvents.push(document.visibilityState));
addEventListener('blur', () => ownerEvents.push('blur'));</script>`;

async function evaluate<T>(cdp: CdpSocket, sessionId: string, expression: string): Promise<T> {
  const { result, exceptionDetails } = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
}

/** A page is its HTML, or a handler that answers, or never answers, the request itself. */
export async function ownerChrome(t: TestContext, pages: Record<string, string | ((response: ServerResponse) => void)> = {}): Promise<OwnerChrome> {
  const dirs = applyHermeticApp("owner-chrome");
  const root = path.dirname(dirs.home);
  const extension = path.join(root, "extension");
  const profile = path.join(root, "profile");
  mkdirSync(profile, { recursive: true });
  execFileSync(process.execPath, [path.resolve("extension/build.mjs"), extension], { stdio: "pipe" });
  const server = createServer((request, response) => {
    const page = pages[request.url ?? ""] ?? OWNER;
    if (typeof page === "function") return page(response);
    response.setHeader("content-type", "text/html");
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = await startApp({ home: dirs.home, extensionHost: true, extensionConfigHome: dirs.nativeHostHome,
    extensionHostDirs: [path.join(profile, "NativeMessagingHosts")] });
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let cdp: CdpSocket | undefined;
  t.after(async () => {
    try {
      cdp?.close();
      await chrome?.close();
      await app.close();
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  chrome = await launchOwnedChromeEndpoint({ userDataDir: profile, headless: true, childHome: dirs.nativeHostHome,
    args: ["--no-startup-window", `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  const probe = cdp;
  let workerTarget: string | undefined;
  for (let tries = 0; tries < 200 && !workerTarget; tries++) {
    const { targetInfos } = await probe.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    workerTarget = targetInfos.find((target) => target.type === "service_worker" && target.url.startsWith(extensionOrigin()))?.targetId;
    if (!workerTarget) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!workerTarget) throw new Error("the Bao extension's worker did not start");
  const { sessionId: worker } = await probe.send<{ sessionId: string }>("Target.attachToTarget", { targetId: workerTarget, flatten: true });
  // Headless Chrome with a debugging port can hold the extension's worker paused until a debugger lets it go.
  await probe.send("Runtime.runIfWaitingForDebugger", {}, worker);
  await app.extensionLink!.waitForHello(0, 30_000);
  const { targetId: ownerTargetId } = await probe.send<{ targetId: string }>("Target.createTarget", { url: `${base}/owner` });
  const inWorker = <T>(expression: string) => evaluate<T>(probe, worker, expression);
  const inPage = async <T>(targetId: string, expression: string) => {
    const { sessionId } = await probe.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    try { return await evaluate<T>(probe, sessionId, expression); }
    finally { await probe.send("Target.detachFromTarget", { sessionId }); }
  };
  let ownerTabId = 0;
  for (let tries = 0; tries < 100 && !ownerTabId; tries++) {
    ownerTabId = await inWorker<number>(`chrome.tabs.query({ url: ${JSON.stringify(`${base}/owner`)} }).then((tabs) => tabs[0]?.id ?? 0)`);
    if (!ownerTabId) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (let tries = 0; tries < 100 && !await inPage<boolean>(ownerTargetId, "Array.isArray(window.ownerEvents)").catch(() => false); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    app, home: dirs.home, base, ownerTabId, ownerTargetId, probe, inWorker, inPage,
    strip: () => inWorker<Strip>(`(async () => ({
      tabs: (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, index: tab.index, active: tab.active, groupId: tab.groupId,
        title: tab.title ?? "", url: tab.url ?? "" })).sort((a, b) => a.index - b.index),
      groups: (await chrome.tabGroups.query({})).map((group) => ({ id: group.id, title: group.title ?? "", color: group.color, collapsed: group.collapsed })),
    }))()`),
    ownerEvents: () => inPage<string[]>(ownerTargetId, "window.ownerEvents"),
    ownerClicks: (tabId) => inWorker<void>(`chrome.tabs.update(${tabId}, { active: true }).then(() => undefined)`),
    targetOf: async (suffix) => {
      const { targetInfos } = await probe.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
      const target = targetInfos.find((item) => item.type === "page" && item.url.endsWith(suffix));
      if (!target) throw new Error(`no page ending ${suffix}`);
      return target.targetId;
    },
  };
}

/** Polls the strip until `ready` holds, so a check waits for Chrome's own tab and group events. */
export async function stripWhen(chrome: OwnerChrome, ready: (strip: Strip) => boolean, timeoutMs = 5000): Promise<Strip> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const strip = await chrome.strip();
    if (ready(strip) || Date.now() > deadline) return strip;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
