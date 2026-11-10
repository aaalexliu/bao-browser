import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserChoice } from "../browser-choice";
import { ChromeFolderDenied } from "../chrome-access";
import { navigateOwned, resolveNormalChrome } from "../launch";
import { ownerWall } from "../cdp-live/owner-wait";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { openCurrentChrome, openTaskTab } from "../cdp-live/current-chrome";
import { relayTab } from "../cdp-live/tab-relay";
import { openRunningChrome } from "../extension/running-chrome";
import type { PersonPrompts } from "../v1/browser-driver";
import type { WorkflowStep } from "../v1/schema";
import { chromeProfilesRoot, openCopiedChromeForProxy } from "./chrome-profile-copy";
import { baoAgentProfileDir, openBaoChromeForProxy, type SignInImport } from "./bao-profile";
import { baoPick, boundOpenPlan, boundRoute, chromeApp, chooseChromeProfile, ChromeProfileQuestion, failedPickLine, fallbackPlan, fallsBack, openOrFallBack, RUNNING_CHROME_FALLBACK, signInSource, type BrowserPick, type BrowserPlan, type ChosenProfile, type RouteWhy } from "./browser-pick";
import { purgeBoundSites } from "./bound-sign-in";

interface BrowserPage {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
  /** The route, Chrome app, user data, and profile, and why. The Bao app's own profile, which has no browser choice, has none. */
  pick?: BrowserPick;
  missed?: string;
}

export type WorkflowBrowser = BrowserPage & (
  | {
    kind: "owned"; choice: "bao" | "copy" | "owned"; profile: string; persistent: boolean; keepOpen?: () => Promise<void>;
    importLogin?: (site: string, preferSource?: boolean) => Promise<SignInImport>;
    /** The Bao profile's sign-in import for the site the run opened with. */
    signIn?: SignInImport;
  }
  /**
   * `show` makes the held tab visible for a handoff: the extension opens Bao's group without switching the owner's tab, and
   * remote debugging brings the tab to the front. `settle` lets the group fold again. `bringToFront` is for the owner's own
   * request to see the run.
   */
  | { kind: "current"; choice: "current"; show(): Promise<void>; settle(): Promise<void>; bringToFront(): Promise<void>; keepOpen(): Promise<void> }
);

/** Ends the run's attachment. A current-Chrome tab stays when Keep window open is on; otherwise that tab closes. An owned browser always closes. */
export function releaseWorkflowBrowser(browser: WorkflowBrowser, keepTab: boolean): Promise<void> {
  return keepTab && browser.kind === "current" ? browser.keepOpen() : browser.close();
}

export const RUNNING_CHROME_FILE_REFUSAL = "This workflow downloads or uploads a file, which Bao cannot do on your running Chrome yet. Run it on the Bao profile instead.";

const movesFile = (step: WorkflowStep): boolean =>
  step.action === "download" || step.action === "upload" || step.action === "drop"
  || (step.action === "for_each" && step.forEach.steps.some(movesFile));

/** The workflow downloads or uploads a file. */
export function workflowMovesFiles(workflow: { steps: WorkflowStep[] }): boolean {
  return workflow.steps.some(movesFile);
}

/** Running Chrome cannot download or upload files yet, so a workflow that does either is refused before it opens a tab. */
export function runningChromeRefusal(browser: BrowserChoice | undefined, workflow: { steps: WorkflowStep[] }): string | undefined {
  return browser === "current" && workflowMovesFiles(workflow) ? RUNNING_CHROME_FILE_REFUSAL : undefined;
}

/**
 * The Chrome profile a saved workflow runs with: the one the agent named, else the one picked in Bao Settings, else the only one.
 * With several and none named or picked, it throws ChromeProfileQuestion. Never a silent "Default".
 */
function workflowProfile(root: string, named: string | undefined, settings: string | undefined): Promise<ChosenProfile> {
  return chooseChromeProfile(root, named ? { directory: named, by: "agent" } : settings ? { directory: settings, by: "settings" } : undefined, settings);
}

/** Bao's own profile runs without Chrome's profiles. It then imports no sign-in and says why. A named or picked profile must exist. */
async function baoSource(root: string, named: string | undefined, settings: string | undefined): Promise<{ profile: ChosenProfile } | { profile?: undefined; unread: string }> {
  try {
    return { profile: await workflowProfile(root, named, settings) };
  } catch (error) {
    if (error instanceof ChromeFolderDenied || !named && !settings && !(error instanceof ChromeProfileQuestion)) return { unread: error instanceof Error ? error.message : String(error) };
    throw error;
  }
}

