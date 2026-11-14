import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createSocketSession } from "../unix-socket";
import path from "node:path";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { CDP_PROGRESS_CEILING_MS, connectCdp, type CdpSocket } from "../cdp-live/socket";
import { openCurrentChrome, openTaskTab, type CurrentChrome } from "../cdp-live/current-chrome";
import { DAEMON_BEHIND_QUERY } from "../cdp-live/shared-connection";
import { isChromeTab, type ChromeTarget } from "../cdp-live/chrome-tabs";
import { openRunningChrome, type RunningChrome } from "../extension/running-chrome";
import { resolveNormalChrome } from "../launch";
import { AgentBrowserRun, type AgentBrowserTaskOutcome, type RecordedAgentBrowserCommand, type StepContext } from "./agent-browser-record";
import { CURRENT_CHROME_ENDED, CURRENT_CHROME_LEFT_OPEN, newInRead, ownerReply, RUN_ENDED, TASK_TAB_CLOSED, type OwnerWaitPage } from "./agent-browser-describe";
import { BROWSER_PICTURE_BYTES, type ShotBox } from "../v1/shots";
import { agentBrowserExecutable } from "./agent-browser";
import { AgentBrowserWorkflow } from "./agent-browser-workflow";
import * as copyFront from "./copy-front";
import { chromeProfilesRoot, openCopiedChromeForProxy } from "./chrome-profile-copy";
import { ChromeFolderDenied } from "../chrome-access";
import { baoAgentProfileDir, openBaoChromeForProxy, type SignInImport } from "./bao-profile";
import { baoPick, boundOpenPlan, boundRoute, chromeApp, ChromeProfileQuestion, chooseChromeProfile, failedPickLine, fallbackPlan, fallsBack, openOrFallBack, pickLine, RoutesFailed, shortPickLine, signInLine, signInSource, type BrowserPick, type BrowserPlan, type RouteWhy } from "./browser-pick";
import { listProfileTabs } from "./profile-tabs";
import { BOUND_REASON, boundSite, purgeBoundSites } from "./bound-sign-in";
import { OWNER_WAIT_LIMIT_MS, ownerWall, ownerWallOnAddress, ownerCanResume, ownerTask, ownerWaitTimeout, ownerWaitInstruction, type OwnerPage } from "../cdp-live/owner-wait";
import { pageWall } from "../cdp-live/page-wall";
import { BROWSER_CHOICES, DEFAULT_BROWSER } from "../browser-choice";
import { targetBox } from "../v1/caption";
import { GLOBAL_BOOL_FLAGS, GLOBAL_VALUE_FLAGS, stripGlobalFlags, tabCommandAction } from "../v1/tab-command";
import { diffView, findView, snapshotView } from "./snapshot-view";
import { AGENT_DISCONNECTED, AGENT_IDLE_REASON, NEWER_TASK_REASON } from "../v1/stop-copy";
import { openBackgroundCdp, type BackgroundCdp } from "./background-cdp";
import { activeNativeTab, parseNativeTabs, type NativeTab } from "./agent-browser-tabs";
import { fileOperands } from "../v1/file-operands";
import { fileArgs, fileFacts, isFileCommand, type FileArgs, type FileCommand, type FileTransfer } from "./agent-browser-files";
import { downloadByClick, NOT_FILE_INPUT, uploadThroughChooser } from "./agent-browser-transfer";

export const AGENT_BROWSER_COMMANDS = ["open", "snapshot", "click", "fill", "press", "scroll", "tab", "screenshot", "upload", "download", "wait_for_owner", "close"] as const;
export type AgentBrowserCommand = typeof AGENT_BROWSER_COMMANDS[number];
export interface AgentBrowserCommandResult { stdout: string; stderr: string; exitCode: number }

const SESSION_IDLE_MS = 10 * 60 * 1000;

const FIXED_OPTIONS = new Set([
  "--session", "--namespace", "--profile", "--executable-path", "--headed", "--cdp", "--auto-connect",
  "--provider", "-p", "--engine", "--config", "--args", "--idle-timeout", "--all", "--pin-tab", "--no-pin-tab", "--download-path",
]);

/** One MCP process serves every chat, so a call that acts on a session names the run it belongs to. */
const runIdNeeded = (command: string) => `run_id is required on ${command} while a browser session is open. Send back the run id from this chat's latest agent_browser result; a chat whose results named no run has no session here.`;
const OTHER_TASK = "The browser now belongs to another task, so stop here.";

export function otherTaskClosed(runId: string): string {
  return `${RUN_ENDED} Run ${runId} is not Bao's open browser session. ${OTHER_TASK}`;
}

export function validateAgentBrowserCommand(command: unknown, args: unknown): asserts args is string[] {
  if (!AGENT_BROWSER_COMMANDS.includes(command as AgentBrowserCommand)) throw new Error("unknown agent-browser command");
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) {
    throw new Error("agent-browser args must be an array of strings");
  }
  if (args.some((arg) => FIXED_OPTIONS.has(arg.split("=", 1)[0]!))) {
    throw new Error("Bao fixes the agent-browser session, browser, headed mode, profile, lifetime, and download folder");
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

function httpPage(url: string | undefined): string | undefined {
  return url && /^https?:\/\//.test(url) ? url : undefined;
}

function hostName(url: string | undefined): string | undefined {
  const http = httpPage(url);
  if (!http) return undefined;
  try { return new URL(http).hostname; } catch { return undefined; }
}

/** The browser a later open is compared with: the route that actually opened. The extension counts as running Chrome. */
function openedChoice(pick: BrowserPick): AgentBrowser {
  return pick.route === "bao" || pick.route === "copy" ? pick.route : "current";
}

/** A command's move to the owner's running Chrome: the line that says so, and the new pick and opened page when it worked. */
type Moved = { line: string; pick?: BrowserPick; site?: string };

interface SessionData {
  browser: AgentBrowser;
  stateDir: string;
  executable: string;
  flags: string[];
  env: NodeJS.ProcessEnv;
  abort: AbortController;
  recording: AgentBrowserRun;
  workflow: AgentBrowserWorkflow;
  /** Chrome's own URL and title for the active tab, from the latest metadata read. */
  page?: OwnerPage;
  /** The latest http(s) page whose URL and title are not a sign-in or check. A click or later navigation reopens this at an address wall or a cross-host sign-in title. */
  beforeWall?: OwnerPage;
  /** The latest sign-in or check page, kept for the owner-wait card. */
  ownerPage?: OwnerPage;
  /** When Bao first stopped for the current or latest owner handoff. */
  ownerSince?: number;
  /** When Bao stopped for the owner, or the latest wait_for_owner call returned. A wait that is still on counts its limit from here. */
  ownerTouched?: number;
  /** Why a Bao-profile session could not move to the owner's running Chrome. Only an explicit wait_for_owner tries again. */
  moveError?: string;
  missed?: string;
  /** Whether Bao brought the waiting window on top of the owner's apps for the latest handoff. */
  raised?: boolean;
  /** The target the agent last had current. Chrome's selected tab can differ, because the background endpoint answers activateTarget itself. */
  agentTarget?: string;
  commandDone?: Promise<void>;
  outcome?: AgentBrowserTaskOutcome;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** The latest native snapshot output for each args list, the baseline of a snapshot diff. */
  snapshots: Map<string, string>;
  daemonStarted?: boolean;
}

interface ParsedTab { action: "list" | "new" | "close" | "switch"; ref?: string; json: boolean; flags: string[]; forwarded: string[] }

/** Global flags pinned agent-browser 0.41.0 accepts on any command, in the caller's order, including each flag's value. */
function acceptedCliFlags(args: readonly string[]): string[] {
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--restore=")) { flags.push(arg); continue; }
    if (GLOBAL_VALUE_FLAGS.has(arg)) {
      flags.push(arg);
      const next = args[i + 1];
      if (next !== undefined) flags.push(next);
      i += 1;
      continue;
    }
    if (arg === "--restore") { flags.push(arg); continue; }
    if (GLOBAL_BOOL_FLAGS.has(arg)) {
      flags.push(arg);
      const next = args[i + 1];
      if (next === "true" || next === "false") { flags.push(next); i += 1; }
      continue;
    }
  }
  return flags;
}

/** `tab new` words the pinned CLI accepts: the url, and `--label` with its value. Other dash words are not forwarded. */
function tabNewWords(cleaned: readonly string[]): string[] {
  const words = ["new"];
  for (let i = 1; i < cleaned.length; i++) {
    const arg = cleaned[i]!;
    if (arg === "--label") {
      words.push(arg);
      if (cleaned[i + 1] !== undefined) words.push(cleaned[++i]!);
      continue;
    }
    if (arg.startsWith("-")) continue;
    words.push(arg);
  }
  return words;
}

/** One parse of a tab command, matching the pinned CLI: flags first, then list, new, close, or a switch reference. */
function parseTabArgs(args: readonly string[]): ParsedTab {
  const { args: cleaned, json } = stripGlobalFlags(args);
  const head = cleaned[0];
  const action = tabCommandAction(args);
  const flags = acceptedCliFlags(args);
  const closeRef = action === "close" && cleaned.length > 1 ? cleaned[1] : undefined;
  const ref = action === "switch" ? head : closeRef;
  const words = action === "list" ? head === "list" || json || flags.length > 0 ? ["list"] : []
    : action === "new" ? tabNewWords(cleaned)
    : action === "close" ? closeRef !== undefined ? ["close", closeRef] : ["close"]
    : [head!];
  return { action, ...(ref !== undefined ? { ref } : {}), json, flags, forwarded: [...words, ...flags] };
}

const opensTab = (command: string, args: readonly string[]) => (command === "tab" && parseTabArgs(args).action === "new") || (command === "click" && args.includes("--new-tab"));

/** A command that can open a tab while the native daemon is running it: open, click, press, tab new, or click --new-tab. */
const canOpenTab = (command: string, args: readonly string[]) => command === "open" || command === "click" || command === "press" || (command === "tab" && parseTabArgs(args).action === "new");

type TabRef = { kind: "id"; id: number } | { kind: "label"; name: string } | { kind: "target"; id: string } | { kind: "invalid"; message: string };

function looksLikeTargetId(value: string): boolean {
  return value.length >= 16 && /^[0-9a-f]+$/iu.test(value);
}

function isValidLabel(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value);
}

