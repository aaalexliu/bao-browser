// Local app. The UI, the library, and replay all stay on disk.
// Nothing is recorded unless a session was started.

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { BrowserContext, Page } from "playwright";
import { launchOwnedChrome, navigateOwned, pidsForDataDir, productHeadless } from "../launch";
import { Capture, actNotice } from "./capture";
import { resolveCaptureUrl } from "./capture-url";
import { visibleCopy } from "../v1/visible-copy";
import { CaptureBar, findCaptureBar, type BarEvent } from "./capture-bar";
import { shotWithBlur } from "../v1/blur";
import { publicLiveSession, shotNameOk } from "../cdp-live/live-record";
import { createLiveHost } from "../cdp-live/live-host";
import type { LiveIdleWarning } from "../cdp-live/live-ops";
import { liveReplayArgs } from "../cdp-live/live-replay";
import { parseLiveTarget } from "../cdp-live/live-target";
import { BrowserDriver, clearOsNotify, elementShot, guideFieldShot, notifyOs, pagePoster, watchOsNotify, type PersonPrompts } from "../v1/browser-driver";
import { actAskLine, actDeadlineLine, actSurfaceText, liveIdleSurfaceText, siteHost, type HumanAsk } from "../v1/human-ask";
import { formatClock } from "../v1/time";
import { ensureTrailTimes } from "../v1/trail-time";
import { blurSensitiveFields, maskPasswordFields, unblurSensitiveFields, unmaskPasswordFields, visibleStatusLines } from "../v1/dom-page";
import {
  cookieHeader,
  loginDocument,
  loginRedirect,
  newToken,
  PENDING_COOKIE,
  readCookie,
  safeNext,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionExpiry,
  sessionStatus,
  type FreezeSession,
} from "../v1/freeze-session";
import { dismissCoveringAds } from "../v1/page-class";
import { clickInDrive } from "../v1/drive-click";
import { recorderSource } from "../v1/recorder";
import { armBrowserDownloads, captureDownloads } from "../v1/files-dates";
import { armFileChooser, queueChooserFile, storedFileEvent } from "../v1/file-chooser";
import {
  auditLine,
  chooseProfile,
  chromeUserDataDir,
  assertDomain,
  importConfirmText,
  injectCookies,
  loadChromeSiteCookies,
  readChromeSafeStoragePassword,
  readProfileNames,
  safeImportError,
  type ChromeProfile,
  type ImportAudit,
} from "../v1/chrome-login";
import { boundsApplied, moveOwnedWindow, readOwnedWindow, type WindowBounds } from "../v1/window-bounds";
import { openReplayVideo } from "../v1/replay-video";
import { capabilityReport, type HelperStatus } from "../helper-capabilities";
import { bundledHelperApp, MacOsHelper } from "../proxy/os-macos";
import { cursorAccountHeal, cursorAccountModelLabel, readCursorAccount } from "../v1/cursor-account";
import { cursorSessionHeal, effectiveMode, keepPatch, maskText, revertPatch, scriptedHeal, unavailableHeal, type HealProposal, type HealProvider, type HealRecord } from "../v1/heal";
import { captureStartUrl, extractPickerHtml, outputCsv, parseCsv, specFromProposal, type PageProposal } from "../v1/data-steps";
import { installDataPage } from "../v1/data-page";
import { explain, type TrailEvent } from "../v1/interpret";
import { isElementCrop, isFullPageShot } from "../v1/redacted-png";
import { isPageAct, selectCardPoster } from "../v1/poster";
import { applySaveEdits, inferSavedWorkflow, saveCompleter, secretValues } from "../v1/save-intent";
import { workflowFloorTitle } from "../v1/workflow-name";
import {
  decide,
  decisionEvent,
  intentEvalPair,
  mergeDemonstrations,
  narratorFromEnv,
  projectTeach,
  publicTrail,
  spliceFix,
  teachIntentCase,
  teachSummaryFrom,
  type Spoken,
  type TeachCorrection,
  type TeachDecision,
} from "../v1/teach";
import { guideCrops, guideHtml } from "../v1/guide";
import { guideMe, type GuideProgress } from "../v1/guide-me";
import { guideShotName, shotFile, workflowShotName } from "../v1/shots";
import { noteDrift, noteReplay, openProvisional, promotionEvent, type Promotion } from "../v1/promote";
import { circuitOpen, stepsNeedingReview } from "../v1/triage";
import { ReceiptLog } from "../v1/receipt";
import { defaultChromeUserData } from "../login-import/chrome-path";
import { importInOwnedChrome, openOwnedSignIn, previewChromeProfiles, probeOwnedProfile, type ClickInput } from "../login-import/import-login";
import { readPlatformKeys, type KeySources } from "../login-import/keys";
import { isNeedsSignIn, runIfSignedIn } from "../login-import/session-gate";
import { SiteStore, siteOrigin } from "../login-import/sites";
import { formatProbeTime } from "../login-import/time";
import { ConsentRequired, type BotCookiePolicy, type SiteLoginConfig } from "../login-import/types";
import { replay, type HealNotice, type ReplayOptions, type RunResult } from "../v1/replay";
import {
  clearPendingPrompt,
  markPromptTimedOut,
  promptDue,
  readPendingPrompt,
  writePendingPrompt,
} from "../v1/pending-prompt";
import { editInput } from "../v1/input-token";
import { cleanSiteTrust, originOf, trustMode } from "../v1/site-trust";
import { tryStep } from "../v1/try-step";
import { showOnce } from "../home";
import { Library } from "../v1/store";
import { hostAccessMode, hostGrantMessage } from "../../../extension/src/host-grant";
import { ExtensionDriver, HostGrantNeeded, isHostGrantMessage } from "../extension/driver";
import { gestureQueue, readGestures, writeGestures } from "../extension/gestures";
import { hostScriptPath, startExtensionLink, type ExtensionLink } from "../extension/link";
import { workflowDriver, type Gesture } from "../extension/protocol";
import { CDP_LIVE_SERVER_REFUSAL, EXTENSION_NOT_CONNECTED, refusesOwnedBrowser, replayRefusal } from "../cdp-live/launch-guard";
import { defaultConfigHome } from "../extension/install-host";
import { createRemoteAgent } from "../v1/remote-agent";
import { clearRelay, loadRelay, relayStatus, saveRelay } from "../v1/relay-link";
import { keepMine, loadState, openConflict, pairDevice, publishWorkflow, resolveConflict, restoreScheduledBackup, revealBackup, runScheduledBackup, setBackupSchedule, setCategoryEnabled, syncAll, syncStatus, workflowShare } from "../v1/sync";
import { draftVersion, listVersions, promoteVersion, restoreVersion, versionDocument } from "../v1/versions";
import { migrate, type HealMode, type ReplayArgs, type WorkflowStep, type WorkflowV2 } from "../v1/schema";
import { applyImportAnswers, importQuestions } from "../../../web/src/lib/import-sheet";
import { decideOpen, parseBaoLink, type OpenedView } from "./deeplink";
import type { Settings } from "../v1/store";

export interface Notice extends HealNotice {
  id: string;
  at: number;
}

export interface App {
  library: Library;
  port: number;
  /** Set when the native host is installed. Replay and tests drive the extension through it. */
  extensionLink?: ExtensionLink;
  notices: Notice[];
  notifications: { title: string; body: string; tooltip: string }[];
  recording: boolean;
  close(): Promise<void>;
}

interface PendingCapture {
  workflow: WorkflowV2;
  events: TrailEvent[];
  shots: Map<string, string>;
  guides: Map<string, string>;
  poster: string;
  floor: string;
  secrets: string[];
  /** Written on commit so a discard does not leave an orphan gesture file. */
  gestures?: Gesture[];
}

/** The checkout this server runs from: the cwd, or the repo above desktop/dist, so `serve` works from any directory. */
const sourceRoot =
  [process.cwd(), path.resolve(__dirname, "../../../../..")].find((dir) => existsSync(path.join(dir, "desktop/src/app/public"))) ||
  process.cwd();
const publicDir = process.env.BAO_PUBLIC || path.join(sourceRoot, "desktop/src/app/public");

/** Move each source step's outlined crop onto the merged step id. A 96×54 stripe is not a crop. */
function copyMergedShots(
  root: string,
  workflowId: string,
  sources: readonly { stepId: string; workflowId: string; sourceStepId: string }[],
): void {
  const destDir = path.join(root, "shots", "workflows", workflowId);
  mkdirSync(destDir, { recursive: true });
  for (const source of sources) {
    const from = path.join(root, "shots", "workflows", source.workflowId, workflowShotName(source.sourceStepId));
    if (!existsSync(from)) continue;
    const png = readFileSync(from);
    if (png.length >= 24 && png.toString("ascii", 12, 16) === "IHDR") {
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      if (width === 96 && height === 54) continue;
    }
    copyFileSync(from, path.join(destDir, workflowShotName(source.stepId)));
    const guideFrom = path.join(root, "shots", "workflows", source.workflowId, guideShotName(source.sourceStepId));
    if (existsSync(guideFrom)) copyFileSync(guideFrom, path.join(destDir, guideShotName(source.stepId)));
  }
}

