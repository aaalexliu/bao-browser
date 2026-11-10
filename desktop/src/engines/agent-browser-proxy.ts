import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { CDP_PROGRESS_CEILING_MS, connectCdp, type CdpSocket } from "../cdp-live/socket";
import { openCurrentChrome, openTaskTab, type CurrentChrome } from "../cdp-live/current-chrome";
import { isChromeTab, type ChromeTarget } from "../cdp-live/chrome-tabs";
import { openRunningChrome, type RunningChrome } from "../extension/running-chrome";
import { focusOwnedHandoff, resolveNormalChrome } from "../launch";
import { AgentBrowserRun, type AgentBrowserTaskOutcome, type RecordedAgentBrowserCommand, type StepContext } from "./agent-browser-record";
import { CURRENT_CHROME_ENDED, CURRENT_CHROME_LEFT_OPEN, newInRead, ownerReply, RUN_ENDED, TASK_TAB_CLOSED, type OwnerWaitPage } from "./agent-browser-describe";
import { BROWSER_PICTURE_BYTES, type ShotBox } from "../v1/shots";
import { agentBrowserExecutable } from "./agent-browser";
import { AgentBrowserWorkflow } from "./agent-browser-workflow";
import { chromeProfilesRoot, openCopiedChromeForProxy } from "./chrome-profile-copy";
import { ChromeFolderDenied } from "../chrome-access";
import { baoAgentProfileDir, openBaoChromeForProxy, type SignInImport } from "./bao-profile";
import { baoPick, boundOpenPlan, boundRoute, chromeApp, ChromeProfileQuestion, chooseChromeProfile, failedPickLine, fallbackPlan, fallsBack, openOrFallBack, pickLine, RoutesFailed, shortPickLine, signInLine, signInSource, type BrowserPick, type BrowserPlan, type RouteWhy } from "./browser-pick";
import { BOUND_REASON, boundSite, purgeBoundSites } from "./bound-sign-in";
import { OWNER_WAIT_LIMIT_MS, ownerWall, ownerCanResume, ownerTask, ownerWaitTimeout, ownerWaitInstruction, type OwnerPage } from "../cdp-live/owner-wait";
import { pageWall } from "../cdp-live/page-wall";
import { BROWSER_CHOICES, DEFAULT_BROWSER } from "../browser-choice";
import { targetBox } from "../v1/caption";
import { diffView, findView, snapshotView } from "./snapshot-view";
import { AGENT_IDLE_REASON, NEWER_TASK_REASON } from "../v1/stop-copy";
import { openBackgroundCdp, type BackgroundCdp } from "./background-cdp";

export const AGENT_BROWSER_COMMANDS = ["open", "snapshot", "click", "fill", "press", "scroll", "tab", "screenshot", "wait_for_owner", "close"] as const;
export type AgentBrowserCommand = typeof AGENT_BROWSER_COMMANDS[number];
export interface AgentBrowserCommandResult { stdout: string; stderr: string; exitCode: number }

const SESSION_IDLE_MS = 10 * 60 * 1000;

const FIXED_OPTIONS = new Set([
  "--session", "--namespace", "--profile", "--executable-path", "--headed", "--cdp", "--auto-connect",
  "--provider", "-p", "--engine", "--config", "--args", "--idle-timeout", "--all", "--pin-tab", "--no-pin-tab",
]);

/** One MCP process serves every chat, so a call that acts on a session names the run it belongs to. */
const runIdNeeded = (command: string) => `run_id is required on ${command} while a browser session is open. Send back the run id from this chat's latest agent_browser result; a chat whose results named no run has no session here.`;
const OTHER_TASK = "The browser now belongs to another task, so stop here.";

export function otherTaskClosed(runId: string): string {
  return `${RUN_ENDED} Run ${runId} is not Bao's open browser session. ${OTHER_TASK}`;
}

/** One row of the native `tab list --json`. */
type NativeTab = { tabId?: string; targetId?: string; label?: string | null; active?: boolean };

export function validateAgentBrowserCommand(command: unknown, args: unknown): asserts args is string[] {
  if (!AGENT_BROWSER_COMMANDS.includes(command as AgentBrowserCommand)) throw new Error("unknown agent-browser command");
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) {
    throw new Error("agent-browser args must be an array of strings");
  }
  if (args.some((arg) => FIXED_OPTIONS.has(arg.split("=", 1)[0]!))) {
    throw new Error("Bao fixes the agent-browser session, browser, headed mode, profile, and lifetime");
  }
}

export const AGENT_BROWSERS = BROWSER_CHOICES;

export type AgentBrowser = typeof AGENT_BROWSERS[number];

/** A side panel, internal page, or non-page target cannot be captured. The task tab can. */
export function uncapturablePage(url: string | undefined, type: string | undefined): boolean {
  if (type && type !== "page") return true;
  if (!url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return true; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  return parsed.pathname === "/glic" || parsed.pathname.startsWith("/glic/");
}

const TASK_TAB_PICTURE = "The active tab could not be pictured, so Bao kept a picture of its task tab.";
const OWNER_PRIVATE = "owner input is private";

class ActiveTargetMiss extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ActiveTargetMiss";
  }
}

/** The pinned task tab is gone and no Bao task tab remains to take its place. */
class TaskTabClosed extends Error {
  constructor() {
    super(TASK_TAB_CLOSED);
    this.name = "TaskTabClosed";
  }
}

function privatePicture(error: unknown): boolean {
  return error instanceof Error && error.message === OWNER_PRIVATE;
}