/** A tab reference as the pinned CLI parses it: trimmed, `t` or `T` plus digits, a label, or a raw target id. */
function parseTabRef(input: string): TabRef {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "invalid", message: "Empty tab reference; expected `t<N>` (e.g. `t2`) or a label" };
  const digits = trimmed.startsWith("t") || trimmed.startsWith("T") ? trimmed.slice(1) : "";
  if (digits && /^[0-9]+$/u.test(digits)) {
    const id = Number(digits);
    if (!Number.isSafeInteger(id) || id > 0xffff_ffff) return { kind: "invalid", message: `Tab id \`${trimmed}\` out of range; ids are incrementing positive integers` };
    if (id === 0) return { kind: "invalid", message: `Tab id \`${trimmed}\` is invalid; tab ids start at t1` };
    return { kind: "id", id };
  }
  if (looksLikeTargetId(trimmed) && !isValidLabel(trimmed)) return { kind: "target", id: trimmed };
  if (/^[0-9]+$/u.test(trimmed)) return { kind: "invalid", message: `Expected a tab id like \`t${trimmed}\` or a label; positional integers are not accepted` };
  if (!isValidLabel(trimmed)) return { kind: "invalid", message: `Invalid tab label \`${trimmed}\`; labels must start with a letter and contain only letters, digits, -, and _` };
  return { kind: "label", name: trimmed };
}

function sameTarget(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

/** The native tab a reference names, or the refusal. An unknown reference is not forwarded. */
function resolveTabRef(ref: string, tabs: readonly NativeTab[]): NativeTab | { message: string } {
  const parsed = parseTabRef(ref);
  if (parsed.kind === "invalid") return { message: parsed.message };
  const canonical = parsed.kind === "id" ? `t${parsed.id}` : undefined;
  const tab = parsed.kind === "id"
    ? tabs.find((item) => item.tabId === canonical)
    : parsed.kind === "label"
      ? tabs.find((item) => item.label === parsed.name) ?? (looksLikeTargetId(parsed.name) ? tabs.find((item) => sameTarget(item.targetId, parsed.name)) : undefined)
      : tabs.find((item) => sameTarget(item.targetId, parsed.id));
  if (tab?.tabId) return tab;
  if (parsed.kind === "id") return { message: `Tab ${canonical} not found; run \`agent-browser tab\` to list open tabs` };
  if (parsed.kind === "label") return { message: `No tab with label \`${parsed.name}\`; run \`agent-browser tab\` to list open tabs` };
  return { message: `No tab with target id \`${parsed.id}\`; run \`agent-browser tab list --json\` to list open tabs with their target ids` };
}

/**
 * The owner's running Chrome over remote debugging. Bao closes only the tabs it opened. `targetId` is the tab the agent works in:
 * Bao's task tab, until a command that can open a tab follows a popup that command opened. That popup joins `taskTabs`.
 * `pending` holds targets in the list taken when that native command returned and absent from the list taken when it started.
 * `ended` is that return list, and only until the command queues it.
 */
type DebuggingChrome = { kind: "current"; relay?: undefined; chrome: CurrentChrome; taskTabs: Set<string>; targetId: string; pending: Set<string>; ended?: ReadonlySet<string>; justClosed?: string };

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

/** A page the owner wait is on. `wall` is set when Bao recognized a sign-in or check, by URL and title or by one snapshot, without keeping that snapshot. */
type WaitOn = { targetId: string; page: OwnerPage; reopen?: string; wall?: true };

/** The owner wait on a live or closing session. Recording status follows this value. */
type OwnerWait = "off" | "pending" | WaitOn;

/**
 * One agent-browser session seat. A live session cannot also be closing or ended.
 * `disconnected` is an ended reason that can still hold the session a later close must reach.
 */
type ProxySeat =
  | { phase: "starting"; promise: Promise<Session>; abort: AbortController; priorEnded?: "current-ended" }
  | { phase: "live"; session: Session; ownerWait: OwnerWait }
  | { phase: "closing"; session: Session; ownerWait: OwnerWait; keep: boolean }
  | { phase: "ended"; reason: "closed" | "current-ended" }
  | { phase: "ended"; reason: "disconnected"; session?: Session; ownerWait?: OwnerWait; starting?: Promise<Session>; closeRequested?: boolean; priorEnded?: "current-ended" };

/** The pid line from `lsappinfo info -only pid`. A missing pid does not skip the raise. */
export function parseFrontPid(text: string): number | undefined {
  const match = text.match(/(?:^|\s)pid\s*=\s*(\d+)\b/);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2000, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
}

/** The front app's pid, from `lsappinfo`. A failed read does not skip the raise. */
export const frontApplication = {
  async pid(): Promise<number | undefined> {
    if (process.platform !== "darwin") return undefined;
    const asn = (await execText("/usr/bin/lsappinfo", ["front"])).trim();
    if (!asn) return undefined;
    return parseFrontPid(await execText("/usr/bin/lsappinfo", ["info", "-only", "pid", asn]));
  },
};

async function chromeIsFront(pid: number | undefined): Promise<boolean> {
  if (process.platform !== "darwin" || pid === undefined) return false;
  try { return await frontApplication.pid() === pid; }
  catch { return false; }
}

/**
 * macOS does not let a Chrome that Bao launched in the background make itself the front app, so Target.activateTarget only
 * lifts its window behind the owner's. A window that comes back from the Dock comes back on top of every app's windows. That
 * Dock cycle leaves the keyboard with the owner's app. A zoomed window comes back zoomed. A full-screen Bao profile
 * window has its own Space, so Bao leaves it. A copy handoff does not use this cycle: minimizing one of its windows brings
 * the copy's other windows forward. Returns whether the window came back on top.
 */
async function windowOnTop(cdp: CdpSocket, targetId: string, options?: { leaveFullscreen?: boolean }): Promise<boolean> {
  const { windowId } = await cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId }, undefined, 2000);
  const { bounds: { windowState } } = await cdp.send<{ bounds: { windowState: string } }>("Browser.getWindowBounds", { windowId }, undefined, 2000);
  if (windowState === "fullscreen" && !options?.leaveFullscreen) return false;
  const set = (state: string) => cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } }, undefined, 2000);
  if (windowState === "fullscreen") await set("normal");
  if (windowState !== "minimized") await set("minimized");
  await set("normal");
  if (windowState === "maximized") {
    // Chrome refuses to zoom a window it still counts as minimized or full screen. The Dock cycle already ran.
    // A copy handoff does not fail on that refusal. Other routes still treat it as a missed raise.
    try { await set("maximized"); }
    catch (error) { if (!options?.leaveFullscreen) throw error; }
  }
  return true;
}

/** Leave full screen or the Dock. Do not minimize a visible window: that brings the copy's other windows forward. */
async function uncoverCopyWindow(cdp: CdpSocket, targetId: string): Promise<void> {
  const once = async () => {
    const { windowId } = await cdp.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId }, undefined, 2000);
    const { bounds } = await cdp.send<{ bounds?: { windowState?: string } }>("Browser.getWindowBounds", { windowId }, undefined, 2000);
    if (bounds?.windowState !== "fullscreen" && bounds?.windowState !== "minimized") return;
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } }, undefined, 2000);
  };
  try {
    await once();
  } catch (first) {
    try {
      await once();
    } catch (retry) {
      const detail = retry instanceof Error ? retry.message : String(retry);
      const prior = first instanceof Error ? first.message : String(first);
      console.error(`bao copy handoff did not uncover the window: ${detail}${detail === prior ? "" : `; first try: ${prior}`}`);
    }
  }
}

