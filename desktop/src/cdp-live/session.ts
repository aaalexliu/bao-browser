import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { navigationAllowed } from "./allowlist";
import { checkboxReach } from "./consent";
import { resolveBaoHome } from "../app/bao-home";
import { AxUnavailable, checkboxState, chromeHelper, chromeTree } from "./ax";
import { liveSessionDir, SessionLog } from "./audit";
import { attachLivePage, openLiveWindow, type CdpLiveDriver, type PageObservation } from "./driver";
import {
  attachPathMatches,
  clearRedact,
  keepAwake,
  pickExistingPage,
  redactForShot,
  releaseAwake,
  workflowFromAudit,
} from "./attach";
import { clearInbox, connectAndAllow } from "./connect";
import { readDevToolsActivePort } from "./endpoint";
import { acquireCdpLock, releaseCdpLock } from "./lock";
import { workflowIdsFromIntent } from "./live-ops";
import { resolveGuardFlags } from "./presets";
import { classifyPage } from "../v1/page-class";
import { validateWorkflow } from "../v1/schema";
import { Library } from "../v1/store";
import type { CdpSocket } from "./socket";

const PACE_MS = 2500;
const FINAL_HOLD_MS = 8000;
const CLICK_CAP = 6;

export interface SurfaceAsk {
  mode: "read" | "mark";
  index: number;
  label: string;
  stopPath: string;
  deny: string;
  commit: string;
}

export interface SurfaceControl {
  index: number;
  label: string;
  kind: string;
  y: number;
}

export interface Surface {
  ok: boolean;
  reason: string;
  path: string;
  title: string;
  headings: string[];
  controls: SurfaceControl[];
  commit: string[];
  blocked: string;
}