/** The app's message for a profile question: the owner answers it in Bao Settings. */
export function settingsProfileQuestion(error: unknown): unknown {
  return error instanceof ChromeProfileQuestion
    ? new Error(`${error.message} Pick one in Bao Settings under Technical details, Page engine, Chrome profile, then run the workflow again.`, { cause: error })
    : error;
}

export interface WorkflowBrowserOptions {
  browser: BrowserChoice;
  home: string;
  site: string;
  sourceRoot?: string;
  /** The Chrome profile folder picked in Bao Settings. */
  directory?: string;
  /** The Chrome profile folder the agent named. It wins over the Settings pick. */
  profile?: string;
  /** The gate for Running Chrome through the Bao extension. Off means remote debugging. */
  extensionRoute?: boolean;
  /** Why the run uses this route: "the default" when the caller did not name it. */
  why?: RouteWhy;
  /** The workflow downloads or uploads a file, which Bao cannot do on running Chrome yet. */
  movesFiles?: boolean;
  /** Opens the caller's own Bao profile, with no sign-in import, in place of running Chrome. Without it, Bao's agent profile opens. */
  fallback?: () => Promise<WorkflowBrowser>;
}

/** The Chrome folder a workflow run reads: the caller's root, then the fixture root, then Chrome's own folder. A pinned test browser with none of those is refused, so that run never reads the owner's Chrome. */
function workflowChromeRoot(options: WorkflowBrowserOptions): string {
  const sourceRoot = options.sourceRoot ?? process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  if (process.env.BAO_TEST_BROWSER && !sourceRoot) throw new Error("tests must supply a throwaway Chrome profile source");
  return sourceRoot ?? chromeProfilesRoot();
}

/** The route and Chrome profile for a saved workflow run, settled before Bao opens anything. */
export async function planWorkflowBrowser(options: WorkflowBrowserOptions): Promise<BrowserPlan> {
  const why = options.why ?? "named by the agent";
  if (options.browser === "current" && options.extensionRoute) return { route: "extension", why };
  const root = workflowChromeRoot(options);
  // Bao's own profile, and a run that did not name a route, work without Chrome's profiles: Bao's profile opens with no sign-in import.
  const fallback = fallsBack(options.browser, why);
  const source = options.browser === "bao" || fallback ? await baoSource(root, options.profile, options.directory)
    : { profile: await workflowProfile(root, options.profile, options.directory) };
  if (!source.profile) return fallback ? fallbackPlan(source.unread) : { route: "bao", why, unread: source.unread };
  // A site that ties its sign-in to the owner's Chrome runs there, unless the workflow moves files.
  if (boundRoute(options.browser, options.site, path.join(source.profile.root, source.profile.directory), options.movesFiles)) {
    return boundOpenPlan(options.browser, source.profile, options.extensionRoute === true);
  }
  if (options.browser === "bao") return { route: "bao", why, profile: source.profile };
  return { route: options.browser, why, profile: source.profile };
}

/**
 * What Bao tried when choosing the profile failed before a plan existed. The folder is the one the agent named, or the Settings
 * pick. The root is the one the planner uses. A pinned test browser with no supplied root does not name the owner's Chrome.
 */
export function triedPickLine(options: WorkflowBrowserOptions): string {
  const why = options.why ?? "named by the agent";
  const directory = options.profile ?? options.directory;
  let root: string | undefined;
  try { root = workflowChromeRoot(options); } catch { root = undefined; }
  return failedPickLine(options.browser, why, chromeApp(), directory && root ? { directory, root } : undefined);
}

/**
 * Opens the planned browser. When the owner's running Chrome cannot be used, a run that did not name it opens in Bao's own
 * profile without a sign-in import. A named Bao profile or copy opens that route, and the pick says why.
 */
export async function openWorkflowBrowser(options: WorkflowBrowserOptions, plan?: BrowserPlan): Promise<WorkflowBrowser> {
  return openOrFallBack(plan ?? await planWorkflowBrowser(options), (next) => {
    const unreadFallback = next.why === RUNNING_CHROME_FALLBACK && "unread" in next && next.unread;
    return unreadFallback && options.fallback ? options.fallback() : openPlanned(options, next);
  });
}