async function behind(chrome: OwnedChrome): Promise<{ chrome: OwnedChrome; background: BackgroundCdp }> {
  try {
    return { chrome, background: await openBackgroundCdp(await readDevToolsActivePort(chrome.target.portFile)) };
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

function ownerWaitPage(wait: OwnerWait, ownerPage: OwnerPage | undefined): OwnerPage | undefined {
  return wait !== "off" && wait !== "pending" ? wait.page : ownerPage;
}

const OWNER_BANNER_STYLE = "position:fixed;bottom:16px;left:16px;right:16px;padding:16px 20px;background:#fff3dd;color:#492800;border:2px solid #e88600;border-radius:12px;font:600 15px/1.5 system-ui;box-shadow:0 4px 20px #0003;z-index:2147483647;pointer-events:none";
const OWNER_BANNER_CANCEL = "baoOwnerWaitCancel";

/** Paints the owner-wait banner in the top frame. It writes that node and reads nothing from the page. */
function ownerBannerScript(text: string): string {
  const handle = JSON.stringify(OWNER_BANNER_CANCEL);
  return `(() => {
    try { if (window.top !== window) return; } catch { return; }
    const place = () => {
      const root = document.documentElement;
      if (!root) return;
      document.getElementById("bao-owner-wait")?.remove();
      const banner = document.createElement("div");
      banner.id = "bao-owner-wait";
      banner.setAttribute("role", "status");
      banner.textContent = ${JSON.stringify(text)};
      banner.style.cssText = ${JSON.stringify(OWNER_BANNER_STYLE)};
      root.append(banner);
    };
    const handle = ${handle};
    const prior = window[handle];
    window[handle] = () => {
      document.removeEventListener("DOMContentLoaded", place);
      try { if (typeof prior === "function") prior(); } catch {}
    };
    // A new document is still loading when Chrome runs this. Placing now loses the node to the parser.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", place, { once: true });
    else place();
  })()`;
}

/** Drops a queued banner callback and Bao's banner node. It writes Bao's handle and reads nothing from the page. */
function ownerBannerGone(): string {
  const handle = JSON.stringify(OWNER_BANNER_CANCEL);
  return `(() => {
    const handle = ${handle};
    const cancel = window[handle];
    window[handle] = undefined;
    try { if (typeof cancel === "function") cancel(); } catch {}
    document.getElementById("bao-owner-wait")?.remove();
  })()`;
}

export class AgentBrowserProxy {
  private seat: ProxySeat = { phase: "ended", reason: "closed" };
  /** Close commands already queued. A close can arrive before the session it closes. */
  private pendingCloses = 0;
  private readonly cleanups = new WeakMap<Session, Promise<void>>();
  private latest: { runId: string; step: RecordedAgentBrowserCommand; steps: readonly RecordedAgentBrowserCommand[]; lastPicture?: AgentBrowserRun["lastPicture"] } | undefined;
  private workflowOutcome: string | undefined;

  get lastWorkflowOutcome(): string | undefined { return this.workflowOutcome; }
  /** Where the latest command's download landed. */
  get savedFile(): string | undefined { return this.saved; }
  private saved: string | undefined;
  get lastCommand(): typeof this.latest { return this.latest; }
  get activeRunId(): string | undefined { return this.session?.recording.id; }
  /** The open session drives the owner's own running Chrome. */
  get currentChrome(): boolean { return this.session?.kind === "current" || this.closedCurrent; }
  /** The sign-in or check page Bao is waiting on, or the latest one it waited on. URL and title only. */
  get ownerPage(): OwnerWaitPage | undefined {
    const session = this.session;
    const page = session && ownerWaitPage(this.waitOf(session), session.ownerPage);
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
    const fallback = missed && this.waitOf(session) === "off" && !session.moveError ? `If the site still asks for a sign-in, Bao moves this session to the owner's running Chrome over remote debugging on the same Chrome profile "${from}" by itself when it sees the wall or when you call wait_for_owner.` : "";
    return [pickLine(session.pick), ...whyMissed, ...this.imports.map((report) => signInLine(report, from)), ...fallback ? [fallback] : [], ...failed];
  }
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
  /**
   * The banner script on the waiting tab. Chrome runs it on the next document, including a reload
   * that keeps the same address and title. Absent when no wait is showing a banner.
   */
  private reloadBanner: {
    targetId: string;
    source: string;
    cdp: CdpSocket;
    sessionId: string;
    identifier: string;
    /** This socket was opened for the script. The owner's Chrome socket is not closed with it. */
    owned: boolean;
  } | undefined;

  constructor(private readonly options: {
    home: string; sourceRoot?: string; executable?: string; keepOpen?: () => boolean; hasHold?: () => boolean;
    /** The Chrome profile folder picked in Bao Settings. On the agent path it is marked when Bao asks for a profile, and it chooses the owner's device-bound purge list on Bao-profile opens. */
    settingsProfile?: () => string | undefined;
    /** The gate for Running Chrome through the Bao extension. Off means remote debugging. */
    extensionRoute?: () => boolean;
  }) {}

  /** The live, closing, or disconnected session. Ended without a leftover has none. */
  private get session(): Session | undefined {
    const seat = this.seat;
    switch (seat.phase) {
      case "live":
      case "closing":
        return seat.session;
      case "ended":
        return seat.reason === "disconnected" ? seat.session : undefined;
      case "starting":
        return undefined;
    }
  }

  private get starting(): Promise<Session> | undefined {
    const seat = this.seat;
    if (seat.phase === "starting") return seat.promise;
    if (seat.phase === "ended" && seat.reason === "disconnected") return seat.starting;
    return undefined;
  }

  private gone(): boolean {
    return this.seat.phase === "ended" && this.seat.reason === "disconnected";
  }

  private isCurrentEnded(): boolean {
    return this.seat.phase === "ended" && this.seat.reason === "current-ended";
  }

  private clearCurrentEnded(): void {
    if (this.seat.phase === "ended" && this.seat.reason === "current-ended") {
      this.seat = { phase: "ended", reason: "closed" };
    }
  }

  private waitOf(session: Session): OwnerWait {
    const seat = this.seat;
    if ((seat.phase === "live" || seat.phase === "closing") && seat.session === session) return seat.ownerWait;
    if (seat.phase === "ended" && seat.reason === "disconnected" && seat.session === session) return seat.ownerWait ?? "off";
    return "off";
  }

  private setWait(session: Session, wait: OwnerWait): void {
    const seat = this.seat;
    if ((seat.phase === "live" || seat.phase === "closing") && seat.session === session) seat.ownerWait = wait;
    else if (seat.phase === "ended" && seat.reason === "disconnected" && seat.session === session) seat.ownerWait = wait;
    if (wait === "off" || wait === "pending") session.raised = undefined;
    session.recording.ownerWaiting(wait !== "off");
  }

  private closingOf(session: Session): boolean {
    const seat = this.seat;
    if (seat.phase === "closing" && seat.session === session) return !seat.keep;
    return seat.phase === "ended" && seat.reason === "disconnected" && seat.session === session && seat.closeRequested === true;
  }

  private requestClose(session: Session): void {
    const seat = this.seat;
    if (seat.phase === "closing" && seat.session === session) {
      seat.keep = false;
      return;
    }
    if (seat.phase === "ended" && seat.reason === "disconnected" && seat.session === session) {
      seat.closeRequested = true;
      return;
    }
    if (seat.phase !== "live" || seat.session !== session) return;
    this.seat = { phase: "closing", session, ownerWait: seat.ownerWait, keep: false };
  }

  private removingOf(session: Session): Promise<void> | undefined {
    return this.cleanups.get(session);
  }

  private adopt(session: Session): void {
    const seat = this.seat;
    if (seat.phase === "ended" && seat.reason === "disconnected") {
      const { priorEnded: _priorEnded, ...kept } = seat;
      this.seat = { ...kept, session, starting: undefined };
      return;
    }
    this.seat = { phase: "live", session, ownerWait: "off" };
  }

  private drop(session: Session, reason: "closed" | "current-ended" = "closed"): void {
    const seat = this.seat;
    if (this.session !== session) return;
    if (seat.phase === "ended" && seat.reason === "disconnected") {
      this.seat = { phase: "ended", reason: "disconnected" };
      return;
    }
    this.seat = { phase: "ended", reason };
  }

  private clearStart(): void {
    const seat = this.seat;
    if (seat.phase === "starting") this.seat = { phase: "ended", reason: seat.priorEnded ?? "closed" };
    else if (seat.phase === "ended" && seat.reason === "disconnected") {
      const { starting: _starting, priorEnded, ...rest } = seat;
      // A start that fails after disconnect must restore the Chrome-ended reason, the same way a start that fails without disconnect does.
      this.seat = priorEnded && !rest.session ? { phase: "ended", reason: priorEnded } : rest;
    }
  }

  private ownerWaitOver(session: Session): boolean {
    return this.waitOf(session) !== "off" && !this.removingOf(session) && Date.now() - (session.ownerTouched ?? Date.now()) >= OWNER_WAIT_LIMIT_MS;
  }

  private wallOf(session: Session): WaitOn | undefined {
    const wait = this.waitOf(session);
    return wait !== "off" && wait !== "pending" ? wait : undefined;
  }

  private reopenOf(session: Session): string | undefined {
    const wall = this.wallOf(session);
    return wall ? wall.reopen : this.pageToReopen(session, session.page);
  }

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
    snapshot: { find?: unknown; diff?: unknown } = {}, runId?: unknown, profileReason?: unknown): Promise<AgentBrowserCommandResult[]> {
    this.endedLine = undefined;
    this.refusal = undefined;
    this.latest = undefined;
    this.shown = undefined;
    this.notOpened = undefined;
    this.saved = undefined;
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
    if (profileReason !== undefined && (command !== "open" || typeof profileReason !== "string")) {
      throw new Error("profile_reason is only accepted on open and must be a short reason");
    }
    const statedReason = typeof profileReason === "string" ? profileReason : undefined;
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
      try {
        if (this.session && this.ownerWaitOver(this.session)) await this.endOwnerWait(this.session);
        else if (this.session && !this.removingOf(this.session!)) await this.endForNewerTask(this.session);
        else if ((this.session && this.removingOf(this.session))) await this.removingOf(this.session!);
      } catch (error) {
        if (this.session) {
          const cause = error instanceof Error && error.cause !== undefined ? error.cause : error;
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`Bao could not clean up the earlier browser session: ${message}`, { cause });
        }
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
      this.refusal = undefined;
    } else if (this.session && this.ownerWaitOver(this.session)) await this.endOwnerWait(this.session);
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
    if (browser !== undefined && (this.session && this.removingOf(this.session))) await this.removingOf(this.session!);
    if (this.session?.kind === "current" && this.session.chrome.isClosed()) await this.remove(this.session);
    if (browser !== undefined && this.starting) throw new Error("choose the browser only on the first open of a session");
    if (this.session && browser !== undefined && browser !== this.session.browser) {
      throw new Error("close the current session before choosing a different browser");
    }
    const leftOpen = command === "close" && this.isCurrentEnded() && !this.taskTabEnded;
    const endedClose: AgentBrowserCommandResult[] = [{ stdout: leftOpen ? `${CURRENT_CHROME_LEFT_OPEN}\n` : "", stderr: "", exitCode: 0 }];
    this.closedCurrent = command === "close" && (this.isCurrentEnded() || this.taskTabEnded);
    if (command === "close") {
      this.clearCurrentEnded();
      this.taskTabEnded = false;
      if (this.session) this.requestClose(this.session);
      if (this.gone()) {
        await this.end(true);
        return endedClose;
      }
    }
    if ((this.session && this.removingOf(this.session))) await this.removingOf(this.session!);
    if (this.gone()) throw new Error(AGENT_DISCONNECTED);
    if (!this.session && command === "close") return endedClose;
    if (!this.session && this.taskTabEnded && (command !== "open" || browser === undefined)) throw new Error(TASK_TAB_CLOSED);
    if (!this.session && this.isCurrentEnded() && (command !== "open" || browser === undefined)) throw new Error(CURRENT_CHROME_ENDED);
    if (!this.session && command !== "open") throw new Error("start agent-browser with open before sending commands");
    if (this.session?.abort.signal.aborted) {
      const session = this.session;
      if (command === "close") await this.remove(session);
      return this.ownerResult("closed", session);
    }
    let files: FileArgs | undefined;
    if (isFileCommand(command) && this.session) {
      if (this.session.kind === "current" && this.session.relay) {
        throw new Error("upload and download need Running Chrome over remote debugging, the Bao profile, or a copy, not the Bao extension.");
      }
      files = await fileArgs(command, args, this.session.recording.downloadsDir);
    }
    const nativeArgs = files?.forwarded ?? args;
    const continuing = !!this.session;
    // The route and profile are settled before any run record, so a question about the profile opens and records nothing.
    const plan = continuing ? undefined : await this.plan(browser as AgentBrowser | undefined, named, webSite(args[0]));
    const recording = this.session?.recording ?? new AgentBrowserRun(this.options.home);
    if (!continuing && named) recording.noteProfileChoice(named, statedReason);
    let step = continuing ? undefined : recording.begin(command as string, args);
    if (step) this.latest = { runId: recording.id, step, steps: recording.steps };
    if (!this.session) {
      try {
        const session = await this.start(recording, plan!, webSite(args[0]));
        this.adopt(session);
        this.clearCurrentEnded();
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
        this.clearStart();
      }
    }
    const session = this.session;
    if (!session) throw new Error("start agent-browser with open before sending commands");
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
      if (this.gone()) throw new Error(AGENT_DISCONNECTED);
      if (continuing && command !== "close" && command !== "wait_for_owner") {
        await this.noteWall(session);
        const opened = await this.settleWall(session);
        // Refs from Bao's browser do not hold in the new tab, so an action waits for a fresh snapshot.
        if (opened && (this.waitOf(session) !== "off" || command !== "snapshot" && command !== "open")) {
          step = recording.begin("open", [this.moved!.site!]);
          this.latest = { runId: recording.id, step, steps: recording.steps };
          results.push(...this.waitOf(session) !== "off" ? this.ownerResult("halted", session) : [opened]);
          return results;
        }
        if (this.waitOf(session) !== "off") {
          results.push(...this.ownerResult("halted", session));
          return results;
        }
      }
      context.previousPage = session.page;
      if (command === "wait_for_owner") {
        const timeout = ownerWaitTimeout(args[0] === undefined ? undefined : Number(args[0]));
        const deadline = Date.now() + timeout;
        const wall = this.wallOf(session);
        const read = !wall ? await this.activePage(session).catch((error: unknown) => { if (error instanceof TaskTabClosed) throw error; return undefined; }) : undefined;
        const stop = wall ?? (read ? this.stopped(session, read) : undefined);
        const page = stop?.page;
        const noted = read && !ownerWall(read.page) ? await this.withWall(session, this.stopped(session, read)) : undefined;
        if (stop && read && (this.waitOf(session) === "off" || this.waitOf(session) === "pending")) {
          if (this.waitOf(session) === "off") session.ownerSince = session.ownerTouched = Date.now();
          this.setWait(session, noted ?? await this.withWall(session, stop));
          session.ownerPage = read.page;
        }
        const opened = stop ? await this.settleWall(session, { retry: true, what: this.wallWords(session), url: stop.reopen }) : undefined;
        if (opened) {
          step = recording.begin("open", [this.moved!.site!]);
          this.latest = { runId: recording.id, step, steps: recording.steps };
          results.push(...this.waitOf(session) !== "off" ? this.ownerResult("halted", session) : [opened]);
          return results;
        }
        if (!stop) {
          if (this.waitOf(session) === "off") {
            session.ownerSince = session.ownerTouched = Date.now();
            this.setWait(session, "pending");
          } else session.recording.ownerWaiting(true);
          let active: { targetId: string; page: OwnerPage } | undefined;
          let absent = false;
          while (Date.now() < deadline && !session.abort.signal.aborted) {
            try {
              const found = await this.activePage(session);
              if (!found) absent = true;
              else active = found;
              break;
            } catch (error) {
              if (error instanceof TaskTabClosed) throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
          }
          if (!active) {
            const discovered = session.abort.signal.aborted || absent ? this.ownerClosed(session) : await this.waitForOwner(session, deadline);
            step = recording.begin(command as string, args);
            this.latest = { runId: recording.id, step, steps: recording.steps };
            results.push(...discovered);
            if (ownerReply(results)?.instruction === TASK_TAB_CLOSED) failure = new Error("Bao's task tab was closed");
            return results;
          }
          if (this.waitOf(session) === "off") session.ownerSince = session.ownerTouched = Date.now();
          this.setWait(session, this.stopped(session, active));
          session.ownerPage = active.page;
          const opened = await this.settleWall(session, { retry: true, what: this.wallWords(session), url: this.reopenOf(session) });
          const moved = this.moved?.site;
          step = recording.begin(moved ? "open" : command as string, moved ? [moved] : args);
          this.latest = { runId: recording.id, step, steps: recording.steps };
          if (opened) {
            results.push(...this.waitOf(session) !== "off" ? this.ownerResult("halted", session) : [opened]);
            return results;
          }
          results.push(...await this.waitForOwner(session, Math.max(deadline, Date.now() + Math.min(timeout, 5000))));
          if (ownerReply(results)?.instruction === TASK_TAB_CLOSED) failure = new Error("Bao's task tab was closed");
          return results;
        }
        step ??= recording.begin(command as string, args);
        this.latest = { runId: recording.id, step, steps: recording.steps };
        results.push(...await this.waitForOwner(session, page ? Math.max(deadline, Date.now() + Math.min(timeout, 5000)) : deadline));
        if (ownerReply(results)?.instruction === TASK_TAB_CLOSED) failure = new Error("Bao's task tab was closed");
        return results;
      }
      if ((command === "click" || command === "fill") && args[0] && !step) {
        await this.noteWall(session);
        if (this.waitOf(session) !== "off") {
          const opened = await this.settleWall(session, { retry: true });
          if (opened) {
            step = recording.begin("open", [this.moved!.site!]);
            this.latest = { runId: recording.id, step, steps: recording.steps };
            results.push(...this.waitOf(session) !== "off" ? this.ownerResult("halted", session) : [opened]);
            return results;
          }
          results.push(...this.ownerResult("halted", session));
          return results;
        }
      }
      step ??= recording.begin(command as string, nativeArgs);
      this.latest = { runId: recording.id, step, steps: recording.steps };
      if (command === "open") {
        const site = webSite(args[0]);
        if (continuing && site && this.bound(session, site)) {
          const opened = await this.moveAway(session, BOUND_REASON, site, true);
          if (opened) {
            await this.settleWall(session);
            results.push(...this.waitOf(session) !== "off" ? this.ownerResult("halted", session) : [opened, await this.forward(session, "tab", ["list"])]);
            return results;
          }
        } else if (continuing && site && "importLogin" in session.chrome) this.imported(session, await session.chrome.importLogin(site));
      }
      const target = command === "click" || command === "fill" ? args[0] : files ? fileOperands(args).selector : undefined;
      if (target) {
        await this.captureTarget(session, step, target);
        if (this.waitOf(session) !== "off") {
          const opened = await this.settleWall(session, { retry: true });
          if (opened && this.moved?.site) {
            step.native.command = "open";
            step.native.args = [this.moved.site];
            results.splice(0, results.length, ...this.waitOf(session) !== "off" ? this.ownerResult("halted", session) : [opened]);
            return results;
          }
          results.splice(0, results.length, ...this.ownerResult("halted", session));
          return results;
        }
      }
      let inPage = false;
      await session.workflow.record(command as string, nativeArgs, step.id, async () => {
        const result = command === "close" && (session.kind === "current" || session.chrome.isClosed())
          ? { stdout: session.kind === "current" ? "Disconnected from the owner's own Chrome. Only Bao's task tabs close; the owner's tabs and windows stay open." : "", stderr: "", exitCode: 0 }
          : files ? await this.transfer(session, command as FileCommand, files).then((done) => { context.transfer = done.transfer; return done.result; })
            : await this.runNative(session, command as string, nativeArgs);
        results.push(result);
        if (files?.saved && result.exitCode === 0) this.saved = files.saved;
        if (command !== "close" && result.exitCode === 0) await this.noteWall(session, command === "open" ? webSite(args[0]) : undefined);
        return result;
      }, () => this.waitOf(session) !== "off");
      if (command !== "close" && results[0]?.exitCode === 0) {
        inPage = this.waitOf(session) === "off" && command === "snapshot" && this.movable(session) && pageWall(results[0].stdout);
        if (inPage && session.page && session.agentTarget) {
          if (session.ownerSince === undefined) session.ownerSince = session.ownerTouched = Date.now();
          this.setWait(session, { ...this.stopped(session, { targetId: session.agentTarget, page: session.page }), wall: true });
          session.ownerPage = session.page;
        }
        const opened = command === "open" && this.waitOf(session) !== "off" ? await this.settleWall(session)
          : inPage && session.page ? await this.settleWall(session, { what: "a sign-in or verification prompt", url: session.page.url }) : undefined;
        if (opened && (command === "open" || this.waitOf(session) === "off")) {
          results.splice(0, results.length, command === "snapshot" && this.waitOf(session) === "off" ? await this.run(session, "snapshot", args) : opened);
        }
      }
      // A close during an owner wait ends the session; it reports the close, not the wait.
      if (this.waitOf(session) !== "off" && command !== "close" && (command === "open" || this.moved?.pick)) {
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
        // A copy or Bao profile keeps the native list, including restored tabs. Running Chrome keeps only Bao's task tabs.
        results.push(await this.forward(session, "tab", ["list"]));
      }
      return results;
    } catch (error) {
      if (error instanceof TaskTabClosed) {
        const agentClosedTab = command === "tab" && parseTabArgs(args).action === "close" && results.some((result) => result.exitCode === 0);
        results.splice(0, results.length, ...await this.endTaskTab(session));
        step ??= recording.begin(command as string, nativeArgs);
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
              this.waitOf(session) !== "off" || command === "wait_for_owner", { ...context, page: session.page, owner: this.ownerPage, current: session.kind === "current",
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
        if (command === "close" || session.kind === "current" && session.abort.signal.aborted && !this.removingOf(session) && !this.gone()) await this.remove(session);
        else this.armIdle(session);
      }
    }
  }

  hasSession(): boolean {
    return this.session !== undefined || this.starting !== undefined;
  }

  disconnect(): void {
    const seat = this.seat;
    if (seat.phase === "starting") seat.abort.abort();
    else this.session?.abort.abort();
    // Chrome already ended, and the task tab was left open. A later close still has to say so. Disconnect must not replace that reason.
    if (seat.phase === "ended" && (seat.reason === "disconnected" || seat.reason === "current-ended")) return;
    const session = seat.phase === "live" || seat.phase === "closing" ? seat.session : undefined;
    const ownerWait = seat.phase === "live" || seat.phase === "closing" ? seat.ownerWait : undefined;
    const starting = seat.phase === "starting" ? seat.promise : undefined;
    const priorEnded = seat.phase === "starting" ? seat.priorEnded : undefined;
    this.seat = {
      phase: "ended", reason: "disconnected",
      ...(session ? { session, ownerWait } : {}),
      ...(starting ? { starting } : {}),
      ...(priorEnded ? { priorEnded } : {}),
    };
  }

  async end(closeRequested = false): Promise<void> {
    this.disconnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await this.starting?.catch(() => undefined);
    if (this.session) {
      if (closeRequested) this.requestClose(this.session);
      await this.remove(this.session, this.options.keepOpen?.() === true);
    }
  }

  /**
   * Ends the open session when `runId` names it. Another run's id changes nothing and returns undefined with `refused` set; no
   * run_id while a session is open is an error.
   */
  async finishTask(outcome: AgentBrowserTaskOutcome, runId?: string): Promise<string | undefined> {
    this.endedLine = undefined;
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
    this.endedLine = this.staleWait;
    this.staleWait = undefined;
    this.clearCurrentEnded();
    this.taskTabEnded = false;
    this.shown = session && { session, command: "finish_task" };
    if (!session) return undefined;
    session.outcome = outcome;
    try {
      await this.remove(session, this.options.keepOpen?.() === true);
      session.recording.finish(outcome);
      this.drop(session);
      return session.recording.id;
    } finally {
      this.endedRuns.delete(session.recording.id);
      this.clearCurrentEnded();
      this.taskTabEnded = false;
    }
  }

  async close(): Promise<void> {
    if (!this.session) return;
    this.requestClose(this.session);
    if (this.gone() || this.removingOf(this.session!) || this.session.abort.signal.aborted) {
      await this.remove(this.session);
      return;
    }
    const [result] = await this.execute("close", [], undefined, false, undefined, {}, this.session.recording.id);
    if (result!.exitCode !== 0) throw new Error("agent-browser close failed");
  }

  /**
   * Tabs for the profile question. A failed read still asks. It does not open a browser or turn debugging on.
   * Live tabs are listed only when a listener is already up, through Bao's shared Chrome connection. That join is released before this returns.
   */
  private async withOpenTabs(error: ChromeProfileQuestion): Promise<ChromeProfileQuestion> {
    try {
      return error.withListing(await listProfileTabs(error.root, error.profiles.map((profile) => profile.directory)));
    } catch {
      return error.withListing({ byDirectory: {}, unread: "remote debugging is off" });
    }
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
      const profile = await chooseChromeProfile(root, named === undefined ? undefined : { directory: named, by: "agent" }, this.options.settingsProfile?.(), route === "current", path.join(this.options.home, "audit", "current-chrome.jsonl"));
      if (boundRoute(route, site, path.join(profile.root, profile.directory))) {
        return boundOpenPlan(route, profile, this.options.extensionRoute?.() === true);
      }
      return { route, why, profile };
    } catch (error) {
      if (error instanceof ChromeProfileQuestion) throw await this.withOpenTabs(error);
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
          return { kind: "current", chrome, taskTabs, targetId: tab.targetId, pending: new Set(),
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
    const abort = new AbortController();
    const seat = this.seat;
    let settle!: (value: Session) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<Session>((resolve, reject) => { settle = resolve; fail = reject; });
    promise.catch(() => undefined);
    const priorEnded = seat.phase === "ended" && seat.reason === "current-ended" ? "current-ended" as const : undefined;
    if (seat.phase === "ended" && seat.reason === "disconnected") this.seat = { ...seat, starting: promise };
    else this.seat = { phase: "starting", promise, abort, ...(priorEnded ? { priorEnded } : {}) };
    let missed: string | undefined;
    let browser: Opened | undefined;
    try {
      browser = await openOrFallBack(plan, (next) => {
        missed = "missed" in next ? next.missed : undefined;
        return this.open(next, abort.signal, site);
      }, () => abort.signal.aborted);
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
      if (session.kind === "current" && !session.relay) await recording.recordTab(session.chrome.cdp, session.targetId);
      settle(session);
      return session;
    } catch (error) {
      if (browser) await this.discard(browser);
      fail(error);
      throw error;
    }
  }

  /** The agent-browser state folder, flags, and environment that drive an opened browser. */
  private async wire(browser: Opened): Promise<Pick<SessionData, "stateDir" | "flags" | "env">> {
    const stateDir = createSocketSession(this.options.home);
    try {
      const config = path.join(stateDir, "config.json");
      await writeFile(config, "{}", { mode: 0o600 });
      // agent-browser selects this session's bound target (`<session>.target` in its socket directory) when its daemon attaches.
      if (browser.targetId) await writeFile(path.join(stateDir, "bao.target"), JSON.stringify({ targetId: browser.targetId, url: "about:blank" }), { mode: 0o600 });
      const endpoint = browser.kind === "current" ? browser.chrome.endpoint : browser.background.endpoint;
      // On the owner's Chrome the native daemon stays on its bound tab. Without the pin it makes every target it discovers
      // current, such as a tab the owner opens or Chrome's Gemini panel. Only its URL carries background=1, so a later Bao
      // process that joins for a handoff is forwarded and can still raise the task tab.
      const pin = browser.kind === "current" && !browser.relay ? ["--pin-tab"] : [];
      const behind = browser.kind === "current" && !browser.relay ? `?${DAEMON_BEHIND_QUERY}` : "";
      return {
        stateDir,
        flags: ["--session", "bao", "--config", config, ...pin, "--cdp", `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}${behind}`, "--idle-timeout", "0"],
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
      if (this.closingOf(session) || session.chrome !== chrome) return;
      if (!this.gone() && !this.removingOf(session)) session.workflow.unavailable("the owner closed the window before the task finished");
      return this.remove(session);
    }).catch(() => undefined);
  }

  /**
   * A Bao-profile session whose move to the owner's running Chrome has not failed, or any Bao-profile session on a retry. A copy
   * moves only to open a site that ties its sign-in to the owner's Chrome.
   */
  private movable(session: Session, retry = false, bound = false): boolean {
    return session.kind === "copy" && (session.pick.route === "bao" || bound && session.pick.route === "copy")
      && (retry || session.moveError === undefined) && !this.closingOf(session) && !this.gone();
  }

  /** The site ties its sign-in to the owner's Chrome, so a Bao profile or copy does not open it. */
  private bound(session: Session, site: string | undefined): boolean {
    if (!site || session.kind !== "copy" || session.pick.route === "extension") return false;
    const profile = session.pick.profile;
    return boundSite(site, profile && path.join(profile.root, profile.directory));
  }

  /**
   * The http(s) page Running Chrome should open. An open reopens the URL it asked for, except a check title, which keeps
   * its own URL. A click or later navigation reopens the page before an address wall or a sign-in title on another host.
   */
  private pageToReopen(session: Session, page: OwnerPage | undefined, openedSite?: string): string | undefined {
    const before = session.beforeWall?.url;
    if (openedSite && !(page && ownerWall(page) === "bot_wall" && !ownerWallOnAddress(page))) return openedSite;
    if (page && ownerWallOnAddress(page)) return before ?? httpPage(page.url);
    if (page && ownerWall(page) === "login_wall") {
      const wallHost = hostName(page.url);
      const beforeHost = hostName(before);
      if (before && beforeHost && wallHost && beforeHost !== wallHost) return before;
    }
    return httpPage(page?.url) ?? before;
  }

  /** The page Running Chrome should open, stored on the wall so a later retry opens that page. */
  private stopped(session: Session, active: { targetId: string; page: OwnerPage }, openedSite?: string): WaitOn {
    return { targetId: active.targetId, page: active.page, reopen: this.pageToReopen(session, active.page, openedSite) };
  }

  /**
   * Records a recognized wall on the wait `wait_for_owner` is about to set. A URL or title wall needs no snapshot.
   * An in-page dialog needs one snapshot read, and that text is not stored.
   */
  private async withWall(session: Session, wait: WaitOn): Promise<WaitOn> {
    if (wait.wall === true || ownerWall(wait.page) !== null || await this.snapshotWall(session)) return { ...wait, wall: true };
    return wait;
  }

  /** One snapshot, only to tell an in-page sign-in or verification dialog from a normal page. A failed read is not a wall. */
  private async snapshotWall(session: Session): Promise<boolean> {
    try {
      const read = await this.run(session, "snapshot", [], 2000);
      return read.exitCode === 0 && pageWall(read.stdout);
    } catch {
      return false;
    }
  }

  private wallWords(session: Session): string {
    const page = this.wallOf(session)?.page ?? session.page;
    const wall = page && ownerWall(page);
    if (wall === "bot_wall") return "a human check";
    if (wall === "login_wall") return "a sign-in page";
    return "a step that needs the owner";
  }

  /**
   * Continues a Bao-profile session in the owner's running Chrome over remote debugging, on the Chrome profile its sign-in
   * import read, in the same session and run. Opens the http(s) page it is given, or the wall or active page when it is given
   * none, then closes Bao's window. When the move does not work, the session stays and the line says why. Returns the open
   * result in the new tab.
   */
  private async moveAway(session: Session, what: string, url: string | undefined, retry = false): Promise<AgentBrowserCommandResult | undefined> {
    const bound = what === BOUND_REASON;
    if (!this.movable(session, retry, bound) || session.kind !== "copy" || session.pick.route === "extension" || session.pick.route === "current") return undefined;
    const wall = this.wallOf(session)?.page;
    const site = url !== undefined ? httpPage(url) : httpPage(wall?.url) ?? httpPage(session.page?.url);
    const named = bound ? site : httpPage(wall?.url ?? session.page?.url) ?? site;
    let host = named ?? "this site";
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
    let moving: Session | undefined;
    try {
      wired = await this.wire(next);
      moving = { ...session, ...next, ...wired };
      opened = await this.runNative(moving, "open", [site]);
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
    const waiting = this.waitOf(session) !== "off";
    Object.assign(session, moving, { browser: openedChoice(next.pick), missed: undefined, page: undefined });
    session.recording.pickBrowser(next.pick);
    if (waiting) this.setWait(session, "off");
    await this.disarmReloadBanner();
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
    await this.noteWall(session);
    return opened;
  }

  private async connectSession(session: Session, options: { timeoutMs: number; signal?: AbortSignal }): Promise<CdpSocket> {
    if (session.kind === "current") return session.chrome.cdp;
    const endpoint = await readDevToolsActivePort(session.chrome.target.portFile);
    return connectCdp(endpoint.port, endpoint.browserPath, options);
  }

  private ownerResult(kind: "halted" | "waiting" | "ready" | "closed" | "recording", session: Session): AgentBrowserCommandResult[] {
    const current = session.kind === "current";
    const instruction = kind === "ready" ? "The page left the sign-in/check state. Take a fresh snapshot and continue in this same session. This is not proof of authentication."
      : kind === "recording" ? "The wait is over and the run is recording. Take a fresh snapshot and continue in this same session."
        : kind === "closed" ? current ? CURRENT_CHROME_ENDED : "The owner closed the Bao window. Report that this session cannot continue."
          : ownerWaitInstruction(current, session.raised === true, session.recording.id, ownerWaitPage(this.waitOf(session), session.ownerPage));
    const shown = kind === "recording" ? instruction : `${instruction}${this.fallback(session)}`;
    return [{ stdout: JSON.stringify({ outcome: kind, instruction: shown }), stderr: "", exitCode: 0 }];
  }

  /**
   * A copy that waits for the owner, or a Bao profile whose move failed, names its fallback: the owner's running Chrome on the
   * same profile, which holds his own sign-in and is a device the site already knows. A copy never switches on its own.
   */
  private fallback(session: Session): string {
    if (session.kind !== "copy" || session.pick.route === "extension") return "";
    if (session.pick.route === "bao" && session.moveError === undefined) return "";
    const site = this.wallOf(session)?.reopen;
    const profile = session.pick.profile?.directory;
    const open = { command: "open", ...(site ? { args: [site] } : {}), browser: "current", ...profile ? { profile } : {} };
    const bao = session.pick.route === "bao";
    return ` If the sign-in or check does not clear in ${bao ? "Bao's window" : "the Chrome copy"}, the fallback is the owner's running Chrome over remote debugging${profile ? ` on the same Chrome profile "${profile}"` : ""}. To take it, call agent_browser with ${JSON.stringify({ command: "close", run_id: session.recording.id })}, then with ${JSON.stringify(open)}. ${bao ? "Bao also tries it again on the next wait_for_owner." : "Bao does not switch on its own."}`;
  }

  private async nativeTabs(session: Session, ceiling?: AbortSignal): Promise<NativeTab[]> {
    const tabs = await this.run(session, "tab", ["list", "--json"], ceiling ? undefined : 5000, ceiling);
    if (tabs.exitCode !== 0) throw new Error(`Native tab list failed (exit ${tabs.exitCode}): ${tabs.stderr || tabs.stdout}`);
    return parseNativeTabs(tabs.stdout);
  }

  /**
   * Keeps the agent in its tab of the owner's Chrome. A fresh tab joins the task only when it is in the target list taken when a
   * command that can open one returned, and not in the list taken when that command started, and its opener is the tab the agent
   * is on or a popup adopted in this same pass. A tab that appears during wall handling, workflow
   * capture, an owner wait, or between commands stays the owner's even when its opener is the task tab: Bao does not switch to it,
   * mark it, or close it. When the daemon is anywhere else, Bao switches it back to the agent's tab. That switch's Page.bringToFront
   * is answered on the daemon's connection, so Chrome does not rise. When no task tab remains, the caller ends the session instead of
   * acting on an owner tab.
   */
  private async keepTab(session: Session & DebuggingChrome, tabs: NativeTab[], ceiling: AbortSignal): Promise<NativeTab[]> {
    const listed = (targetId: string | undefined) => tabs.find((tab) => tab.targetId === targetId);
    let want = session.targetId;
    const adopt: ChromeTarget[] = [];
    const waiting = new Set<string>();
    if (session.pending.size) {
      const { targetInfos } = await session.chrome.cdp.sendUntilProgress<{ targetInfos: ChromeTarget[] }>("Target.getTargets", {}, undefined, { signal: ceiling });
      const alive = new Set(targetInfos.map((info) => info.targetId));
      for (const targetId of [...session.pending]) if (!alive.has(targetId)) session.pending.delete(targetId);
      const owned = (targetId: string) => session.taskTabs.has(targetId) || adopt.some((item) => item.targetId === targetId);
      const skipped = new Set<string>();
      let progressed = true;
      while (progressed && !ceiling.aborted) {
        progressed = false;
        for (const info of targetInfos) {
          if (!session.pending.has(info.targetId) || waiting.has(info.targetId) || skipped.has(info.targetId) || adopt.some((item) => item.targetId === info.targetId)) continue;
          if (info.openerId && waiting.has(info.openerId)) {
            waiting.add(info.targetId);
            progressed = true;
            continue;
          }
          if (info.openerId !== want || !owned(want)) continue;
          if (!listed(info.targetId)?.tabId) {
            waiting.add(info.targetId);
            progressed = true;
            continue;
          }
          if (!await isChromeTab(session.chrome.cdp, info, ceiling)) {
            skipped.add(info.targetId);
            continue;
          }
          adopt.push(info);
          want = info.targetId;
          progressed = true;
        }
      }
      if (ceiling.aborted) throw new Error("cdp aborted Browser.getWindowForTarget");
      for (const targetId of [...session.pending]) {
        if (waiting.has(targetId) || adopt.some((info) => info.targetId === targetId)) continue;
        session.pending.delete(targetId);
      }
    }
    if (!listed(want) || adopt.at(-1)?.targetId !== want) {
      adopt.length = 0;
      if (!listed(want)) want = [...session.taskTabs].reverse().find((targetId) => listed(targetId)) ?? want;
    }
    const tab = listed(want);
    if (!tab?.tabId) return tabs;
    for (const info of adopt) session.taskTabs.add(info.targetId);
    if (!tab.active) {
      const back = await this.run(session, "tab", [tab.tabId], undefined, ceiling);
      if (back.exitCode !== 0) {
        for (const info of adopt) session.taskTabs.delete(info.targetId);
        throw new Error(`Bao could not keep the agent in its tab ${tab.tabId}: ${back.stderr || back.stdout || `exit ${back.exitCode}`}`);
      }
    }
    session.targetId = want;
    for (const info of adopt) {
      session.pending.delete(info.targetId);
      await this.focusTab(session, info.targetId, ceiling);
    }
    return tab.active ? tabs : this.nativeTabs(session, ceiling);
  }

  /**
   * An upload to a file input runs natively. An upload through any other element, and every download, runs on Bao's own
   * connection to the agent's tab: Running Chrome's shared connection, or a direct one to a Bao profile or copy. The native CLI
   * only clicks there, because its own download waits 30 s on a PDF that Chrome shows instead of downloading, and holds the daemon.
   */
  private async transfer(session: Session, command: FileCommand, files: FileArgs): Promise<{ result: AgentBrowserCommandResult; transfer?: FileTransfer }> {
    if (command === "upload") {
      const native = await this.runNative(session, "upload", files.forwarded);
      if (native.exitCode === 0) return { result: native, transfer: { command, source: "file-input", files: await fileFacts(files.files) } };
      if (!NOT_FILE_INPUT.test(native.stderr)) return { result: native };
    }
    const active = await this.activePage(session);
    if (!active) throw new Error("no active Bao page metadata");
    const cdp = await this.connectSession(session, { timeoutMs: 5000, signal: session.abort.signal });
    const click = () => this.runNative(session, "click", files.click);
    try {
      if (command === "upload") {
        const result = await uploadThroughChooser(cdp, active.targetId, files.files, click);
        return { result, ...result.exitCode === 0 ? { transfer: { command, source: "file-chooser" as const, files: await fileFacts(files.files) } } : {} };
      }
      const { result, from } = await downloadByClick(cdp, active.targetId, files.saved!, click);
      return { result, ...from ? { transfer: { command, ...from, files: await fileFacts([files.saved!]) } } : {} };
    } finally {
      if (session.kind === "copy") cdp.close();
    }
  }

  /** Runs the agent's command. On the owner's Chrome, a new tab is the agent's only when it is in the return list and not the entry list. */
  private async runNative(session: Session, command: string, args: string[]): Promise<AgentBrowserCommandResult> {
    if (session.kind !== "current" || session.relay || this.waitOf(session) !== "off" || !canOpenTab(command, args)) {
      return this.forward(session, command, args);
    }
    session.ended = undefined;
    const baseline = await this.targetIds(session);
    const result = await this.forward(session, command, args);
    await this.queueFresh(session, baseline);
    return result;
  }

  private async targetIds(session: Session & DebuggingChrome): Promise<Set<string>> {
    const { targetInfos } = await session.chrome.cdp.sendUntilProgress<{ targetInfos: ChromeTarget[] }>("Target.getTargets", {}, undefined, { signal: session.abort.signal });
    return new Set(targetInfos.map((info) => info.targetId));
  }

  /** Notes targets in the list taken when the native command returned and absent from the list taken when it started. */
  private async queueFresh(session: Session & DebuggingChrome, baseline: ReadonlySet<string>): Promise<void> {
    const ended = session.ended;
    session.ended = undefined;
    if (!ended) return;
    for (const targetId of ended) {
      if (!baseline.has(targetId) && !session.taskTabs.has(targetId)) session.pending.add(targetId);
    }
  }

  /** Focus emulation keeps a background task tab painting and taking input. It lasts while this session stays attached. */
  private async focusTab(session: Session & DebuggingChrome, targetId: string, ceiling: AbortSignal): Promise<void> {
    const { sessionId } = await session.chrome.cdp.sendUntilProgress<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, { signal: ceiling });
    await session.chrome.cdp.sendUntilProgress("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId, { signal: ceiling });
  }

  /**
   * Runs one agent command. On the owner's Chrome over remote debugging, a tab list names only Bao's task tabs in this session's
   * profile, marked as such, and leaves out the owner's tabs, other profiles, and Chrome's own surfaces, such as the Gemini panel.
   * Switching to or closing such a surface is refused. Switching to or closing a tab the owner opened is refused too; the agent
   * opens that page's URL in the task tab instead.
   */
  private async forward(session: Session, command: string, args: string[]): Promise<AgentBrowserCommandResult> {
    const parsed = command === "tab" ? parseTabArgs(args) : undefined;
    if (parsed?.action === "close" && parsed.ref !== undefined && !parsed.ref.trim()) {
      return { stdout: "", stderr: "\u2717 Empty tab reference; expected `t<N>` (e.g. `t2`) or a label\n", exitCode: 1 };
    }
    if (!parsed || session.kind !== "current" || session.relay || parsed.action === "new") return this.run(session, command, parsed ? parsed.forwarded : args);
    const tabs = await this.nativeTabs(session);
    const resolved = parsed.ref === undefined ? parsed.action === "close" ? tabs.find((tab) => tab.active) : undefined : resolveTabRef(parsed.ref, tabs);
    if (parsed.ref !== undefined && resolved && "message" in resolved) return { stdout: "", stderr: `\u2717 ${resolved.message}\n`, exitCode: 1 };
    const named = resolved && "tabId" in resolved ? resolved : undefined;
    if (parsed.action === "close" && parsed.ref === undefined && !named?.tabId) return { stdout: "", stderr: "\u2717 No current tab to close.\n", exitCode: 1 };
    const list = parsed.action === "list";
    const ref = parsed.ref ?? named?.tabId;
    const { targetInfos } = await session.chrome.cdp.send<{ targetInfos: (ChromeTarget & { browserContextId?: string })[] }>("Target.getTargets", {}, undefined, 5000);
    const profileContext = targetInfos.find((target) => target.targetId === session.targetId)?.browserContextId;
    const surfaces = new Set<string>();
    for (const tab of list ? tabs : named ? [named] : []) {
      const info = targetInfos.find((target) => target.targetId === tab.targetId);
      if (tab.tabId && (!info || !await isChromeTab(session.chrome.cdp, info))) surfaces.add(tab.tabId);
    }
    if (named?.tabId && surfaces.has(named.tabId)) {
      return { stdout: "", stderr: `✗ ${ref} is not a tab in a Chrome window, such as the Gemini panel or a side panel. Stay in Bao's task tab.\n`, exitCode: 1 };
    }
    if (named?.tabId && named.targetId && !session.taskTabs.has(named.targetId)) {
      const url = targetInfos.find((target) => target.targetId === named.targetId)?.url;
      const where = url ? `: ${url}` : "";
      return { stdout: "", stderr: `✗ ${ref} is a tab the owner opened. When the owner wants work done on a page he has open, open that page's URL in your task tab (it shares his sign-ins)${where}.\n`, exitCode: 1 };
    }
    const forwarded = parsed.action === "list" ? parsed.forwarded : parsed.action === "close" ? [...(named?.tabId ? ["close", named.tabId] : ["close"]), ...parsed.flags] : [named?.tabId ?? "", ...parsed.flags];
    const result = await this.run(session, command, forwarded);
    if (result.exitCode !== 0) return result;
    if (parsed.action === "close" && named?.targetId && session.taskTabs.has(named.targetId)) {
      session.taskTabs.delete(named.targetId);
      session.justClosed = named.targetId;
      if (session.targetId === named.targetId) session.targetId = [...session.taskTabs].at(-1) ?? "";
    }
    if (parsed.action === "switch" && named?.targetId) {
      session.targetId = named.targetId;
      return result;
    }
    if (parsed.action !== "list") return result;
    const task = (tab: NativeTab | undefined) => !!tab?.targetId && session.taskTabs.has(tab.targetId);
    const inProfile = (tab: NativeTab | undefined) => {
      if (!profileContext || !tab?.targetId) return true;
      const info = targetInfos.find((target) => target.targetId === tab.targetId);
      return info?.browserContextId === undefined || info.browserContextId === profileContext;
    };
    const shown = (tab: NativeTab | undefined) => task(tab) && inProfile(tab) && (!tab?.tabId || !surfaces.has(tab.tabId));
    if (parsed.json) {
      try {
        const body = JSON.parse(result.stdout) as { data?: { tabs?: (NativeTab & { baoTaskTab?: boolean })[] } };
        if (body.data?.tabs) body.data.tabs = body.data.tabs.filter(shown).map((tab) => ({ ...tab, baoTaskTab: true }));
        return { ...result, stdout: `${JSON.stringify(body)}\n` };
      } catch {
        return { stdout: "", stderr: result.stderr || "Native tab list was not JSON.\n", exitCode: 1 };
      }
    }
    const stdout = result.stdout.split("\n").flatMap((line) => {
      const tabId = /^(?:→|\s) \[([^\]]+)\] /u.exec(line)?.[1];
      if (!tabId) return [line];
      if (!shown(tabs.find((tab) => tab.tabId === tabId))) return [];
      return [line.replace(`[${tabId}] `, `[${tabId}] (Bao task tab) `)];
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
  private async endTaskTab(session: Session): Promise<AgentBrowserCommandResult[]> {
    this.taskTabEnded = true;
    this.endedRuns.set(session.recording.id, TASK_TAB_CLOSED);
    this.requestClose(session);
    session.outcome = { outcome: "failed", reason: "Bao's task tab was closed" };
    session.workflow.unavailable("Bao's task tab was closed before the task finished");
    if (this.waitOf(session) !== "off") {
      await session.recording.endVideoCapture();
      this.setWait(session, "off");
      session.recording.ownerWaiting(false);
    }
    await this.disarmReloadBanner();
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
      const active = activeNativeTab(tabs);
      if (!active) return undefined;
      session.agentTarget = active.targetId;
      // Native tab titles can be URL-derived labels. Read the real title from Chrome, not that label.
      cdp = await this.connectSession(session, { timeoutMs: CDP_PROGRESS_CEILING_MS, signal });
      const { targetInfo } = await cdp.sendUntilProgress<{ targetInfo: { url: string; title: string } }>("Target.getTargetInfo", { targetId: active.targetId }, undefined, { signal });
      if (session.kind === "current" && !session.relay) await session.recording.recordTab(cdp, active.targetId);
      session.page = { url: targetInfo.url, title: targetInfo.title };
      if (!ownerWall(session.page) && httpPage(session.page.url)) session.beforeWall = session.page;
      return { targetId: active.targetId, targetIds: tabs.flatMap((tab) => tab.targetId ? [tab.targetId] : []), page: session.page };
    } catch (error) {
      if (error instanceof TaskTabClosed) throw error;
      if (session.abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new ActiveTargetMiss(error);
    } finally {
      if (timer) clearTimeout(timer);
      if (cdp && session.kind === "copy") cdp.close();
    }
  }

  /** Records a URL or title wall. It does not select the window, raise it, or move the session. */
  private async noteWall(session: Session, openedSite?: string): Promise<void> {
    if (this.waitOf(session) !== "off") return;
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
    this.setWait(session, this.stopped(session, active, openedSite));
    session.ownerPage = active.page;
    session.ownerSince = session.ownerTouched = Date.now();
  }

  /**
   * The only handoff. A Bao profile that can still move tries Running Chrome first and raises only if that move declines.
   * A copy or Running Chrome does not take this move. It raises once, the way it already does.
   */
  private async settleWall(session: Session, options?: { retry?: boolean; what?: string; url?: string }): Promise<AgentBrowserCommandResult | undefined> {
    const wait = this.wallOf(session);
    if (!wait && !options?.what) return undefined;
    if (this.movable(session, options?.retry === true)) {
      const opened = await this.moveAway(session, options?.what ?? this.wallWords(session), options?.url ?? wait?.reopen ?? this.reopenOf(session), options?.retry === true);
      if (opened) {
        const noted = this.wallOf(session);
        if (noted && session.kind === "current" && session.raised === undefined) await this.ownerBanner(session, noted.targetId, true).catch(() => undefined);
        return opened;
      }
    }
    const staying = this.wallOf(session);
    if (staying && session.raised === undefined) await this.ownerBanner(session, staying.targetId, true).catch(() => undefined);
    return undefined;
  }

  private imported(session: Session, report: SignInImport): SignInImport {
    this.imports.push(report);
    session.recording.signInImported(report);
    return report;
  }

  private bannerText(session: Session): string {
    return `Bao is waiting for you to ${ownerTask(ownerWaitPage(this.waitOf(session), session.ownerPage))}. The agent will continue in this window. Only URL and title are read while waiting.`;
  }

  /**
   * Leaves one banner script on the waiting tab. Chrome runs it on the next document, so a reload
   * at the same address paints the banner again. This does not read the page or activate the tab.
   */
  private async armReloadBanner(session: Session, targetId: string, text: string): Promise<void> {
    const source = ownerBannerScript(text);
    const armed = this.reloadBanner;
    if (armed?.targetId === targetId && armed.source === source && armed.cdp.isOpen) return;
    if (armed?.targetId === targetId && armed.cdp.isOpen) {
      try {
        await armed.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: armed.identifier }, armed.sessionId, 2000);
        const { identifier } = await armed.cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source }, armed.sessionId, 2000);
        armed.identifier = identifier;
        armed.source = source;
        return;
      } catch {
        await this.disarmReloadBanner();
      }
    } else if (armed) await this.disarmReloadBanner();
    const owned = session.kind === "copy";
    let cdp: CdpSocket | undefined;
    let sessionId: string | undefined;
    try {
      if (owned) {
        const endpoint = await readDevToolsActivePort(session.chrome.target.portFile);
        cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 2000, signal: session.abort.signal });
      } else cdp = session.chrome.cdp;
      if (!cdp.isOpen) return;
      ({ sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 2000));
      // Chrome runs this script on the next document only after Page is enabled. Bao does not read the events that enablement also sends.
      await cdp.send("Page.enable", {}, sessionId, 2000);
      const { identifier } = await cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId, 2000);
      this.reloadBanner = { targetId, source, cdp, sessionId, identifier, owned };
    } catch (error) {
      if (cdp?.isOpen && sessionId) await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 2000).catch(() => undefined);
      if (owned) cdp?.close();
      throw error;
    }
  }

  /** Drops the reload script, cancels a banner callback already queued in this document, and, on a copy, closes the socket opened for the script. */
  private async disarmReloadBanner(): Promise<void> {
    const armed = this.reloadBanner;
    this.reloadBanner = undefined;
    if (!armed) return;
    try {
      if (armed.cdp.isOpen) {
        await armed.cdp.send("Runtime.evaluate", { expression: ownerBannerGone(), returnByValue: true }, armed.sessionId, 2000).catch(() => undefined);
        await armed.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: armed.identifier }, armed.sessionId, 2000).catch(() => undefined);
        await armed.cdp.send("Target.detachFromTarget", { sessionId: armed.sessionId }, undefined, 2000).catch(() => undefined);
      }
    } finally {
      if (armed.owned) armed.cdp.close();
    }
  }

  /** Writes only Bao's status banner. Never reads the form, page text, or field values. */
  private async ownerBanner(session: Session, targetId: string, waiting: boolean, options?: { raise?: boolean }): Promise<void> {
    const raise = options?.raise !== false;
    if (waiting && raise) session.raised = false;
    const text = this.bannerText(session);
    if (waiting) await this.armReloadBanner(session, targetId, text).catch(() => undefined);
    else await this.disarmReloadBanner();
    const cdp = await this.connectSession(session, { timeoutMs: 2000, signal: session.abort.signal });
    let attached: string | undefined;
    try {
      // The extension keeps the task tab folded in Bao's group and opens the group while the owner has to act in it.
      // Otherwise the tab and its window come to the front when the owner has to act in it. Bao's own Chrome stays behind until then.
      if (raise && session.kind === "current" && session.relay) await cdp.send(waiting ? "Bao.showTab" : "Bao.settleTab", { targetId }, undefined, 2000);
      else if (raise && waiting) {
        const copyHandoff = session.kind === "copy" && session.pick.route === "copy" && process.platform === "darwin";
        if (copyHandoff) await cdp.send("Target.activateTarget", { targetId }, undefined, 2000).catch(() => undefined);
        else await cdp.send("Target.activateTarget", { targetId }, undefined, 2000);
        // Focus emulation makes document.hasFocus() true on every connection, so the front app pid is the check.
        if (session.kind === "copy" && process.platform === "darwin" && !await chromeIsFront(session.chrome.pid)) {
          const pick = session.pick;
          if (copyHandoff && pick.route === "copy") {
            await uncoverCopyWindow(cdp, targetId);
            // Default activation brings the key window forward. Claim the raise only if this copy's own process comes forward.
            session.raised = await copyFront.bringCopyFront(pick.chrome, pick.userDataDir);
          } else session.raised = await windowOnTop(cdp, targetId).catch(() => false);
        }
      }
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 2000);
      attached = sessionId;
      const expression = waiting ? ownerBannerScript(text) : ownerBannerGone();
      await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId, 2000);
    } catch {
      // The durable Library notice remains visible if the page rejects the banner or closes.
    } finally {
      if (session.kind === "copy") cdp.close();
      else if (attached) await cdp.send("Target.detachFromTarget", { sessionId: attached }, undefined, 2000).catch(() => undefined);
    }
  }

  private ownerClosed(session: Session): AgentBrowserCommandResult[] {
    void this.disarmReloadBanner();
    const result = this.ownerResult("closed", session);
    session.abort.abort();
    session.workflow.unavailable("the owner wait did not finish");
    session.recording.finish("session_closed");
    return result;
  }

  /** A non-wall deadline ends the wait and says recording. A recognized wall stays waiting. */
  private async stillWaiting(session: Session): Promise<AgentBrowserCommandResult[]> {
    const wait = this.waitOf(session);
    const wall = wait !== "off" && wait !== "pending" && (wait.wall === true || ownerWall(wait.page) !== null);
    if (!wall && wait !== "off" && wait !== "pending") await this.ownerBanner(session, wait.targetId, false).catch(() => undefined);
    if (session.abort.signal.aborted) return this.ownerClosed(session);
    if (!wall) this.setWait(session, "off");
    return this.ownerResult(wall ? "waiting" : "recording", session);
  }

  private async waitForOwner(session: Session, deadline: number): Promise<AgentBrowserCommandResult[]> {
    if (session.abort.signal.aborted) return this.ownerClosed(session);
    if (this.waitOf(session) === "off") {
      session.ownerSince = session.ownerTouched = Date.now();
      this.setWait(session, "pending");
    } else session.recording.ownerWaiting(true);
    let cdp: CdpSocket | undefined;
    const onAbort = () => { if (session.kind === "copy") cdp?.close(); };
    session.abort.signal.addEventListener("abort", onAbort, { once: true });
    let candidate = "";
    let stableAt = 0;
    try {
      while (Date.now() < deadline) {
        if (session.abort.signal.aborted || cdp && !cdp.isOpen) return this.ownerClosed(session);
        try {
          const waiting = this.wallOf(session);
          if (!waiting) return this.ownerClosed(session);
          if (!cdp) {
            cdp = await this.connectSession(session, { timeoutMs: 2000, signal: session.abort.signal });
          }
          if (session.abort.signal.aborted || !cdp.isOpen) return this.ownerClosed(session);
          const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; url: string; title: string }[] }>("Target.getTargets", {}, undefined, 2000);
          const page = targetInfos.find((tab) => tab.targetId === waiting.targetId);
          if (!page && cdp.isOpen && this.noTaskTabLeft(session, targetInfos)) return await this.endTaskTab(session);
          if (!page || session.abort.signal.aborted || !cdp.isOpen) return this.ownerClosed(session);
          if (ownerWall(page) && (waiting.page.url !== page.url || waiting.page.title !== page.title)) {
            waiting.page = { url: page.url, title: page.title };
            session.ownerPage = session.page = waiting.page;
            this.setWait(session, waiting);
            await this.ownerBanner(session, waiting.targetId, true, { raise: false });
          } else if (ownerWall(page)) await this.armReloadBanner(session, waiting.targetId, this.bannerText(session)).catch(() => undefined);
          const ready = ownerCanResume(waiting.page, page);
          const signature = ready ? JSON.stringify([page.url, page.title]) : "";
          if (!ready || candidate !== signature) { candidate = signature; stableAt = Date.now(); }
          if (ready && Date.now() - stableAt >= 750) {
            await this.ownerBanner(session, waiting.targetId, false);
            if (session.abort.signal.aborted || !cdp.isOpen) return this.ownerClosed(session);
            const result = this.ownerResult("ready", session);
            this.setWait(session, "off");
            session.page = { url: page.url, title: page.title };
            session.recording.ownerWaiting(false);
            return result;
          }
        } catch (error) {
          if (error instanceof TaskTabClosed) throw error;
          candidate = "";
          if (session.abort.signal.aborted || cdp && !cdp.isOpen) return this.ownerClosed(session);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
      }
      if (session.abort.signal.aborted || cdp && !cdp.isOpen) return this.ownerClosed(session);
      return this.stillWaiting(session);
    } finally {
      session.ownerTouched = Date.now();
      session.abort.signal.removeEventListener("abort", onAbort);
      if (session.kind === "copy") cdp?.close();
    }
  }

  /** Measure the heading or dialog a read found new, so its card can box it. */
  private async readMark(session: Session, seen: ReadonlySet<string> | undefined, current: string): Promise<ShotBox | undefined> {
    if (this.waitOf(session) !== "off") return undefined;
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
    if (command === "close" || this.gone() || session.abort.signal.aborted) throw new Error("page closed");
    const taskId = session.kind === "current" ? session.targetId : undefined;
    try {
      await this.noteWall(session);
    } catch (error) {
      if (session.kind !== "current" || session.abort.signal.aborted || !(error instanceof ActiveTargetMiss)) throw error;
      return this.taskTabPicture(session, session.targetId, visual);
    }
    if (this.waitOf(session) !== "off") throw new Error(OWNER_PRIVATE);
    const tabs = await this.run(session, "tab", ["list", "--json"], 3000);
    if (tabs.exitCode !== 0) throw new Error(`Native tab list failed (exit ${tabs.exitCode}): ${tabs.stderr || tabs.stdout}`);
    const activeId = activeNativeTab(parseNativeTabs(tabs.stdout))?.targetId;
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
    if (this.gone()) throw new Error(AGENT_DISCONNECTED);
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
    if (session.kind === "current" && !session.relay && canOpenTab(command, args)) session.ended = await this.targetIds(session);
    if (session.kind === "current" && !session.relay && opensTab(command, args) && result.exitCode === 0) {
      try {
        const tabs = await execute("tab", ["list", "--json"], 5000);
        if (tabs.exitCode !== 0) throw new Error(`Native task tab list failed: ${tabs.stderr || tabs.stdout}`);
        const targetId = activeNativeTab(parseNativeTabs(tabs.stdout))?.targetId;
        if (!targetId) throw new Error("Native task tab has no target id");
        session.taskTabs.add(targetId);
        session.targetId = targetId;
        await this.focusTab(session, targetId, bound ?? session.abort.signal);
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
    this.requestClose(session);
    await this.remove(session);
    this.drop(session);
  }

  endedByNewerTask(runId: string | undefined): boolean {
    return runId !== undefined && this.endedByNewer.has(runId);
  }

  /** Ends the open run because a newer open started, and closes its task tab. */
  private async endForNewerTask(session: Session): Promise<void> {
    this.endedByNewer.add(session.recording.id);
    if (this.waitOf(session) !== "off") {
      this.staleWait = this.waitEndedLine(session, "a new open starts a new task");
      await session.recording.endVideoCapture();
      session.recording.ownerWaiting(false);
    }
    session.outcome = { outcome: "failed", reason: NEWER_TASK_REASON };
    session.workflow.unavailable(NEWER_TASK_REASON);
    this.requestClose(session);
    await this.remove(session);
    this.drop(session);
  }

  private armIdle(session: Session): void {
    clearTimeout(session.idleTimer);
    if (this.session !== session || this.removingOf(session) || this.gone()) return;
    // A closed wait still names its page, but the session expires on the idle timer.
    if (this.waitOf(session) !== "off" && !session.abort.signal.aborted) {
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
          this.drop(session);
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
    const existing = this.cleanups.get(session);
    if (existing) {
      await existing;
      await this.afterCleanup(session);
      return;
    }
    this.afterWall = session.kind === "copy" && this.waitOf(session) !== "off";
    const endedCurrent = session.kind === "current" && !this.closingOf(session) && !this.gone();
    if (endedCurrent) this.endedRuns.set(session.recording.id, CURRENT_CHROME_ENDED);
    let resolveCleanup!: () => void;
    let rejectCleanup!: (error: unknown) => void;
    const completion = new Promise<void>((done, fail) => { resolveCleanup = done; rejectCleanup = fail; });
    completion.catch(() => undefined);
    this.cleanups.set(session, completion);
    this.armCleanup(session);
    try {
      await this.cleanupBody(session, keepOpen, closeTaskTabs);
      resolveCleanup();
      await this.afterCleanup(session, endedCurrent);
    } catch (error) {
      rejectCleanup(error);
      this.cleanups.set(session, Promise.resolve());
      // The call that owns the run throws this named error. A newer open writes it to stderr and starts. The session and its run end here, so later calls start fresh.
      const message = error instanceof Error ? error.message : String(error);
      session.recording.cleanupFailed(message);
      this.drop(session, endedCurrent ? "current-ended" : "closed");
      throw new Error(`Bao could not clean up the browser session of run ${session.recording.id}: ${message}`, { cause: error });
    } finally {
      if (this.session === session && session.kind === "current" && session.chrome.isClosed()) this.drop(session, endedCurrent ? "current-ended" : "closed");
    }
  }

  private armCleanup(session: Session): void {
    const seat = this.seat;
    if (seat.phase === "ended" && seat.reason === "disconnected") return;
    if ((seat.phase !== "live" && seat.phase !== "closing") || seat.session !== session) return;
    const ownerWait = seat.ownerWait;
    const keep = seat.phase === "closing" ? seat.keep : true;
    this.seat = { phase: "closing", session, ownerWait, keep };
  }

  /** Selects the agent's last tab on Bao's direct connection. That does not bring the window to the front. A failed select still keeps the window. */
  private async showAgentTab(session: Session): Promise<void> {
    if (session.kind !== "copy") return;
    const targetId = session.agentTarget ?? session.targetId;
    if (!targetId || session.chrome.isClosed()) return;
    let cdp: CdpSocket | undefined;
    try {
      cdp = await this.connectSession(session, { timeoutMs: 2000 });
      await cdp.send("Target.activateTarget", { targetId }, undefined, 2000);
    } catch {
      // The kept window stays on Chrome's selected tab if the direct connection is already gone.
    } finally {
      cdp?.close();
    }
  }

  private async cleanupBody(session: Session, keepOpen: boolean, closeTaskTabs: boolean): Promise<void> {
    await this.disarmReloadBanner();
    session.abort.abort();
    await session.commandDone;
    await session.recording.endVideoCapture();
    session.recording.finish(session.outcome);
    if (this.waitOf(session) !== "off") session.workflow.unavailable("the owner wait did not finish");
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
        } else if (keepOpen && !this.closingOf(session) && this.pendingCloses === 0 && !session.chrome.isClosed()) {
          await this.showAgentTab(session);
          await session.chrome.keepOpen();
        } else await session.chrome.close();
      }
      await rm(session.stateDir, { recursive: true, force: true });
    } finally {
      await session.recording.encodeVideo();
      this.workflowOutcome = session.workflow.finish(session.outcome?.outcome === "failed");
    }
  }

  private async afterCleanup(session: Session, endedCurrent = false): Promise<void> {
    if (session.kind === "copy" && (this.closingOf(session) || this.pendingCloses > 0) && !session.chrome.isClosed()) {
      this.requestClose(session);
      await session.chrome.close();
    }
    if (this.session !== session) return;
    if (session.chrome.isClosed()) this.drop(session, endedCurrent ? "current-ended" : "closed");
  }
}