export async function startApp(opts: {
  home: string;
  port?: number;
  chromeUserData?: string;
  baoProfile?: string;
  loginKeys?: KeySources | (() => KeySources | Promise<KeySources>);
  /** Preview copy only. Cookie decryption follows loginKeys.platform. */
  loginPlatform?: NodeJS.Platform;
  /** Install the native host and accept a connection from the Chrome extension. */
  extensionHost?: boolean;
  /** Chrome config home for the host manifest. The socket still lives under home. */
  extensionConfigHome?: string;
  extensionHostDirs?: string[];
  /** Resolver notices for this launch. Each shows in the window once per library. */
  libraryNotices?: string[];
  /** The Chrome a live session drives when the agent names none: daily (default), daily:<profile>, bao, or throwaway:<DevToolsActivePort>. */
  liveTarget?: string;
  /** Live session lock. Default /tmp/bao-cdp-session.lock, shared by every Bao on this machine. */
  liveLockFile?: string;
  /** Idle save and its warning lead, for a test. Default LIVE_IDLE_MS and LIVE_IDLE_WARN_MS. */
  liveIdleMs?: number;
  liveIdleWarnMs?: number;
}): Promise<App> {
  opts = { ...opts, home: path.resolve(opts.home) };
  process.env.BAO_HOME = opts.home;
  await readCursorAccount().catch(() => undefined);
  const library = new Library(opts.home);
  const librarySplits = showOnce(opts.home, opts.libraryNotices || []);
  const sites = new SiteStore(path.join(opts.home, "login-sites.json"));
  const chromeUserData = opts.chromeUserData ?? defaultChromeUserData();
  const baoProfile = opts.baoProfile ?? path.join(opts.home, "chrome-profile");
  let liveIdle: LiveIdleWarning | null = null;
  const live = createLiveHost({
    home: library.root,
    target: parseLiveTarget(opts.liveTarget, baoProfile),
    lockFile: opts.liveLockFile,
    idleMs: opts.liveIdleMs,
    idleWarnMs: opts.liveIdleWarnMs,
    onIdleWarn: (warning) => {
      liveIdle = warning;
      if (warning) raiseLiveIdle(warning);
      else if (!activeAsk && !loginWait && !humanConfirm) void clearOsNotify();
    },
  });
  let signIn: { close(): Promise<void> } | undefined;
  const notices: Notice[] = [];
  let boundPort = opts.port ?? 0;
  const capture = new Capture();
  let captureVia: "playwright" | "extension" = "playwright";
  const gestureById = new Map<string, Gesture>();
  const extensionOn = opts.extensionHost === true || process.env.BAO_EXTENSION_HOST === "1";
  const extensionLink: ExtensionLink | undefined = extensionOn
    ? await startExtensionLink({
      home: opts.home,
      configHome: opts.extensionConfigHome || defaultConfigHome(),
      hostScript: hostScriptPath(),
      extraDirs: opts.extensionHostDirs,
    })
    : undefined;
  const bar = new CaptureBar();
  watchOsNotify((report) => {
    if (!bar.running) return;
    if (report.authorization === "denied") bar.send({ cmd: "notify-off" });
    else if (report.authorization === "authorized" || report.authorization === "provisional") bar.send({ cmd: "notify-clear" });
  });
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let nextDialogAnswer: string | undefined;
  let profile: string | undefined;
  let fileChooser: unknown;
  const captureShots = new Map<string, string>();
  const captureGuideShots = new Map<string, string>();
  const pendingShots = new Set<Promise<unknown>>();
  const replays = new Map<string, { context: BrowserContext; page: Page; profile: string }>();
  let pending: PendingImport | undefined;
  let importing = false;
  let loginWait: { message: string; detail?: string } | null = null;
  let humanConfirm: { message: string; detail?: string } | null = null;
  let activeAsk: HumanAsk | null = null;
  let stopRun = false;
  let loginContinued = false;
  let replaying = false;
  let recordingSince = 0;
  /** URL passed to beginSession. page.url() at stop is a later navigation. */
  let captureOpenUrl = "";
  let capturePosterPath = "";
  let capturePageTitle = "";
  let posterTried = false;
  let pendingSave: PendingCapture | null = null;
  let sessionMode: "capture" | "teach" = "capture";
  let teachPhase: "idle" | "live" | "review" = "idle";
  let teachDecisions: TeachDecision[] = [];
  let teachCaseId = "";
  let teachFix: { workflowId: string; stepId: string } | null = null;
  let teachStartUrl = "";
  let teachName = "";
  let blurredShots = 0;
  let teachBaseline: string[] = [];
  let narrateGen = 0;
  const narrationCache = new Map<string, Spoken & { sig: string }>();
  const cardSeen = new Map<string, { at: number; shownAt: number }>();
  let guideLive: (GuideProgress & { workflowId: string; runId: string }) | null = null;
  const notifications: { title: string; body: string; tooltip: string }[] = [];
  let opened: OpenedView | null = null;
  let extractProposal: PageProposal | undefined;
  let pendingDoc: WorkflowV2 | null = null;
  let site: { context: BrowserContext; page: Page; profile: string } | undefined;
  let watch: { context: BrowserContext; page: Page; profile: string } | undefined;
  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }
  function publishCapture(): void {
    if (!bar.running) return;
    if (!capture.recording) {
      bar.send({ cmd: "hide" });
      return;
    }
    bar.send({ cmd: "show", paused: capture.paused, steps: capture.steps.map(captureStepLabel) });
  }
  function raiseAct(ask: HumanAsk): void {
    const text = actSurfaceText(ask);
    const notice = actNotice(text);
    notifications.push({ title: notice.title, body: notice.body, tooltip: notice.tooltip });
    if (bar.running) {
      bar.send({
        cmd: "act",
        title: actAskLine(ask),
        detail: actDeadlineLine(ask.deadline),
        badge: notice.badge,
        tooltip: notice.tooltip,
      });
    }
    void notifyOs(notice.title, notice.body, notice.tooltip);
  }
  function clearAct(): void {
    if (bar.running && !activeAsk && !loginWait && !humanConfirm) bar.send({ cmd: "clear-badge" });
    if (!liveIdle) void clearOsNotify();
  }
  /** The idle warning posts through the same notification and Dock badge as an act. Keep open is in the Bao window. */
  function raiseLiveIdle(warning: LiveIdleWarning): void {
    const notice = actNotice(liveIdleSurfaceText(warning));
    notifications.push({ title: notice.title, body: notice.body, tooltip: notice.tooltip });
    void notifyOs(notice.title, notice.body, notice.tooltip);
  }
  const prompts: PersonPrompts = {
    showConfirm(_label) {
      humanConfirm = { message: "confirm before applying", detail: "Press Apply on the site window." };
    },
    clearConfirm() {
      humanConfirm = null;
      if (activeAsk?.kind === "confirm") {
        activeAsk = null;
        clearPendingPrompt(library.root);
      }
      clearAct();
    },
    showLoginWait(label) {
      const detail = label && label.length <= 120 ? label : "Sign in on the site window";
      loginWait = { message: "waiting for you to log in", detail };
    },
    clearLoginWait() {
      loginWait = null;
      loginContinued = false;
      if (activeAsk?.kind === "login" || activeAsk?.kind === "wall") {
        activeAsk = null;
        clearPendingPrompt(library.root);
      }
      clearAct();
    },
    showAsk(ask) {
      activeAsk = ask;
      rememberPending(ask);
      raiseAct(ask);
    },
    shouldStop: () => stopRun,
    loginContinued: () => loginContinued,
    pauseCapture() {
      capture.pause();
      capture.handoff(`Handoff started ${formatClock(Date.now())}`);
    },
    resumeCapture() {
      capture.handoff(`Handoff ended ${formatClock(Date.now())}`);
      capture.resume();
    },
  };
  const remote = createRemoteAgent({
    library,
    prompts,
    stop: () => { stopRun = true; },
    clearStop: () => { stopRun = false; },
    runners: {
      extension: async (id, inputs) => {
        if (!extensionLink?.connected()) return { outcome: "failed", workflowId: id, reason: EXTENSION_NOT_CONNECTED };
        const workflow = library.read(id);
        const result = await runExtension(library, workflow, inputs, notices, prompts, extensionLink) as {
          status?: string;
          runId?: string;
          outputs?: unknown;
          failure?: { reason?: string };
          reason?: string;
        };
        const status = result.status || "failed";
        const outcome = status === "passed" ? "ok" : status === "paused" ? "needs_human" : "failed";
        return {
          outcome,
          status,
          workflowId: id,
          runId: result.runId,
          outputs: result.outputs,
          reason: result.failure?.reason || result.reason,
        };
      },
      live: (workflow, inputs) => live.replay(workflow, inputs),
    },
  });
  const sessions = new Map<string, FreezeSession>();
  const pendings = new Map<string, { user: string; exp: number }>();
  let applyClicks = 0;
  let helperReport: unknown;
  if (process.platform === "darwin" && bundledHelperApp()) {
    helperReport = await new MacOsHelper(bundledHelperApp()!).permissions(false).catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  function localWorkflow(link: string): WorkflowV2 | null {
    const parsed = parseBaoLink(link);
    if (!parsed) return null;
    try {
      return library.read(parsed.id);
    } catch {
      return null;
    }
  }

  async function readExtensionHostAccess(): Promise<"all" | "site" | "none"> {
    if (extensionLink?.connected()) {
      try {
        const value = await extensionLink.command("host-access", {}, 4_000) as { access?: string };
        const hostAccess = hostAccessMode(value.access);
        if (library.settings().hostAccess !== hostAccess) library.updateSettings({ hostAccess });
        return hostAccess;
      } catch {
        /* the stored line is what Settings can show while the extension is busy */
      }
    }
    return hostAccessMode(library.settings().hostAccess);
  }

  /** A request a page on another origin sent. A local client sends no Origin, or this app's own. */
  function foreignOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return typeof origin === "string" && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return sendFile(res, path.join(publicDir, "index.html"), "text/html");
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        const js = await browserScript();
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(js);
        return;
      }
      if (req.method === "GET" && (url.pathname === "/fixture" || url.pathname === "/secure")) {
        return sendFile(res, path.join(publicDir, "fixture.html"), "text/html");
      }
      if (req.method === "GET" && url.pathname === "/fixture/calendar") {
        return sendFile(res, path.join(publicDir, "calendar.html"), "text/html");
      }
      if (req.method === "GET" && url.pathname === "/login") {
        const verify = url.searchParams.get("verify") === "1";
        const html = loginDocument(readFileSync(path.join(publicDir, "login.html"), "utf8"), verify);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && url.pathname === "/login") {
        return answerLogin(req, res);
      }
      if (req.method === "POST" && url.pathname === "/freeze/applied") {
        applyClicks += 1;
        return json(res, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/fixture/apply-count") {
        return json(res, { count: applyClicks });
      }
      if (req.method === "GET" && url.pathname === "/freeze") {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        const status = sessionStatus(token, sessions, Date.now());
        if (status !== "ok") {
          const next = `${url.pathname}${url.search}`;
          const dest = loginRedirect(next, url.searchParams.get("verify") === "1");
          res.writeHead(302, { location: dest, "cache-control": "no-store" });
          res.end();
          return;
        }
        return sendFile(res, path.join(publicDir, "freeze.html"), "text/html");
      }
      if (req.method === "POST" && url.pathname === "/api/live") {
        if (foreignOrigin(req)) return json(res, { error: "local clients only" }, 403);
        const body = await readBody(req);
        return json(res, await live.call(body));
      }
      if (req.method === "POST" && url.pathname === "/api/live/keep") {
        if (foreignOrigin(req)) return json(res, { error: "local clients only" }, 403);
        return json(res, { open: await live.keepOpen() });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/live-session/shots/")) {
        const name = path.basename(decodeURIComponent(url.pathname.split("/")[4] || ""));
        if (!shotNameOk(name)) return json(res, { error: "no picture" }, 404);
        return sendPng(res, path.join(library.root, "live-session", "shots", name));
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        runScheduledBackup(library);
        syncPending();
        return json(res, {
          recording: capture.recording,
          capture: {
            recording: capture.recording,
            paused: capture.paused,
            steps: capture.steps.map(captureStepLabel),
          },
          notices,
          home: opts.home,
          librarySplits,
          settings: library.settings(),
          workflows: library.list().map(summary),
          trails: library.listTrails(),
          runs: library.listRuns().map(slimRun),
          helper: helperStatus(helperReport),
          helperApp: bundledHelperApp() || null,
          model: modelStatus(),
          pendingImport: pending ? publicPending(pending) : null,
          loginWait,
          humanConfirm,
          activeAsk,
          capturePaused: capture.paused,
          recordingSince: capture.recording ? recordingSince : 0,
          liveTrail: capture.events.slice(-40).map((event) => ({ id: event.id, ts: event.ts, op: event.op, kind: event.kind })),
          teach: teachState(),
          guide: guideLive,
          extractPicker: extractProposal && !extractProposal.error ? extractPickerHtml(extractProposal) : "",
          notifications,
          promotions: library.list().map((workflow) => library.readPromotion(workflow.id)).filter(Boolean),
          sync: syncStatus(library),
          opened,
          saveSheet: saveSheetState(),
          remote: remote.view(),
          relay: relayStatus(library.root),
          liveSession: readLiveSessionFile(library.root),
          liveIdle,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/open") {
        const body = await readBody(req) as { link?: string; document?: unknown };
        const parsed = decideOpen(String(body.link || ""), localWorkflow(String(body.link || "")), body.document);
        if ("error" in parsed) return json(res, { ok: false, error: parsed.error }, 404);
        opened = parsed.opened;
        pendingDoc = parsed.pending;
        return json(res, { ok: true, opened });
      }
      if (req.method === "POST" && url.pathname === "/api/open/install") {
        if (!pendingDoc) return json(res, { ok: false, error: "nothing to import" }, 400);
        const body = await readBody(req) as { answers?: Record<string, unknown> };
        try {
          const installed = migrate(applyImportAnswers(pendingDoc, body.answers || {}));
          library.save(installed);
          pendingDoc = null;
          opened = {
            kind: "workflow",
            id: installed.id,
            name: installed.name,
            link: `bao://workflow/${installed.id}`,
            importLink: `bao://import/${installed.id}`,
            questions: importQuestions(installed),
            saved: true,
          };
          return json(res, { ok: true, id: installed.id, opened });
        } catch (err) {
          return json(res, { ok: false, error: err instanceof Error ? err.message : "answer the import questions" }, 400);
        }
      }
      if (req.method === "GET" && url.pathname === "/api/import-login") {
        if (!pending || pending.id !== url.searchParams.get("id")) return json(res, { error: "no import" }, 404);
        return json(res, publicPending(pending));
      }
      if (req.method === "POST" && url.pathname === "/api/import-login") {
        const body = await readBody(req) as { from?: string; domain?: string; profile?: string };
        if (body.from !== "chrome") return json(res, { error: "only chrome is supported" }, 400);
        let domain = "";
        try { domain = assertDomain(body.domain || ""); }
        catch (err) { return json(res, { error: safeImportError(err) }, 400); }
        if (pending && (pending.phase === "confirm" || pending.phase === "pick" || pending.phase === "running")) {
          return json(res, publicPending(pending));
        }
        pending = {
          id: `imp-${Date.now()}`,
          domain,
          profile: body.profile,
          phase: "confirm",
          message: importConfirmText(domain),
        };
        return json(res, publicPending(pending));
      }
      if (req.method === "POST" && url.pathname === "/api/import-login/answer") {
        const body = await readBody(req) as { id?: string; accept?: boolean; profile?: string };
        if (!pending || body.id !== pending.id) return json(res, { error: "no import" }, 404);
        if (body.accept === false) {
          pending.phase = "cancelled";
          return json(res, publicPending(pending));
        }
        if (pending.phase !== "confirm" && pending.phase !== "pick") return json(res, publicPending(pending));
        if (pending.phase === "pick" && !body.profile) return json(res, { error: "pick a profile" }, 400);
        if (body.profile) pending.profile = body.profile;
        void settleImport();
        return json(res, publicPending(pending));
      }
      if (req.method === "POST" && url.pathname === "/api/prompt") {
        const body = await readBody(req) as { kind?: string; detail?: string };
        if (body.kind === "login") {
          const detail = typeof body.detail === "string" ? body.detail.replace(/\s+/g, " ").trim() : "";
          if (detail && (detail.length > 120 || looksPersonal(detail))) return json(res, { error: "detail" }, 400);
          loginWait = { message: "waiting for you to log in", ...(detail ? { detail } : {}) };
        }
        else if (body.kind === "confirm") {
          humanConfirm = { message: "confirm before applying", detail: body.detail || "Press Apply on the site window." };
        }
        else { loginWait = null; humanConfirm = null; }
        return json(res, { loginWait, humanConfirm });
      }
      if (req.method === "GET" && url.pathname === "/api/site") {
        if (!site || site.page.isClosed()) return json(res, { open: false });
        return json(res, { open: true, ...(await siteSignals(site.page)) });
      }
      if (req.method === "POST" && url.pathname === "/api/site/open") {
        const body = await readBody(req) as { url?: string };
        const page = await sitePage();
        if (body.url) await page.goto(body.url, { waitUntil: "domcontentloaded" });
        await moveOwnedWindow(page, { x: 80, y: 60, width: 1100, height: 780 }).catch(() => undefined);
        return json(res, { open: true, ...(await siteSignals(page)) });
      }
      if (req.method === "POST" && url.pathname === "/api/site/query") {
        const body = await readBody(req) as { names?: string[] };
        const names = (body.names || []).filter((name) => typeof name === "string" && name.trim() && name.length <= 40).slice(0, 8);
        const page = await sitePage();
        const controls = await namedControls(page, names);
        return json(res, { controls });
      }
      if (req.method === "POST" && url.pathname === "/api/site/click") {
        const body = await readBody(req) as { name?: string };
        const name = (body.name || "").trim();
        if (!["open", "frozen"].includes(name.toLowerCase())) return json(res, { error: "that control is not a selectable state" }, 400);
        const page = await sitePage();
        try {
          await page.getByText(name, { exact: true }).first().click();
        } catch {
          return json(res, { error: "could not select that state" }, 409);
        }
        return json(res, { selected: name });
      }
      if (req.method === "POST" && url.pathname === "/api/site/text") {
        const body = await readBody(req) as { phrases?: string[] };
        const phrases = (body.phrases || []).filter((phrase) => typeof phrase === "string" && phrase.length <= 40).slice(0, 6);
        const page = await sitePage();
        const texts = (await shortTexts(page, phrases)).filter((text) => !looksPersonal(text));
        return json(res, { texts });
      }
      if (req.method === "POST" && url.pathname === "/api/site/shot") {
        const body = await readBody(req) as { phrase?: string; file?: string };
        const phrase = (body.phrase || "").trim();
        if (!phrase || phrase.length > 80 || looksPersonal(phrase)) return json(res, { error: "phrase" }, 400);
        const base = path.basename(body.file || "status-card.png");
        if (!/^[\w.-]+$/.test(base)) return json(res, { error: "file" }, 400);
        const page = await sitePage();
        const box = await clipForPhrase(page, phrase);
        if (!box) return json(res, { error: "status card was not found" }, 404);
        const shots = path.join(opts.home, "shots");
        mkdirSync(shots, { recursive: true });
        const dest = path.join(shots, base);
        await shotWithBlur(page, { path: dest, clip: box });
        return json(res, { file: base });
      }
      if (req.method === "GET" && url.pathname === "/api/pids") {
        const product = pidsForDataDir(path.join(opts.home, "ui-profile"))[0] ?? null;
        const capture = profile ? pidsForDataDir(profile)[0] ?? null : null;
        const replay: Record<string, number> = {};
        for (const [id, session] of replays) {
          const pid = pidsForDataDir(session.profile)[0];
          if (pid) replay[id] = pid;
        }
        return json(res, { helper: bundledHelperApp() || null, helperReport, product, capture, replay });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/workflows/") && url.pathname.includes("/shots/")) {
        const parts = url.pathname.split("/");
        const id = decodeURIComponent(parts[3] || "");
        const file = path.basename(decodeURIComponent(parts[5] || ""));
        return sendPng(res, path.join(library.root, "shots", "workflows", id, file));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/poster")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const file = workflowPoster(path.join(library.root, "shots", "workflows", id));
        if (!file) return json(res, { error: "no picture" }, 404);
        return sendPng(res, file);
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/share")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        return json(res, await workflowShare(library, id));
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/publish")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        try {
          const result = await publishWorkflow(library, id);
          return json(res, result, result.ok ? 200 : 409);
        } catch (err) {
          const why = err instanceof Error ? err.message : "The clean replay did not pass.";
          return json(res, { ok: false, why }, 409);
        }
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/inputs")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        return json(res, library.readPublicInputs(id));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/versions")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        return json(res, { versions: listVersions(library, id) });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/versions")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const body = await readBody(req) as { action?: string; n?: number };
        const n = Number(body.n);
        if (!Number.isInteger(n) || n < 1) return json(res, { error: "version" }, 400);
        if (body.action === "promote") return json(res, promoteVersion(library, id, n));
        if (body.action === "restore") return json(res, restoreVersion(library, id, n));
        return json(res, { error: "action" }, 400);
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/guide")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        try {
          const doc = library.read(id);
          const html = guideHtml(doc, guideCrops(library.root, doc));
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(html);
          return;
        } catch {
          return json(res, { error: "not found" }, 404);
        }
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/workflows/")) {
        return json(res, library.read(decodeURIComponent(url.pathname.split("/")[3] || "")));
      }
      if (req.method === "GET" && url.pathname === "/api/capture/poster") {
        const file = pendingSave?.poster;
        if (!file || !existsSync(file) || !isFullPageShot(readFileSync(file))) return json(res, { error: "no picture" }, 404);
        return sendPng(res, file);
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/capture/shots/")) {
        const file = path.basename(decodeURIComponent(url.pathname.split("/")[4] || ""));
        return sendPng(res, path.join(library.root, "shots", "capture", file));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/runs/") && (url.pathname.endsWith("/outputs.csv") || url.pathname.endsWith("/outputs.json"))) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const run = library.readRun(id);
        if (url.pathname.endsWith("/outputs.csv")) {
          const csv = outputCsv(run.outputs, url.searchParams.get("name") || undefined);
          if (!csv) return json(res, { error: "no output" }, 404);
          res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=\"output.csv\"" });
          res.end(csv);
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": "attachment; filename=\"outputs.json\"" });
        res.end(JSON.stringify(run.outputs ?? [], null, 2));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/video")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const run = library.readRun(id);
        const file = path.join(library.root, "videos", `${run.id}.webm`);
        if (!existsSync(file)) return json(res, { error: "no video" }, 404);
        return sendVideo(req, res, file);
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/runs/") && url.pathname.includes("/shots/")) {
        const parts = url.pathname.split("/");
        const id = decodeURIComponent(parts[3] || "");
        const file = path.basename(decodeURIComponent(parts[5] || ""));
        return sendPng(res, path.join(library.root, "shots", "runs", id, file));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/poster")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const frame = path.join(library.root, "videos", `${id}.png`);
        const file = existsSync(frame) ? frame : newestPng(path.join(library.root, "shots", "runs", id));
        if (!file) return json(res, { error: "no picture" }, 404);
        return sendPng(res, file);
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
        return json(res, library.readRun(decodeURIComponent(url.pathname.split("/")[3] || "")));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/trails/")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const raw = library.readTrail(id);
        const events = Array.isArray(raw) ? raw as { ts?: number }[] : [];
        const timed = ensureTrailTimes(events);
        if (timed.filled) library.saveTrail(id, timed.events);
        return json(res, timed.events);
      }
      if (req.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readBody(req) as { heal?: HealMode; promoteAfter?: number; actTimeoutMin?: number; circuitLimit?: number; syncServer?: string; remoteMcp?: boolean; remotePermission?: string; siteTrust?: unknown };
        const patch: Partial<Settings> = {};
        if (body.heal === "auto" || body.heal === "approve") patch.heal = body.heal;
        if (typeof body.promoteAfter === "number" && body.promoteAfter >= 1 && body.promoteAfter <= 20) {
          patch.promoteAfter = Math.round(body.promoteAfter);
        }
        if (typeof body.actTimeoutMin === "number" && body.actTimeoutMin >= 1 && body.actTimeoutMin <= 24 * 60) {
          patch.actTimeoutMs = Math.round(body.actTimeoutMin) * 60 * 1000;
        }
        if (typeof body.circuitLimit === "number" && body.circuitLimit >= 1 && body.circuitLimit <= 50) {
          patch.circuitLimit = Math.round(body.circuitLimit);
        }
        if (typeof body.syncServer === "string") patch.syncServer = body.syncServer;
        if (typeof body.remoteMcp === "boolean") patch.remoteMcp = body.remoteMcp;
        if (body.remotePermission === "ask" || body.remotePermission === "deny") patch.remotePermission = body.remotePermission;
        if ("siteTrust" in body) {
          const siteTrust = cleanSiteTrust(body.siteTrust);
          if (siteTrust) patch.siteTrust = siteTrust;
        }
        if (!Object.keys(patch).length) return json(res, { error: "settings" }, 400);
        return json(res, library.updateSettings(patch));
      }
      if (req.method === "GET" && url.pathname === "/api/extension/host-access") {
        return json(res, { hostAccess: await readExtensionHostAccess() });
      }
      if (req.method === "POST" && url.pathname === "/api/extension/host-access/revoke") {
        if (!extensionLink?.connected()) return json(res, { error: "extension is not connected" }, 409);
        const value = await extensionLink.command("revoke-hosts", {}, 10_000) as { access?: string };
        const hostAccess = hostAccessMode(value.access);
        library.updateSettings({ hostAccess });
        return json(res, { hostAccess });
      }
      if (req.method === "POST" && url.pathname === "/api/sync/pair") {
        const body = await readBody(req) as { code?: string; server?: string; name?: string; secret?: string };
        if (!body.code || !body.server) return json(res, { error: "code and server" }, 400);
        return json(res, await pairDevice(library, { code: body.code, server: body.server, name: body.name, secret: body.secret }));
      }
      if (req.method === "POST" && url.pathname === "/api/sync") {
        const body = await readBody(req) as { mode?: "sync" | "push" | "pull" };
        const mode = body.mode === "push" || body.mode === "pull" ? body.mode : "sync";
        return json(res, await syncAll(library, mode));
      }
      if (req.method === "POST" && url.pathname === "/api/sync/category") {
        const body = await readBody(req) as { category?: string; enabled?: boolean };
        return json(res, setCategoryEnabled(library, String(body.category || ""), Boolean(body.enabled)));
      }
      if (req.method === "POST" && url.pathname === "/api/sync/backup") {
        const body = await readBody(req) as { schedule?: string; action?: string };
        if (body.action === "restore") return json(res, restoreScheduledBackup(library));
        return json(res, setBackupSchedule(library, String(body.schedule || "off")));
      }
      if (req.method === "POST" && url.pathname === "/api/sync/reveal") {
        const target = revealBackup(library);
        const command = process.platform === "darwin" ? "open" : "xdg-open";
        const args = process.platform === "darwin" ? ["-R", target] : [target];
        const child = spawn(command, args, { stdio: "ignore", detached: true });
        child.on("error", () => undefined);
        child.unref();
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/sync/conflict") {
        const body = await readBody(req) as { id?: string; action?: string };
        if (!body.id) return json(res, { error: "id" }, 400);
        if (body.action === "open") return json(res, openConflict(library, body.id));
        if (body.action === "keep" || body.action === "keep-mine") return json(res, await keepMine(library, body.id));
        if (body.action === "keep-theirs" || body.action === "keep-both") return json(res, await resolveConflict(library, body.id, body.action));
        return json(res, { error: "action" }, 400);
      }
      if (req.method === "POST" && url.pathname === "/api/workflows/import") {
        return json(res, library.importJson(String(await readBody(req, true))));
      }
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        const body = await readBody(req) as { url?: string; teach?: boolean; fix?: { workflowId?: string; stepId?: string } };
        if (body.teach) {
          let nextFix: { workflowId: string; stepId: string } | null = null;
          let nextUrl = body.url || "";
          if (body.fix?.workflowId && body.fix.stepId) {
            const saved = library.read(body.fix.workflowId);
            if (!saved.steps.some((step) => step.id === body.fix?.stepId)) return json(res, { error: "missing step" }, 404);
            nextFix = { workflowId: body.fix.workflowId, stepId: body.fix.stepId };
            if (!nextUrl) nextUrl = saved.startUrl;
          }
          await enqueue(() => beginTeach(nextUrl, nextFix));
          return json(res, { recording: capture.recording, teach: true });
        }
        await enqueue(() => beginSession(body.url || ""));
        return json(res, { recording: capture.recording, paused: capture.paused });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/resume") {
        await enqueue(async () => {
          if (capture.recording) capture.resume();
          publishCapture();
        });
        return json(res, { recording: capture.recording, paused: capture.paused });
      }
      if (req.method === "POST" && (url.pathname === "/api/sessions/note" || url.pathname === "/api/sessions/check")) {
        const body = await readBody(req) as { text?: string };
        const text = typeof body.text === "string" ? body.text : "";
        try {
          const step = await enqueue(async () => {
            const saved = url.pathname.endsWith("/check") ? capture.check(text) : capture.note(text);
            if (sessionMode === "teach") stampTeachSeen();
            publishCapture();
            return saved;
          });
          return json(res, { id: step.id, label: step.label });
        } catch (err) {
          const message = err instanceof Error ? err.message : "";
          if (message === "not recording") return json(res, { error: "not recording" }, 409);
          if (message === "note") return json(res, { error: "note" }, 400);
          throw err;
        }
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/discard") {
        await enqueue(() => discardSession());
        return json(res, { recording: false });
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "GET" && url.pathname === "/api/sessions/page") {
        if (!page || page.isClosed()) return json(res, { open: false }, 404);
        return json(res, { open: true, ...(await drivePageView(page)) });
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "POST" && url.pathname === "/api/sessions/drive") {
        if (!page) return json(res, { error: "no session" }, 409);
        const body = await readBody(req) as {
          fill?: { selector: string; value: string; keys?: boolean };
          click?: string;
          upload?: { selector: string; path: string };
          drop?: { selector: string; name: string; path: string };
          chooser?: { selector: string; path: string };
          box?: string;
          scroll?: string;
          select?: { selector: string; value?: string; label?: string };
          press?: string;
          goto?: string;
          drag?: { from?: string; to?: string };
          prompt?: string;
          timeout?: number;
        };
        const timeout = typeof body.timeout === "number" && body.timeout > 0 ? body.timeout : undefined;
        await page.evaluate(dismissCoveringAds).catch(() => undefined);
        if (typeof body.scroll === "string" && /^#[A-Za-z][\w-]*$/.test(body.scroll)) {
          await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (el instanceof Element) el.scrollIntoView({ block: "start", inline: "nearest" });
          }, body.scroll);
          return json(res, { events: capture.events.length });
        }
        if (typeof body.box === "string" && /^#[A-Za-z][\w-]*$/.test(body.box)) {
          const box = await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!(el instanceof Element)) return null;
            const rect = el.getBoundingClientRect();
            const outerH = window.outerHeight;
            const innerH = window.innerHeight;
            const viewH = window.visualViewport && window.visualViewport.height ? window.visualViewport.height : innerH;
            // innerHeight on this Chrome build stays larger than the window, so
            // outer-inner is negative and the point lands above the element.
            // The visible viewport, then a measured title-bar inset, keep the
            // point on the element.
            let chrome = outerH - viewH;
            if (!(chrome > 20 && chrome < 160)) chrome = outerH - innerH;
            if (!(chrome > 20 && chrome < 160)) chrome = 87;
            return {
              x: window.screenX + rect.left + rect.width / 2,
              y: window.screenY + chrome + rect.top + rect.height / 2,
              w: rect.width,
              h: rect.height,
              top: rect.top,
              chrome,
            };
          }, body.box);
          return json(res, { box, events: capture.events.length });
        }
        if (body.goto) {
          const beforeUrl = page.url();
          await page.goto(body.goto, { waitUntil: "domcontentloaded", timeout: timeout ?? 30000 });
          // page.goto does not go through the in-page recorder. A capture that
          // jumps to the next page otherwise replays the following click on the
          // page it just left.
          if (capture.recording) capture.push({ kind: "act", op: "navigate", beforeUrl, afterUrl: page.url() });
        }
        if (body.drag?.from && body.drag.to) {
          const from = page.locator(body.drag.from).first();
          const to = page.locator(body.drag.to).first();
          await from.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" })).catch(() => undefined);
          const startBox = await from.boundingBox();
          const endBox = await to.boundingBox();
          if (!startBox || !endBox) throw new Error("drag target is not visible");
          await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2);
          await page.mouse.down();
          await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2, { steps: 18 });
          await page.mouse.up();
        }
        if (body.fill) {
          const loc = page.locator(body.fill.selector).first();
          if (body.fill.keys) {
            await loc.evaluate((el) => {
              if (!(el instanceof Element)) return;
              const rect = el.getBoundingClientRect();
              const inView = rect.width > 1 && rect.height > 1
                && rect.top >= 0 && rect.left >= 0
                && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
              if (!inView) el.scrollIntoView({ block: "center", inline: "nearest" });
            }).catch(() => undefined);
            // Clicking the combobox again closes the menu the previous click opened.
            await loc.focus(timeout ? { timeout } : undefined);
            await loc.press("Control+a").catch(() => undefined);
            await loc.press("Backspace").catch(() => undefined);
            await loc.pressSequentially(body.fill.value, { delay: 15 });
          } else {
            await loc.fill(body.fill.value, timeout ? { timeout } : undefined);
          }
        }
        if (typeof body.prompt === "string") nextDialogAnswer = body.prompt;
        if (body.click) {
          await page.evaluate(dismissCoveringAds).catch(() => undefined);
          await clickInDrive(page, body.click, timeout);
        }
        if (body.press) await page.keyboard.press(body.press);
        if (body.select?.selector) {
          const choice = body.select.label ? { label: body.select.label } : body.select.value ?? "";
          await page.selectOption(body.select.selector, choice, timeout ? { timeout } : undefined);
        }
        if (body.chooser?.selector && body.chooser.path) {
          const landed = queueChooserFile(body.chooser.path);
          await page.click(body.chooser.selector);
          await landed;
        }
        if (body.upload) await page.setInputFiles(body.upload.selector, body.upload.path);
        if (body.drop) {
          const b64 = readFileSync(body.drop.path).toString("base64");
          await page.evaluate(({ selector, name, b64 }) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error("missing drop target");
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], name));
            for (const type of ["dragenter", "dragover", "drop"]) {
              el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
            }
          }, { selector: body.drop.selector, name: body.drop.name, b64 });
        }
        await page.waitForTimeout(50);
        await settleShots();
        return json(res, { events: capture.events.length });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/extract/arm") {
        if (!page || page.isClosed()) return json(res, { error: "no session" }, 409);
        await page.evaluate(installDataPage);
        await page.evaluate(() => {
          const host = window as unknown as { __baoArm?: () => void };
          host.__baoArm?.();
        });
        return json(res, { armed: true });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/extract/propose") {
        if (!page || page.isClosed()) return json(res, { error: "no session" }, 409);
        const body = await readBody(req) as { selector?: string; x?: number; y?: number };
        await page.evaluate(installDataPage);
        const proposal = await page.evaluate((arg) => {
          const host = window as unknown as { __baoPropose?: (arg: { selector?: string; x?: number; y?: number }) => PageProposal };
          return host.__baoPropose ? host.__baoPropose(arg) : { error: "extract is not installed" };
        }, { selector: body.selector, x: body.x, y: body.y });
        extractProposal = proposal as PageProposal;
        return json(res, extractProposal);
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/extract/commit") {
        if (!capture.recording) return json(res, { error: "not recording" }, 409);
        if (!extractProposal || extractProposal.error) return json(res, { error: "no list" }, 409);
        const body = await readBody(req) as { names?: Record<string, string>; drop?: string[]; maxPages?: number; as?: string; vary?: string };
        const spec = specFromProposal(extractProposal, body);
        capture.push({ kind: "act", op: "extract", extract: spec, locators: spec.locators });
        if (body.vary && /^[A-Za-z][A-Za-z0-9_]*$/.test(body.vary)) {
          const click = [...capture.events].reverse().find((event) => event.op === "click");
          if (click) click.parameter = body.vary;
        }
        extractProposal = undefined;
        publishCapture();
        return json(res, { as: spec.as, columns: spec.columns.filter((column) => !column.dropped).map((column) => column.name) });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/table") {
        if (!capture.recording) return json(res, { error: "not recording" }, 409);
        const body = await readBody(req) as { csv?: string; as?: string };
        const rows = parseCsv(String(body.csv || ""));
        if (rows.length < 1) return json(res, { error: "csv" }, 400);
        capture.push({
          kind: "act",
          op: "copy",
          list: { rows, headers: Object.keys(rows[0] || {}), as: body.as || "rows" },
        });
        return json(res, { rows: rows.length });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/stop") {
        if (sessionMode === "teach") return json(res, await finishTeach());
        const workflow = await enqueue(() => saveSession());
        return json(res, workflow);
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/commit") {
        const body = await readBody(req) as { name?: string; summary?: string; intent?: string };
        try {
          const workflow = await enqueue(() => commitSave(body));
          return json(res, workflow);
        } catch (err) {
          const message = err instanceof Error ? err.message : "save failed";
          return json(res, { error: message }, message === "nothing to save" ? 409 : 400);
        }
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/save/discard") {
        await enqueue(() => discardPending());
        return json(res, { saved: false });
      }
      if (req.method === "POST" && url.pathname === "/api/replay") {
        const body = await readBody(req) as { id: string; args: ReplayArgs; heal?: HealMode; fromStep?: string; guide?: boolean; fresh?: boolean };
        const saved = library.read(body.id);
        const workflow: WorkflowV2 = body.heal ? { ...saved, heal: body.heal } : saved;
        if (refusesOwnedBrowser(workflow.driver)) {
          const liveArgs = liveReplayArgs(workflow, body.args || {});
          let run: RunResult;
          try {
            run = await live.replay(workflow, liveArgs);
          } catch (err) {
            const message = err instanceof Error ? err.message : "live replay failed";
            return json(res, { error: message, modelCalls: 0 }, 409);
          }
          library.saveRun(persistedRun(run, workflow, liveArgs, {
            promotion: undefined,
            recorded: { wrote: false },
            videoStartedAt: 0,
            secretList: [],
          }));
          library.savePublicInputs(workflow.id, keptInputs(workflow, liveArgs));
          return json(res, { ...run, id: run.runId });
        }
        const args = await materializeFiles(body.args || {});
        if (body.fresh) {
          const existing = replays.get(saved.id);
          if (existing) {
            await existing.context.close().catch(() => undefined);
            replays.delete(saved.id);
          }
        }
        stopRun = false;
        loginContinued = false;
        replaying = true;
        try {
          await releaseSharedProfile({ keepReplays: true });
          if (body.guide) {
            const run = await runGuide(library, workflow, args, replays, prompts);
            return json(res, run);
          }
          const fromStep = typeof body.fromStep === "string" && body.fromStep ? body.fromStep : undefined;
          if (workflowDriver(workflow) === "extension") {
            if (!extensionLink?.connected()) return json(res, { error: EXTENSION_NOT_CONNECTED }, 409);
            const run = await runRecorded(library, workflow, args, notices, replays, prompts, undefined, fromStep, extensionLink);
            library.savePublicInputs(workflow.id, keptInputs(workflow, args));
            return json(res, run);
          }
          const run = await runWorkflow(library, workflow, args, notices, replays, prompts, {
            baoProfile,
            sites,
            closeSignIn: async () => {
              await signIn?.close();
              signIn = undefined;
            },
          }, fromStep);
          library.savePublicInputs(workflow.id, keptInputs(workflow, args));
          return json(res, run);
        } finally {
          replaying = false;
        }
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "GET" && url.pathname === "/api/replay/page") {
        const session = replays.get(url.searchParams.get("id") || "");
        if (!session || session.page.isClosed()) return json(res, { open: false }, 404);
        const current = new URL(session.page.url());
        const hasPassword = await session.page.locator("input[type=password]:visible").count().then((count) => count > 0).catch(() => false);
        const status = await session.page.locator("#status").innerText().catch(() => "");
        const openPages = session.context.pages().filter((item) => !item.isClosed());
        const views = [];
        for (const item of openPages) views.push(await drivePageView(item));
        const view = views[0] || await drivePageView(session.page);
        const text = views.map((item) => item.text || "").filter(Boolean).join("\n");
        const title = views.map((item) => item.title || "").filter(Boolean).join("\n");
        return json(res, { open: true, pathname: current.pathname, hasPassword, status, ...view, title: title || view.title, text });
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "GET" && url.pathname === "/api/sessions/page") {
        if (!page || page.isClosed()) return json(res, { open: false }, 404);
        const view = await drivePageView(page);
        return json(res, { open: true, ...view });
      }
      if (req.method === "POST" && url.pathname === "/api/prompt/continue") {
        loginContinued = true;
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/remote/pair") {
        const body = await readBody(req) as { code?: string; server?: string };
        const code = String(body.code || "").trim();
        if (!code) return json(res, { error: "code" }, 400);
        const sync = loadState(library.root);
        const server = String(body.server || sync.server || "").replace(/\/$/, "");
        if (!server) return json(res, { error: "no registry" }, 400);
        if (!sync.deviceId) return json(res, { error: "pair the device first" }, 400);
        const claimed = await fetch(`${server}/api/agent/pair/claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code,
            name: sync.deviceName || "Mac",
            deviceId: sync.deviceId,
          }),
        });
        const payload = await claimed.json().catch(() => ({ error: "pair failed" })) as { token?: string; tokenId?: string; deviceId?: string; error?: string };
        if (!claimed.ok || !payload.token || !payload.deviceId) {
          return json(res, { error: payload.error || "pair failed" }, claimed.status || 400);
        }
        saveRelay(library.root, {
          server,
          token: payload.token,
          deviceId: payload.deviceId,
          tokenId: payload.tokenId,
        });
        return json(res, { paired: true, deviceId: payload.deviceId });
      }
      if (req.method === "POST" && url.pathname === "/api/remote/revoke") {
        const link = loadRelay(library.root);
        if (link) {
          await fetch(`${link.server}/api/agent/pair/revoke`, {
            method: "POST",
            headers: { authorization: `Bearer ${link.token}` },
          }).catch(() => undefined);
        }
        clearRelay(library.root);
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/remote/allow") {
        remote.allow();
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/remote/deny") {
        remote.deny();
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/remote/kill") {
        remote.kill();
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/remote/confirm") {
        return json(res, await remote.approveConfirm());
      }
      if (req.method === "POST" && url.pathname === "/api/replay/cancel") {
        stopRun = true;
        if (!replaying) {
          clearPendingPrompt(library.root);
          activeAsk = null;
          loginWait = null;
          humanConfirm = null;
          loginContinued = false;
          clearAct();
        }
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/replay/show") {
        const session = [...replays.values()].find((item) => !item.page.isClosed());
        if (session) await session.page.bringToFront().catch(() => undefined);
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/pause") {
        await enqueue(async () => {
          if (!capture.recording) return;
          if (capture.paused) capture.resume();
          else capture.pause();
          publishCapture();
        });
        return json(res, { paused: capture.paused, recording: capture.recording });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/mark") {
        if (capture.recording) capture.push({ kind: "act", op: "mark" });
        publishCapture();
        return json(res, { events: capture.events.length });
      }
      if (req.method === "GET" && url.pathname === "/api/evals/intent") {
        return json(res, library.listIntentEvals());
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/evals/intent/")) {
        return json(res, library.readIntentEval(decodeURIComponent(url.pathname.split("/")[4] || "")));
      }
      if (req.method === "POST" && url.pathname === "/api/teach/correct") {
        if (teachPhase === "idle") return json(res, { error: "not teaching" }, 409);
        const body = await readBody(req) as TeachCorrection;
        const projected = projectTeach(capture.events, teachDecisions, teachMeta(), spokenMap());
        const index = projected.cards.findIndex((card) => card.id === body.cardId);
        if (index < 0) return json(res, { error: "no step" }, 404);
        if (body.kind === "merge") {
          const previous = projected.cards.slice(0, index).reverse().find((card) => !card.dropped && !card.merged);
          if (!previous) return json(res, { error: "nothing to merge" }, 400);
        }
        teachDecisions = decide(teachDecisions, body, Date.now());
        persistTeachCase();
        return json(res, teachState());
      }
      if (req.method === "POST" && url.pathname === "/api/teach/check") {
        if (teachPhase !== "live" || !page || page.isClosed()) return json(res, { error: "not teaching" }, 409);
        const text = await checkText(page);
        if (!capture.push({ kind: "act", op: "verify", afterText: text })) return json(res, { error: "not teaching" }, 409);
        const id = capture.events[capture.events.length - 1]!.id;
        teachDecisions = decide(teachDecisions, { kind: "check", cardId: id, outcome: text }, Date.now());
        persistTeachCase();
        void narrateSoon();
        return json(res, teachState());
      }
      if (req.method === "POST" && url.pathname === "/api/teach/stop") {
        if (teachPhase !== "live") return json(res, { error: "not teaching" }, 409);
        return json(res, await finishTeach());
      }
      if (req.method === "POST" && url.pathname === "/api/teach/discard") {
        if (teachPhase === "idle") return json(res, { error: "not teaching" }, 409);
        teachDecisions = [];
        cardSeen.clear();
        narrationCache.clear();
        teachBaseline = [];
        teachFix = null;
        teachPhase = "idle";
        sessionMode = "capture";
        recordingSince = 0;
        await discardSession();
        return json(res, { phase: "idle" });
      }
      if (req.method === "POST" && url.pathname === "/api/teach/save") {
        if (teachPhase !== "review") return json(res, { error: "review first" }, 409);
        const body = await readBody(req) as { name?: string };
        if (body.name) teachName = body.name;
        const saved = saveTeach();
        return json(res, saved);
      }
      if (req.method === "POST" && url.pathname === "/api/teach/merge") {
        const body = await readBody(req) as { ids?: string[]; name?: string };
        const ids = body.ids || [];
        if (ids.length < 2) return json(res, { error: "need two demonstrations" }, 400);
        const docs = ids.map((id) => library.read(id));
        const id = `wf-${Date.now()}`;
        const shotSources: { stepId: string; workflowId: string; sourceStepId: string }[] = [];
        const merged = mergeDemonstrations(docs, { id, name: body.name || "Merged workflow", now: Date.now() }, shotSources);
        library.save(merged);
        copyMergedShots(library.root, merged.id, shotSources);
        library.saveTrail(id, [{ id: "dec-0", ts: Date.now(), kind: "decision", op: "decision", decision: "merge", detail: `merged ${ids.join(", ")}`, cardId: id }]);
        return json(res, merged);
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "POST" && url.pathname === "/api/replay/press") {
        const body = await readBody(req) as { name?: string; fill?: { selector: string; value: string } };
        const session = [...replays.values()].find((item) => !item.page.isClosed());
        if (!session) return json(res, { error: "replay window is not open" }, 409);
        if (body.fill) await session.page.fill(body.fill.selector, body.fill.value);
        if (body.name) await session.page.getByRole("button", { name: body.name, exact: true }).click();
        return json(res, { ok: true });
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "POST" && url.pathname === "/api/replay/drive") {
        const body = await readBody(req) as { id?: string; fill?: { selector?: string; value?: string }; click?: string };
        const session = replays.get(body.id || "");
        if (!session || session.page.isClosed()) return json(res, { error: "replay window is not open" }, 409);
        const fill = body.fill;
        if (fill) {
          if (!fill.selector || !/^#[A-Za-z][\w-]*$/.test(fill.selector)) return json(res, { error: "selector" }, 400);
          await session.page.locator(fill.selector).fill(fill.value ?? "");
        }
        if (body.click) {
          if (!/^#[A-Za-z][\w-]*$/.test(body.click)) return json(res, { error: "selector" }, 400);
          await session.page.locator(body.click).click();
        }
        return json(res, { ok: true });
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "POST" && url.pathname === "/api/replay/shot") {
        const body = await readBody(req) as { id?: string; file?: string; width?: number; height?: number };
        const session = replays.get(body.id || "");
        if (!session || session.page.isClosed()) return json(res, { error: "replay window is not open" }, 409);
        const base = path.basename(body.file || "replay.png");
        if (!/^[\w.-]+$/.test(base)) return json(res, { error: "file" }, 400);
        const width = Math.round(Number(body.width) || 0);
        const height = Math.round(Number(body.height) || 0);
        if (width >= 400 && width <= 1600 && height >= 400 && height <= 1400) {
          await session.page.setViewportSize({ width, height });
        }
        const shots = path.join(opts.home, "shots");
        mkdirSync(shots, { recursive: true });
        await session.page.evaluate(maskPasswordFields);
        try {
          await session.page.screenshot({ path: path.join(shots, base), type: "png" });
        } finally {
          await session.page.evaluate(unmaskPasswordFields).catch(() => undefined);
        }
        return json(res, { file: base });
      }
      if (req.method === "POST" && url.pathname === "/api/replay/place") {
        const body = await readBody(req) as { id?: string; x?: number; y?: number; width?: number; height?: number };
        const id = body.id || "";
        const session = replays.get(id);
        if (!session || session.page.isClosed()) return json(res, { error: "replay window is not open" }, 409);
        const want: WindowBounds = { x: Number(body.x), y: Number(body.y), width: Number(body.width), height: Number(body.height) };
        const placed = await placeReplayWindow(session.page, session.profile, want);
        if (placed.applied && placed.after) library.writeBounds(id, placed.after);
        return json(res, placed);
      }
      if (req.method === "POST" && url.pathname === "/api/promotions/check") {
        const body = await readBody(req) as { id?: string };
        const checked = await checkPromotion(library, body.id || "", notices);
        return json(res, checked);
      }
      if (req.method === "POST" && url.pathname === "/api/heal/keep") {
        const body = await readBody(req) as { id: string; stepId: string; patch: HealProposal["patch"]; runId?: string; healId?: string };
        const next = keepPatch(library.read(body.id), body.stepId, body.patch, { runId: body.runId, score: 100 });
        draftVersion(library, next, "heal");
        if (body.runId && body.healId) {
          const recorded = library.appendDecision(body.runId, { ts: Date.now(), healId: body.healId, decision: "keep" });
          const heal = (recorded.heals as HealRecord[]).find((item) => item.id === body.healId);
          if (heal) library.noteHealPromotion(body.id, heal);
        }
        return json(res, next);
      }
      if (req.method === "POST" && url.pathname === "/api/heal/revert") {
        const body = await readBody(req) as { id: string; runId: string; healId: string };
        const run = library.readRun(body.runId);
        const heal = (run.heals as HealRecord[]).find((item) => item.id === body.healId);
        if (!heal) return json(res, { error: "no heal" }, 404);
        const next = revertPatch(library.read(body.id), heal.failedStep, { runId: body.runId });
        draftVersion(library, next, "restore");
        const recorded = library.appendDecision(body.runId, { ts: Date.now(), healId: body.healId, decision: "revert" });
        return json(res, { workflow: next, decisions: recorded.decisions, heals: recorded.heals });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/workflows/") && url.pathname.endsWith("/try")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const body = await readBody(req) as { stepId?: string };
        let doc: WorkflowV2;
        try {
          doc = library.read(id);
        } catch {
          return json(res, { error: "no workflow" }, 404);
        }
        const step = doc.steps.find((item) => item.id === body.stepId);
        if (!step) return json(res, { error: "no step" }, 404);
        try {
          const live = await livePage(doc.startUrl);
          const driver = new BrowserDriver(live);
          const outcome = await tryStep(step, driver);
          const preview = outcome.matched ? await driver.outlinePreview() : undefined;
          return json(res, { ...outcome, preview, actions: 0, modelCalls: 0 });
        } catch (err) {
          const message = err instanceof Error ? err.message : "try failed";
          return json(res, { error: message, actions: 0, modelCalls: 0 }, 500);
        }
      }
      if (req.method === "PATCH" && url.pathname.startsWith("/api/workflows/")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const body = await readBody(req) as {
          name?: string;
          summary?: string;
          intent?: string;
          workflow?: WorkflowV2;
          heal?: HealMode | null;
          driver?: "playwright" | "extension" | null;
          stepHeal?: { stepId?: string; heal?: string | null };
          inputEdit?: { name?: string; label?: string; type?: string; default?: string; required?: boolean };
        };
        if (body.inputEdit?.name) {
          const doc = library.read(id);
          const edited = editInput(doc, {
            name: body.inputEdit.name,
            label: body.inputEdit.label,
            type: body.inputEdit.type,
            default: body.inputEdit.default,
            required: body.inputEdit.required,
          });
          if (!edited.doc) return json(res, { error: edited.error || "input" }, 400);
          const drafted = draftVersion(library, edited.doc, "edit");
          return json(res, promoteVersion(library, id, drafted.n).document);
        }
        if (body.stepHeal?.stepId) {
          const doc = library.read(id);
          const policy = stepHealChoice(body.stepHeal.heal);
          const steps = doc.steps.map((step) => {
            if (step.id !== body.stepHeal?.stepId) return step;
            if (policy) return { ...step, heal: policy };
            const { heal: _drop, ...rest } = step;
            return rest;
          });
          const next = { ...doc, steps, updatedAt: Date.now() };
          draftVersion(library, next, "edit");
          return json(res, next);
        }
        if (body.workflow) {
          const next = { ...body.workflow, id, updatedAt: Date.now() };
          draftVersion(library, next, "edit");
          return json(res, next);
        }
        if (body.driver === "playwright" || body.driver === "extension" || body.driver === null) {
          const doc = library.read(id);
          // A live workflow's steps came from the live Chrome. Replaying it in Bao's own Chrome is the wrong browser.
          if (refusesOwnedBrowser(doc.driver)) return json(res, { error: CDP_LIVE_SERVER_REFUSAL }, 409);
          const next: WorkflowV2 = { ...doc, updatedAt: Date.now() };
          if (body.driver) next.driver = body.driver;
          else delete next.driver;
          draftVersion(library, next, "edit");
          return json(res, next);
        }
        if (body.heal === "auto" || body.heal === "approve" || body.heal === null) {
          const doc = library.read(id);
          const next: WorkflowV2 = { ...doc, updatedAt: Date.now() };
          if (body.heal) next.heal = body.heal;
          else delete next.heal;
          draftVersion(library, next, "edit");
          return json(res, next);
        }
        const current = library.read(id);
        const renamed = applySaveEdits(current, {
          name: typeof body.name === "string" ? body.name : current.name,
          summary: typeof body.summary === "string" ? body.summary : current.summary,
          intent: typeof body.intent === "string" ? body.intent : current.intent,
        });
        draftVersion(library, renamed, "edit");
        return json(res, renamed);
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/workflows/")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const body = await readBody(req) as { confirm?: boolean };
        if (!body.confirm) return json(res, { error: "confirm required" }, 400);
        library.remove(id);
        return json(res, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/login-sites") {
        return json(res, { sites: sites.list().map(publicSite) });
      }
      if (req.method === "PUT" && url.pathname === "/api/login-sites") {
        const body = await readBody(req) as Partial<SiteLoginConfig> & LoginBody;
        const origin = siteOrigin(body.origin || body.site || "");
        const prior = sites.has(origin) ? sites.get(origin) : undefined;
        return json(res, sites.save(siteConfig(body, prior)));
      }
      if (req.method === "DELETE" && url.pathname === "/api/login-sites") {
        const body = await readBody(req) as { origin?: string };
        sites.remove(body.origin || "");
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/login-sites/recheck") {
        const body = await readBody(req) as { origin?: string };
        const origin = siteOrigin(body.origin || "");
        if (!sites.has(origin)) return json(res, { error: "That site is not saved." }, 404);
        await signIn?.close();
        signIn = undefined;
        const config = sites.get(origin);
        let signedIn = false;
        try {
          signedIn = (await probeOwnedProfile({ baoProfile, config })).signedIn;
        } catch {
          signedIn = false;
        }
        return json(res, { site: sites.recordProbe(origin, signedIn) });
      }
      if (req.method === "POST" && url.pathname === "/api/login-import/preview") {
        const body = await readBody(req) as LoginBody;
        const click = clickFrom(body);
        const config = rememberSite(sites, body);
        return json(res, await previewChromeProfiles({
          click,
          chromeUserData,
          config,
          platform: opts.loginPlatform ?? process.platform,
        }));
      }
      if (req.method === "POST" && url.pathname === "/api/login-import") {
        const body = await readBody(req) as LoginBody;
        const click = clickFrom(body);
        const config = rememberSite(sites, body);
        if (!body.profile) return json(res, { error: "Choose a Chrome profile." }, 400);
        await signIn?.close();
        signIn = undefined;
        const keys = await resolveLoginKeys(opts.loginKeys);
        const result = await importInOwnedChrome({
          click,
          chromeUserData,
          profileDirectory: body.profile,
          baoProfile,
          config,
          keys,
        });
        if (result.probed) sites.recordProbe(config.origin, result.signedIn);
        return json(res, result);
      }
      if (req.method === "POST" && url.pathname === "/api/login-import/sign-in") {
        const body = await readBody(req) as LoginBody;
        const click = clickFrom(body);
        const config = rememberSite(sites, body);
        await signIn?.close();
        const signInUrl = config.probeUrl || config.origin;
        signIn = await openOwnedSignIn({
          baoProfile,
          url: signInUrl,
          headless: process.env.BAO_SIGNIN_HEADLESS === "1",
        });
        return json(res, { opened: true, url: signInUrl });
      }
      json(res, { error: "not found" }, 404);
    } catch (err) {
      if (hostGrantError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, { status: "needs_human", message, reason: message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof ConsentRequired ? 403 : message.startsWith("The site") ? 400 : 500;
      json(res, { error: message }, status);
    }
  });

  function rememberPending(ask: HumanAsk): void {
    if (!ask.runId) return;
    writePendingPrompt(library.root, { ask, runId: ask.runId });
    try {
      library.readRun(ask.runId);
    } catch {
      library.saveRun({
        id: ask.runId,
        workflowId: ask.workflowId,
        status: "paused",
        at: Date.now(),
        heals: [],
        steps: [{ id: ask.stepId, status: "paused", label: ask.label }],
      });
    }
  }

  function syncPending(now = Date.now()): void {
    const prompt = readPendingPrompt(library.root);
    if (!prompt) return;
    if (promptDue(prompt, now)) {
      if (replaying) return;
      markPromptTimedOut(library, prompt, now);
      clearPendingPrompt(library.root);
      activeAsk = null;
      if (prompt.ask.kind === "login") {
        loginWait = null;
        loginContinued = false;
      } else {
        humanConfirm = null;
      }
      clearAct();
      return;
    }
    if (!activeAsk) activeAsk = prompt.ask;
  }

  syncPending();
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  remote.start();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  boundPort = port;
  writeFileSync(path.join(opts.home, "server.json"), JSON.stringify({ port }));
  if (process.env.BAO_CAPTURE_BAR === "1") {
    const bin = findCaptureBar();
    if (bin) {
      bar.onEvent = (event) => { void enqueue(() => onBar(event)).catch(() => undefined); };
      bar.open(bin);
    }
  }

  async function releaseSharedProfile(opts: { keepReplays: boolean }): Promise<void> {
    if (context) await stopBrowser();
    const replayContexts = new Set([...replays.values()].map((session) => session.context));
    if (site && !replayContexts.has(site.context) && path.resolve(site.profile) === path.resolve(baoProfile)) {
      await site.context.close().catch(() => undefined);
      site = undefined;
    }
    if (watch && !replayContexts.has(watch.context) && path.resolve(watch.profile) === path.resolve(baoProfile)) {
      await watch.context.close().catch(() => undefined);
      watch = undefined;
    }
    if (opts.keepReplays) return;
    for (const [id, session] of replays) {
      if (path.resolve(session.profile) !== path.resolve(baoProfile)) continue;
      await session.context.close().catch(() => undefined);
      replays.delete(id);
    }
  }

  async function beginSession(startUrl: string): Promise<void> {
    startUrl = resolveCaptureUrl(startUrl, boundPort);
    await releaseSharedProfile({ keepReplays: false });
    captureVia = "playwright";
    gestureById.clear();
    capture.start();
    recordingSince = Date.now();
    captureShots.clear();
    captureGuideShots.clear();
    capturePosterPath = "";
    capturePageTitle = "";
    posterTried = false;
    try {
      profile = baoProfile;
      mkdirSync(profile, { recursive: true });
      context = await launchOwnedChrome({ userDataDir: profile, headless: productHeadless() });
      await context.exposeBinding("__baoRecord", async (_source, payload: TrailEvent) => {
        await watchShot(recordCaptured(payload));
      });
      await context.exposeBinding("__baoDeliver", async (_source, proposal: PageProposal) => {
        extractProposal = proposal;
      });
      await context.addInitScript(recorderSource());
      page = context.pages()[0] || await context.newPage();
      page.on("dialog", (dialog) => {
        const answer = nextDialogAnswer;
        nextDialogAnswer = undefined;
        if (dialog.type() === "prompt" && answer != null) dialog.accept(answer).catch(() => undefined);
        else dialog.accept().catch(() => undefined);
      });
      fileChooser = await armFileChooser(page, async (chosen) => {
        await watchShot(recordCaptured({
          kind: "act",
          op: "upload",
          fileName: chosen.fileName,
          identity: chosen.identity,
        }));
      });
      const downloadDir = await mkdtemp(path.join(tmpdir(), "bao-capture-downloads-"));
      const downloads = await armBrowserDownloads(page, downloadDir);
      captureDownloads(downloads, (info) => {
        void watchShot(recordCaptured({
          kind: "act",
          op: "download",
          suggestedFilename: info.suggestedFilename,
          fileName: info.suggestedFilename,
        }));
      });
      captureOpenUrl = startUrl;
      await navigateOwned(page, startUrl);
      // The init script does not observe this goto, and a later page.url() is not
      // the URL the capture began on. Record that opening navigation explicitly.
      if (sessionMode === "capture") capture.push({ kind: "act", op: "navigate", beforeUrl: startUrl, afterUrl: startUrl });
      await (fileChooser as { send(method: string, params?: object): Promise<unknown> }).send(
        "Page.setInterceptFileChooserDialog",
        { enabled: true },
      );
    } catch (err) {
      capture.discard();
      recordingSince = 0;
      captureOpenUrl = "";
      capturePosterPath = "";
      capturePageTitle = "";
      posterTried = false;
      await stopBrowser();
      publishCapture();
      throw err;
    }
    publishCapture();
  }

  function watchShot(work: Promise<unknown>): Promise<unknown> {
    pendingShots.add(work);
    void work.finally(() => pendingShots.delete(work));
    return work;
  }

  async function settleShots(): Promise<void> {
    while (pendingShots.size) await Promise.all([...pendingShots]);
  }

  async function recordCaptured(payload: Omit<TrailEvent, "id" | "ts">): Promise<void> {
    if (!capture.push(payload)) return;
    const stored = capture.events[capture.events.length - 1];
    if (sessionMode === "teach") stampTeachSeen();
    publishCapture();
    if (!stored || !page || page.isClosed()) return;
    if (sessionMode === "capture" && !posterTried && isPageAct(stored.op)) {
      posterTried = true;
      await takeCardPoster();
    }
    const dir = path.join(opts.home, "shots", "capture");
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${stored.id}.png`);
    if (sessionMode === "teach") void narrateSoon();
    try {
      const target = { identity: payload.identity, action: payload.op, label: payload.identity?.text };
      if (sessionMode === "teach") {
        const blurred = await page.evaluate(blurSensitiveFields);
        try {
          const png = await elementShot(page, target, { blur: false });
          if (!png) return;
          writeFileSync(dest, png);
          const guide = await guideFieldShot(page, target).catch(() => undefined);
          if (guide) {
            const guideDest = path.join(dir, `${stored.id}.guide.png`);
            writeFileSync(guideDest, guide);
            captureGuideShots.set(stored.id, guideDest);
          }
        } finally {
          await page.evaluate(unblurSensitiveFields).catch(() => undefined);
        }
        if (blurred > 0) blurredShots += 1;
      } else {
        const png = await elementShot(page, target);
        if (!png) return;
        writeFileSync(dest, png);
        const guide = await guideFieldShot(page, target).catch(() => undefined);
        if (guide) {
          const guideDest = path.join(dir, `${stored.id}.guide.png`);
          writeFileSync(guideDest, guide);
          captureGuideShots.set(stored.id, guideDest);
        }
      }
      captureShots.set(stored.id, dest);
    } catch { /* headed Chromium can refuse captureScreenshot */ }
  }

  async function beginTeach(startUrl: string, fix: { workflowId: string; stepId: string } | null): Promise<void> {
    startUrl = resolveCaptureUrl(startUrl, boundPort);
    teachDecisions = [];
    cardSeen.clear();
    narrationCache.clear();
    narrateGen += 1;
    blurredShots = 0;
    teachBaseline = [];
    teachName = "";
    teachStartUrl = startUrl;
    teachFix = fix;
    teachCaseId = `teach-${Date.now().toString(36)}`;
    sessionMode = "teach";
    try {
      await beginSession(startUrl);
      // Live means the capture page exists. Publishing it earlier lets a
      // drive land in the gap while Chrome is still launching.
      teachPhase = "live";
      if (page && !page.isClosed()) teachBaseline = await page.evaluate(visibleStatusLines).catch(() => []);
    } catch (err) {
      sessionMode = "capture";
      teachPhase = "idle";
      teachFix = null;
      throw err;
    }
  }

  function saveSheetState(): { id: string; name: string; summary: string; intent: string; poster: boolean } | null {
    if (!pendingSave) return null;
    return {
      id: pendingSave.workflow.id,
      name: pendingSave.workflow.name,
      summary: pendingSave.workflow.summary || "",
      intent: pendingSave.workflow.intent || "",
      poster: !!pendingSave.poster,
    };
  }

  async function takeCardPoster(): Promise<void> {
    if (capturePosterPath || !page || page.isClosed()) return;
    try {
      const title = await page.title().catch(() => "");
      if (title && !capturePageTitle) capturePageTitle = title.replace(/\s+/g, " ").trim().slice(0, 120);
      const png = await pagePoster(page);
      if (!png || !selectCardPoster([{ name: "poster.png", bytes: png }])) return;
      const dir = path.join(opts.home, "shots", "capture");
      mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, "poster.png");
      writeFileSync(dest, png);
      capturePosterPath = dest;
    } catch { /* no poster is better than an element crop */ }
  }

  async function saveSession(): Promise<WorkflowV2> {
    await settleShots();
    const raw = capture.stop();
    recordingSince = 0;
    const id = `wf-${Date.now()}`;
    const opened = captureOpenUrl || (page && !page.isClosed() ? page.url() : "");
    captureOpenUrl = "";
    const clean = raw.map((event) => {
      const file = storedFileEvent(event);
      if (!file.sensitive && file.identity?.role !== "password") return file;
      const copy = { ...file, sensitive: true };
      delete copy.value;
      return copy;
    });
    const startUrl = captureStartUrl(clean, opened);
    extractProposal = undefined;
    const secrets = secretValues(raw);
    const built = explain(clean, { id, name: "Untitled workflow", startUrl, secrets: [] });
    const floor = workflowFloorTitle({
      startUrl,
      events: clean,
      steps: built.workflow.steps,
      pageTitle: capturePageTitle,
      secrets,
    });
    const drafted = await inferSavedWorkflow(built.workflow, {
      floorTitle: floor,
      startUrl,
      events: clean,
      steps: built.workflow.steps,
      pageTitle: capturePageTitle,
      groups: built.groups,
      secrets,
    }, await saveCompleter());
    if (captureVia === "extension") drafted.driver = "extension";
    const gestures = captureVia === "extension"
      ? gestureQueue(drafted.steps, built.groups, gestureById)
      : undefined;
    if (pendingSave) await rm(path.join(opts.home, "shots", "pending", pendingSave.workflow.id), { recursive: true, force: true }).catch(() => undefined);
    const shotDir = path.join(opts.home, "shots", "pending", drafted.id);
    mkdirSync(shotDir, { recursive: true });
    const shots = new Map<string, string>();
    const guides = new Map<string, string>();
    for (let i = 0; i < drafted.steps.length; i++) {
      const group = built.groups[i] || [];
      const event = group.find((item) => item.op !== "note") || group[0];
      const step = drafted.steps[i];
      const src = event ? captureShots.get(event.id) : undefined;
      if (src && step && existsSync(src)) {
        const dest = path.join(shotDir, workflowShotName(step.id));
        copyFileSync(src, dest);
        shots.set(step.id, dest);
      }
      const guideSrc = event ? captureGuideShots.get(event.id) : undefined;
      if (guideSrc && step && existsSync(guideSrc)) {
        const dest = path.join(shotDir, guideShotName(step.id));
        copyFileSync(guideSrc, dest);
        guides.set(step.id, dest);
      }
    }
    let poster = "";
    if (capturePosterPath && existsSync(capturePosterPath)) {
      const bytes = readFileSync(capturePosterPath);
      if (selectCardPoster([{ name: "poster.png", bytes }])) {
        poster = path.join(shotDir, "poster.png");
        copyFileSync(capturePosterPath, poster);
      }
    }
    pendingSave = {
      workflow: drafted,
      events: ensureTrailTimes(clean).events,
      shots,
      guides,
      poster,
      floor,
      secrets,
      gestures,
    };
    capture.discard();
    captureShots.clear();
    captureGuideShots.clear();
    capturePosterPath = "";
    capturePageTitle = "";
    posterTried = false;
    captureVia = "playwright";
    gestureById.clear();
    await stopBrowser();
    publishCapture();
    return drafted;
  }

  async function commitSave(edits: { name?: string; summary?: string; intent?: string }): Promise<WorkflowV2> {
    const pending = pendingSave;
    if (!pending) throw new Error("nothing to save");
    const workflow = applySaveEdits(pending.workflow, {
      name: edits.name,
      summary: edits.summary,
      intent: edits.intent,
    }, pending.secrets, pending.floor);
    const shotDest = path.join(opts.home, "shots", "workflows", workflow.id);
    mkdirSync(shotDest, { recursive: true });
    for (const [stepId, src] of pending.shots) {
      if (existsSync(src)) copyFileSync(src, path.join(shotDest, workflowShotName(stepId)));
    }
    for (const [stepId, src] of pending.guides) {
      if (existsSync(src)) copyFileSync(src, path.join(shotDest, guideShotName(stepId)));
    }
    if (pending.poster && existsSync(pending.poster)) {
      const bytes = readFileSync(pending.poster);
      if (selectCardPoster([{ name: "poster.png", bytes }])) copyFileSync(pending.poster, path.join(shotDest, "poster.png"));
    }
    library.save(workflow);
    library.saveTrail(workflow.id, pending.events);
    if (workflow.driver === "extension" && pending.gestures) {
      writeGestures(opts.home, workflow.id, pending.gestures);
    }
    pendingSave = null;
    await rm(path.join(opts.home, "shots", "pending", workflow.id), { recursive: true, force: true }).catch(() => undefined);
    return workflow;
  }

  async function discardPending(): Promise<void> {
    const pending = pendingSave;
    pendingSave = null;
    if (!pending) return;
    await rm(path.join(opts.home, "shots", "pending", pending.workflow.id), { recursive: true, force: true }).catch(() => undefined);
  }

  async function discardSession(): Promise<void> {
    capture.discard();
    recordingSince = 0;
    extractProposal = undefined;
    captureOpenUrl = "";
    capturePosterPath = "";
    capturePageTitle = "";
    posterTried = false;
    captureVia = "playwright";
    gestureById.clear();
    await stopBrowser();
    publishCapture();
  }

  extensionLink?.onTrail((event, gesture) => {
    if (captureVia !== "extension" || !capture.recording) return;
    if (!capture.push(event as Omit<TrailEvent, "id" | "ts">)) return;
    const stored = capture.events[capture.events.length - 1];
    if (stored && gesture) gestureById.set(stored.id, gesture);
    publishCapture();
  });
  extensionLink?.onHostAccess((access) => {
    const hostAccess = hostAccessMode(access);
    if (library.settings().hostAccess === hostAccess) return;
    library.updateSettings({ hostAccess });
  });
  extensionLink?.onRecord((kind, url) => {
    if (kind === "start") {
      if (capture.recording) return;
      captureVia = "extension";
      gestureById.clear();
      captureOpenUrl = url;
      capture.start();
      recordingSince = Date.now();
      publishCapture();
      return;
    }
    if (capture.recording && captureVia === "extension") void enqueue(() => saveSession());
  });

  async function onBar(event: BarEvent): Promise<void> {
    if (event.event === "pause") {
      if (capture.recording) capture.pause();
    } else if (event.event === "resume") {
      if (capture.recording) capture.resume();
    } else if (event.event === "note") {
      try { capture.note(event.text || ""); } catch { return; }
    } else if (event.event === "check") {
      try { capture.check(event.text || ""); } catch { return; }
    } else if (event.event === "discard") {
      await discardSession();
      return;
    } else if (event.event === "hotkey" && event.name === "start") {
      if (!capture.recording) await beginSession("");
      return;
    } else if (event.event === "hotkey" && event.name === "stop") {
      if (capture.recording) await saveSession();
      return;
    } else if (event.event === "notify-off") {
      console.log(`bao notify off ${JSON.stringify({ title: event.title || "", button: event.button || "", url: event.url || "" })}`);
      return;
    } else if (event.event === "show-window") {
      const session = [...replays.values()].find((item) => !item.page.isClosed());
      if (!session) {
        console.log("bao show window missed");
        return;
      }
      void session.page.bringToFront().then(() => {
        console.log("bao show window");
      }, () => {
        console.log("bao show window missed");
      });
      return;
    } else if (event.event === "hotkey" && event.name === "pause") {
      if (!capture.recording) return;
      if (capture.paused) capture.resume();
      else capture.pause();
    } else return;
    publishCapture();
  }

  function stampTeachSeen(): void {
    if (sessionMode !== "teach" || teachPhase === "idle") return;
    let projected: ReturnType<typeof projectTeach>;
    try {
      projected = projectTeach(capture.events, teachDecisions, teachMeta(), spokenMap());
    } catch {
      return;
    }
    const now = Date.now();
    for (const card of projected.cards) {
      if (card.dropped || card.merged || cardSeen.has(card.id)) continue;
      const event = capture.events.find((item) => item.id === card.id);
      cardSeen.set(card.id, { at: event?.ts ?? now, shownAt: now });
    }
  }

  function teachMeta(): { id: string; name: string; startUrl: string } {
    return {
      id: "teach-draft",
      name: teachName || (teachFix ? "Taught fix" : "Taught workflow"),
      startUrl: teachStartUrl,
    };
  }

  function persistTeachCase(): void {
    if (!teachDecisions.length || !teachCaseId) return;
    try {
      const id = `${teachCaseId}-${teachDecisions.length}`;
      const doc = teachIntentCase(id, capture.events, teachDecisions, { ...teachMeta(), id }, spokenMap());
      library.saveTeachIntentCase(id, doc);
    } catch {
      return;
    }
  }

  function spokenMap(): Map<string, Spoken> {
    const map = new Map<string, Spoken>();
    for (const [id, value] of narrationCache) {
      if (value.narrator === "model") map.set(id, { narrator: "model", modelName: value.modelName, intent: value.intent, outcome: value.outcome });
    }
    return map;
  }

  function teachState(): Record<string, unknown> {
    if (teachPhase === "idle") return { phase: "idle" };
    let projected: ReturnType<typeof projectTeach> | undefined;
    let error = "";
    try {
      projected = projectTeach(capture.events, teachDecisions, teachMeta(), spokenMap());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const narrator = projected?.cards.some((card) => card.narrator === "model") ? "model" : "heuristic";
    const summary = projected ? teachSummaryFrom(capture.events, projected) : undefined;
    const reasons = new Map((summary?.dropped || []).map((item) => [item.id, item.reason]));
    const now = Date.now();
    const cards = (projected?.cards || []).map((card) => {
      let seen = cardSeen.get(card.id);
      if (!seen && !card.dropped && !card.merged) {
        const event = capture.events.find((item) => item.id === card.id);
        seen = { at: event?.ts ?? now, shownAt: now };
        cardSeen.set(card.id, seen);
      }
      return seen ? { ...card, at: seen.at, shownAt: seen.shownAt } : card;
    });
    return {
      phase: teachPhase,
      paused: capture.paused,
      since: recordingSince,
      blur: true,
      blurredShots,
      narrator,
      fix: teachFix,
      error,
      cards,
      decisions: teachDecisions.map((decision) => ({ kind: decision.kind, detail: decision.detail, cardId: decision.cardId })),
      review: teachPhase === "review" && projected && summary ? {
        summary,
        raw: publicTrail(capture.events).map((event) => ({
          id: event.id,
          op: event.op,
          kind: event.kind,
          detail: event.detail,
          reason: reasons.get(event.id),
        })),
        decisions: teachDecisions,
        workflow: {
          name: projected.workflow.name,
          inputs: projected.workflow.inputs.map((input) => ({ name: input.name, type: input.type })),
          steps: projected.workflow.steps.map((step) => ({
            id: step.id,
            label: step.label,
            intent: step.intent,
            action: step.action,
            human: step.human,
            value: step.value,
            input: step.input,
            sensitive: step.sensitive,
          })),
        },
      } : undefined,
    };
  }

  async function narrateSoon(): Promise<void> {
    const gen = ++narrateGen;
    const narrator = narratorFromEnv();
    if (!narrator) return;
    let drafted: ReturnType<typeof projectTeach>;
    try {
      drafted = projectTeach(capture.events, [], teachMeta());
    } catch {
      return;
    }
    for (const card of drafted.cards) {
      if (gen !== narrateGen) return;
      const sig = `${card.action}|${card.intent}|${card.outcome}`;
      const cached = narrationCache.get(card.id);
      if (cached?.sig === sig) continue;
      const spoken = await narrator.narrate(card);
      if (gen !== narrateGen) return;
      narrationCache.set(card.id, spoken
        ? { sig, narrator: "model", modelName: narrator.name, intent: spoken.intent, outcome: spoken.outcome }
        : { sig, narrator: "heuristic", intent: card.intent, outcome: card.outcome });
    }
  }

  async function checkText(current: Page): Promise<string> {
    const lines = await current.evaluate(visibleStatusLines).catch(() => [] as string[]);
    const fresh = lines.filter((line) => !teachBaseline.includes(line));
    return fresh.slice(-2).join(" ").slice(0, 180) || "the page matches this check";
  }

  async function finishTeach(): Promise<Record<string, unknown>> {
    await settleShots();
    if (page && !page.isClosed()) teachStartUrl = page.url();
    teachPhase = "review";
    sessionMode = "teach";
    capture.stop();
    recordingSince = 0;
    await stopBrowser();
    publishCapture();
    return teachState();
  }

  function saveTeach(): WorkflowV2 {
    const id = teachFix ? teachFix.workflowId : `wf-${Date.now()}`;
    const meta = { id: teachFix ? `${id}-fix` : id, name: teachName || teachMeta().name, startUrl: teachStartUrl };
    const projected = projectTeach(capture.events, teachDecisions, { ...meta, id: teachFix ? `${id}-taught` : id }, spokenMap());
    let workflow = projected.workflow;
    const decisions = [...teachDecisions];
    if (teachFix) {
      workflow = spliceFix(library.read(teachFix.workflowId), teachFix.stepId, { ...projected.workflow, id });
      decisions.push({ ts: Date.now(), cardId: teachFix.stepId, kind: "splice", detail: `spliced into ${teachFix.stepId}` });
      workflow = { ...workflow, name: teachName || library.read(teachFix.workflowId).name };
    } else {
      workflow = { ...projected.workflow, id, name: meta.name, startUrl: teachStartUrl };
    }
    if (!workflow.steps.length) throw new Error("nothing to save");
    const shotDest = path.join(opts.home, "shots", "workflows", workflow.id);
    mkdirSync(shotDest, { recursive: true });
    let stepIndex = 0;
    for (const card of projected.cards) {
      if (card.dropped || card.merged) continue;
      const step = workflow.steps[teachFix ? workflow.steps.findIndex((item) => item.id.startsWith(`${workflow.id}-fix-`)) + stepIndex : stepIndex];
      stepIndex += 1;
      const src = captureShots.get(card.id);
      if (src && step && existsSync(src)) copyFileSync(src, path.join(shotDest, workflowShotName(step.id)));
      const guideSrc = captureGuideShots.get(card.id);
      if (guideSrc && step && existsSync(guideSrc)) copyFileSync(guideSrc, path.join(shotDest, guideShotName(step.id)));
    }
    library.save(workflow);
    const trail = [...publicTrail(capture.events), ...decisions.map((decision, index) => decisionEvent(decision, index))];
    library.saveTrail(workflow.id, ensureTrailTimes(trail).events);
    const pair = intentEvalPair(workflow.id, capture.events, teachDecisions, { id: workflow.id, name: workflow.name, startUrl: workflow.startUrl }, spokenMap());
    if (teachFix) {
      pair.workflow = workflow;
      pair.decisions = decisions;
    }
    library.saveIntentEval(workflow.id, pair);
    const caseDoc = teachIntentCase(workflow.id, capture.events, decisions, {
      id: workflow.id,
      name: workflow.name,
      startUrl: workflow.startUrl,
    }, spokenMap());
    if (teachFix) caseDoc.workflow = workflow;
    library.saveTeachIntentCase(workflow.id, caseDoc);
    capture.discard();
    teachDecisions = [];
    cardSeen.clear();
    narrationCache.clear();
    teachFix = null;
    teachPhase = "idle";
    sessionMode = "capture";
    return workflow;
  }

  async function runGuide(
    library: Library,
    workflow: WorkflowV2,
    args: ReplayArgs,
    replays: Map<string, { context: BrowserContext; page: Page; profile: string }>,
    prompts?: PersonPrompts,
  ) {
    if (refusesOwnedBrowser(workflow.driver)) throw new Error(CDP_LIVE_SERVER_REFUSAL);
    const session = await openReplay(library, workflow.id, replays, baoProfile);
    const page = session.page;
    const driver = new BrowserDriver(page, undefined, prompts);
    if (workflow.startUrl.startsWith("http")) await navigateOwned(page, workflow.startUrl);
    await driver.watchGuide();
    const runId = `guide-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const first = workflow.steps[0];
    guideLive = {
      workflowId: workflow.id,
      runId,
      index: 0,
      total: workflow.steps.length,
      stepId: first?.id || "",
      intent: first?.intent || first?.label || "",
      status: "highlight",
      actions: 0,
    };
    const result = await guideMe(workflow, args, driver, {
      runId,
      onProgress(progress) {
        guideLive = { ...progress, workflowId: workflow.id, runId };
      },
    });
    guideLive = {
      workflowId: workflow.id,
      runId,
      index: Math.max(0, workflow.steps.length - 1),
      total: workflow.steps.length,
      stepId: result.steps[result.steps.length - 1]?.id || first?.id || "",
      intent: first ? (workflow.steps.find((step) => step.id === (result.steps[result.steps.length - 1]?.id || ""))?.intent
        || workflow.steps.find((step) => step.id === (result.steps[result.steps.length - 1]?.id || ""))?.label
        || guideLive?.intent
        || "") : "",
      status: result.status,
      actions: result.actions,
    };
    library.saveRun({
      id: runId,
      workflowId: workflow.id,
      status: result.status,
      at: Date.now(),
      heals: [],
      steps: result.steps,
      modelCalls: 0,
    });
    return { ...result, workflowId: workflow.id };
  }

  async function stopBrowser(): Promise<void> {
    fileChooser = undefined;
    await context?.close().catch(() => undefined);
    context = undefined;
    page = undefined;
    profile = undefined;
  }

  async function sitePage(): Promise<Page> {
    if (site && !site.page.isClosed()) return site.page;
    if (page && !page.isClosed() && context) {
      site = { context, page, profile: baoProfile };
      return page;
    }
    for (const session of replays.values()) {
      if (session.page.isClosed()) continue;
      if (path.resolve(session.profile) !== path.resolve(baoProfile)) continue;
      site = session;
      return session.page;
    }
    if (watch && !watch.page.isClosed()) {
      site = { context: watch.context, page: watch.page, profile: watch.profile };
      return watch.page;
    }
    mkdirSync(baoProfile, { recursive: true });
    const opened = await launchOwnedChrome({
      userDataDir: baoProfile,
      headless: productHeadless(),
    });
    const live = opened.pages()[0] || await opened.newPage();
    site = { context: opened, page: live, profile: baoProfile };
    return live;
  }

  async function settleImport(): Promise<void> {
    if (!pending || importing) return;
    if (pending.phase === "done" || pending.phase === "cancelled" || pending.phase === "error") return;
    importing = true;
    try {
      const userData = chromeUserDataDir();
      if (!existsSync(path.join(userData, "Local State"))) throw new Error("Chrome was not found");
      const profiles = readProfileNames(path.join(userData, "Local State"));
      const choice = chooseProfile(profiles, pending.profile);
      if (!choice.ok) {
        if (choice.reason === "none") throw new Error("Chrome has no profiles");
        pending.profile = undefined;
        pending.profiles = profiles;
        pending.phase = "pick";
        return;
      }
      pending.phase = "running";
      const password = readChromeSafeStoragePassword();
      const loaded = await loadChromeSiteCookies({
        userDataDir: userData,
        profileDir: choice.profile.directory,
        domain: pending.domain,
        password,
      });
      let count = loaded.cookies.length;
      const page = await sitePage();
      try {
        count = await injectCookies(page, loaded.cookies);
      } finally {
        for (const cookie of loaded.cookies) cookie.value = "";
      }
      const audit = { ...loaded.audit, count };
      writeImportAudit(opts.home, audit);
      pending.audit = audit;
      pending.phase = "done";
      pending.profiles = undefined;
    } catch (err) {
      if (pending) {
        const profile = pending.profile;
        pending.phase = "error";
        pending.error = safeImportError(err, profile);
        const audit = { domain: pending.domain, count: 0, at: Date.now(), reason: pending.error, profile };
        writeImportAudit(opts.home, audit);
        pending.audit = audit;
      }
    } finally {
      importing = false;
    }
  }

  async function answerLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req) as {
      username?: string;
      password?: string;
      code?: string;
      next?: string;
      verify?: boolean;
      ttlMs?: number;
    };
    const next = safeNext(typeof body.next === "string" ? body.next : undefined);
    const now = Date.now();
    const pendingToken = readCookie(req.headers.cookie, PENDING_COOKIE);
    const pending = pendingToken ? pendings.get(pendingToken) : undefined;
    if (typeof body.code === "string") {
      if (!pending || pending.exp <= now || !body.code.trim()) return json(res, { error: "code" }, 401);
      pendings.delete(pendingToken || "");
      const session = issueSession(pending.user, now, typeof body.ttlMs === "number" ? body.ttlMs : SESSION_TTL_MS);
      writeLogin(res, { ok: true, next }, [
        cookieHeader(SESSION_COOKIE, session.token, Math.max(0, Math.ceil((session.exp - now) / 1000))),
        cookieHeader(PENDING_COOKIE, "", 0),
      ]);
      return;
    }
    const username = typeof body.username === "string" ? body.username.trim().slice(0, 80) : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username) return json(res, { error: "username" }, 400);
    if (!password) return json(res, { error: "password" }, 400);
    if (body.verify === true) {
      const token = newToken();
      pendings.set(token, { user: username, exp: now + 5 * 60 * 1000 });
      writeLogin(res, { ok: false, stage: "code" }, [cookieHeader(PENDING_COOKIE, token, 300)]);
      return;
    }
    const session = issueSession(username, now, typeof body.ttlMs === "number" ? body.ttlMs : SESSION_TTL_MS);
    const maxAge = session.exp <= now ? 0 : Math.ceil((session.exp - now) / 1000);
    writeLogin(res, { ok: true, next }, [cookieHeader(SESSION_COOKIE, session.token, maxAge)]);
  }

  function issueSession(user: string, now: number, ttlMs: number): FreezeSession {
    const token = newToken();
    const session = { token, user, exp: sessionExpiry(now, ttlMs) };
    sessions.set(token, session);
    return session;
  }

  async function livePage(startUrl: string): Promise<Page> {
    if (page && !page.isClosed()) return page;
    for (const session of replays.values()) {
      if (!session.page.isClosed()) return session.page;
    }
    if (watch && !watch.page.isClosed()) {
      if (startUrl.startsWith("http") && !sameTarget(watch.page.url(), startUrl)) {
        await navigateOwned(watch.page, startUrl, { waitUntil: "domcontentloaded" });
      }
      return watch.page;
    }
    if (site && !site.page.isClosed()) {
      if (startUrl.startsWith("http") && !sameTarget(site.page.url(), startUrl)) {
        await navigateOwned(site.page, startUrl, { waitUntil: "domcontentloaded" });
      }
      watch = { context: site.context, page: site.page, profile: site.profile };
      return site.page;
    }
    mkdirSync(baoProfile, { recursive: true });
    const opened = await launchOwnedChrome({ userDataDir: baoProfile, headless: productHeadless() });
    const live = opened.pages()[0] || await opened.newPage();
    if (startUrl.startsWith("http")) await navigateOwned(live, startUrl, { waitUntil: "domcontentloaded" });
    watch = { context: opened, page: live, profile: baoProfile };
    return live;
  }

  return {
    library,
    port,
    extensionLink,
    notices,
    notifications,
    get recording() { return capture.recording; },
    async close() {
      watchOsNotify(() => {});
      bar.close();
      capture.discard();
      await signIn?.close();
      signIn = undefined;
      await stopBrowser();
      await site?.context.close().catch(() => undefined);
      site = undefined;
      await watch?.context.close().catch(() => undefined);
      if (watch && path.resolve(watch.profile) !== path.resolve(baoProfile)) {
        await rm(watch.profile, { recursive: true, force: true }).catch(() => undefined);
      }
      watch = undefined;
      for (const session of replays.values()) {
        await session.context.close().catch(() => undefined);
        await keepReplayClip(library.root, session.profile);
        if (path.resolve(session.profile) !== path.resolve(baoProfile)) {
          await rm(session.profile, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      replays.clear();
      await remote.stop();
      await live.close();
      await extensionLink?.close();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}

const replayClips = new Map<string, { video: { path(): Promise<string> }; runId?: string }>();

async function keepReplayClip(root: string, profile: string): Promise<void> {
  const clip = replayClips.get(profile);
  if (!clip) return;
  replayClips.delete(profile);
  if (!clip.runId) return;
  const src = await clip.video.path().catch(() => "");
  if (!src || !existsSync(src)) return;
  const dest = path.join(root, "videos", `${clip.runId}.webm`);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function captureStepLabel(step: { label: string; note?: string }): string {
  const text = step.note ? `${step.label} — ${step.note}` : step.label;
  return visibleCopy(text);
}

function stepHealChoice(value: string | null | undefined): "auto" | "ask" | "never" | undefined {
  if (value === "auto" || value === "ask" || value === "never") return value;
  return undefined;
}

interface LoginGate {
  baoProfile: string;
  sites: SiteStore;
  closeSignIn: () => Promise<void>;
}

async function runWorkflow(
  library: Library,
  workflow: WorkflowV2,
  args: ReplayArgs,
  notices: Notice[],
  replays: Map<string, { context: BrowserContext; page: Page; profile: string }>,
  prompts?: PersonPrompts,
  gate?: LoginGate,
  fromStep?: string,
) {
  if (gate) {
    const gated = await gateSavedLogin(library, workflow, args, notices, replays, prompts, gate, fromStep);
    if (gated) return gated;
  }
  return runRecorded(library, workflow, args, notices, replays, prompts, gate?.baoProfile, fromStep);
}

async function gateSavedLogin(
  library: Library,
  workflow: WorkflowV2,
  args: ReplayArgs,
  notices: Notice[],
  replays: Map<string, { context: BrowserContext; page: Page; profile: string }>,
  prompts: PersonPrompts | undefined,
  gate: LoginGate,
  fromStep?: string,
) {
  await gate.closeSignIn();
  const origin = httpOrigin(workflow.startUrl);
  if (!origin || !gate.sites.has(origin)) return null;
  const config = gate.sites.get(origin);
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const headless = process.env.BAO_HEADED !== "1";
  await releaseProfile(replays, gate.baoProfile);
  const outcome = await runIfSignedIn({
    enabled: true,
    signInUrl: config.probeUrl || workflow.startUrl,
    runId,
    probe: async () => {
      try {
        const judged = await probeOwnedProfile({ baoProfile: gate.baoProfile, config, headless });
        gate.sites.recordProbe(origin, judged.signedIn);
        return judged;
      } catch (err) {
        gate.sites.recordProbe(origin, false);
        throw err;
      }
    },
    run: () => runRecorded(library, workflow, args, notices, replays, prompts, gate.baoProfile, fromStep),
  });
  if (isNeedsSignIn(outcome)) {
    library.saveRun({
      id: outcome.runId,
      workflowId: workflow.id,
      status: outcome.status,
      at: Date.now(),
      heals: [],
      steps: [],
      failure: { reason: outcome.message },
    });
    return { ...outcome, mode: effectiveMode(workflow, library.settings()) };
  }
  return outcome;
}

function persistedRun(
  result: RunResult,
  workflow: WorkflowV2,
  args: ReplayArgs,
  extra: {
    promotion: unknown;
    recorded: { wrote: boolean };
    videoStartedAt: number;
    secretList: string[];
  },
): Parameters<Library["saveRun"]>[0] {
  const wall = result.pausedKind === "wall";
  return JSON.parse(maskText(JSON.stringify({
    id: result.runId,
    workflowId: workflow.id,
    status: wall ? "needs_human" : result.status,
    at: Date.now(),
    heals: result.heals,
    failure: result.failure,
    steps: result.steps,
    repairs: result.repairs,
    receipts: result.receipts,
    trail: result.trail,
    precondition: result.precondition,
    trajectory: result.trajectory,
    console: result.console,
    network: result.network,
    promotion: extra.promotion,
    modelCalls: result.modelCalls,
    pageClasses: result.pageClasses,
    inputs: maskedInputs(workflow, args),
    ...(result.outputs ? { outputs: result.outputs } : {}),
    ...(wall ? {
      envelope: {
        status: "needs_human",
        run_id: result.runId,
        step: result.pausedStepId,
        reason: result.ask?.instruction,
        ask: result.ask?.instruction,
        deadline: result.ask?.deadline ? formatClock(result.ask.deadline) : "No timeout",
      },
    } : {}),
    ...(extra.recorded.wrote ? { video: `${result.runId}.webm`, videoStartedAt: extra.videoStartedAt } : {}),
  }), extra.secretList)) as Parameters<Library["saveRun"]>[0];
}

function hostGrantError(err: unknown): boolean {
  if (err instanceof HostGrantNeeded) return true;
  return err instanceof Error && isHostGrantMessage(err.message);
}

function grantText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return hostGrantMessage("the site", "timeout");
}

function rememberHostGrant(
  library: Library,
  workflow: WorkflowV2,
  message: string,
  prompts: PersonPrompts | undefined,
  runId: string,
) {
  const step = workflow.steps[0];
  const stepId = step?.id || "open";
  const label = step?.label || "Open the site";
  const ask: HumanAsk = {
    kind: "wall",
    workflowId: workflow.id,
    workflowName: workflow.name,
    stepId,
    stepIndex: 1,
    stepCount: Math.max(1, workflow.steps.length),
    label,
    site: siteHost(workflow.startUrl),
    windowName: "Bao window",
    instruction: message,
    startedAt: Date.now(),
    deadline: null,
    timeoutMs: 0,
    runId,
  };
  const saved = {
    id: runId,
    workflowId: workflow.id,
    status: "needs_human",
    at: Date.now(),
    heals: [],
    steps: [{ id: stepId, status: "paused", label, reason: message }],
    failure: {
      stepId,
      index: step?.index ?? 0,
      intent: step?.intent || label,
      phase: "find",
      reason: message,
      snapshot: {},
    },
    modelCalls: 0,
    envelope: {
      status: "needs_human",
      run_id: runId,
      step: stepId,
      reason: message,
      ask: message,
      deadline: "No timeout",
    },
  };
  library.saveRun(saved);
  prompts?.showAsk?.(ask);
  return {
    runId,
    id: runId,
    status: "needs_human" as const,
    message,
    reason: message,
    steps: saved.steps,
    heals: [] as unknown[],
    modelCalls: 0,
    envelope: saved.envelope,
  };
}

async function runExtension(
  library: Library,
  workflow: WorkflowV2,
  args: ReplayArgs,
  notices: Notice[],
  prompts: PersonPrompts | undefined,
  link: ExtensionLink,
  fromStep?: string,
) {
  const driver = new ExtensionDriver(link, readGestures(library.root, workflow.id), prompts, (notice) => {
    notices.unshift({ ...notice, id: `n-${notices.length + 1}`, at: Date.now() });
  }, true);
  const secretList = workflow.inputs.flatMap((input) => {
    if (input.type !== "secret") return [];
    const value = args[input.name];
    return typeof value === "string" && value ? [value] : [];
  });
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    if (workflow.startUrl.startsWith("http")) await driver.open(workflow.startUrl);
  } catch (err) {
    if (hostGrantError(err)) return rememberHostGrant(library, workflow, grantText(err), prompts, runId);
    throw err;
  }
  const heal = await healProvider(secretList);
  const receiptLog = new ReceiptLog(path.join(library.root, "trails", `${workflow.id}.receipts.jsonl`));
  const shotDir = path.join(library.root, "shots", "runs", runId);
  const settings = library.settings();
  const recent = library.listRuns().filter((run) => run.workflowId === workflow.id);
  const reviewSteps = new Set(stepsNeedingReview(recent as Parameters<typeof stepsNeedingReview>[0]).map((item) => item.stepId));
  let result: Awaited<ReturnType<typeof replay>>;
  try {
    result = await replay(workflow, args, driver, {
      runId,
      shotDir,
      settings,
      heal,
      now: () => Date.now(),
      receipts: receiptLog,
      fromStepId: fromStep,
      reviewSteps,
      circuitOpen: circuitOpen(recent, Date.now(), { limit: settings.circuitLimit, windowMs: settings.circuitWindowMs }),
      siteTrust: trustMode(settings, originOf(workflow.startUrl)),
      holdForPerson: process.env.BAO_PROOF_PAGE !== "1",
      onPause: (partial) => {
        library.saveRun(persistedRun(partial, workflow, args, {
          promotion: undefined,
          recorded: { wrote: false },
          videoStartedAt: Date.now(),
          secretList,
        }));
      },
    });
  } finally {
    await driver.end();
  }
  if (result.failure && isHostGrantMessage(result.failure.reason)) {
    return rememberHostGrant(library, workflow, result.failure.reason, prompts, result.runId);
  }
  spillBinaryShots(result, shotDir);
  for (const repair of result.repairs) library.appendTrail(workflow.id, { kind: "repair", ts: Date.now(), ...repair });
  for (const receipt of result.receipts) library.appendTrail(workflow.id, receipt);
  const promotion = recordProvisional(library, workflow, result.heals);
  const saved = persistedRun(result, workflow, args, {
    promotion,
    recorded: { wrote: false },
    videoStartedAt: Date.now(),
    secretList,
  });
  library.saveRun(saved);
  if (result.status !== "paused") clearPendingPrompt(library.root);
  return { ...result, promotion, mode: effectiveMode(workflow, library.settings()), fileProof: driver.proofs };
}

async function runRecorded(
  library: Library,
  workflow: WorkflowV2,
  args: ReplayArgs,
  notices: Notice[],
  replays: Map<string, { context: BrowserContext; page: Page; profile: string }>,
  prompts?: PersonPrompts,
  profileDir?: string,
  fromStep?: string,
  link?: ExtensionLink,
) {
  const refusal = replayRefusal(workflow.driver, { extensionLinked: Boolean(link) });
  if (refusal) throw new Error(refusal);
  if (link && workflowDriver(workflow) === "extension") return runExtension(library, workflow, args, notices, prompts, link, fromStep);
  const session = await openReplay(library, workflow.id, replays, profileDir);
  const page = session.page;
  const driver = new BrowserDriver(page, (notice) => {
    notices.unshift({ ...notice, id: `n-${notices.length + 1}`, at: Date.now() });
  }, prompts);
  driver.markStep("open");
  if (workflow.startUrl.startsWith("http")) await navigateOwned(page, workflow.startUrl);
  const secretList = workflow.inputs.flatMap((input) => {
    if (input.type !== "secret") return [];
    const value = args[input.name];
    return typeof value === "string" && value ? [value] : [];
  });
  const heal = await healProvider(secretList);
  const receiptLog = new ReceiptLog(path.join(library.root, "trails", `${workflow.id}.receipts.jsonl`));
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const clip = replayClips.get(session.profile);
  if (clip) clip.runId = runId;
  const shotDir = path.join(library.root, "shots", "runs", runId);
  const videoStartedAt = Date.now();
  const video = await openReplayVideo(pidsForDataDir(session.profile), path.join(library.root, "videos", `${runId}.webm`));
  const settings = library.settings();
  const recent = library.listRuns().filter((run) => run.workflowId === workflow.id);
  const reviewSteps = new Set(stepsNeedingReview(recent as Parameters<typeof stepsNeedingReview>[0]).map((item) => item.stepId));
  let result: Awaited<ReturnType<typeof replay>>;
  let recorded = { wrote: false, frames: 0 };
  try {
    result = await replay(workflow, args, driver, {
      runId,
      shotDir,
      settings,
      heal,
      now: () => Date.now(),
      receipts: receiptLog,
      fromStepId: fromStep,
      reviewSteps,
      circuitOpen: circuitOpen(recent, Date.now(), { limit: settings.circuitLimit, windowMs: settings.circuitWindowMs }),
      siteTrust: trustMode(settings, originOf(workflow.startUrl)),
      // The desktop waits. The proof scores the pause and must not sit on a bot wall.
      holdForPerson: process.env.BAO_PROOF_PAGE !== "1",
      onPause: (partial) => {
        library.saveRun(persistedRun(partial, workflow, args, {
          promotion: undefined,
          recorded: { wrote: false },
          videoStartedAt,
          secretList,
        }));
      },
    } satisfies ReplayOptions);
  } finally {
    recorded = await video.stop();
  }
  spillBinaryShots(result, shotDir);
  for (const repair of result.repairs) {
    library.appendTrail(workflow.id, { kind: "repair", ts: Date.now(), ...repair });
  }
  for (const receipt of result.receipts) {
    library.appendTrail(workflow.id, receipt);
  }
  const promotion = recordProvisional(library, workflow, result.heals);
  const saved = persistedRun(result, workflow, args, { promotion, recorded, videoStartedAt, secretList });
  library.saveRun(saved);
  if (result.status !== "paused") clearPendingPrompt(library.root);
  const hold = Number(process.env.BAO_REPLAY_HOLD_MS || 0);
  if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
  const bounds = await readOwnedWindow(page).catch(() => null);
  if (bounds) library.writeBounds(workflow.id, bounds);
  return { ...result, promotion, mode: effectiveMode(workflow, library.settings()), fileProof: driver.proofs, bounds };
}

async function openReplay(
  library: Library,
  id: string,
  replays: Map<string, { context: BrowserContext; page: Page; profile: string }>,
  fixedDir?: string,
): Promise<{ context: BrowserContext; page: Page; profile: string }> {
  const existing = replays.get(id);
  const sameDir = Boolean(existing && fixedDir && path.resolve(existing.profile) === path.resolve(fixedDir));
  if (existing && !existing.page.isClosed() && (!fixedDir || sameDir)) return existing;
  if (existing) {
    await existing.context.close().catch(() => undefined);
    if (!sameDir) await rm(existing.profile, { recursive: true, force: true }).catch(() => undefined);
    replays.delete(id);
  }
  if (fixedDir) {
    for (const session of replays.values()) {
      if (session.page.isClosed()) continue;
      if (path.resolve(session.profile) !== path.resolve(fixedDir)) continue;
      replays.set(id, session);
      return session;
    }
  }
  const profile = fixedDir ?? await mkdtemp(path.join(tmpdir(), "bao-replay-"));
  if (fixedDir) mkdirSync(profile, { recursive: true });
  const record = process.env.BAO_RUN_VIDEO === "1";
  const videoDir = record ? path.join(library.root, "videos", "incoming") : undefined;
  if (videoDir) mkdirSync(videoDir, { recursive: true });
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: productHeadless(),
    videoDir,
  });
  const page = context.pages()[0] || await context.newPage();
  const video = page.video();
  if (video) replayClips.set(profile, { video });
  const saved = library.readBounds(id);
  if (saved) await moveOwnedWindow(page, saved).catch(() => undefined);
  const session = { context, page, profile };
  replays.set(id, session);
  return session;
}

async function placeReplayWindow(page: Page, profile: string, want: WindowBounds) {
  const attempts: { method: string; applied: boolean; error?: string; after?: unknown }[] = [];
  try {
    const cdp = await moveOwnedWindow(page, want);
    attempts.push({ method: "cdp", applied: cdp.applied, after: cdp.after });
  } catch (err) {
    attempts.push({ method: "cdp", applied: false, error: err instanceof Error ? err.message : String(err) });
  }
  const helper = process.platform === "darwin" ? bundledHelperApp() : undefined;
  const pid = pidsForDataDir(profile)[0];
  if (helper && pid) {
    try {
      const ax = await new MacOsHelper(helper).moveWindow("", {
        x: want.x, y: want.y, w: want.width, h: want.height,
      }, { pid, frontmost: true });
      const after = ax.after
        ? { x: ax.after.x, y: ax.after.y, width: ax.after.w, height: ax.after.h }
        : null;
      attempts.push({ method: "ax-frontmost", applied: boundsApplied(after, want), after });
    } catch (err) {
      attempts.push({ method: "ax-frontmost", applied: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const after = await readOwnedWindow(page).catch(() => null);
  const applied = boundsApplied(after, want);
  return {
    applied,
    after,
    attempts,
    reason: applied
      ? `window at ${after?.x},${after?.y} ${after?.width}x${after?.height}`
      : `n/a-harness: requested ${want.x},${want.y} ${want.width}x${want.height}; stayed ${after ? `${after.x},${after.y} ${after.width}x${after.height}` : "unread"}`,
  };
}

async function healProvider(secrets: string[] = []): Promise<HealProvider> {
  if (process.env.BAO_HEAL_FIXTURE === "1") {
    return scriptedHeal({
      patch: { identity: { surface: "dom", role: "button", testId: "login", path: [] } },
      model: { provider: "fixture", name: "bao-heal-fixture", version: "1" },
      prompt: "The login control's test id is login. Propose that identity. No coordinates.",
      rawResponse: "{\"identity\":{\"surface\":\"dom\",\"role\":\"button\",\"testId\":\"login\",\"path\":[]}}",
    });
  }
  const cursorResponse = process.env.BAO_HEAL_CURSOR_RESPONSE;
  if (cursorResponse && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return cursorSessionHeal(() => readFileSync(cursorResponse, "utf8"));
  }
  return cursorAccountHeal(process.env, secrets);
}

interface PendingImport {
  id: string;
  domain: string;
  profile?: string;
  phase: "confirm" | "pick" | "running" | "done" | "cancelled" | "error";
  message: string;
  profiles?: ChromeProfile[];
  error?: string;
  audit?: ImportAudit;
}

function writeImportAudit(home: string, audit: ImportAudit): void {
  const auditDir = path.join(home, "audit");
  mkdirSync(auditDir, { recursive: true });
  appendFileSync(path.join(auditDir, "import-login.jsonl"), `${auditLine(audit)}\n`);
}

function publicPending(pending: PendingImport) {
  return {
    id: pending.id,
    domain: pending.domain,
    phase: pending.phase,
    message: pending.message,
    profiles: pending.profiles?.map((profile) => ({ directory: profile.directory, name: profile.name, lastUsed: profile.lastUsed === true })),
    error: pending.error,
    audit: pending.audit,
  };
}

/** Read-only view for the proof harness. Recording and replay are unchanged. */
async function drivePageView(page: Page): Promise<{ url: string; title: string; text: string }> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const text = await page.evaluate(() => {
    const light = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const extra: string[] = [];
    const skip = new Set(["STYLE", "SCRIPT", "NOSCRIPT"]);
    const hidden = (el: Element) => {
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
      const style = getComputedStyle(el);
      return style.display === "none" || style.visibility === "hidden";
    };
    const collect = (node: Node): void => {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (skip.has(el.tagName) || hidden(el)) return;
        if (el.shadowRoot) collect(el.shadowRoot);
      }
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const bit = (child.textContent || "").replace(/\s+/g, " ").trim();
          if (bit) extra.push(bit);
        } else {
          collect(child);
        }
      }
    };
    const root = document.body;
    if (root) {
      for (const child of root.querySelectorAll("*")) {
        if (child.shadowRoot && !hidden(child)) collect(child.shadowRoot);
      }
    }
    const strip = (document.getElementById("bao-control-strip")?.innerText || "").replace(/\s+/g, " ").trim();
    return `${strip} ${light} ${extra.join(" ")}`.replace(/\s+/g, " ").trim().slice(0, 20000);
  }).catch(() => "");
  return { url, title, text };
}

async function siteSignals(page: Page): Promise<{ url: string; hasPassword: boolean }> {
  const raw = page.url();
  let url = "";
  try {
    const parsed = new URL(raw);
    url = `${parsed.origin}${parsed.pathname}`;
  } catch {
    url = "";
  }
  const hasPassword = await page.locator("input[type=password]").count().then((count) => count > 0).catch(() => false);
  return { url, hasPassword };
}

async function namedControls(page: Page, names: string[]): Promise<{ role: string; name: string; id: string; testId: string; tag: string }[]> {
  return page.evaluate((wanted) => {
    const exact = new Set(wanted.map((name) => name.toLowerCase()));
    const out: { role: string; name: string; id: string; testId: string; tag: string }[] = [];
    for (const el of document.querySelectorAll("button, a, label, [role=radio], [role=button], input")) {
      const name = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (!exact.has(name.toLowerCase()) || name.length > 40) continue;
      out.push({
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name,
        id: (el as HTMLElement).id || "",
        testId: el.getAttribute("data-testid") || "",
        tag: el.tagName.toLowerCase(),
      });
    }
    return out;
  }, names);
}

async function shortTexts(page: Page, phrases: string[]): Promise<string[]> {
  return page.evaluate((wanted) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const el of document.querySelectorAll("body *")) {
      const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 80) continue;
      const lower = text.toLowerCase();
      if (!wanted.some((phrase) => lower.includes(phrase.toLowerCase()))) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(text);
      if (out.length >= 8) break;
    }
    return out;
  }, phrases);
}

function looksPersonal(text: string): boolean {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return true;
  if (/\d{6,}/.test(text)) return true;
  return false;
}

async function clipForPhrase(page: Page, phrase: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const box = await page.evaluate((wanted) => {
    let best: { length: number; x: number; y: number; width: number; height: number } | null = null;
    for (const el of document.querySelectorAll("body *")) {
      const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (!text.toLowerCase().includes(wanted.toLowerCase()) || text.length > 160) continue;
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      if (!best || text.length < best.length) {
        best = { length: text.length, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    if (!best) return null;
    return { x: best.x, y: best.y, width: Math.min(best.width, 640), height: Math.min(best.height, 240) };
  }, phrase);
  if (!box) return null;
  return {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: box.width,
    height: box.height,
  };
}

function recordProvisional(library: Library, workflow: WorkflowV2, heals: HealRecord[]): Promotion | undefined {
  const heal = [...heals].reverse().find((item) => item.postconditionPassed && item.proposedPatch);
  if (!heal?.proposedPatch) return undefined;
  const before = workflow.steps.find((step) => step.id === heal.failedStep.id) || heal.failedStep;
  const promotion = openProvisional({
    healId: heal.id,
    workflowId: workflow.id,
    stepId: heal.failedStep.id,
    patch: heal.proposedPatch,
    before,
    need: library.settings().promoteAfter,
  });
  const drafted = draftVersion(library, keepPatch(workflow, heal.failedStep.id, heal.proposedPatch, { at: Date.now(), runId: heal.runId, score: 100 }), "heal");
  const stored = { ...promotion, version: drafted.n };
  library.savePromotion(stored);
  library.appendTrail(workflow.id, promotionEvent(promotion, Date.now()));
  return promotion;
}

async function checkPromotion(library: Library, id: string, notices: Notice[]): Promise<Promotion> {
  const current = library.readPromotion(id) as (Promotion & { version?: number }) | undefined;
  if (!current || current.status !== "provisional") throw new Error("no provisional heal");
  const candidate = current.version ? versionDocument(library, id, current.version) : library.read(id);
  const args = defaultArgs(candidate);
  let driftOk = true;
  for (const change of driftChanges) {
    if (!await replayChanged(candidate, args, change)) {
      driftOk = false;
      break;
    }
  }
  let promotion = noteDrift(current, driftOk);
  library.savePromotion(promotion);
  library.appendTrail(id, promotionEvent(promotion, Date.now()));
  if (promotion.status === "reverted") return promotion;
  const required = library.settings().promoteAfter;
  for (let i = 0; i < required && promotion.status === "provisional"; i++) {
    const passed = await replayChanged(candidate, args, { query: "" });
    promotion = noteReplay(promotion, passed, required);
    library.savePromotion(promotion);
    library.appendTrail(id, promotionEvent(promotion, Date.now()));
    if (promotion.status === "reverted") return promotion;
  }
  if (promotion.status === "promoted" && current.version) promoteVersion(library, id, current.version);
  notices.unshift({
    id: `n-${notices.length + 1}`,
    at: Date.now(),
    title: promotion.status === "promoted" ? "Bao promoted a heal" : "Bao reverted a heal",
    body: `${candidate.name}: ${promotion.status}`,
    workflowId: id,
    runId: promotion.healId,
    stepId: promotion.stepId,
  });
  return promotion;
}

const driftChanges: { name: string; query: string; slow?: boolean; scale?: number }[] = [
  { name: "shift", query: "shift=1" },
  { name: "theme", query: "theme=dark" },
  { name: "font", query: "font=big" },
  { name: "order", query: "order=flip" },
  { name: "slow", query: "", slow: true },
  { name: "scale-2x", query: "", scale: 2 },
];

function defaultArgs(workflow: WorkflowV2): ReplayArgs {
  const args: ReplayArgs = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret" || input.type === "file" || !input.default) continue;
    args[input.name] = input.type === "number" ? Number(input.default) : input.default;
  }
  return args;
}

async function replayChanged(
  workflow: WorkflowV2,
  args: ReplayArgs,
  change: { query: string; slow?: boolean; scale?: number },
): Promise<boolean> {
  const profile = await mkdtemp(path.join(tmpdir(), "bao-promote-"));
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: true,
    deviceScaleFactor: change.scale,
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    if (change.slow) {
      await page.route("**/*", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.continue();
      });
    }
    const startUrl = withChange(workflow.startUrl, change.query);
    await page.goto(startUrl);
    const result = await replay({ ...workflow, startUrl }, args, new BrowserDriver(page), { heal: unavailableHeal() });
    return result.status === "passed";
  } finally {
    await context.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

function withChange(startUrl: string, query: string): string {
  const url = new URL(startUrl);
  if (query) new URLSearchParams(query).forEach((value, key) => url.searchParams.set(key, value));
  return url.toString();
}

function keptInputs(workflow: WorkflowV2, args: ReplayArgs): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret" || input.type === "file") continue;
    const value = args[input.name];
    if (typeof value === "string" || typeof value === "number") out[input.name] = value;
  }
  return out;
}

function summary(doc: WorkflowV2) {
  return {
    id: doc.id,
    name: doc.name,
    summary: doc.summary,
    intent: doc.intent,
    steps: doc.steps.length,
    inputs: doc.inputs,
    heal: doc.heal,
    heals: doc.steps.filter((step) => step.label.startsWith("healed")).length,
    replayed: doc.replayed,
    waits: doc.steps.filter((step) => step.action === "login" || step.action === "confirm").length,
    expects: doc.steps.filter((step) => step.action === "verify" || step.expect || step.readBack).length,
    firstStep: doc.steps[0] ? { action: doc.steps[0].action, label: doc.steps[0].label } : undefined,
    startUrl: doc.startUrl,
    driver: refusesOwnedBrowser(doc.driver) ? doc.driver : workflowDriver(doc),
  };
}

function sameTarget(current: string, startUrl: string): boolean {
  try {
    const left = new URL(current);
    const right = new URL(startUrl);
    return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search;
  } catch {
    return false;
  }
}

function sendVideo(req: IncomingMessage, res: ServerResponse, file: string): void {
  const size = statSync(file).size;
  const asked = byteRange(req.headers.range, size);
  if (req.headers.range && !asked) {
    res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
    res.end();
    return;
  }
  if (size === 0) {
    res.writeHead(200, { "content-type": "video/webm", "content-length": 0, "accept-ranges": "bytes", "cache-control": "no-store" });
    res.end();
    return;
  }
  const start = asked?.start ?? 0;
  const end = asked?.end ?? size - 1;
  const headers: Record<string, number | string> = {
    "content-type": "video/webm",
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    "cache-control": "no-store",
  };
  if (asked) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(asked ? 206 : 200, headers);
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

/** A single `bytes=` range. Unparseable or multipart ranges return null. */
function byteRange(header: string | string[] | undefined, size: number): { start: number; end: number } | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match) return null;
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (startRaw === "" && endRaw === "") return null;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw === "" ? size - 1 : Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function readLiveSessionFile(root: string): ReturnType<typeof publicLiveSession> {
  try {
    return publicLiveSession(JSON.parse(readFileSync(path.join(root, "live-session", "session.json"), "utf8")));
  } catch {
    return null;
  }
}

function sendPng(res: ServerResponse, file: string): void {
  if (!/^[\w.-]+\.png$/.test(path.basename(file)) || !existsSync(file)) {
    json(res, { error: "no picture" }, 404);
    return;
  }
  res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
  res.end(readFileSync(file));
}

function newestPng(dir: string): string | undefined {
  if (!existsSync(dir)) return;
  const ranked = readdirSync(dir)
    .filter((name) => /^[\w.-]+\.png$/.test(name))
    .map((name) => {
      const file = path.join(dir, name);
      return { file, mtime: statSync(file).mtimeMs, after: name.endsWith("-after.png"), cropped: croppedPng(file) };
    })
    .filter((item) => item.cropped)
    .sort((a, b) => Number(b.after) - Number(a.after) || b.mtime - a.mtime);
  return ranked[0]?.file;
}

/** A run poster may still be an element crop. The workflow card does not use this. */
function croppedPng(file: string): boolean {
  return isElementCrop(readFileSync(file));
}

/** The card poster is the full-page file. An element crop is not a stand-in. */
function workflowPoster(dir: string): string | undefined {
  const file = path.join(dir, "poster.png");
  if (!existsSync(file)) return;
  const bytes = readFileSync(file);
  if (!selectCardPoster([{ name: "poster.png", bytes }])) return;
  return file;
}

function spillBinaryShots(result: { heals: HealRecord[]; failure?: { snapshot?: { screenshot?: string; screenshotRef?: string } } }, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const write = (name: string, b64?: string): string | undefined => {
    if (!b64 || !b64.startsWith("iVBORw0KGgo")) return;
    const buf = Buffer.from(b64, "base64");
    if (buf.length < 24 || buf[0] !== 0x89) return;
    const file = path.basename(name);
    if (!/^[\w.-]+\.png$/.test(file)) return;
    writeFileSync(path.join(dir, file), buf);
    return file;
  };
  for (const heal of result.heals) {
    const before = write(shotFile(heal.id, "before"), heal.beforeShot);
    if (before) heal.beforeShot = before;
    const after = write(shotFile(heal.id, "after"), heal.snapshot?.screenshot);
    if (after && heal.snapshot) heal.snapshot = { ...heal.snapshot, screenshot: undefined, screenshotRef: after };
  }
  const failed = write("failure.png", result.failure?.snapshot?.screenshot);
  if (failed && result.failure?.snapshot) {
    result.failure.snapshot = { ...result.failure.snapshot, screenshot: undefined, screenshotRef: failed };
  }
}

function slimRun(run: ReturnType<Library["readRun"]>) {
  const { outputs: _outputs, ...withoutOutputs } = run;
  const steps = Array.isArray(withoutOutputs.steps) ? withoutOutputs.steps.map((step) => {
    const row = step as { beforeShot?: string; afterShot?: string };
    const { beforeShot, afterShot, ...kept } = row;
    void beforeShot;
    void afterShot;
    return kept;
  }) : [];
  const failure = run.failure && typeof run.failure === "object"
    ? { ...(run.failure as Record<string, unknown>), snapshot: undefined, beforeShot: undefined }
    : run.failure;
  const heals = Array.isArray(run.heals) ? run.heals.map((heal) => {
    const row = heal as { snapshot?: unknown; beforeShot?: string };
    return { ...row, snapshot: undefined, beforeShot: undefined };
  }) : [];
  return { ...withoutOutputs, steps, failure, heals };
}

function maskedInputs(workflow: WorkflowV2, args: ReplayArgs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of workflow.inputs) {
    const value = args[input.name];
    if (input.type === "secret") out[input.name] = value ? "••••" : "";
    else if (value && typeof value === "object" && !Array.isArray(value) && "name" in value) out[input.name] = String((value as { name?: string }).name || "");
    else if (Array.isArray(value)) out[input.name] = value.map((file) => file && typeof file === "object" && "name" in file ? String(file.name) : "").filter(Boolean).join(", ");
    else out[input.name] = value === undefined || value === null ? "" : String(value);
  }
  return out;
}

function helperStatus(report: unknown): HelperStatus {
  const platform = process.platform;
  const row = report as { accessibility?: boolean; screenCapture?: boolean } | undefined;
  return capabilityReport({
    platform,
    helperPresent: platform === "darwin" && !!bundledHelperApp(),
    accessibility: row?.accessibility === true,
    screenCapture: row?.screenCapture === true,
  });
}

function modelStatus(): { label: string } {
  if (process.env.BAO_HEAL_FIXTURE === "1") return { label: "fixture model" };
  const account = cursorAccountModelLabel();
  if (account) return { label: account };
  if (process.env.BAO_HEAL_CURSOR === "1") return { label: "fixture model" };
  if (process.env.XAI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) return { label: "model ready" };
  return { label: "no model" };
}

let bundledClient = "";
async function browserScript(): Promise<string> {
  if (bundledClient) return bundledClient;
  const prebuilt = path.join(__dirname, "app.js");
  if (existsSync(prebuilt)) {
    bundledClient = readFileSync(prebuilt, "utf8");
    return bundledClient;
  }
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    absWorkingDir: sourceRoot,
    entryPoints: ["desktop/src/app/client.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    target: "es2022",
  });
  bundledClient = result.outputFiles[0]?.text || "";
  return bundledClient;
}

async function materializeFiles(args: ReplayArgs): Promise<ReplayArgs> {
  const out: ReplayArgs = { ...args };
  for (const [key, value] of Object.entries(out)) {
    const file = value as { name?: string; base64?: string; path?: string };
    if (!file || typeof file !== "object" || !file.base64 || !file.name) continue;
    const dir = await mkdtemp(path.join(tmpdir(), "bao-file-"));
    const dest = path.join(dir, file.name);
    await writeFile(dest, Buffer.from(file.base64, "base64"));
    out[key] = { name: file.name, path: dest };
  }
  return out;
}

function writeLogin(res: ServerResponse, body: unknown, cookies: string[]): void {
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "set-cookie": cookies,
  });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, file: string, type: string): void {
  const body = readFileSync(file);
  res.writeHead(200, { "content-type": type });
  res.end(body);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface LoginBody {
  site?: string;
  consent?: boolean;
  profile?: string;
  probeUrl?: string;
  signedInSelector?: string;
  signedInText?: string;
  botCookies?: BotCookiePolicy;
  origins?: string[] | string;
  origin?: string;
}

function clickFrom(body: LoginBody): ClickInput {
  if (body.consent !== true) throw new ConsentRequired();
  return { site: body.site, clicked: true };
}

function publicSite(site: SiteLoginConfig): SiteLoginConfig & { lastProbeLabel: string | null } {
  return {
    ...site,
    lastProbeLabel: typeof site.lastProbeAt === "number" ? formatProbeTime(site.lastProbeAt) : null,
  };
}

function siteConfig(body: Partial<SiteLoginConfig> & LoginBody, prior?: SiteLoginConfig): SiteLoginConfig {
  return {
    origin: body.origin || body.site || "",
    probeUrl: body.probeUrl || "",
    signedInSelector: body.signedInSelector || "",
    signedInText: body.signedInText || "",
    botCookies: body.botCookies === "include" ? "include" : "skip",
    origins: listedOrigins(body.origins, []),
    lastProbeAt: prior?.lastProbeAt ?? null,
    signedIn: prior?.signedIn ?? null,
  };
}

function rememberSite(store: SiteStore, body: LoginBody): SiteLoginConfig {
  const origin = siteOrigin(body.site || "");
  const prior = store.get(origin);
  return store.save({
    origin,
    probeUrl: chosenProbe(body.probeUrl, body.site, origin, prior.probeUrl),
    signedInSelector: body.signedInSelector ?? prior.signedInSelector,
    signedInText: body.signedInText ?? prior.signedInText,
    botCookies: body.botCookies === "include" || body.botCookies === "skip" ? body.botCookies : prior.botCookies,
    origins: listedOrigins(body.origins, prior.origins),
    lastProbeAt: prior.lastProbeAt ?? null,
    signedIn: prior.signedIn ?? null,
  });
}

function chosenProbe(probe: string | undefined, site: string | undefined, origin: string, prior: string): string {
  const typed = probe?.trim();
  if (typed) return typed;
  const page = site?.trim();
  if (page && page !== origin) {
    try {
      const url = new URL(page);
      if (url.protocol === "http:" || url.protocol === "https:") return page;
    } catch {
      // The site field is checked separately. An empty probe falls back.
    }
  }
  return prior || origin;
}

function listedOrigins(value: string[] | string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  const raw = Array.isArray(value) ? value : value.split(/[\s,]+/);
  return raw.map((item) => item.trim()).filter(Boolean);
}

async function resolveLoginKeys(loginKeys: KeySources | (() => KeySources | Promise<KeySources>) | undefined): Promise<KeySources> {
  if (!loginKeys) return readPlatformKeys();
  return typeof loginKeys === "function" ? loginKeys() : loginKeys;
}

function httpOrigin(startUrl: string): string | null {
  try {
    return siteOrigin(startUrl);
  } catch {
    return null;
  }
}

async function releaseProfile(
  replays: Map<string, { context: BrowserContext; page: Page; profile: string }>,
  dir: string,
): Promise<void> {
  const resolved = path.resolve(dir);
  for (const [id, session] of replays) {
    if (path.resolve(session.profile) !== resolved) continue;
    await session.context.close().catch(() => undefined);
    replays.delete(id);
  }
}

function readBody(req: IncomingMessage, text = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (text) return resolve(raw);
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
  });
}
