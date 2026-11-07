import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserChoice } from "../browser-choice";
import { navigateOwned } from "../launch";
import { ownerWall } from "../cdp-live/owner-wait";
import { openCurrentChrome } from "../cdp-live/current-chrome";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { chromeProfilesRoot, openCopiedChromeForProxy } from "./chrome-profile-copy";
import { baoAgentProfileDir, openBaoChromeForProxy } from "./bao-profile";

interface BrowserPage {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export type WorkflowBrowser = BrowserPage & (
  | { kind: "owned"; choice: "bao" | "copy" | "owned"; profile: string; persistent: boolean; importLogin?: (site: string, preferSource?: boolean) => Promise<boolean> }
  | { kind: "current"; choice: "current" }
);

export async function openWorkflowBrowser(options: {
  browser: BrowserChoice;
  home: string;
  site: string;
  sourceRoot?: string;
  directory?: string;
}): Promise<WorkflowBrowser> {
  const sourceRoot = options.sourceRoot ?? process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  if (process.env.BAO_TEST_BROWSER && !sourceRoot) throw new Error("tests must supply a throwaway Chrome profile source");
  const root = sourceRoot ?? chromeProfilesRoot();
  if (options.browser === "current") {
    const chrome = await openCurrentChrome({ root, defaultRoot: chromeProfilesRoot(), axLog: path.join(options.home, "audit", "current-chrome.jsonl") });
    try {
      const browser = await chrome.withConsent(() => chromium.connectOverCDP(`ws://127.0.0.1:${chrome.endpoint.port}${chrome.endpoint.browserPath}`, { noDefaults: true }));
      try {
        const context = browser.contexts()[0];
        if (!context) throw new Error("Chrome opened without a profile context");
        const page = await context.newPage();
        let closing: Promise<void> | undefined;
        const close = () => closing ??= (async () => { try { await browser.close(); } finally { chrome.detach(); } })();
        return { kind: "current", choice: "current", context, page, close };
      } catch (error) { await browser.close(); throw error; }
    } catch (error) { chrome.detach(); throw error; }
  }
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
      return { kind: "owned", choice: options.browser, context, page,
        profile: options.browser === "bao" ? baoAgentProfileDir(options.home) : path.dirname(chrome.target.portFile), persistent: options.browser === "bao",
        importLogin: "importLogin" in chrome ? chrome.importLogin : undefined, close };
    } catch (error) { await browser.close(); throw error; }
  } catch (error) { await chrome.close(); throw error; }
}

export async function navigateWorkflowBrowser(browser: WorkflowBrowser, site: string): Promise<void> {
  await navigateOwned(browser.page, site, { waitUntil: "domcontentloaded" });
  if (browser.kind === "owned" && browser.importLogin && ownerWall({ url: browser.page.url(), title: await browser.page.title() }) === "login_wall") {
    if (await browser.importLogin(new URL(browser.page.url()).origin, true)) {
      await navigateOwned(browser.page, site, { waitUntil: "domcontentloaded" });
    }
  }
}