async function openPlanned(options: WorkflowBrowserOptions, plan: BrowserPlan): Promise<WorkflowBrowser> {
  const why = plan.why;
  if (plan.route === "extension") {
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
        // The run's tabs close with the run, unless the caller keeps them. The owner's tabs and windows stay as they were.
        const release = (keep: boolean) => closing ??= (async () => {
          try {
            if (!keep) await chrome.cdp.send("Bao.closeTabs", {}, undefined, 10_000).catch(() => undefined);
            await browser.close();
          } finally { chrome.detach(); }
        })();
        return { kind: "current", choice: "current", context, page, close: () => release(false), keepOpen: () => release(true),
          pick: { route: "extension", why },
          show: () => tab("Bao.showTab"), settle: () => tab("Bao.settleTab"), bringToFront: () => tab("Bao.showTab", { front: true }) };
      } catch (error) { await browser.close(); throw error; }
    } catch (error) {
      await chrome.cdp.send("Bao.closeTabs", {}, undefined, 10_000).catch(() => undefined);
      chrome.detach();
      throw error;
    }
  }
  if (plan.route === "current") {
    const profile = plan.profile;
    const chrome = await openCurrentChrome({ root: profile.root, axLog: path.join(options.home, "audit", "current-chrome.jsonl") });
    try {
      const { targetId, background } = await openTaskTab(chrome, profile.directory);
      const closeTab = () => chrome.cdp.send("Target.closeTarget", { targetId }, undefined, 5000).then(() => undefined, () => undefined);
      try {
        const relay = await relayTab(chrome.endpoint, targetId);
        void chrome.closed.then(relay.close);
        const browser = await chromium.connectOverCDP(relay.url, { noDefaults: true });
        try {
          const context = browser.contexts()[0];
          const page = context?.pages()[0];
          if (!context || !page) throw new Error("Chrome opened without the replay tab");
          // Focus emulation keeps a background tab painting, running timers, and taking input while Playwright stays attached.
          await (await context.newCDPSession(page)).send("Emulation.setFocusEmulationEnabled", { enabled: true });
          const front = () => chrome.cdp.send("Target.activateTarget", { targetId }, undefined, 5000).then(() => undefined);
          let closing: Promise<void> | undefined;
          // The run's tab closes with the run, unless the caller keeps it. The owner's tabs and windows stay as they were.
          const release = (keep: boolean) => closing ??= (async () => {
            try { if (!keep) await closeTab(); await browser.close(); } finally { chrome.detach(); }
          })();
          return { kind: "current", choice: "current", context, page, close: () => release(false), keepOpen: () => release(true),
            show: front, settle: async () => undefined, bringToFront: front,
            pick: { route: "current", why, chrome: chrome.executable, userDataDir: chrome.root, profile, background } };
        } catch (error) { await browser.close(); throw error; }
      } catch (error) { await closeTab(); throw error; }
    } catch (error) { chrome.detach(); throw error; }
  }
  const launch = { home: options.home, site: options.site };
  const chrome = plan.route === "bao"
    ? await openBaoChromeForProxy({ ...launch, ...signInSource(plan), boundSites: purgeBoundSites(
        workflowChromeRoot(options), options.directory,
        plan.profile ? path.join(plan.profile.root, plan.profile.directory) : undefined) })
    : await openCopiedChromeForProxy({ ...launch, sourceRoot: plan.profile.root, directory: plan.profile.directory, restoreTabs: false });
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
      const pick: BrowserPick = plan.route === "bao" ? baoPick(plan, baoAgentProfileDir(options.home))
        : { route: "copy", why, chrome: resolveNormalChrome(), userDataDir: path.dirname(chrome.target.portFile), profile: plan.profile };
      const missed = "missed" in plan ? plan.missed : undefined;
      return { kind: "owned", choice: plan.route, context, page, pick, ...missed ? { missed } : {},
        profile: plan.route === "bao" ? baoAgentProfileDir(options.home) : path.dirname(chrome.target.portFile), persistent: plan.route === "bao",
        importLogin: "importLogin" in chrome ? chrome.importLogin : undefined, signIn: "signIn" in chrome ? chrome.signIn : undefined,
        keepOpen: async () => { if (!closing && !page.isClosed()) await chrome.keepOpen(); }, close };
    } catch (error) { await browser.close(); throw error; }
  } catch (error) { await chrome.close(); throw error; }
}

/** The owner asked to see the run's page. */
export function showWorkflowPage(browser: WorkflowBrowser): Promise<void> {
  return browser.kind === "current" ? browser.bringToFront() : browser.page.bringToFront();
}

/** On Running Chrome, a step that needs the owner shows him the held tab. */
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

/** Opens the run's start page. At a login wall in Bao's profile it imports the sign-in again and returns that import. */
export async function navigateWorkflowBrowser(browser: WorkflowBrowser, site: string): Promise<SignInImport | undefined> {
  await navigateOwned(browser.page, site, { waitUntil: "domcontentloaded" });
  if (browser.kind === "owned" && browser.importLogin && ownerWall({ url: browser.page.url(), title: await browser.page.title() }) === "login_wall") {
    const imported: SignInImport = { ...await browser.importLogin(new URL(browser.page.url()).origin, true), retry: true };
    if (imported.cookies || imported.storage) {
      await navigateOwned(browser.page, site, { waitUntil: "domcontentloaded" });
    }
    return imported;
  }
  return undefined;
}
