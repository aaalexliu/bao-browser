import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserChoice } from "../browser-choice";
import { navigateOwned } from "../launch";
import { ownerWall } from "../cdp-live/owner-wait";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { openRunningChrome } from "../extension/running-chrome";
import type { PersonPrompts } from "../v1/browser-driver";
import { chromeProfilesRoot, openCopiedChromeForProxy } from "./chrome-profile-copy";
import { baoAgentProfileDir, openBaoChromeForProxy } from "./bao-profile";

interface BrowserPage {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export type WorkflowBrowser = BrowserPage & (
  | { kind: "owned"; choice: "bao" | "copy" | "owned"; profile: string; persistent: boolean; keepOpen?: () => Promise<void>; importLogin?: (site: string, preferSource?: boolean) => Promise<boolean> }
  /**
   * `show` opens Bao's group for a handoff without switching the owner's tab; `settle` lets it fold again.
   * `bringToFront` is for the owner's own request to see the run.
   */
  | { kind: "current"; choice: "current"; show(): Promise<void>; settle(): Promise<void>; bringToFront(): Promise<void> }
);

export async function openWorkflowBrowser(options: {
  browser: BrowserChoice;
  home: string;
  site: string;
  sourceRoot?: string;
  directory?: string;
}): Promise<WorkflowBrowser> {
  if (options.browser === "current") {
    const chrome = await openRunningChrome({ home: options.home });
    try {
      const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${chrome.endpoint.port}${chrome.endpoint.browserPath}`, { noDefaults: true });
      try {
        const context = browser.contexts()[0];
        if (!context) throw new Error("Chrome opened without a profile context");
        // The extension opens the page in the background, in the window's collapsed Bao group.
        const page = await context.newPage();
        const { targetInfos: [target] } = await chrome.cdp.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets", {}, undefined, 5000);
        if (!target) throw new Error("Bao's tab in Chrome closed before the run started");
        const tab = (method: string, extra: Record<string, unknown> = {}) =>
          chrome.cdp.send(method, { targetId: target.targetId, ...extra }, undefined, 5000).then(() => undefined);
        let closing: Promise<void> | undefined;
        // The run's tabs close with the run. The owner's tabs and windows stay as they were.
        const close = () => closing ??= (async () => {
          try {
            await chrome.cdp.send("Bao.closeTabs", {}, undefined, 10_000).catch(() => undefined);
            await browser.close();
          } finally { chrome.detach(); }
        })();
        return { kind: "current", choice: "current", context, page, close,
          show: () => tab("Bao.showTab"), settle: () => tab("Bao.settleTab"), bringToFront: () => tab("Bao.showTab", { front: true }) };
      } catch (error) { await browser.close(); throw error; }
    } catch (error) {
      await chrome.cdp.send("Bao.closeTabs", {}, undefined, 10_000).catch(() => undefined);
      chrome.detach();
      throw error;
    }
  }
  const sourceRoot = options.sourceRoot ?? process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  if (process.env.BAO_TEST_BROWSER && !sourceRoot) throw new Error("tests must supply a throwaway Chrome profile source");
  const root = sourceRoot ?? chromeProfilesRoot();
  const launch = { sourceRoot: root, directory: options.directory || "Default", home: options.home, site: options.site };
  const chrome = options.browser === "copy" ? await openCopiedChromeForProxy({ ...launch, restoreTabs: false }) : await openBaoChromeForProxy(launch);
  try {
    const endpoint = await readDevToolsActivePort(chrome.target.portFile);
    const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`, { noDefaults: true });
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error("Chrome opened without a profile context");
      const page = context.pages()[0] || await context.newPage();
      let closing: Promise<void> | undefined;
      const close = () => closing ??= (async () => { try { await browser.close(); } finally { await chrome.close(); } })();
      void chrome.closed.then(close).catch(() => undefined);
      browser.on("disconnected", () => { void close().catch(() => undefined); });
      return { kind: "owned", choice: options.browser, context, page,
        profile: options.browser === "bao" ? baoAgentProfileDir(options.home) : path.dirname(chrome.target.portFile), persistent: options.browser === "bao",
        importLogin: "importLogin" in chrome ? chrome.importLogin : undefined,
        keepOpen: async () => { if (!closing && !page.isClosed()) await chrome.keepOpen(); }, close };
    } catch (error) { await browser.close(); throw error; }
  } catch (error) { await chrome.close(); throw error; }
}

/** The owner asked to see the run's page. */
export function showWorkflowPage(browser: WorkflowBrowser): Promise<void> {
  return browser.kind === "current" ? browser.bringToFront() : browser.page.bringToFront();
}

/** On Running Chrome, a step that needs the owner opens Bao's group so he can see the held tab. */
export function ownerPrompts(browser: WorkflowBrowser, prompts?: PersonPrompts): PersonPrompts | undefined {
  if (browser.kind !== "current") return prompts;
  const settle = () => { void browser.settle().catch(() => undefined); };
  return {
    ...prompts,
    showAsk(ask) {
      prompts?.showAsk?.(ask);
      void browser.show().catch(() => undefined);
    },
    clearConfirm(runId) {
      prompts?.clearConfirm?.(runId);
      settle();
    },
    clearLoginWait(runId) {
      prompts?.clearLoginWait?.(runId);
      settle();
    },
  };
}

export async function navigateWorkflowBrowser(browser: WorkflowBrowser, site: string): Promise<void> {
  await navigateOwned(browser.page, site, { waitUntil: "domcontentloaded" });
  if (browser.kind === "owned" && browser.importLogin && ownerWall({ url: browser.page.url(), title: await browser.page.title() }) === "login_wall") {
    if (await browser.importLogin(new URL(browser.page.url()).origin, true)) {
      await navigateOwned(browser.page, site, { waitUntil: "domcontentloaded" });
    }
  }
}