function webSite(value: string | undefined): string | undefined {
  try {
    if (!value) return undefined;
    const url = new URL(value.includes("://") || /^(about|file|data|chrome|javascript):/i.test(value) ? value : `https://${value}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

/** The browser a later open is compared with: the route that actually opened. The extension counts as running Chrome. */
function openedChoice(pick: BrowserPick): AgentBrowser {
  return pick.route === "bao" || pick.route === "copy" ? pick.route : "current";
}

/** A command's move to the owner's running Chrome: the line that says so, and the new pick and opened page when it worked. */
type Moved = { line: string; pick?: BrowserPick; site?: string };

interface SessionData {
  browser: AgentBrowser;
  /** The site the latest open asked for. A sign-in wall's fallback reopens it. */
  site?: string;
  stateDir: string;
  executable: string;
  flags: string[];
  env: NodeJS.ProcessEnv;
  abort: AbortController;
  recording: AgentBrowserRun;
  workflow: AgentBrowserWorkflow;
  ownerWait?: { targetId: string; page: OwnerPage } | "pending";
  /** Chrome's own URL and title for the active tab, from the latest metadata read. */
  page?: OwnerPage;
  /** The latest sign-in or check page, kept for the owner-wait card. */
  ownerPage?: OwnerPage;
  /** When Bao first stopped for the current or latest owner handoff. */
  ownerSince?: number;
  /** When Bao stopped for the owner, or the latest wait_for_owner call returned; the wait limit counts from here. */
  ownerTouched?: number;
  /** Why a Bao-profile session could not move to the owner's running Chrome. Only an explicit wait_for_owner tries again. */
  moveError?: string;
  missed?: string;
  /** Whether Bao brought the waiting window on top of the owner's apps for the latest handoff. */
  raised?: boolean;
  commandDone?: Promise<void>;
  closing?: boolean;
  removing?: Promise<void>;
  outcome?: AgentBrowserTaskOutcome;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** The latest native snapshot output for each args list, the baseline of a snapshot diff. */
  snapshots: Map<string, string>;
  daemonStarted?: boolean;
}

/** Whether a native command opens a new tab itself: `tab new`, or a click that opens its link in a new tab. */
const opensTab = (command: string, args: readonly string[]) => (command === "tab" && args[0] === "new") || (command === "click" && args.includes("--new-tab"));

/**
 * The owner's running Chrome over remote debugging. Bao closes only the tabs it opened. `targetId` is the tab the agent works in:
 * Bao's task tab, until the agent switches tabs or its tab opens one. A popup followed from a task tab joins `taskTabs`.
 * `seen` holds every target the native tab list has shown.
 */
type DebuggingChrome = { kind: "current"; relay?: undefined; chrome: CurrentChrome; taskTabs: Set<string>; targetId: string; seen: Set<string>; justClosed?: string };

/** An opened browser, what it runs on and why, and on the owner's Chrome the task tab the native daemon binds to. */
type Opened = { pick: BrowserPick } & (
  /**
   * Bao's own agent Chrome. The native agent reaches it through `background`, which keeps it behind the owner's apps. On a
   * Chrome copy, `targetId` is the background tab Bao opened beside the restored tabs, or the startup tab when Chrome restored none.
   */
  | { kind: "copy"; chrome: OwnedChrome; background: BackgroundCdp; targetId?: string }
  | DebuggingChrome
  /** The owner's running Chrome through the gated Bao extension relay. */
  | { kind: "current"; relay: true; chrome: RunningChrome; targetId: string }
);

type Session = SessionData & Opened;
type OwnedChrome = Awaited<ReturnType<typeof openCopiedChromeForProxy>> | Awaited<ReturnType<typeof openBaoChromeForProxy>>;

/**
 * macOS does not let a Chrome that Bao launched in the background make itself the front app, so Target.activateTarget only
 * lifts its window behind the owner's. A window that comes back from the Dock comes back on top of every app's windows. The
 * owner's app keeps the keyboard until he clicks the window. A zoomed window comes back zoomed. A full-screen window has its
 * own Space, so Bao leaves it. Returns whether the window came back on top.
 */
async function windowOnTop(cdp: CdpSocket, targetId: string): Promise<boolean> {
  const { windowId } = await cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId }, undefined, 2000);
  const { bounds: { windowState } } = await cdp.send<{ bounds: { windowState: string } }>("Browser.getWindowBounds", { windowId }, undefined, 2000);
  if (windowState === "fullscreen") return false;
  const set = (state: string) => cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } }, undefined, 2000);
  if (windowState !== "minimized") await set("minimized");
  await set("normal");
  if (windowState === "maximized") await set("maximized");
  return true;
}

async function behind(chrome: OwnedChrome): Promise<{ chrome: OwnedChrome; background: BackgroundCdp }> {
  try {
    return { chrome, background: await openBackgroundCdp(await readDevToolsActivePort(chrome.target.portFile)) };
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

function ownerWaitPage(session: Session): OwnerPage | undefined {
  const wait = session.ownerWait;
  return wait && wait !== "pending" ? wait.page : session.ownerPage;
}

function ownerWaitOver(session: Session): boolean {
  return !!session.ownerWait && !session.removing && Date.now() - (session.ownerTouched ?? Date.now()) >= OWNER_WAIT_LIMIT_MS;
}

export class AgentBrowserProxy {
  private session: Session | undefined;
  private disconnected = false;
  private starting: Promise<Session> | undefined;
  private startAbort: AbortController | undefined;
  private pendingCloses = 0;
  private latest: { runId: string; step: RecordedAgentBrowserCommand; steps: readonly RecordedAgentBrowserCommand[]; lastPicture?: AgentBrowserRun["lastPicture"] } | undefined;
  private workflowOutcome: string | undefined;

  get lastWorkflowOutcome(): string | undefined { return this.workflowOutcome; }
  get lastCommand(): typeof this.latest { return this.latest; }
  get activeRunId(): string | undefined { return this.session?.recording.id; }
  /** The open session drives the owner's own running Chrome. */
  get currentChrome(): boolean { return this.session?.kind === "current" || this.closedCurrent; }
  /** The sign-in or check page Bao is waiting on, or the latest one it waited on. URL and title only. */
  get ownerPage(): OwnerWaitPage | undefined {
    const session = this.session;
    const page = session && ownerWaitPage(session);
    return page && { ...page, ...(session?.ownerSince !== undefined ? { since: session.ownerSince } : {}) };
  }
  /**
   * What the latest result runs on. An open names the route, Chrome app, user data, and profile and why, and what each sign-in
   * import did; later commands name the route and profile in one short line; an open that failed names what Bao tried.
   */
  get pickLines(): string[] {
    if (this.notOpened) return [this.notOpened];
    if (!this.shown) return [];
    if (this.moved?.pick) return [pickLine(this.moved.pick)];
    const { session, command } = this.shown;
    const failed = this.moved ? [this.moved.line] : [];
    if (command !== "open") return [shortPickLine(session.pick), ...failed];
    const whyMissed = session.missed ? [session.missed] : [];
    const from = session.pick.route === "bao" && session.pick.unread === undefined ? session.pick.profile?.directory : undefined;
    if (!from) return [pickLine(session.pick), ...whyMissed, ...failed];
    const missed = this.imports.some((report) => report.error || !report.found && !report.storage);
    const fallback = missed && !session.ownerWait && !session.moveError ? `If the site still asks for a sign-in, Bao moves this session to the owner's running Chrome over remote debugging on the same Chrome profile "${from}" by itself when it sees the wall or when you call wait_for_owner.` : "";
    return [pickLine(session.pick), ...whyMissed, ...this.imports.map((report) => signInLine(report, from)), ...fallback ? [fallback] : [], ...failed];
  }
  private currentEnded = false;
  /** The last session ended because Bao's task tab was closed, so the next open must name a browser. */
  private taskTabEnded = false;
  private closedCurrent = false;
  /** The session and command of the latest result. */
  private shown: { session: Session; command: string } | undefined;
  /** What a failed open tried. */
  private notOpened: string | undefined;
  /** Sign-in imports the current command ran. */
  private imports: SignInImport[] = [];
  /** The last session ended while a Bao profile or copy waited for the owner, so a Running Chrome open is its fallback. */
  private afterWall = false;
  /** The owner wait Bao ended, until a result says so. */
  private staleWait: string | undefined;
  private endedLine: string | undefined;
  /** The latest result's line about an owner wait Bao ended. */
  get endedWait(): string | undefined { return this.endedLine; }
  /** The reconnect instruction for a run whose owner's Chrome ended or whose task tab closed. */
  private endedRuns = new Map<string, string>();
  private endedByNewer = new Set<string>();
  private refusal: { runId?: string } | undefined;
  /** A command Bao refused because it named no run, or a run that is not the open session. */
  get refused(): { runId?: string } | undefined { return this.refusal; }
  private moved: Moved | undefined;

  constructor(private readonly options: {
    home: string; sourceRoot?: string; executable?: string; keepOpen?: () => boolean; hasHold?: () => boolean;
    /** The Chrome profile folder picked in Bao Settings. On the agent path it is marked when Bao asks for a profile, and it chooses the owner's device-bound purge list on Bao-profile opens. */
    settingsProfile?: () => string | undefined;
    /** The gate for Running Chrome through the Bao extension. Off means remote debugging. */
    extensionRoute?: () => boolean;
  }) {}

  queueClose(args: unknown = [], runId?: unknown): () => void {
    validateAgentBrowserCommand("close", args);
    if (this.session && (typeof runId === "string" ? runId.trim() : runId) !== this.session.recording.id) return () => undefined;
    this.pendingCloses++;
    return () => { this.pendingCloses--; };
  }

  /**
   * Runs one command. `snapshot` asks a snapshot for only the lines a find matches or only what changed since the last snapshot
   * with the same args; the run still records the full native output.
   */
  async execute(command: unknown, args: unknown = [], browser?: unknown, visual = false, profile?: unknown,
    snapshot: { find?: unknown; diff?: unknown } = {}, runId?: unknown): Promise<AgentBrowserCommandResult[]> {
    this.endedLine = undefined;
    this.refusal = undefined;
    this.latest = undefined;
    this.shown = undefined;
    this.notOpened = undefined;
    this.imports = [];
    this.moved = undefined as Moved | undefined;
    this.workflowOutcome = undefined;
    const claimed = typeof runId === "string" ? runId.trim() : undefined;
    if (runId !== undefined && (typeof runId !== "string" || !claimed)) {
      this.refusal = {};
      throw new Error("run_id must be the run id this chat's latest agent_browser result names");
    }
    // A call that does not name the open run must not learn that run from an error, a picture, or a browser line.
    const openRun = this.session?.recording.id;
    const foreign = openRun !== undefined && claimed !== openRun;
    if (foreign) this.refusal = claimed === undefined ? {} : { runId: claimed };
    validateAgentBrowserCommand(command, args);
    const view = snapshotView(command, snapshot.find, snapshot.diff);
    if (browser !== undefined && (command !== "open" || !AGENT_BROWSERS.includes(browser as AgentBrowser))) {
      throw new Error("browser is only accepted on open and must be copy, bao, or current");
    }
    if (profile !== undefined && (command !== "open" || typeof profile !== "string" || !profile.trim())) {
      throw new Error("profile is only accepted on open and must be a Chrome profile folder, such as Default or Profile 2");
    }
    if (command === "wait_for_owner") {
      if (args.length > 1) throw new Error("wait_for_owner accepts only an optional timeout in milliseconds");
      ownerWaitTimeout(args[0] === undefined ? undefined : Number(args[0]));
    }
    // Snapshot, click, and the rest change nothing unless they name the open run. An open with no run_id starts a new task. An open that names a run a newer task ended does not.
    if (claimed !== undefined && this.endedByNewer.has(claimed)) {
      this.refusal = { runId: claimed };
      return [{ stdout: JSON.stringify({ outcome: "closed", instruction: otherTaskClosed(claimed) }), stderr: "", exitCode: 0 }];
    }
    if (foreign && command !== "open") {
      if (claimed === undefined) throw new Error(runIdNeeded(String(command)));
      return [{ stdout: JSON.stringify({ outcome: "closed", instruction: otherTaskClosed(claimed) }), stderr: "", exitCode: 0 }];
    }
    if (foreign && command === "open") {
      if (this.session && ownerWaitOver(this.session)) await this.endOwnerWait(this.session);
      else if (this.session && !this.session.removing) await this.endForNewerTask(this.session);
      else if (this.session?.removing) await this.session.removing;
      this.refusal = undefined;
    } else if (this.session && ownerWaitOver(this.session)) await this.endOwnerWait(this.session);
    this.endedLine = this.staleWait;
    this.staleWait = undefined;
    this.workflowOutcome = undefined;
    this.shown = this.session && { session: this.session, command: String(command) };
    const run = claimed;
    if (!this.session && command === "wait_for_owner" && run !== undefined) {
      this.refusal = { runId: run };
      this.shown = undefined;
      const reconnect = this.endedRuns.get(run);
      const instruction = reconnect ?? `${RUN_ENDED} Run ${run} is not Bao's open browser session.`;
      return [{ stdout: JSON.stringify({ outcome: "closed", instruction }), stderr: "", exitCode: 0 }];
    }
    const named = typeof profile === "string" ? profile.trim() : undefined;
    if (this.session && named !== undefined && this.session.pick.route !== "extension" && named !== this.session.pick.profile?.directory) {
      throw new Error("close the current session before choosing a different Chrome profile");
    }
    if (browser !== undefined && this.session?.removing) await this.session.removing;
    if (this.session?.kind === "current" && this.session.chrome.isClosed()) await this.remove(this.session);
    if (browser !== undefined && this.starting) throw new Error("choose the browser only on the first open of a session");
    if (this.session && browser !== undefined && browser !== this.session.browser) {
      throw new Error("close the current session before choosing a different browser");
    }
    const leftOpen = command === "close" && this.currentEnded && !this.taskTabEnded;
    const endedClose: AgentBrowserCommandResult[] = [{ stdout: leftOpen ? `${CURRENT_CHROME_LEFT_OPEN}\n` : "", stderr: "", exitCode: 0 }];
    this.closedCurrent = command === "close" && (this.currentEnded || this.taskTabEnded);
    if (command === "close") {
      this.currentEnded = false;
      this.taskTabEnded = false;
      if (this.session) this.session.closing = true;
      if (this.disconnected) {
        await this.end(true);
        return endedClose;
      }
    }
    if (this.session?.removing) await this.session.removing;
    if (this.disconnected) throw new Error("The agent disconnected.");
    if (!this.session && command === "close") return endedClose;
    if (!this.session && this.taskTabEnded && (command !== "open" || browser === undefined)) throw new Error(TASK_TAB_CLOSED);
    if (!this.session && this.currentEnded && (command !== "open" || browser === undefined)) throw new Error(CURRENT_CHROME_ENDED);
    if (!this.session && command !== "open") throw new Error("start agent-browser with open before sending commands");
    if (this.session?.abort.signal.aborted) {
      const session = this.session;
      if (command === "close") await this.remove(session);
      return this.ownerResult("closed", session);
    }
    const continuing = !!this.session;
    // The route and profile are settled before any run record, so a question about the profile opens and records nothing.
    const plan = continuing ? undefined : await this.plan(browser as AgentBrowser | undefined, named, webSite(args[0]));
    const recording = this.session?.recording ?? new AgentBrowserRun(this.options.home);
    let step = continuing ? undefined : recording.begin(command as string, args);
    if (step) this.latest = { runId: recording.id, step, steps: recording.steps };
    if (!this.session) {
      try {
        const session = await (this.starting = this.start(recording, plan!, webSite(args[0])));
        this.session = session;
        this.currentEnded = false;
        this.taskTabEnded = false;
        if ("signIn" in session.chrome && session.chrome.signIn) this.imported(session, session.chrome.signIn);
        this.watch(session);
      } catch (error) {
        this.notOpened = error instanceof RoutesFailed ? error.line
          : failedPickLine(plan!.route, plan!.why, chromeApp(), plan!.route === "extension" ? undefined : plan!.profile);
        step!.failedToStart = true;
        await recording.complete(step!, [], this.options.home, async () => { throw error; }, error);
        recording.finish();
        throw error;
      } finally {
        this.starting = undefined;
        this.startAbort = undefined;
      }
    }
    const session = this.session;
    this.shown = { session, command: command as string };
    if (session.pick.route === "current" && !session.pick.background && opensTab(command as string, args)) {
      throw new Error(`Chrome would open a new tab in the profile you used last, not necessarily "${session.pick.profile.directory}". Stay in Bao's task tab and use open there.`);
    }
    clearTimeout(session.idleTimer);
    let commandDone!: () => void;
    session.commandDone = new Promise<void>((resolve) => { commandDone = resolve; });
    const results: AgentBrowserCommandResult[] = [];
    const context: StepContext = {};
    let failure: unknown;
    try {
      if (this.disconnected) throw new Error("The agent disconnected.");
      if (continuing && command !== "close" && command !== "wait_for_owner") {
        await this.detectOwnerWall(session);
        const opened = session.ownerWait ? await this.moveAway(session, this.wallWords(session), session.site) : undefined;
        // Refs from Bao's browser do not hold in the new tab, so an action waits for a fresh snapshot.
        if (opened && (session.ownerWait || command !== "snapshot" && command !== "open")) {
          step = recording.begin("open", [this.moved!.site!]);
          this.latest = { runId: recording.id, step, steps: recording.steps };
          results.push(...session.ownerWait ? this.ownerResult("halted", session) : [opened]);
          return results;
        }
        if (session.ownerWait) {
          results.push(...this.ownerResult("halted", session));
          return results;
        }
      }
      context.previousPage = session.page;
      step ??= recording.begin(command as string, args);
      this.latest = { runId: recording.id, step, steps: recording.steps };
      if (command === "open") {
        const site = webSite(args[0]);
        if (site) session.site = site;
        if (continuing && site && this.bound(session, site)) {
          const opened = await this.moveAway(session, BOUND_REASON, site, true);
          if (opened) {
            results.push(...session.ownerWait ? this.ownerResult("halted", session) : [opened, await this.run(session, "tab", ["list"])]);
            return results;
          }
        } else if (continuing && site && "importLogin" in session.chrome) this.imported(session, await session.chrome.importLogin(site));
      }
      if (command === "wait_for_owner") {
        const timeout = ownerWaitTimeout(args[0] === undefined ? undefined : Number(args[0]));
        const deadline = Date.now() + timeout;
        const wall = session.ownerWait && session.ownerWait !== "pending" ? session.ownerWait.page : undefined;
        const read = !wall && this.movable(session, true) ? await this.activePage(session).catch(() => undefined) : undefined;
        const page = wall ?? read?.page;
        const opened = page && await this.moveAway(session, wall ? this.wallWords(session) : "a step that needs the owner",
          wall ? session.site ?? page.url : page.url, true);
        if (opened) {
          results.push(...session.ownerWait ? this.ownerResult("halted", session) : [opened]);
          return results;
        }
        if (read && (!session.ownerWait || session.ownerWait === "pending")) {
          if (!session.ownerWait) session.ownerSince = session.ownerTouched = Date.now();
          session.ownerWait = read;
          session.ownerPage = read.page;
          await this.ownerBanner(session, read.targetId, true).catch(() => undefined);
        }
        results.push(...await this.waitForOwner(session, page ? Math.max(deadline, Date.now() + Math.min(timeout, 5000)) : deadline));
        if (ownerReply(results)?.instruction === TASK_TAB_CLOSED) failure = new Error("Bao's task tab was closed");
        return results;
      }
      if ((command === "click" || command === "fill") && args[0]) {
        await this.captureTarget(session, step, args[0]);
        if (session.ownerWait) { results.push(...this.ownerResult("halted", session)); return results; }
      }
      await session.workflow.record(command as string, args, step.id, async () => {
        const result = command === "close" && (session.kind === "current" || session.chrome.isClosed())
          ? { stdout: session.kind === "current" ? "Disconnected from the owner's own Chrome. Only Bao's task tabs close; the owner's tabs and windows stay open." : "", stderr: "", exitCode: 0 }
          : await this.forward(session, command as string, args);
        results.push(result);
        if (command !== "close" && result.exitCode === 0) await this.detectOwnerWall(session, command === "open" ? webSite(args[0]) : undefined);
        return result;
      }, () => !!session.ownerWait);
      if (command !== "close" && results[0]?.exitCode === 0) {
        const inPage = !session.ownerWait && command === "snapshot" && this.movable(session) && pageWall(results[0].stdout);
        const opened = session.ownerWait ? await this.moveAway(session, this.wallWords(session), session.site)
          : inPage && session.page ? await this.moveAway(session, "a sign-in or verification prompt", session.page.url) : undefined;
        if (opened) results.splice(0, results.length, command === "snapshot" && !session.ownerWait ? await this.run(session, "snapshot", args) : opened);
      }
      // A close during an owner wait ends the session; it reports the close, not the wait.
      if (session.ownerWait && command !== "close") {
        results.splice(0, results.length, ...this.ownerResult("halted", session));
        return results;
      }
      if (command === "snapshot" && results[0]?.exitCode === 0) {
        const native = results[0].stdout;
        if (visual) context.mark = await this.readMark(session, recording.seenOn(session.page?.url), native);
        const key = args.join("\0");
        const before = session.snapshots.get(key);
        session.snapshots.set(key, native);
        if (view) return [{ ...results[0], stdout: view.kind === "find" ? findView(native, view.find) : diffView(before, native) }];
      }
      if (command === "open" && results[0]!.exitCode === 0) {
        // Keep the native list intact, including stable tab ids and every restored tab on the site's host.
        results.push(await this.forward(session, "tab", ["list"]));
      }
      return results;
    } catch (error) {
      if (error instanceof TaskTabClosed) {
        const agentClosedTab = command === "tab" && args[0] === "close" && results.some((result) => result.exitCode === 0);
        results.splice(0, results.length, ...this.endTaskTab(session));
        step ??= recording.begin(command as string, args);
        this.latest = { runId: recording.id, step, steps: recording.steps };
        if (!agentClosedTab) failure = new Error("Bao's task tab was closed");
        return results;
      }
      failure = error;
      session.workflow.unavailable("a browser command was interrupted", step ? { id: step.id, command: step.native.command } : undefined);
      throw error;
    } finally {
      try {
        if (step) {
          try {
            await session.recording.complete(step, results, session.stateDir, () => this.screenshot(session, step!.native.command, visual), failure,
              !!session.ownerWait || command === "wait_for_owner", { ...context, page: session.page, owner: this.ownerPage, current: session.kind === "current",
                ...this.moved?.pick ? { moved: this.moved.line } : {} });
          } catch (completeError) {
            // A hung command already failed with AbortError. The completion
            // screenshot throws page closed after disconnect and must not replace it.
            if (failure === undefined) throw completeError;
          }
          if (command === "close") this.latest = { runId: recording.id, step, steps: recording.steps, lastPicture: recording.lastPicture };
        }
      } finally {
        commandDone();
        if (command === "close" || session.kind === "current" && session.abort.signal.aborted && !session.removing && !this.disconnected) await this.remove(session);
        else this.armIdle(session);
      }
    }
  }

  hasSession(): boolean {
    return this.session !== undefined || this.starting !== undefined;
  }

  disconnect(): void {
    this.disconnected = true;
    this.startAbort?.abort();
    this.session?.abort.abort();
  }

  async end(closeRequested = false): Promise<void> {
    this.disconnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.starting?.catch(() => undefined);
    if (this.session) {
      if (closeRequested) this.session.closing = true;
      await this.remove(this.session, this.options.keepOpen?.() === true);
    }
  }

  /**
   * Ends the open session when `runId` names it. Another run's id changes nothing and returns undefined with `refused` set; no
   * run_id while a session is open is an error.
   */
  async finishTask(outcome: AgentBrowserTaskOutcome, runId?: string): Promise<string | undefined> {
    this.workflowOutcome = undefined;
    this.notOpened = undefined;
    this.refusal = undefined;
    this.shown = undefined;
    const session = this.session;
    if (runId !== undefined && this.endedByNewer.has(runId)) {
      this.refusal = { runId };
      return undefined;
    }
    if (session && runId !== session.recording.id) {
      this.refusal = runId === undefined ? {} : { runId };
      if (runId === undefined) throw new Error(runIdNeeded("finish_task"));
      return undefined;
    }
    this.currentEnded = false;
    this.taskTabEnded = false;
    this.shown = session && { session, command: "finish_task" };
    if (!session) return undefined;
    session.outcome = outcome;
    if (outcome.outcome === "failed") session.workflow.unavailable(outcome.reason);
    try {
      await this.remove(session, this.options.keepOpen?.() === true);
      session.recording.finish(outcome);
      if (this.session === session) this.session = undefined;
      return session.recording.id;
    } finally {
      this.endedRuns.delete(session.recording.id);
      this.currentEnded = false;
      this.taskTabEnded = false;
    }
  }

  async close(): Promise<void> {
    if (!this.session) return;
    this.session.closing = true;
    if (this.disconnected || this.session.removing || this.session.abort.signal.aborted) {
      await this.remove(this.session);
      return;
    }
    const [result] = await this.execute("close", [], undefined, false, undefined, {}, this.session.recording.id);
    if (result!.exitCode !== 0) throw new Error("agent-browser close failed");
  }

  /**
   * The route and Chrome profile for a new session. More than one profile and none named is a question, not a guess. A site that
   * ties its sign-in to the owner's Chrome opens there, whatever route the agent named.
   */
  private async plan(browser: AgentBrowser | undefined, named: string | undefined, site: string | undefined): Promise<BrowserPlan> {
    const route = browser ?? DEFAULT_BROWSER;
    const why: RouteWhy = browser === undefined ? "the default" : route === "current" && this.afterWall ? "fallback after a sign-in wall" : "named by the agent";
    if (route === "current" && this.options.extensionRoute?.() === true) return { route: "extension", why };
    if (process.env.BAO_TEST_BROWSER && !this.options.sourceRoot) throw new Error("tests must supply a throwaway Chrome profile source");
    const root = this.options.sourceRoot ?? chromeProfilesRoot();
    try {
      const profile = await chooseChromeProfile(root, named === undefined ? undefined : { directory: named, by: "agent" }, this.options.settingsProfile?.());
      if (boundRoute(route, site, path.join(profile.root, profile.directory))) {
        return boundOpenPlan(route, profile, this.options.extensionRoute?.() === true);
      }
      return { route, why, profile };
    } catch (error) {
      // Bao's own profile works without Chrome's profiles. It opens with no sign-in import and says why. A named profile must exist.
      const fallback = fallsBack(route, why);
      if ((route === "bao" || fallback) && (error instanceof ChromeFolderDenied || named === undefined && !(error instanceof ChromeProfileQuestion))) {
        const unread = error instanceof Error ? error.message : String(error);
        return fallback ? fallbackPlan(unread) : { route: "bao", why, unread };
      }
      if (!(error instanceof ChromeProfileQuestion)) this.notOpened = failedPickLine(route, why, chromeApp(), named === undefined ? undefined : { directory: named, root });
      throw error;
    }
  }

  /** Opens the planned browser. On the owner's Chrome this also opens Bao's task tab, which the native daemon binds to. */
  private async open(plan: BrowserPlan, signal: AbortSignal, site?: string): Promise<Opened> {
    const why = plan.why;
    switch (plan.route) {
      case "extension": {
        const chrome = await openRunningChrome({ home: this.options.home, signal });
        try {
          // The extension opens the task tab in the background, in the window's collapsed Bao group.
          const { targetId } = await chrome.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, undefined, 15_000);
          return { kind: "current", relay: true, chrome, targetId, pick: { route: "extension", why } };
        } catch (error) {
          await chrome.cdp.send("Bao.closeTabs", {}, undefined, 5000).catch(() => undefined);
          chrome.detach();
          throw error;
        }
      }
      case "current": {
        const chrome = await openCurrentChrome({ root: plan.profile.root, axLog: path.join(this.options.home, "audit", "current-chrome.jsonl"), signal });
        const taskTabs = new Set<string>();
        try {
          const tab = await openTaskTab(chrome, plan.profile.directory, signal);
          taskTabs.add(tab.targetId);
          // Focus emulation keeps a background tab painting, running timers, and taking input. It lasts while this session stays attached.
          const { sessionId } = await chrome.cdp.sendUntilProgress<{ sessionId: string }>("Target.attachToTarget", { targetId: tab.targetId, flatten: true }, undefined, { signal });
          await chrome.cdp.sendUntilProgress("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId, { signal });
          return { kind: "current", chrome, taskTabs, targetId: tab.targetId, seen: new Set(),
            pick: { route: "current", why, chrome: chrome.executable, userDataDir: chrome.root, profile: plan.profile, background: tab.background } };
        } catch (error) {
          for (const targetId of taskTabs) await chrome.cdp.send("Target.closeTarget", { targetId }, undefined, 5000).catch(() => undefined);
          chrome.detach();
          throw error;
        }
      }
      case "bao": {
        const detached = this.options.keepOpen?.() === true;
        const importDir = plan.profile ? path.join(plan.profile.root, plan.profile.directory) : undefined;
        const boundSites = purgeBoundSites(this.options.sourceRoot ?? chromeProfilesRoot(), this.options.settingsProfile?.(), importDir);
        const opened = await behind(await openBaoChromeForProxy({ ...signInSource(plan), home: this.options.home, detached, site, boundSites }));
        return { kind: "copy", ...opened, pick: baoPick(plan, baoAgentProfileDir(this.options.home)) };
      }
      case "copy": {
        const chrome = await openCopiedChromeForProxy({ sourceRoot: plan.profile.root, directory: plan.profile.directory, home: this.options.home,
          detached: this.options.keepOpen?.() === true });
        return { kind: "copy", ...await behind(chrome), targetId: chrome.targetId, pick: { route: "copy", why, chrome: resolveNormalChrome(), profile: plan.profile, userDataDir: path.dirname(chrome.target.portFile) } };
      }
    }
  }

  private async start(recording: AgentBrowserRun, plan: BrowserPlan, site?: string): Promise<Session> {
    const executable = agentBrowserExecutable(this.options.executable);
    const abort = this.startAbort = new AbortController();
    let missed: string | undefined;
    const browser = await openOrFallBack(plan, (next) => {
      missed = "missed" in next ? next.missed : undefined;
      return this.open(next, abort.signal, site);
    }, () => abort.signal.aborted);
    try {
      const wired = await this.wire(browser);
      recording.pickBrowser(browser.pick);
      const session: Session = {
        ...browser, ...wired, browser: openedChoice(browser.pick), missed, executable, abort, recording, snapshots: new Map(),
        workflow: new AgentBrowserWorkflow(this.options.home, recording.id, async () => {
          const active = await this.activePage(session);
          if (!active) throw new Error("no active Bao page metadata");
          const endpoint = session.kind === "current" ? session.chrome.endpoint : await readDevToolsActivePort(session.chrome.target.portFile);
          return { ...endpoint, targetId: active.targetId, targetIds: active.targetIds };
        }, abort.signal),
      };
      return session;
    } catch (error) {
      await this.discard(browser);
      throw error;
    }
  }

  /** The agent-browser state folder, flags, and environment that drive an opened browser. */
  private async wire(browser: Opened): Promise<Pick<SessionData, "stateDir" | "flags" | "env">> {
    const stateDir = await mkdtemp(path.join(tmpdir(), "bao-proxy-"));
    try {
      const config = path.join(stateDir, "config.json");
      await writeFile(config, "{}", { mode: 0o600 });
      // agent-browser selects this session's bound target (`<session>.target` in its socket directory) when its daemon attaches.
      if (browser.targetId) await writeFile(path.join(stateDir, "bao.target"), JSON.stringify({ targetId: browser.targetId, url: "about:blank" }), { mode: 0o600 });
      const endpoint = browser.kind === "current" ? browser.chrome.endpoint : browser.background.endpoint;
      // On the owner's Chrome the native daemon stays on its bound tab. Without the pin it makes every target it discovers
      // current, such as a tab the owner opens or Chrome's Gemini panel.
      const pin = browser.kind === "current" && !browser.relay ? ["--pin-tab"] : [];
      return {
        stateDir,
        flags: ["--session", "bao", "--config", config, ...pin, "--cdp", `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`, "--idle-timeout", "0"],
        env: {
          HOME: stateDir, TMPDIR: stateDir, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
          AGENT_BROWSER_SOCKET_DIR: stateDir, AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0", BAO_HEAL_CURSOR_ACCOUNT: "0",
          ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        },
      };
    } catch (error) {
      await rm(stateDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Closes a browser no session took: only Bao's task tabs in the owner's Chrome, or the whole Bao window. */
  private async discard(browser: Opened): Promise<void> {
    if (browser.kind === "current") {
      if (browser.relay) await browser.chrome.cdp.send("Bao.closeTabs", {}, undefined, 5000).catch(() => undefined);
      else for (const targetId of browser.taskTabs) await browser.chrome.cdp.send("Target.closeTarget", { targetId }, undefined, 5000).catch(() => undefined);
      browser.chrome.detach();
    } else {
      browser.background.close();
      await browser.chrome.close();
    }
  }

  /** Ends the session when its browser closes under it, unless Bao closed that browser itself. */
  private watch(session: Session): void {
    const chrome = session.chrome;
    void chrome.closed.then(() => {
      if (session.closing || session.chrome !== chrome) return;
      if (!this.disconnected && !session.removing) session.workflow.unavailable("the owner closed the window before the task finished");
      return this.remove(session);
    }).catch(() => undefined);
  }

  /**
   * A Bao-profile session whose move to the owner's running Chrome has not failed, or any Bao-profile session on a retry. A copy
   * moves only to open a site that ties its sign-in to the owner's Chrome.
   */
  private movable(session: Session, retry = false, bound = false): boolean {
    return session.kind === "copy" && (session.pick.route === "bao" || bound && session.pick.route === "copy")
      && (retry || session.moveError === undefined) && !session.closing && !this.disconnected;
  }

  /** The site ties its sign-in to the owner's Chrome, so a Bao profile or copy does not open it. */
  private bound(session: Session, site: string | undefined): boolean {
    if (!site || session.kind !== "copy" || session.pick.route === "extension") return false;
    const profile = session.pick.profile;
    return boundSite(site, profile && path.join(profile.root, profile.directory));
  }

  private wallWords(session: Session): string {
    const page = session.ownerWait && session.ownerWait !== "pending" ? session.ownerWait.page : session.page;
    return page && ownerWall(page) === "bot_wall" ? "a human check" : "a sign-in page";
  }

  /**
   * A Bao-profile session that stopped at a wall continues in the owner's running Chrome over remote debugging, on the Chrome
   * profile its sign-in import read, in the same session and run. Bao opens the page there, then closes its own window. When
   * that does not work, the session stays in Bao's window and the line says why. Returns the open result in the new tab.
   */
  private async moveAway(session: Session, what: string, url: string | undefined, retry = false): Promise<AgentBrowserCommandResult | undefined> {
    const bound = what === BOUND_REASON;
    if (!this.movable(session, retry, bound) || session.kind !== "copy" || session.pick.route === "extension" || session.pick.route === "current") return undefined;
    const wall = session.ownerWait && session.ownerWait !== "pending" ? session.ownerWait.page : undefined;
    const site = url ?? wall?.url ?? session.page?.url;
    let host = site ?? "this site";
    try { host = new URL(host).hostname; } catch {}
    const stopped = bound ? `Bao did not open ${host} in its own browser because ${BOUND_REASON}` : `Bao's own browser hit ${what} on ${host}`;
    const profile = session.pick.profile;
    const copy = session.pick.route === "copy";
    const fail = (error: unknown) => {
      session.moveError = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
      const open = { command: "open", ...(site ? { args: [site] } : {}), browser: "current", ...profile ? { profile: profile.directory } : {} };
      const next = copy
        ? `The page stays in the Chrome copy, without this site's sign-in. To try your running Chrome yourself, call agent_browser with ${JSON.stringify({ command: "close", run_id: session.recording.id })}, then with ${JSON.stringify(open)}.`
        : "The session stays in Bao's window; Bao tries again on the next wait_for_owner.";
      this.moved = { line: `${stopped}. Bao could not continue in your running Chrome over remote debugging: ${session.moveError}. ${next}` };
      return undefined;
    };
    if (!profile) return fail("Bao could not read Chrome's profiles, so it does not know which Chrome profile to use");
    if (!site) return fail("Bao does not know which page to open");
    let next: Opened;
    try { next = await this.open({ route: "current", why: bound ? BOUND_REASON : "fallback after a sign-in wall", profile }, session.abort.signal); }
    catch (error) { return fail(error); }
    let wired: Awaited<ReturnType<AgentBrowserProxy["wire"]>> | undefined;
    let opened: AgentBrowserCommandResult;
    try {
      wired = await this.wire(next);
      opened = await this.run({ ...session, ...next, ...wired }, "open", [site]);
      if (opened.exitCode !== 0) throw new Error(`the open in Bao's task tab failed: ${opened.stderr || opened.stdout || `exit ${opened.exitCode}`}`);
    } catch (error) {
      try { if (wired) await this.stopDaemon(wired.stateDir); }
      finally {
        if (wired) await rm(wired.stateDir, { recursive: true, force: true });
        await this.discard(next);
      }
      return fail(error);
    }
    const old = { chrome: session.chrome, background: session.background, stateDir: session.stateDir };
    const waiting = !!session.ownerWait;
    Object.assign(session, next, wired, { browser: openedChoice(next.pick), missed: undefined, ownerWait: undefined, page: undefined });
    session.recording.pickBrowser(next.pick);
    if (waiting) session.recording.ownerWaiting(false);
    this.watch(session);
    session.moveError = undefined;
    this.moved = { line: `${stopped}; continued in your running Chrome (Chrome profile "${profile.directory}", ${profile.name}) over remote debugging. Take a fresh snapshot before acting.`, pick: next.pick, site };
    try { await this.stopDaemon(old.stateDir); }
    catch (error) { process.stderr.write(`Bao could not stop the agent-browser daemon of its own window: ${error instanceof Error ? error.message : String(error)}\n`); }
    finally {
      old.background.close();
      await old.chrome.close().catch((error: unknown) => process.stderr.write(`Bao could not close its own window: ${error instanceof Error ? error.message : String(error)}\n`));
      await rm(old.stateDir, { recursive: true, force: true });
    }
    await this.detectOwnerWall(session);
    return opened;
  }

  private async connectSession(session: Session, options: { timeoutMs: number; signal?: AbortSignal }): Promise<CdpSocket> {
    if (session.kind === "current") return session.chrome.cdp;
    const endpoint = await readDevToolsActivePort(session.chrome.target.portFile);
    return connectCdp(endpoint.port, endpoint.browserPath, options);
  }

  private ownerResult(kind: "halted" | "waiting" | "ready" | "closed", session: Session): AgentBrowserCommandResult[] {
    const current = session.kind === "current";
    const instruction = kind === "ready" ? "The page left the sign-in/check state. Take a fresh snapshot and continue in this same session. This is not proof of authentication."
      : kind === "closed" ? current ? CURRENT_CHROME_ENDED : "The owner closed the Bao window. Report that this session cannot continue."
        : ownerWaitInstruction(current, session.raised === true, session.recording.id, ownerWaitPage(session));
    return [{ stdout: JSON.stringify({ outcome: kind, instruction: `${instruction}${this.fallback(session)}` }), stderr: "", exitCode: 0 }];
  }

  /**
   * A copy that waits for the owner, or a Bao profile whose move failed, names its fallback: the owner's running Chrome on the
   * same profile, which holds his own sign-in and is a device the site already knows. A copy never switches on its own.
   */
  private fallback(session: Session): string {
    if (session.kind !== "copy" || session.pick.route === "extension") return "";
    if (session.pick.route === "bao" && session.moveError === undefined) return "";
    const site = session.site ?? session.ownerPage?.url;
    const profile = session.pick.profile?.directory;
    const open = { command: "open", ...(site ? { args: [site] } : {}), browser: "current", ...profile ? { profile } : {} };
    const bao = session.pick.route === "bao";
    return ` If the sign-in or check does not clear in ${bao ? "Bao's window" : "the Chrome copy"}, the fallback is the owner's running Chrome over remote debugging${profile ? ` on the same Chrome profile "${profile}"` : ""}. To take it, call agent_browser with ${JSON.stringify({ command: "close", run_id: session.recording.id })}, then with ${JSON.stringify(open)}. ${bao ? "Bao also tries it again on the next wait_for_owner." : "Bao does not switch on its own."}`;
  }

  private async nativeTabs(session: Session, ceiling?: AbortSignal): Promise<NativeTab[]> {
    const tabs = await this.run(session, "tab", ["list", "--json"], ceiling ? undefined : 5000, ceiling);
    if (tabs.exitCode !== 0) throw new Error(`Native tab list failed (exit ${tabs.exitCode}): ${tabs.stderr || tabs.stdout}`);
    return (JSON.parse(tabs.stdout) as { data?: { tabs?: NativeTab[] } }).data?.tabs ?? [];
  }

  /**
   * Keeps the agent in its tab of the owner's Chrome. The pinned native daemon never makes a tab the owner opens, or Chrome's Gemini
   * panel, current. A tab the agent's tab opened, such as a sign-in popup, becomes the agent's tab, as it does in Bao's own Chrome.
   * When that opener is a Bao task tab, the popup is a task tab too, so tab lists mark it and finish closes it.
   * When the daemon is anywhere else, Bao switches it back to the agent's tab, or to Bao's newest task tab when that tab is gone.
   * When neither remains, the caller ends the session instead of acting on an owner tab.
   */
  private async keepTab(session: Session & DebuggingChrome, tabs: NativeTab[], ceiling: AbortSignal): Promise<NativeTab[]> {
    const listed = (targetId: string | undefined) => tabs.find((tab) => tab.targetId === targetId);
    const fresh = new Set(tabs.flatMap((tab) => tab.targetId && !session.seen.has(tab.targetId) ? [tab.targetId] : []));
    let want = session.targetId;
    if (fresh.size) {
      const { targetInfos } = await session.chrome.cdp.sendUntilProgress<{ targetInfos: ChromeTarget[] }>("Target.getTargets", {}, undefined, { signal: ceiling });
      for (const info of targetInfos) {
        if (fresh.has(info.targetId) && info.openerId === want && await isChromeTab(session.chrome.cdp, info, ceiling)) {
          if (session.taskTabs.has(want)) session.taskTabs.add(info.targetId);
          want = info.targetId;
        }
      }
      if (ceiling.aborted) throw new Error("cdp aborted Browser.getWindowForTarget");
      for (const targetId of fresh) session.seen.add(targetId);
    }
    if (!listed(want)) want = [...session.taskTabs].reverse().find((targetId) => listed(targetId)) ?? want;
    const tab = listed(want);
    if (!tab?.tabId) return tabs;
    session.targetId = want;
    if (tab.active) return tabs;
    const back = await this.run(session, "tab", [tab.tabId], undefined, ceiling);
    if (back.exitCode !== 0) throw new Error(`Bao could not keep the agent in its tab ${tab.tabId}: ${back.stderr || back.stdout || `exit ${back.exitCode}`}`);
    return this.nativeTabs(session, ceiling);
  }

  /**
   * Runs one agent command. On the owner's Chrome over remote debugging, a tab list leaves out Chrome's own surfaces, such as the
   * Gemini panel and side panels, and marks Bao's task tabs. Switching to or closing such a surface is refused. A switch makes the
   * chosen tab the agent's tab.
   */
  private async forward(session: Session, command: string, args: string[]): Promise<AgentBrowserCommandResult> {
    if (session.kind !== "current" || session.relay || command !== "tab" || args[0] === "new") return this.run(session, command, args);
    const list = args[0] === undefined || args[0] === "list" || args[0].startsWith("-");
    const ref = list ? undefined : args[0] === "close" ? args[1] : args[0];
    const tabs = await this.nativeTabs(session);
    const named = ref === undefined ? undefined : tabs.find((tab) => tab.tabId === ref || tab.label === ref);
    const { targetInfos } = await session.chrome.cdp.send<{ targetInfos: ChromeTarget[] }>("Target.getTargets", {}, undefined, 5000);
    const surfaces = new Set<string>();
    for (const tab of list ? tabs : named ? [named] : []) {
      const info = targetInfos.find((target) => target.targetId === tab.targetId);
      if (tab.tabId && (!info || !await isChromeTab(session.chrome.cdp, info))) surfaces.add(tab.tabId);
    }
    if (named?.tabId && surfaces.has(named.tabId)) {
      return { stdout: "", stderr: `✗ ${ref} is not a tab in a Chrome window, such as the Gemini panel or a side panel. Stay in Bao's task tab.\n`, exitCode: 1 };
    }
    const result = await this.run(session, command, args);
    if (result.exitCode !== 0) return result;
    if (args[0] === "close" && named?.targetId && session.taskTabs.has(named.targetId)) {
      session.taskTabs.delete(named.targetId);
      session.justClosed = named.targetId;
      if (session.targetId === named.targetId) session.targetId = [...session.taskTabs].at(-1) ?? "";
    }
    if (!list) {
      const active = args[0] === "close" ? undefined : (await this.nativeTabs(session)).find((tab) => tab.active);
      if (active?.targetId) session.targetId = active.targetId;
      return result;
    }
    const task = (tab: NativeTab | undefined) => !!tab?.targetId && session.taskTabs.has(tab.targetId);
    if (args.includes("--json")) {
      try {
        const parsed = JSON.parse(result.stdout) as { data?: { tabs?: (NativeTab & { baoTaskTab?: boolean })[] } };
        if (parsed.data?.tabs) {
          parsed.data.tabs = parsed.data.tabs.filter((tab) => !tab.tabId || !surfaces.has(tab.tabId)).map((tab) => task(tab) ? { ...tab, baoTaskTab: true } : tab);
        }
        return { ...result, stdout: `${JSON.stringify(parsed)}\n` };
      } catch { return result; }
    }
    const stdout = result.stdout.split("\n").flatMap((line) => {
      const tabId = /^(?:→|\s) \[([^\]]+)\] /u.exec(line)?.[1];
      if (!tabId) return [line];
      if (surfaces.has(tabId)) return [];
      return [task(tabs.find((tab) => tab.tabId === tabId)) ? line.replace(`[${tabId}] `, `[${tabId}] (Bao task tab) `) : line];
    }).join("\n");
    return { ...result, stdout };
  }

  /** The agent's tab is gone and no Bao task tab is left to switch to. Owner tabs do not count. */
  private noTaskTabLeft(session: Session, tabs: readonly { targetId?: string }[]): boolean {
    if (session.kind !== "current" || session.relay) return false;
    const listed = new Set(tabs.flatMap((tab) => tab.targetId ? [tab.targetId] : []));
    if (session.justClosed) listed.delete(session.justClosed);
    if (listed.has(session.targetId)) return false;
    return ![...session.taskTabs].some((id) => listed.has(id));
  }

  /** Chrome's own target list no longer has the agent's tab or any Bao task tab. A failed read is not that proof. */
  private async taskTabClosedInChrome(session: Session): Promise<boolean> {
    if (session.kind !== "current" || session.relay || !session.chrome.cdp.isOpen) return false;
    try {
      const { targetInfos } = await session.chrome.cdp.send<{ targetInfos: { targetId?: string }[] }>("Target.getTargets", {}, undefined, 5000);
      return this.noTaskTabLeft(session, targetInfos);
    } catch {
      return false;
    }
  }

  /** Ends this session because Bao's task tab was closed. The caller returns the closed result; cleanup runs after the command. */
  private endTaskTab(session: Session): AgentBrowserCommandResult[] {
    this.taskTabEnded = true;
    this.endedRuns.set(session.recording.id, TASK_TAB_CLOSED);
    session.closing = true;
    session.outcome = { outcome: "failed", reason: "Bao's task tab was closed" };
    session.workflow.unavailable("Bao's task tab was closed before the task finished");
    if (session.ownerWait) {
      session.ownerWait = undefined;
      session.recording.ownerWaiting(false);
    }
    session.abort.abort();
    return [{ stdout: JSON.stringify({ outcome: "closed", instruction: TASK_TAB_CLOSED }), stderr: "", exitCode: 0 }];
  }

  private async activePage(session: Session): Promise<{ targetId: string; targetIds: string[]; page: OwnerPage } | undefined> {
    const starting = !session.daemonStarted;
    const own = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) return;
      timer = setTimeout(() => own.abort(), CDP_PROGRESS_CEILING_MS);
      timer.unref();
    };
    if (!starting) arm();
    const signal = AbortSignal.any([session.abort.signal, own.signal]);
    let cdp: CdpSocket | undefined;
    try {
      let tabs = await this.nativeTabs(session, signal);
      arm();
      if (session.kind === "current" && !session.relay) {
        tabs = await this.keepTab(session, tabs, signal);
        if (this.noTaskTabLeft(session, tabs) && await this.taskTabClosedInChrome(session)) throw new TaskTabClosed();
      }
      const active = tabs.find((tab) => tab.active);
      if (!active?.targetId) return undefined;
      // Native tab titles can be URL-derived labels. Read the real title from Chrome, not that label.
      cdp = await this.connectSession(session, { timeoutMs: CDP_PROGRESS_CEILING_MS, signal });
      const { targetInfo } = await cdp.sendUntilProgress<{ targetInfo: { url: string; title: string } }>("Target.getTargetInfo", { targetId: active.targetId }, undefined, { signal });
      session.page = { url: targetInfo.url, title: targetInfo.title };
      return { targetId: active.targetId, targetIds: tabs.flatMap((tab) => tab.targetId ? [tab.targetId] : []), page: { url: targetInfo.url, title: targetInfo.title } };
    } catch (error) {
      if (error instanceof TaskTabClosed) throw error;
      if (session.abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new ActiveTargetMiss(error);
    } finally {
      if (timer) clearTimeout(timer);
      if (cdp && session.kind === "copy") cdp.close();
    }
  }

  private async detectOwnerWall(session: Session, openedSite?: string): Promise<void> {
    if (session.ownerWait) return;
    let active = await this.activePage(session);
    if (!active) throw new Error("no active Bao page metadata");
    if (!ownerWall(active.page)) return;
    // A wall on a site that ties its sign-in to the owner's Chrome, such as Google's account page, imports nothing; it moves there.
    if (openedSite && ownerWall(active.page) === "login_wall" && "importLogin" in session.chrome
      && !this.bound(session, openedSite) && !this.bound(session, active.page.url)) {
      const retried = this.imported(session, { ...await session.chrome.importLogin(new URL(active.page.url).origin, true), retry: true });
      if (retried.cookies || retried.storage) {
        const retry = await this.run(session, "open", [openedSite]);
        if (retry.exitCode !== 0) throw new Error(`Bao sign-in retry failed: ${retry.stderr || retry.stdout || `exit ${retry.exitCode}`}`);
        active = await this.activePage(session);
        if (!active) throw new Error("no active Bao page metadata");
        if (!ownerWall(active.page)) return;
      }
    }
    session.ownerWait = active;
    session.ownerPage = active.page;
    session.ownerSince = session.ownerTouched = Date.now();
    session.recording.ownerWaiting(true);
    await this.ownerBanner(session, active.targetId, true);
  }

  private imported(session: Session, report: SignInImport): SignInImport {
    this.imports.push(report);
    session.recording.signInImported(report);
    return report;
  }

  /** Writes only Bao's status banner. Never reads the form, page text, or field values. */
  private async ownerBanner(session: Session, targetId: string, waiting: boolean): Promise<void> {
    if (waiting) session.raised = false;
    if (session.kind === "copy" && "userDataDir" in session.pick) await focusOwnedHandoff(session.pick.userDataDir, waiting).catch(() => undefined);
    const cdp = await this.connectSession(session, { timeoutMs: 2000, signal: session.abort.signal });
    let attached: string | undefined;
    try {
      // The extension keeps the task tab folded in Bao's group and opens the group while the owner has to act in it.
      // Otherwise the tab and its window come to the front when the owner has to act in it. Bao's own Chrome stays behind until then.
      if (session.kind === "current" && session.relay) await cdp.send(waiting ? "Bao.showTab" : "Bao.settleTab", { targetId }, undefined, 2000);
      else if (waiting) {
        await cdp.send("Target.activateTarget", { targetId }, undefined, 2000);
        if (session.kind === "copy" && process.platform === "darwin") session.raised = await windowOnTop(cdp, targetId).catch(() => false);
      }
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 2000);
      attached = sessionId;
      const expression = waiting ? `(() => {
        const banner = document.createElement('div');
        banner.id = 'bao-owner-wait'; banner.setAttribute('role', 'status');
        banner.textContent = ${JSON.stringify(`Bao is waiting for you to ${ownerTask(ownerWaitPage(session))}. The agent will continue in this window. Only URL and title are read while waiting.`)};
        banner.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;padding:16px 20px;background:#fff3dd;color:#492800;border:2px solid #e88600;border-radius:12px;font:600 15px/1.5 system-ui;box-shadow:0 4px 20px #0003;z-index:2147483647;pointer-events:none';
        document.documentElement.append(banner);
      })()` : `document.getElementById('bao-owner-wait')?.remove()`;
      await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId, 2000);
    } catch {
      // The durable Library notice remains visible if the page rejects the banner or closes.
    } finally {
      if (session.kind === "copy") cdp.close();
      else if (attached) await cdp.send("Target.detachFromTarget", { sessionId: attached }, undefined, 2000).catch(() => undefined);
    }
  }

  private ownerClosed(session: Session): AgentBrowserCommandResult[] {
    session.abort.abort();
    session.ownerWait = undefined;
    session.workflow.unavailable("the owner wait did not finish");
    session.recording.finish("session_closed");
    return this.ownerResult("closed", session);
  }

  private async waitForOwner(session: Session, deadline: number): Promise<AgentBrowserCommandResult[]> {
    if (session.abort.signal.aborted) return this.ownerClosed(session);
    if (!session.ownerWait) {
      session.ownerWait = "pending";
      session.ownerSince = session.ownerTouched = Date.now();
    }
    session.recording.ownerWaiting(true);
    let cdp: CdpSocket | undefined;
    const onAbort = () => { if (session.kind === "copy") cdp?.close(); };
    session.abort.signal.addEventListener("abort", onAbort, { once: true });
    let candidate = "";
    let stableAt = 0;
    try {
      while (Date.now() < deadline) {
        if (session.abort.signal.aborted || cdp && !cdp.isOpen) return this.ownerClosed(session);
        try {
          if (!session.ownerWait || session.ownerWait === "pending") {
            const active = await this.activePage(session);
            if (!active) return this.ownerClosed(session);
            session.ownerWait = active;
            session.ownerPage = active.page;
            await this.ownerBanner(session, active.targetId, true);
          }
          const waiting = session.ownerWait;
          if (!cdp) {
            cdp = await this.connectSession(session, { timeoutMs: 2000, signal: session.abort.signal });
          }
          if (session.abort.signal.aborted || !cdp.isOpen) return this.ownerClosed(session);
          const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; url: string; title: string }[] }>("Target.getTargets", {}, undefined, 2000);
          const page = targetInfos.find((tab) => tab.targetId === waiting.targetId);
          if (!page && cdp.isOpen && this.noTaskTabLeft(session, targetInfos)) return this.endTaskTab(session);
          if (!page || session.abort.signal.aborted || !cdp.isOpen) return this.ownerClosed(session);
          const ready = ownerCanResume(waiting.page, page);
          const signature = ready ? JSON.stringify([page.url, page.title]) : "";
          if (!ready || candidate !== signature) { candidate = signature; stableAt = Date.now(); }
          if (ready && Date.now() - stableAt >= 750) {
            await this.ownerBanner(session, waiting.targetId, false);
            if (session.abort.signal.aborted || !cdp.isOpen) return this.ownerClosed(session);
            session.ownerWait = undefined;
            session.page = { url: page.url, title: page.title };
            session.recording.ownerWaiting(false);
            return this.ownerResult("ready", session);
          }
        } catch (error) {
          if (error instanceof TaskTabClosed) throw error;
          candidate = "";
          if (session.abort.signal.aborted || cdp && !cdp.isOpen) return this.ownerClosed(session);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
      }
      return session.abort.signal.aborted || cdp && !cdp.isOpen ? this.ownerClosed(session) : this.ownerResult("waiting", session);
    } finally {
      session.ownerTouched = Date.now();
      session.abort.signal.removeEventListener("abort", onAbort);
      if (session.kind === "copy") cdp?.close();
    }
  }

  /** Measure the heading or dialog a read found new, so its card can box it. */
  private async readMark(session: Session, seen: ReadonlySet<string> | undefined, current: string): Promise<ShotBox | undefined> {
    const added = newInRead(seen, current);
    if (!added?.ref) return undefined;
    try { return await this.box(session, `@${added.ref}`); }
    catch { return undefined; }
  }

  private async box(session: Session, target: string): Promise<ShotBox | undefined> {
    const result = await this.run(session, "get", ["box", target, "--json"], 3000);
    if (result.exitCode !== 0) return undefined;
    const { data } = JSON.parse(result.stdout) as { data?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } };
    if (!data) return undefined;
    const { x, y, width, height } = data;
    if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number"
        || ![x, y, width, height].every(Number.isFinite)) return undefined;
    return { x, y, width, height };
  }

  private async captureTarget(session: Session, step: RecordedAgentBrowserCommand, target: string): Promise<void> {
    try {
      const rect = await this.box(session, target);
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const frame = await this.screenshot(session, step.native.command, true);
      if (frame.note || !frame.viewport) return;
      const box = targetBox(rect, frame.viewport);
      if (!box) return;
      await session.recording.actionPicture(step, frame.bytes, { rect: { x: box.x, y: box.y, width: box.width, height: box.height }, viewport: frame.viewport });
    } catch (error) {
      // A disconnect aborts the box read. That abort is the command's result.
      if (session.abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      // Missing action evidence must not change the native command.
    }
  }

  private async screenshot(session: Session, command: string, visual = false): Promise<{ bytes: Buffer; viewport?: { width: number; height: number }; note?: string }> {
    if (command === "close" || this.disconnected || session.abort.signal.aborted) throw new Error("page closed");
    const taskId = session.kind === "current" ? session.targetId : undefined;
    try {
      await this.detectOwnerWall(session);
    } catch (error) {
      if (session.kind !== "current" || session.abort.signal.aborted || !(error instanceof ActiveTargetMiss)) throw error;
      return this.taskTabPicture(session, session.targetId, visual);
    }
    if (session.ownerWait) throw new Error(OWNER_PRIVATE);
    const tabs = await this.run(session, "tab", ["list", "--json"], 3000);
    if (tabs.exitCode !== 0) throw new Error(`Native tab list failed (exit ${tabs.exitCode}): ${tabs.stderr || tabs.stdout}`);
    const parsed = JSON.parse(tabs.stdout) as { data?: { tabs?: { active?: boolean; targetId?: string }[] } };
    const activeId = parsed.data?.tabs?.find((tab) => tab.active)?.targetId;
    if (!activeId) throw new Error("no active page");
    const preferred = await this.pictureTarget(session, activeId, taskId);
    try {
      if (preferred !== activeId && session.kind === "current") await this.refusePrivateTarget(session, preferred);
      const frame = await this.captureFrame(session, preferred, visual);
      return preferred === activeId ? frame : { ...frame, note: TASK_TAB_PICTURE };
    } catch (error) {
      if (privatePicture(error) || session.kind !== "current" || preferred === taskId || session.abort.signal.aborted) throw error;
      return this.taskTabPicture(session, session.targetId, visual);
    }
  }

  /** On running Chrome, a side panel or a target that will not answer is pictured from the task tab instead. */
  private async pictureTarget(session: Session, activeId: string, taskId: string | undefined): Promise<string> {
    if (!taskId || taskId === activeId || session.kind !== "current") return activeId;
    try {
      const { targetInfo } = await session.chrome.cdp.send<{ targetInfo: { url?: string; type?: string } }>("Target.getTargetInfo", { targetId: activeId }, undefined, 500);
      return uncapturablePage(targetInfo.url, targetInfo.type) ? taskId : activeId;
    } catch (error) {
      if (session.abort.signal.aborted) throw error;
      return taskId;
    }
  }

  private async taskTabPicture(session: Extract<Session, { kind: "current" }>, taskId: string, visual: boolean): Promise<{ bytes: Buffer; viewport?: { width: number; height: number }; note: string }> {
    await this.refusePrivateTarget(session, taskId);
    return { ...await this.captureFrame(session, taskId, visual), note: TASK_TAB_PICTURE };
  }

  private async refusePrivateTarget(session: Extract<Session, { kind: "current" }>, targetId: string): Promise<void> {
    const { targetInfo } = await session.chrome.cdp.send<{ targetInfo: { url?: string; title?: string } }>("Target.getTargetInfo", { targetId }, undefined, 2000);
    if (session.abort.signal.aborted) throw new Error("page closed");
    if (ownerWall({ url: targetInfo.url ?? "", title: targetInfo.title ?? "" })) throw new Error(OWNER_PRIVATE);
  }

  private async captureFrame(session: Session, targetId: string, visual: boolean): Promise<{ bytes: Buffer; viewport?: { width: number; height: number } }> {
    const deadline = Date.now() + 3000;
    const remaining = () => Math.max(1, deadline - Date.now());
    const signal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(3000)]);
    let cdp: CdpSocket | undefined;
    let attached: string | undefined;
    const close = () => { if (session.kind === "copy") cdp?.close(); };
    signal.addEventListener("abort", close, { once: true });
    try {
      cdp = await this.connectSession(session, { signal, timeoutMs: remaining() });
      if (signal.aborted) throw new Error("screenshot timed out");
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, remaining());
      attached = sessionId;
      const metrics = visual ? await cdp.send<{ cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics", {}, sessionId, remaining()) : undefined;
      if (!metrics) {
        const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId, remaining());
        return { bytes: Buffer.from(data, "base64") };
      }
      const { result } = await cdp.send<{ result: { value: number } }>("Runtime.evaluate", { expression: "window.devicePixelRatio", returnByValue: true }, sessionId, remaining());
      const ratio = result.value > 0 ? result.value : 1;
      const view = metrics.cssLayoutViewport;
      // Cards show the viewport about 480 CSS pixels wide, so up to 2 device pixels per CSS pixel keeps text sharp on a 2x screen.
      // A picture over the card reader's limit falls back to CSS-pixel size, then to the older quality.
      const tries = [{ scale: Math.min(2, ratio) / ratio, quality: 85 }, { scale: 1 / ratio, quality: 80 }, { scale: 1 / ratio, quality: 65 }];
      let bytes = Buffer.alloc(0);
      for (const shot of tries) {
        const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: shot.quality,
          clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: shot.scale } }, sessionId, remaining());
        bytes = Buffer.from(data, "base64");
        if (bytes.length <= BROWSER_PICTURE_BYTES) break;
      }
      return { bytes, viewport: { width: view.clientWidth, height: view.clientHeight } };
    } finally {
      signal.removeEventListener("abort", close);
      if (session.kind === "copy") cdp?.close();
      else if (attached) await cdp?.send("Target.detachFromTarget", { sessionId: attached }, undefined, remaining()).catch(() => undefined);
    }
  }

  private async run(session: Session, command: string, args: string[], readTimeoutMs?: number, bound?: AbortSignal): Promise<AgentBrowserCommandResult> {
    if (this.disconnected) throw new Error("The agent disconnected.");
    // The session's first call starts the native daemon, which takes seconds on a copy that restores many tabs. Only the session's end bounds it.
    if (!session.daemonStarted) {
      readTimeoutMs = undefined;
      bound = undefined;
    }
    session.daemonStarted = true;
    const execute = (command: string, args: string[], timeoutMs?: number, ceiling?: AbortSignal) => new Promise<AgentBrowserCommandResult>((resolve, reject) => {
      const childSignal = ceiling
        ? AbortSignal.any([session.abort.signal, ceiling])
        : timeoutMs === undefined ? session.abort.signal : AbortSignal.any([session.abort.signal, AbortSignal.timeout(timeoutMs)]);
      execFile(session.executable, [...session.flags, command, ...args], {
        cwd: session.stateDir, env: session.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal: childSignal,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") { reject(error); return; }
        resolve({ stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : 0 });
      });
    });
    const result = await execute(command, args, readTimeoutMs, bound);
    if (session.kind === "current" && !session.relay && opensTab(command, args) && result.exitCode === 0) {
      try {
        const tabs = await execute("tab", ["list", "--json"], 5000);
        if (tabs.exitCode !== 0) throw new Error(`Native task tab list failed: ${tabs.stderr || tabs.stdout}`);
        const parsed = JSON.parse(tabs.stdout) as { data?: { tabs?: { active?: boolean; targetId?: string }[] } };
        const targetId = parsed.data?.tabs?.find((tab) => tab.active)?.targetId;
        if (!targetId) throw new Error("Native task tab has no target id");
        session.taskTabs.add(targetId);
        session.targetId = targetId;
      } catch (error) {
        process.stderr.write(`Bao task tab tracking unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return result;
  }

  private waitEndedLine(session: Session, why: string): string {
    const since = session.ownerSince ?? Date.now();
    const time = new Intl.DateTimeFormat("en-US", { ...new Date(since).toDateString() === new Date().toDateString() ? {} : { month: "short", day: "numeric" },
      hour: "numeric", minute: "2-digit" }).format(since);
    return `Bao ended an earlier owner wait from ${time}; ${why}.`;
  }

  /** Ends a session's owner wait and the session, so no later request inherits it. */
  private async endOwnerWait(session: Session, why = `nobody continued it for ${OWNER_WAIT_LIMIT_MS / 60_000} minutes`): Promise<void> {
    this.staleWait = this.waitEndedLine(session, why);
    session.closing = true;
    await this.remove(session);
    if (this.session === session) this.session = undefined;
  }

  endedByNewerTask(runId: string | undefined): boolean {
    return runId !== undefined && this.endedByNewer.has(runId);
  }

  /** Ends the open run because a newer open started, and closes its task tab. */
  private async endForNewerTask(session: Session): Promise<void> {
    this.endedByNewer.add(session.recording.id);
    if (session.ownerWait) {
      this.staleWait = this.waitEndedLine(session, "a new open starts a new task");
      session.recording.ownerWaiting(false);
    }
    session.outcome = { outcome: "failed", reason: NEWER_TASK_REASON };
    session.workflow.unavailable(NEWER_TASK_REASON);
    session.closing = true;
    await this.remove(session);
    if (this.session === session) this.session = undefined;
  }

  private armIdle(session: Session): void {
    clearTimeout(session.idleTimer);
    if (this.session !== session || session.removing || this.disconnected) return;
    if (session.ownerWait) {
      session.idleTimer = setTimeout(() => {
        void this.endOwnerWait(session).catch((error: unknown) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`));
      }, Math.max(0, (session.ownerTouched ?? Date.now()) + OWNER_WAIT_LIMIT_MS - Date.now()));
      session.idleTimer.unref();
      return;
    }
    session.idleTimer = setTimeout(() => {
      if (this.options.hasHold?.()) { this.armIdle(session); return; }
      session.outcome = { outcome: "failed", reason: AGENT_IDLE_REASON };
      session.workflow.unavailable(session.outcome.reason);
      void this.remove(session, this.options.keepOpen?.() === true, false)
        .then(() => {
          if (this.session === session) this.session = undefined;
        })
        .catch((error: unknown) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`));
    }, SESSION_IDLE_MS);
    session.idleTimer.unref();
  }

  /** Stops the agent-browser daemon of one state folder, if it runs. */
  private async stopDaemon(stateDir: string): Promise<void> {
    try {
      const pid = Number((await readFile(path.join(stateDir, "bao.pid"), "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
      const running = () => {
        try { process.kill(pid, 0); return true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      };
      for (const signal of ["SIGTERM", "SIGTERM", "SIGKILL"] as const) {
        process.kill(pid, signal);
        const deadline = performance.now() + 1000;
        while (running() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (!running()) break;
      }
      if (running()) throw new Error(`agent-browser daemon ${pid} did not exit during bounded shutdown`);
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }

  private async remove(session: Session, keepOpen = false, closeTaskTabs = true): Promise<void> {
    clearTimeout(session.idleTimer);
    if (!session.removing) this.afterWall = session.kind === "copy" && !!session.ownerWait;
    try {
      if (session.kind === "current" && !session.closing && !this.disconnected) {
        this.currentEnded = true;
        this.endedRuns.set(session.recording.id, CURRENT_CHROME_ENDED);
      }
      await (session.removing ??= (async () => {
        session.abort.abort();
        await session.commandDone;
        session.recording.finish(session.outcome);
        if (session.ownerWait) session.workflow.unavailable("the owner wait did not finish");
        try {
          try { await this.stopDaemon(session.stateDir); }
          finally {
            if (session.kind === "copy") session.background.close();
            if (session.kind === "current" && session.relay) {
              // The lease holds every tab Bao opened in the owner's Chrome, including the agent's tab new and popups.
              // Detaching without closing hands them to the owner.
              try {
                if (closeTaskTabs && session.chrome.cdp.isOpen) await session.chrome.cdp.send("Bao.closeTabs", {}, undefined, 10_000);
              } finally { session.chrome.detach(); }
            } else if (session.kind === "current") {
              try {
                if (closeTaskTabs && session.taskTabs.size && session.chrome.cdp.isOpen) {
                  const { targetInfos } = await session.chrome.cdp.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets", {}, undefined, 5000);
                  for (const target of targetInfos.filter((target) => session.taskTabs.has(target.targetId))) {
                    await session.chrome.cdp.send("Target.closeTarget", { targetId: target.targetId }, undefined, 5000).catch(() => undefined);
                  }
                }
              } finally { session.chrome.detach(); }
            } else if (keepOpen && !session.closing && this.pendingCloses === 0 && !session.chrome.isClosed()) await session.chrome.keepOpen();
            else await session.chrome.close();
          }
          await rm(session.stateDir, { recursive: true, force: true });
        } finally {
          this.workflowOutcome = session.workflow.finish();
        }
      })());
      if (session.kind === "copy" && (session.closing || this.pendingCloses > 0) && !session.chrome.isClosed()) {
        session.closing = true;
        await session.chrome.close();
      }
      if (this.session === session && session.chrome.isClosed()) this.session = undefined;
    } catch (error) {
      // The call that ran the cleanup reports its failure. The session and its run end here, so later calls start fresh.
      const message = error instanceof Error ? error.message : String(error);
      session.removing = Promise.resolve();
      session.recording.cleanupFailed(message);
      if (this.session === session) this.session = undefined;
      throw new Error(`Bao could not clean up the browser session of run ${session.recording.id}: ${message}`, { cause: error });
    } finally {
      if (this.session === session && session.kind === "current" && session.chrome.isClosed()) this.session = undefined;
    }
  }
}