export function publicPath(href: string): string {
  let pathname = "";
  try {
    pathname = new URL(href, "https://example.invalid").pathname;
  } catch {
    return "";
  }
  const parts = pathname.split("/").map((seg) => {
    if (!seg) return seg;
    if (/^\d{3,}$/.test(seg)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(seg)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ":id";
    return seg;
  });
  return parts.join("/") || "/";
}

export function redactText(text: string): string {
  const clean = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\b\d{3,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (/^(hi|hello|welcome)\b/i.test(clean)) return "[greeting]";
  if (/@|\bstreet\b|\bavenue\b|\broad\b|\bapt\b|\bssn\b/i.test(clean)) return "";
  return clean.slice(0, 80);
}

export interface ContextPage {
  targetId: string;
  host: string;
  browserContextId: string;
  path: string;
  login: boolean;
}

export function pathIsLogin(pathname: string): boolean {
  return /(?:^|\/)(?:login|sign-?in|signin)(?:\/|$)/i.test(pathname);
}

export function signedOutSurface(page: { blocked: string; path: string; title?: string; headings?: string[] }): boolean {
  if (page.blocked === "captcha" || page.blocked === "bot_wall" || page.blocked === "upsell") return false;
  if (page.blocked === "login" || page.blocked === "login_wall") return true;
  const blob = `${page.path}\n${page.title || ""}\n${(page.headings || []).join("\n")}`;
  return pathIsLogin(page.path) || /sign in to your account/i.test(blob);
}

export function sameContext(ourId: string, dashboardId: string | null): boolean | null {
  if (dashboardId == null) return null;
  return ourId === dashboardId;
}

/** True when this page is not in the same browser context as the already-open page. */
export function isolatedFromDashboard(ourId: string, dashboardId: string | null, createdIds: readonly string[]): boolean {
  if (dashboardId == null) return ourId !== "" && createdIds.includes(ourId);
  return ourId !== dashboardId;
}

/**
 * Id to pass when joining the default context. Empty means omit the parameter.
 * An id returned by Target.getBrowserContexts was created separately, so it is not the default.
 */
export function defaultContextJoinId(dashboardId: string | null, createdIds: readonly string[]): string {
  if (!dashboardId) return "";
  if (createdIds.includes(dashboardId)) return "";
  return dashboardId;
}

export function pickDashboardPage<T extends { login: boolean; path: string }>(pages: readonly T[]): T | null {
  const named = pages.filter((page) => !page.login && page.path !== "/" && page.path !== "/blank");
  if (named.length > 0) return named[0] || null;
  return pages.find((page) => !page.login) ?? null;
}

export function dashboardNavigation(page: { host: string; path: string }, hosts: readonly string[]): string {
  if (!page.host || !page.path.startsWith("/") || page.path.startsWith("//")) return "";
  if (/[?#\\]/.test(page.path)) return "";
  const url = `https://${page.host}${page.path}`;
  return navigationAllowed(url, hosts) ? url : "";
}

export function clickAllowed(label: string, kind: string, denySource: string, commitSource: string): boolean {
  if (kind === "submit" || kind === "radio" || kind === "check" || kind === "other") return false;
  if (kind !== "link" && kind !== "button") return false;
  const text = label.trim();
  if (!text || text.length > 120) return false;
  try {
    if (denySource && new RegExp(denySource, "i").test(text)) return false;
    if (kind === "button" && commitSource && new RegExp(commitSource, "i").test(text)) return false;
  } catch {
    return false;
  }
  return true;
}

/** Lists visible controls in the top document and open shadow roots. Marks one only after the guard passes. */
export function readSurface(ask: SurfaceAsk): Surface {
  const empty: Surface = {
    ok: false, reason: "", path: "", title: "", headings: [], controls: [], commit: [], blocked: "",
  };
  function labelOf(el: Element): string {
    const aria = el.getAttribute("aria-label") || "";
    const text = (el as HTMLElement).innerText || el.textContent || "";
    const value = el instanceof HTMLInputElement ? el.value : "";
    return (aria || text || value).replace(/\s+/g, " ").trim().slice(0, 120);
  }
  function kindOf(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (type === "password") return "password";
    if (tag === "a" || role === "link") return "link";
    if (type === "submit") return "submit";
    if (type === "radio" || role === "radio") return "radio";
    if (type === "checkbox" || role === "checkbox") return "check";
    if (tag === "button" || type === "button" || role === "button") return "button";
    return "other";
  }
  const seen = new Set<Element>();
  const found: { el: Element; y: number }[] = [];
  let password = false;
  function walk(root: ParentNode): void {
    for (const el of root.querySelectorAll("*")) {
      if (!(el instanceof Element)) continue;
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.hasAttribute("data-bao-pick")) el.removeAttribute("data-bao-pick");
      if (seen.has(el)) continue;
      const kind = kindOf(el);
      if (kind === "password") {
        password = true;
        continue;
      }
      if (kind === "other") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.height > 140) continue;
      if (!labelOf(el)) continue;
      seen.add(el);
      found.push({ el, y: rect.top });
    }
  }
  walk(document);
  found.sort((a, b) => a.y - b.y);
  const head = found.filter((item) => item.y < window.innerHeight + 40).slice(0, 40);
  const tail = found.slice(-15);
  const picked: { el: Element; y: number }[] = [];
  const pickSeen = new Set<Element>();
  for (const item of head.concat(tail)) {
    if (pickSeen.has(item.el)) continue;
    pickSeen.add(item.el);
    picked.push(item);
  }
  let deny: RegExp | null = null;
  let commit: RegExp | null = null;
  let stopPath: RegExp | null = null;
  try {
    if (ask.deny) deny = new RegExp(ask.deny, "i");
    if (ask.commit) commit = new RegExp(ask.commit, "i");
    if (ask.stopPath) stopPath = new RegExp(ask.stopPath, "i");
  } catch {
    return { ...empty, reason: "bad-guard" };
  }
  const controls: SurfaceControl[] = picked.map((item, index) => ({
    index,
    label: labelOf(item.el),
    kind: kindOf(item.el),
    y: Math.round(item.y),
  }));
  const commitLabels = controls
    .filter((control) => control.kind !== "link" && !!commit && commit.test(control.label))
    .map((control) => control.label)
    .slice(0, 4);
  let blocked = "";
  if (password) blocked = "login";
  const here = location.pathname || "/";
  if (!blocked && stopPath && stopPath.test(here)) blocked = "stop-path";
  const body = (document.body?.innerText || "").slice(0, 1500).toLowerCase();
  if (!blocked && /request unsuccessful|powered by imperva|incapsula incident/.test(body)) blocked = "bot_wall";
  if (!blocked && /verify you are human|i'm not a robot|recaptcha challenge/.test(body)) blocked = "captcha";
  for (const dialog of document.querySelectorAll("[role=dialog], dialog")) {
    if (blocked) break;
    const text = ((dialog as HTMLElement).innerText || "").slice(0, 400).toLowerCase();
    if (/captcha|verify you are human/.test(text)) blocked = "captcha";
    else if (/password|verification code|one-time|two-factor/.test(text)) blocked = "login";
    else if (deny && deny.test(text) && /trial|upgrade|subscribe|premium|purchase/.test(text)) blocked = "upsell";
  }
  if (ask.mode === "mark") {
    const item = picked[ask.index];
    if (!item || blocked) return { ...empty, reason: blocked || "missing", path: here, blocked };
    const label = labelOf(item.el);
    const kind = kindOf(item.el);
    if (label !== ask.label) return { ...empty, reason: "moved", path: here };
    if (kind !== "link" && kind !== "button") return { ...empty, reason: "refused", path: here };
    if (deny && deny.test(label)) return { ...empty, reason: "refused", path: here };
    if (kind === "button" && commit && commit.test(label)) return { ...empty, reason: "refused", path: here };
    item.el.setAttribute("data-bao-pick", "1");
    (item.el as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
    return { ok: true, reason: "", path: here, title: "", headings: [], controls: [], commit: commitLabels, blocked };
  }
  const headings: string[] = [];
  for (const el of document.querySelectorAll("h1, h2, [role=heading]")) {
    const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    headings.push(text.slice(0, 80));
    if (headings.length >= 4) break;
  }
  return {
    ok: true,
    reason: "",
    path: here,
    title: (document.title || "").slice(0, 80),
    headings,
    controls,
    commit: commitLabels,
    blocked,
  };
}

class NeedsHuman extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NeedsHuman";
  }
}

interface StepNote {
  name: string;
  path: string;
  label: string;
  ms: number;
  isTrusted: boolean | null;
  kind: string;
  shot: string;
}

interface Guard {
  hosts: string[];
  start: string;
  deny: string;
  commit: string;
  stopPath: string;
  reached: string;
  intent: string;
  inbox: string;
  attachPath: string;
  agent: string;
  lockFile: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progress(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || "";
}

function parseGuard(root: string): Guard {
  const preset = arg("--preset");
  const hostsArg = arg("--hosts");
  const flags = resolveGuardFlags({
    preset: preset || undefined,
    hosts: hostsArg ? hostsArg.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean) : undefined,
    start: arg("--start") || undefined,
    deny: arg("--deny") || undefined,
    commit: arg("--commit") || undefined,
    stopPath: arg("--stop-path") || undefined,
    reached: arg("--reached") || undefined,
  });
  const hosts = flags.hosts;
  const start = flags.start;
  const deny = flags.deny;
  const commit = flags.commit;
  const stopPath = flags.stopPath;
  const reached = flags.reached;
  const intent = arg("--intent");
  const inbox = arg("--inbox", path.join(root, ".evidence", "session-inbox.txt"));
  const attachPath = arg("--attach-path");
  const agent = arg("--agent", "bao-cdp");
  const lockFile = arg("--lock", "/tmp/bao-cdp-session.lock");
  if (hosts.length === 0 || hosts.some((host) => host.includes("*") || host.includes("/"))) {
    throw new Error("hosts must be exact names");
  }
  if (!start || !navigationAllowed(start, hosts)) throw new Error("start url is not on the host list");
  if (attachPath && (!attachPath.startsWith("/") || attachPath.startsWith("//") || /[?#\\]/.test(attachPath))) {
    throw new Error("attach path must be a pathname");
  }
  if (attachPath && !attachPathMatches(start, attachPath)) throw new Error("attach path does not match the start url");
  if (!/^[\w.-]+$/.test(agent)) throw new Error("agent id is not a token");
  if (path.basename(lockFile) !== "bao-cdp-session.lock") throw new Error("refusing a different lock file");
  if (!deny || !commit || !stopPath || !reached || !intent) {
    throw new Error("deny, commit, stop-path, reached, and intent are required");
  }
  new RegExp(deny, "i");
  new RegExp(commit, "i");
  new RegExp(stopPath, "i");
  new RegExp(reached, "i");
  return { hosts, start, deny, commit, stopPath, reached, intent, inbox, attachPath, agent, lockFile };
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 240);
}

function publishSurface(page: Surface): Surface {
  return {
    ...page,
    path: publicPath(page.path),
    title: redactText(page.title),
    headings: page.headings.map(redactText).filter(Boolean).slice(0, 4),
    controls: page.controls.map((control) => ({ ...control, label: redactText(control.label) })).filter((control) => control.label),
    commit: page.commit.map(redactText).filter(Boolean),
  };
}

function scrollDown(): void {
  window.scrollBy(0, Math.round(window.innerHeight * 0.75));
}

async function wall(driver: CdpLiveDriver, start: string): Promise<string | null> {
  const signals = await driver.pageSignals();
  const decision = classifyPage({
    url: signals.url,
    startedUrl: start,
    hasPassword: signals.hasPassword,
    markers: signals.markers,
    widgets: signals.widgets,
    iframeSrcs: [],
    texts: [],
    cookies: [],
    responses: [],
    closes: [],
  });
  if (decision.class === "bot_wall" || decision.class === "login_wall") return decision.class;
  return null;
}

interface ListedTarget {
  targetId?: string;
  type?: string;
  url?: string;
  browserContextId?: string;
}

async function browserPicture(cdp: CdpSocket, hosts: readonly string[], skipId: string): Promise<{
  createdContextIds: string[];
  pages: ContextPage[];
}> {
  const created = await cdp.send<{ browserContextIds?: string[] }>("Target.getBrowserContexts").catch(() => ({
    browserContextIds: [] as string[],
  }));
  const listed = await cdp.send<{ targetInfos?: ListedTarget[] }>("Target.getTargets");
  const pages: ContextPage[] = [];
  for (const info of listed.targetInfos || []) {
    if (info.type !== "page" || !info.targetId || info.targetId === skipId || !info.url) continue;
    let host = "";
    let pathname = "";
    try {
      const parsed = new URL(info.url);
      host = parsed.hostname;
      pathname = parsed.pathname || "/";
    } catch {
      continue;
    }
    if (!hosts.includes(host)) continue;
    pages.push({
      targetId: info.targetId,
      host,
      browserContextId: info.browserContextId || "",
      path: pathname,
      login: pathIsLogin(pathname),
    });
  }
  return { createdContextIds: created.browserContextIds || [], pages };
}

async function ownContextId(cdp: CdpSocket, targetId: string): Promise<string> {
  const info = await cdp.send<{ targetInfo?: { browserContextId?: string } }>("Target.getTargetInfo", { targetId });
  return info.targetInfo?.browserContextId || "";
}

async function ownWindowId(cdp: CdpSocket, targetId: string): Promise<number | null> {
  try {
    const result = await cdp.send<{ windowId?: number }>("Browser.getWindowForTarget", { targetId });
    return typeof result.windowId === "number" ? result.windowId : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const guard = parseGuard(root);
  const evidence = path.join(root, ".evidence");
  const axLog = path.join(evidence, "cdp-live-ax.jsonl");
  const outFile = path.join(evidence, "session-run.json");
  const draftFile = path.join(evidence, "session-workflow.json");
  await mkdir(evidence, { recursive: true });
  progress("waiting for the cdp session lock");
  await acquireCdpLock(guard.agent, { file: guard.lockFile });
  await clearInbox(guard.inbox, true);
  const awake = keepAwake();
  try {
  await runGuarded(root, guard, evidence, axLog, outFile, draftFile);
  } finally {
    releaseAwake(awake);
    releaseCdpLock(guard.agent, guard.lockFile);
  }
}

async function runGuarded(
  root: string,
  guard: Guard,
  evidence: string,
  axLog: string,
  outFile: string,
  draftFile: string,
): Promise<void> {
  const helper = chromeHelper();
  progress("helper permissions");
  const perms = await helper.permissions(false);
  if (perms.prompted) throw new Error("helper asked for a permission prompt");
  if (!perms.accessibility) throw new Error("BaoOSHelper accessibility is not granted");
  if (perms.screenCapture) throw new Error("BaoOSHelper screen recording is granted; not starting");
  progress("reading the remote-debugging checkbox");
  const box = await checkboxState(helper);
  if (checkboxReach(box.summary) === "stop") {
    throw new AxUnavailable("BaoOSHelper cannot see a Chrome window", box.summary);
  }
  if (box.on === false) throw new NeedsHuman("remote-debugging-off");
  const dialogPresentBeforeConnect = box.summary.dialog.present || box.summary.dialog.buttonCount > 0;
  if (dialogPresentBeforeConnect) {
    throw new AxUnavailable("Allow dialog was already up; not connecting and not clicking", box.summary);
  }
  progress("reading DevToolsActivePort");
  const endpoint = await readDevToolsActivePort();
  progress(`browser socket on port ${endpoint.port}`);
  const opened = await connectAndAllow({
    helper,
    endpoint,
    dialogPresentBeforeConnect,
    axLog,
    pid: box.pid,
    log: progress,
  });
  const cdp: CdpSocket = opened.cdp;
  const clickedAt = opened.clickedAt;
  const allowWindow = opened.allowWindow;
  const connectToAllowMs = opened.connectToAllowMs;
  progress(`socket open; connect-to-Allow ${connectToAllowMs == null ? "not clicked" : `${connectToAllowMs}ms`}`);
  const ids = workflowIdsFromIntent(guard.intent, arg("--workflow-id") || undefined);
  const liveLog = new SessionLog(
    liveSessionDir(resolveBaoHome({ homeFlag: arg("--home") || undefined })),
    guard.intent,
    ids.workflowId.slice(0, 40),
  );
  await liveLog.flush("running", "", guard.hosts[0] || "");

  const steps: StepNote[] = [];
  let clicks = 0;
  let reached = false;
  let confirmLabel = "";
  let confirmClicked = false;
  let code = "";
  let status: "passed" | "needs_human" | "failed" = "failed";
  let observed: PageObservation | undefined;
  let lastSurface: Surface | undefined;
  let rawControls: SurfaceControl[] = [];
  let driver: CdpLiveDriver | undefined;
  let contextReport = {
    createdBrowserContext: false,
    isolated: false,
    sameAsDashboard: null as boolean | null,
    reopenedDefault: false,
    opened: "window" as "window" | "tab" | "attached",
    broughtDashboardForward: false,
    dashboardPath: "",
    closedTarget: false,
    hostPagesBefore: 0,
    hostPagesAfter: 0,
    attachedStillOpen: null as boolean | null,
  };

  const ask = (mode: "read" | "mark", index = -1, label = ""): SurfaceAsk => ({
    mode, index, label, stopPath: guard.stopPath, deny: guard.deny, commit: guard.commit,
  });

  const note = (
    name: string,
    started: number,
    label: string,
    pagePath: string,
    isTrusted: boolean | null = null,
    kind = "",
  ): void => {
    steps.push({
      name,
      path: publicPath(pagePath),
      label: redactText(label),
      ms: Date.now() - started,
      isTrusted,
      kind,
      shot: "",
    });
  };

  const remember = (page: Surface): Surface => {
    lastSurface = page;
    rawControls = page.controls;
    const screen = [page.title, page.path, ...page.headings].join("\n");
    let onScreen = false;
    try {
      onScreen = new RegExp(guard.reached, "i").test(screen);
    } catch {
      onScreen = false;
    }
    if (page.commit.length && onScreen) {
      reached = true;
      if (!confirmLabel) confirmLabel = page.commit[0] || "";
    }
    return publishSurface(page);
  };

  const read = async (): Promise<Surface> => {
    const page = await driver!.evaluateFunction<Surface>(readSurface, ask("read"));
    const blockedWall = await wall(driver!, guard.start).catch(() => null);
    if (blockedWall && !page.blocked) page.blocked = blockedWall;
    return page;
  };

  const shots: string[] = [];
  const saveShot = async (name: string): Promise<{ file: string; png?: Buffer }> => {
    if (!driver) return { file: "" };
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "step";
    const base = `${String(shots.length + 1).padStart(2, "0")}-${slug}.png`;
    const file = path.join(evidence, "frames", base);
    await mkdir(path.dirname(file), { recursive: true });
    const blurred = await driver.evaluateFunction<number>(redactForShot, null);
    if (typeof blurred !== "number") throw new Error("redaction did not run");
    const png = await driver.screenshotPng();
    await writeFile(file, png);
    await driver.evaluateFunction<number>(clearRedact, null).catch(() => undefined);
    return { file: base, png };
  };
  const emit = async (page: Surface, shotName: string): Promise<void> => {
    const shown = remember(page);
    const saved = await saveShot(shotName).catch((err) => {
      progress(`screenshot skipped ${safeError(err)}`);
      return { file: "" };
    });
    if (saved.file) {
      shots.push(saved.file);
      const last = steps[steps.length - 1];
      if (last) last.shot = saved.file;
    }
    const last = steps[steps.length - 1];
    liveLog.setSteps(steps.map((step) => ({ name: step.name, status: step.name, ms: step.ms })));
    await liveLog.add({
      action: shotName,
      label: shown.title || shotName,
      path: shown.path,
      isTrusted: last?.isTrusted ?? null,
      ms: last?.ms || 0,
      png: "png" in saved ? saved.png : undefined,
    });
    process.stdout.write(`${JSON.stringify({
      path: shown.path,
      title: shown.title,
      headings: shown.headings,
      commit: shown.commit,
      blocked: shown.blocked,
      reached,
      shot: saved.file,
      controls: shown.controls.map((control) => ({ index: control.index, kind: control.kind, label: control.label, y: control.y })),
    })}\n`);
  };

  const finishHold = async (): Promise<void> => {
    progress(reached ? "holding the stop screen" : "closing");
    await sleep(reached ? FINAL_HOLD_MS : PACE_MS);
  };

  const settle = async (label: string): Promise<Surface> => {
    const openStarted = Date.now();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const signals = await driver!.pageSignals().catch(() => null);
      const href = signals?.url || "";
      try {
        if (guard.hosts.includes(new URL(href).hostname)) break;
      } catch {
        /* the new page is still blank */
      }
      await sleep(200);
    }
    await driver!.show();
    await sleep(PACE_MS);
    const page = await read();
    note(label, openStarted, "", page.path);
    await emit(page, label);
    return page;
  };

  const stopForWall = (page: Surface): void => {
    if (page.blocked === "captcha" || page.blocked === "bot_wall" || page.blocked === "upsell") {
      throw new NeedsHuman(page.blocked);
    }
  };

  try {
    if (guard.attachPath) {
      const picture = await browserPicture(cdp, guard.hosts, "").catch((err) => {
        progress(`target list failed ${safeError(err)}`);
        return { createdContextIds: [] as string[], pages: [] as ContextPage[] };
      });
      contextReport.opened = "attached";
      contextReport.createdBrowserContext = false;
      contextReport.hostPagesBefore = picture.pages.length;
      const choice = pickExistingPage(picture.pages, guard.hosts, guard.attachPath);
      if (!choice.page) {
        const paths = picture.pages.map((page) => publicPath(`https://${page.host}${page.path}`));
        const distinct = [...new Set(paths)];
        progress(`no single attach match (${choice.matches}); open paths ${paths.join(" ") || "none"}`);
        const sameUnexpected = choice.matches === 0 && picture.pages.length > 0 && distinct.length === 1;
        if (!sameUnexpected) throw new NeedsHuman(choice.matches === 0 ? "dashboard-tab-missing" : "ambiguous-tab");
        const sample = picture.pages[0];
        if (!sample) throw new NeedsHuman("dashboard-tab-missing");
        progress(`dashboard path missing; reading one open tab ${distinct[0]} without clicking`);
        driver = await attachLivePage(cdp, guard.hosts, sample.targetId);
        const landed = await settle("unexpected");
        contextReport.dashboardPath = distinct[0] || "";
        contextReport.closedTarget = false;
        stopForWall(landed);
        if (signedOutSurface(landed)) throw new NeedsHuman(landed.blocked || "login");
        if (/\/myoffers|\/plus|\/premium|\/trial|\/subscribe/i.test(landed.path)) {
          throw new NeedsHuman(landed.blocked || "upsell");
        }
        throw new NeedsHuman(landed.blocked || "unexpected-screen");
      }
      const attachedPath = publicPath(`https://${choice.page.host}${choice.page.path}`);
      progress(`attaching to the open tab ${attachedPath}`);
      driver = await attachLivePage(cdp, guard.hosts, choice.page.targetId);
      const landed = await settle("attach");
      contextReport.dashboardPath = attachedPath;
      contextReport.sameAsDashboard = true;
      contextReport.isolated = false;
      contextReport.closedTarget = false;
      stopForWall(landed);
      if (signedOutSurface(landed)) throw new NeedsHuman(landed.blocked || "login");
      if (landed.blocked && !reached) throw new NeedsHuman(landed.blocked);
    } else {
    driver = await openLiveWindow(cdp, guard.hosts);
    await driver.goto(guard.start, 30_000);
    let landed = await settle("open");
    const picture = await browserPicture(cdp, guard.hosts, driver.targetId).catch((err) => {
      progress(`context check failed ${safeError(err)}`);
      return { createdContextIds: [] as string[], pages: [] as ContextPage[] };
    });
    const ours = await ownContextId(cdp, driver.targetId).catch(() => "");
    const dashboard = pickDashboardPage(picture.pages);
    const dashboardId = dashboard ? dashboard.browserContextId : null;
    contextReport = {
      createdBrowserContext: false,
      isolated: isolatedFromDashboard(ours, dashboardId, picture.createdContextIds),
      sameAsDashboard: sameContext(ours, dashboardId),
      reopenedDefault: false,
      opened: "window",
      broughtDashboardForward: false,
      dashboardPath: dashboard ? publicPath(`https://${dashboard.host}${dashboard.path}`) : "",
      closedTarget: false,
      hostPagesBefore: picture.pages.length,
      hostPagesAfter: 0,
      attachedStillOpen: null,
    };
    progress(`context created=false isolated=${contextReport.isolated} sameAsDashboard=${String(contextReport.sameAsDashboard)} dashboard=${contextReport.dashboardPath || "none"}`);
    stopForWall(landed);

    if (signedOutSurface(landed) && contextReport.isolated && dashboard) {
      const join = defaultContextJoinId(dashboard.browserContextId, picture.createdContextIds);
      progress("new window is outside the default browser context; opening one in the default context");
      await driver.end();
      driver = undefined;
      await sleep(PACE_MS);
      driver = await openLiveWindow(cdp, guard.hosts, join ? { browserContextId: join } : {});
      await driver.goto(guard.start, 30_000);
      landed = await settle("open-default");
      const again = await ownContextId(cdp, driver.targetId).catch(() => "");
      contextReport.reopenedDefault = true;
      contextReport.isolated = isolatedFromDashboard(again, dashboard.browserContextId, picture.createdContextIds);
      contextReport.sameAsDashboard = sameContext(again, dashboard.browserContextId);
      stopForWall(landed);
    }

    if (signedOutSurface(landed)) {
      if (!dashboard) throw new NeedsHuman(landed.blocked || "login");
      progress("still signed out in the default context; opening a new tab in the dashboard window");
      const join = defaultContextJoinId(dashboard.browserContextId, picture.createdContextIds);
      const dashWindow = await ownWindowId(cdp, dashboard.targetId);
      const initial = dashboardNavigation(dashboard, guard.hosts) || guard.start;
      await driver.end();
      driver = undefined;
      await sleep(400);
      const tabOptions = {
        newWindow: false,
        url: initial,
        ...(join ? { browserContextId: join } : {}),
      };
      contextReport.opened = "tab";
      driver = await openLiveWindow(cdp, guard.hosts, tabOptions);
      const tabWindow = await ownWindowId(cdp, driver.targetId);
      if (dashWindow != null && tabWindow != null && dashWindow !== tabWindow) {
        progress("new tab opened in another window; opening it beside the dashboard");
        await driver.end();
        driver = undefined;
        await cdp.send("Target.activateTarget", { targetId: dashboard.targetId });
        contextReport.broughtDashboardForward = true;
        await sleep(400);
        driver = await openLiveWindow(cdp, guard.hosts, tabOptions);
      }
      landed = await settle("open-tab");
      if (signedOutSurface(landed)) {
        const next = dashboardNavigation(dashboard, guard.hosts) || guard.start;
        progress("new tab is still on a sign-in screen; loading the open page path in that tab");
        await driver.goto(next, 30_000);
        landed = await settle("open-dashboard-path");
      }
      const tabContext = await ownContextId(cdp, driver.targetId).catch(() => "");
      contextReport.opened = "tab";
      contextReport.isolated = isolatedFromDashboard(tabContext, dashboard.browserContextId, picture.createdContextIds);
      contextReport.sameAsDashboard = sameContext(tabContext, dashboard.browserContextId);
      stopForWall(landed);
      if (signedOutSurface(landed)) throw new NeedsHuman(landed.blocked || "login");
    }

    if (landed.blocked && !reached) throw new NeedsHuman(landed.blocked);
    }

    let offset = 0;
    let finished = reached;
    while (!finished) {
      const raw = await readFile(guard.inbox, "utf8").catch(() => "");
      const chunk = raw.slice(offset);
      offset = raw.length;
      const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length === 0) {
        await sleep(300);
        continue;
      }
      for (const line of lines) {
        if (line === "look") {
          const started = Date.now();
          await driver.show();
          const page = await read();
          note("look", started, "", page.path);
          await emit(page, "look");
          stopForWall(page);
          if (page.blocked && !reached) throw new NeedsHuman(page.blocked);
          if (reached) {
            finished = true;
            break;
          }
          continue;
        }
        if (line === "scroll") {
          const started = Date.now();
          await driver.show();
          await driver.evaluateFunction(scrollDown, null);
          await sleep(PACE_MS);
          const page = await read();
          note("scroll", started, "", page.path);
          await emit(page, "scroll");
          stopForWall(page);
          if (page.blocked && !reached) throw new NeedsHuman(page.blocked);
          if (reached) {
            finished = true;
            break;
          }
          continue;
        }
        if (line.startsWith("click ")) {
          if (reached) throw new NeedsHuman("commit-visible");
          const index = Number(line.slice(6));
          const control = rawControls.find((item) => item.index === index);
          if (!control || !redactText(control.label) || !clickAllowed(control.label, control.kind, guard.deny, guard.commit)) {
            throw new NeedsHuman("refused-click");
          }
          if (clicks >= CLICK_CAP) throw new NeedsHuman("too-many-clicks");
          const started = Date.now();
          await driver.show();
          const marked = await driver.evaluateFunction<Surface>(readSurface, ask("mark", index, control.label));
          if (!marked.ok) throw new NeedsHuman(marked.reason || "refused-click");
          await driver.clickCss("[data-bao-pick]");
          clicks += 1;
          await sleep(PACE_MS);
          const page = await read();
          observed = await driver.observe().catch(() => observed);
          const trusted = observed?.trust.length ? observed.trust[observed.trust.length - 1]?.isTrusted === true : null;
          note("click", started, control.label, page.path, trusted, control.kind);
          await emit(page, `click-${control.kind}`);
          stopForWall(page);
          if (page.blocked && !reached) throw new NeedsHuman(page.blocked);
          if (reached) {
            finished = true;
            break;
          }
          continue;
        }
        if (line === "stop") {
          reached = true;
          if (!confirmLabel) {
            const commit = rawControls.find((item) => item.kind !== "link" && new RegExp(guard.commit, "i").test(item.label));
            const named = rawControls.find((item) => item.kind === "button" && /confirm|submit|apply|unfreeze|continue|lift/i.test(item.label));
            confirmLabel = commit?.label || named?.label || "";
          }
          const page = await read();
          note("stop", Date.now(), confirmLabel, page.path);
          await emit(page, "stop");
          finished = true;
          break;
        }
        if (line === "done") {
          finished = true;
          break;
        }
        progress(`ignored command`);
      }
    }
    observed = await driver.observe();
    if (reached && !confirmClicked) {
      status = "needs_human";
      code = code || "stopped-before-confirm";
    } else if (reached) {
      status = "passed";
    } else {
      status = "needs_human";
      code = code || "not-reached";
    }
    await finishHold();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NeedsHuman) {
      code = err.code;
      if (code === "commit-visible") {
        reached = true;
        code = "stopped-before-confirm";
      }
      status = "needs_human";
    } else if (/allowlist refused/.test(message)) {
      code = /blocked-path/.test(message) ? "blocked-path" : "off-host";
      status = "needs_human";
      if (guard.attachPath && driver) {
        progress("leaving the allowlist; stepping back once and stopping");
        await driver.returnToAllowlist().catch(() => undefined);
        await sleep(PACE_MS);
      }
    } else {
      code = safeError(err);
      status = "failed";
    }
    progress(`stopped ${status} ${code}`);
    if (driver) observed = await driver.observe().catch(() => undefined);
    await finishHold().catch(() => undefined);
  } finally {
    const attachedId = guard.attachPath && driver ? driver.targetId : "";
    await driver?.end().catch(() => undefined);
    if (attachedId) {
      const again = await browserPicture(cdp, guard.hosts, "").catch(() => null);
      if (again) {
        contextReport.hostPagesAfter = again.pages.length;
        contextReport.attachedStillOpen = again.pages.some((page) => page.targetId === attachedId);
        contextReport.closedTarget = contextReport.attachedStillOpen === false;
      }
    }
  }

  progress("reading the automation banner");
  const during = (await chromeTree(helper)).summary.banner;
  cdp.close();
  await sleep(500);
  const after = (await chromeTree(helper)).summary.banner;
  const trust = (observed?.trust || []).map((event) => ({
    isTrusted: event.isTrusted === true,
    tag: event.tag,
    text: redactText(event.text),
  }));
  const shown = lastSurface ? publishSurface(lastSurface) : undefined;
  const body = {
    status,
    code: code || undefined,
    intent: guard.intent,
    reached,
    path: shown?.path || "",
    title: shown?.title || "",
    headings: shown?.headings || [],
    confirmLabel: redactText(confirmLabel),
    confirmClicked,
    clicks,
    connectToAllowMs,
    allowWindow,
    webdriver: observed ? observed.webdriver : null,
    host: guard.hosts.includes(observed?.host || "") ? observed?.host || "" : "",
    trusted: trust.length ? trust.every((event) => event.isTrusted) : null,
    trust,
    steps,
    context: contextReport,
    botWall: code === "bot_wall",
    banner: { during: during.visible, afterClose: after.visible },
    checkboxOn: box.on,
    screenCapture: false,
    shots,
    audit: [
      {
        action: "ax-allow",
        label: "Allow",
        path: "",
        isTrusted: null,
        axAllow: clickedAt != null,
        ms: connectToAllowMs,
        kind: "ax",
      },
      ...steps.map((step) => ({
        action: step.name,
        label: step.label,
        path: step.path,
        isTrusted: step.isTrusted,
        axAllow: false,
        ms: step.ms,
        kind: step.kind,
        shot: step.shot,
      })),
    ],
  };
  const draft = {
    driver: "cdp-live",
    intent: guard.intent,
    hosts: guard.hosts,
    steps: steps.map((step) => ({ action: step.name, path: step.path, label: step.label, kind: step.kind, ms: step.ms, isTrusted: step.isTrusted })),
    confirmLabel: body.confirmLabel,
    confirmClicked: false,
  };
  if (guard.attachPath) {
    const workflow = workflowFromAudit({
      id: ids.workflowId,
      name: guard.intent.slice(0, 80),
      intent: guard.intent,
      startUrl: guard.start,
      createdAt: Date.now(),
      steps,
      confirmLabel: body.confirmLabel,
    });
    const workflowErrors = validateWorkflow(workflow);
    if (workflowErrors.length === 0) {
      const library = new Library(resolveBaoHome({ homeFlag: arg("--home") || undefined }));
      library.save(workflow);
      const confirm = workflow.steps.find((step) => step.action === "confirm");
      library.saveRun({
        id: ids.runId,
        workflowId: workflow.id,
        status: "needs_human",
        at: Date.now(),
        heals: [],
        modelCalls: 0,
        steps: workflow.steps.map((step) => ({
          id: step.id,
          status: step.action === "confirm" ? "paused" : "passed",
          action: step.action,
          label: step.label,
          reason: step.action === "confirm" ? "stopped before confirm" : "",
        })),
        envelope: {
          status: "needs_human",
          run_id: ids.runId,
          step: confirm?.id,
          reason: "stopped before confirm",
          ask: confirm?.label || "Stop before confirm",
        },
      });
      await writeFile(path.join(evidence, "unfreeze-workflow.json"), `${JSON.stringify(workflow, null, 2)}\n`);
    } else {
      progress(`workflow draft invalid ${workflowErrors.join(",")}`);
    }
  }
  await liveLog.setSteps(steps.map((step) => ({ name: step.name, status: step.name, ms: step.ms })));
  await liveLog.flush(status, code || "", body.host);
  await writeFile(outFile, `${JSON.stringify(body, null, 2)}\n`);
  await writeFile(draftFile, `${JSON.stringify(draft, null, 2)}\n`);
  progress(`wrote ${path.basename(outFile)}`);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  if (status !== "passed") process.exitCode = 2;
}

if (require.main === module) {
  main().catch((err) => {
    const summary = err instanceof AxUnavailable ? err.summary : undefined;
    process.stderr.write(`${safeError(err)}\n`);
    if (summary) process.stderr.write(`${JSON.stringify(summary)}\n`);
    process.exit(1);
  });
}
