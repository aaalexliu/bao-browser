import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";
import { openCurrentChrome, type CurrentChrome } from "../cdp-live/current-chrome";
import { AgentBrowserRun, type AgentBrowserTaskOutcome, type RecordedAgentBrowserCommand, type StepContext } from "./agent-browser-record";
import { CURRENT_CHROME_ENDED, newInRead, type OwnerWaitPage } from "./agent-browser-describe";
import { BROWSER_PICTURE_BYTES, type ShotBox } from "../v1/shots";
import { agentBrowserExecutable } from "./agent-browser";
import { AgentBrowserWorkflow } from "./agent-browser-workflow";
import { chromeProfilesRoot, openCopiedChromeForProxy } from "./chrome-profile-copy";
import { openBaoChromeForProxy } from "./bao-profile";
import { ownerWall, ownerCanResume, ownerWaitTimeout, OWNER_WAIT_INSTRUCTION, type OwnerPage } from "../cdp-live/owner-wait";
import { BROWSER_CHOICES, DEFAULT_BROWSER } from "../browser-choice";
import { targetBox } from "../v1/caption";

export const AGENT_BROWSER_COMMANDS = ["open", "snapshot", "click", "fill", "press", "scroll", "tab", "screenshot", "wait_for_owner", "close"] as const;
export type AgentBrowserCommand = typeof AGENT_BROWSER_COMMANDS[number];
export interface AgentBrowserCommandResult { stdout: string; stderr: string; exitCode: number }

const SESSION_IDLE_MS = 10 * 60 * 1000;

const FIXED_OPTIONS = new Set([
  "--session", "--namespace", "--profile", "--executable-path", "--headed", "--cdp", "--auto-connect",
  "--provider", "-p", "--engine", "--config", "--args", "--idle-timeout", "--all",
]);

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

function webSite(value: string | undefined): string | undefined {
  try {
    if (!value) return undefined;
    const url = new URL(value.includes("://") || /^(about|file|data|chrome|javascript):/i.test(value) ? value : `https://${value}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

interface SessionData {
  browser: AgentBrowser;
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
  commandDone?: Promise<void>;
  closing?: boolean;
  removing?: Promise<void>;
  outcome?: AgentBrowserTaskOutcome;
  idleTimer?: ReturnType<typeof setTimeout>;
}

type Session = SessionData & (
  | { kind: "copy"; chrome: Awaited<ReturnType<typeof openCopiedChromeForProxy>> | Awaited<ReturnType<typeof openBaoChromeForProxy>> }
  | { kind: "current"; chrome: CurrentChrome; taskTabs: Set<string> }
);

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
  /** The sign-in or check page Bao is waiting on, or the latest one it waited on. URL and title only. */
  get ownerPage(): OwnerWaitPage | undefined {
    const session = this.session;
    const wait = session?.ownerWait;
    const page = wait && wait !== "pending" ? wait.page : session?.ownerPage;
    return page && { ...page, ...(session?.ownerSince !== undefined ? { since: session.ownerSince } : {}) };
  }
  private currentEnded = false;

  constructor(private readonly options: { home: string; sourceRoot?: string; directory?: string; executable?: string; keepOpen?: () => boolean; hasHold?: () => boolean }) {}

  queueClose(args: unknown = []): () => void {
    validateAgentBrowserCommand("close", args);
    this.pendingCloses++;
    return () => { this.pendingCloses--; };
  }

  async execute(command: unknown, args: unknown = [], browser?: unknown, visual = false): Promise<AgentBrowserCommandResult[]> {
    this.latest = undefined;
    this.workflowOutcome = undefined;
    validateAgentBrowserCommand(command, args);
    if (browser !== undefined && (command !== "open" || !AGENT_BROWSERS.includes(browser as AgentBrowser))) {
      throw new Error("browser is only accepted on open and must be copy, bao, or current");
    }
    if (browser !== undefined && this.session?.removing) await this.session.removing;
    if (this.session?.kind === "current" && this.session.chrome.isClosed()) await this.remove(this.session);
    if (browser !== undefined && (this.session?.kind === "current" || this.starting)) throw new Error("choose the browser only on the first open of a session");
    if (this.session && browser !== undefined && browser !== this.session.browser) {
      throw new Error("close the current session before choosing a different browser");
    }
    if (command === "close") {
      this.currentEnded = false;
      if (this.session) this.session.closing = true;
      if (this.disconnected) {
        await this.end(true);
        return [{ stdout: "", stderr: "", exitCode: 0 }];
      }
    }
    if (this.session?.removing) await this.session.removing;
    if (this.disconnected) throw new Error("agent-browser client disconnected");
    if (!this.session && command === "close") return [{ stdout: "", stderr: "", exitCode: 0 }];
    if (!this.session && this.currentEnded && (command !== "open" || browser === undefined)) throw new Error(CURRENT_CHROME_ENDED);
    if (!this.session && command !== "open") throw new Error("start agent-browser with open before sending commands");
    if (this.session?.abort.signal.aborted) {
      const current = this.session.kind === "current";
      if (command === "close") await this.remove(this.session);
      return this.ownerResult("closed", current);
    }
    if (command === "wait_for_owner") {
      if (args.length > 1) throw new Error("wait_for_owner accepts only an optional timeout in milliseconds");
      ownerWaitTimeout(args[0] === undefined ? undefined : Number(args[0]));
    }
    const continuing = !!this.session;
    const recording = this.session?.recording ?? new AgentBrowserRun(this.options.home);
    let step = continuing ? undefined : recording.begin(command as string, args);
    if (step) this.latest = { runId: recording.id, step, steps: recording.steps };
    if (!this.session) {
      try {
        const session = await (this.starting = this.start(recording, (browser as AgentBrowser | undefined) ?? DEFAULT_BROWSER, webSite(args[0])));
        this.session = session;
        this.currentEnded = false;
        void session.chrome.closed.then(() => {
          if (session.closing) return;
          if (!this.disconnected && !session.removing) session.workflow.unavailable("the owner closed the window before the task finished");
          return this.remove(session);
        }).catch(() => undefined);
      } catch (error) {
        await recording.complete(step!, [], this.options.home, async () => { throw error; }, error);
        recording.finish();
        throw error;
      } finally {
        this.starting = undefined;
        this.startAbort = undefined;
      }
    }
    const session = this.session;
    clearTimeout(session.idleTimer);
    let commandDone!: () => void;
    session.commandDone = new Promise<void>((resolve) => { commandDone = resolve; });
    const results: AgentBrowserCommandResult[] = [];
    const context: StepContext = {};
    let failure: unknown;
    try {
      if (this.disconnected) throw new Error("agent-browser client disconnected");
      if (continuing && command !== "close" && command !== "wait_for_owner") {
        await this.detectOwnerWall(session);
        if (session.ownerWait) {
          results.push(...this.ownerResult("halted"));
          return results;
        }
      }
      context.previousPage = session.page;
      step ??= recording.begin(command as string, args);
      this.latest = { runId: recording.id, step, steps: recording.steps };
      if (command === "open") {
        const site = webSite(args[0]);
        if (continuing && site && "importLogin" in session.chrome) await session.chrome.importLogin(site);
      }
      if (command === "wait_for_owner") {
        results.push(...await this.waitForOwner(session, args));
        return results;
      }
      if ((command === "click" || command === "fill") && args[0]) {
        await this.captureTarget(session, step, args[0]);
        if (session.ownerWait) { results.push(...this.ownerResult("halted")); return results; }
      }
      await session.workflow.record(command as string, args, step.id, async () => {
        const result = command === "close" && (session.kind === "current" || session.chrome.isClosed())
          ? { stdout: session.kind === "current" ? "Disconnected from the owner's own Chrome. Only Bao's task tabs close; the owner's tabs and windows stay open." : "", stderr: "", exitCode: 0 }
          : await this.run(session, command as string, args);
        results.push(result);
        if (command !== "close" && result.exitCode === 0) await this.detectOwnerWall(session, command === "open" ? webSite(args[0]) : undefined);
        return result;
      }, () => !!session.ownerWait);
      if (session.ownerWait) {
        results.splice(0, results.length, ...this.ownerResult("halted"));
        return results;
      }
      if (visual && command === "snapshot" && results[0]?.exitCode === 0) context.mark = await this.readMark(session, recording.seenOn(session.page?.url), results[0].stdout);
      if (command === "open" && results[0]!.exitCode === 0) {
        // Keep the native list intact, including stable tab ids and every restored tab on the site's host.
        results.push(await this.run(session, "tab", ["list"]));
      }
      return results;
    } catch (error) {
      failure = error;
      session.workflow.unavailable("a browser command was interrupted");
      throw error;
    } finally {
      try {
        if (step) {
          try {
            await session.recording.complete(step, results, session.stateDir, () => this.screenshot(session, command as string, visual), failure,
              !!session.ownerWait || command === "wait_for_owner", { ...context, page: session.page, owner: this.ownerPage });
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

  async finishTask(outcome: AgentBrowserTaskOutcome): Promise<string | undefined> {
    this.workflowOutcome = undefined;
    this.currentEnded = false;
    const session = this.session;
    if (!session) return undefined;
    session.outcome = outcome;
    if (outcome.outcome === "failed") session.workflow.unavailable(outcome.reason);
    const runId = session.recording.id;
    try {
      await this.remove(session, this.options.keepOpen?.() === true);
      session.recording.finish(outcome);
      if (this.session === session) this.session = undefined;
      return runId;
    } finally {
      this.currentEnded = false;
    }
  }

  async close(): Promise<void> {
    if (!this.session) return;
    this.session.closing = true;
    if (this.disconnected || this.session.removing || this.session.abort.signal.aborted) {
      await this.remove(this.session);
      return;
    }
    const [result] = await this.execute("close");
    if (result!.exitCode !== 0) throw new Error("agent-browser close failed");
  }

  private async start(recording: AgentBrowserRun, route: AgentBrowser, site?: string): Promise<Session> {
    const executable = agentBrowserExecutable(this.options.executable);
    if (process.env.BAO_TEST_BROWSER && !this.options.sourceRoot) throw new Error("tests must supply a throwaway Chrome profile source");
    const abort = this.startAbort = new AbortController();
    const options = {
      sourceRoot: this.options.sourceRoot ?? chromeProfilesRoot(), directory: this.options.directory || "Default", home: this.options.home,
      detached: this.options.keepOpen?.() === true,
    };
    const browser = route === "current"
      ? { kind: "current" as const, taskTabs: new Set<string>(), chrome: await openCurrentChrome({ root: options.sourceRoot, defaultRoot: chromeProfilesRoot(),
        axLog: path.join(this.options.home, "audit", "current-chrome.jsonl"), signal: abort.signal }) }
      : { kind: "copy" as const, chrome: route === "bao" ? await openBaoChromeForProxy({ ...options, site }) : await openCopiedChromeForProxy(options) };
    let stateDir: string | undefined;
    try {
      stateDir = await mkdtemp(path.join(tmpdir(), "bao-proxy-"));
      const config = path.join(stateDir, "config.json");
      await writeFile(config, "{}", { mode: 0o600 });
      if (browser.kind === "current") {
        // A background target leaves the owner's active tab and window focus alone. agent-browser selects this
        // session's bound target (`<session>.target` in its socket directory) when its daemon attaches.
        const { targetId } = await browser.chrome.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true }, undefined, 5000);
        browser.taskTabs.add(targetId);
        // Focus emulation keeps the background tab painting, running timers, and taking input. It lasts while this session stays attached.
        const { sessionId } = await browser.chrome.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 5000);
        await browser.chrome.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId, 5000);
        await writeFile(path.join(stateDir, "bao.target"), JSON.stringify({ targetId, url: "about:blank" }), { mode: 0o600 });
      }
      const endpoint = browser.kind === "current" ? browser.chrome.endpoint : await readDevToolsActivePort(browser.chrome.target.portFile);
      const session: Session = {
        ...browser, browser: route, stateDir, executable, abort, recording,
        workflow: new AgentBrowserWorkflow(this.options.home, recording.id, async () => {
          const active = await this.activePage(session);
          if (!active) throw new Error("no active Bao page metadata");
          const endpoint = session.kind === "current" ? session.chrome.endpoint : await readDevToolsActivePort(session.chrome.target.portFile);
          return { ...endpoint, targetId: active.targetId, targetIds: active.targetIds };
        }),
        flags: ["--session", "bao", "--config", config, "--cdp", `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`,
          "--idle-timeout", "0"],
        env: {
          HOME: stateDir, TMPDIR: stateDir, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
          AGENT_BROWSER_SOCKET_DIR: stateDir, AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0", BAO_HEAL_CURSOR_ACCOUNT: "0",
          ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        },
      };
      return session;
    } catch (error) {
      if (stateDir) await rm(stateDir, { recursive: true, force: true });
      if (browser.kind === "current") {
        for (const targetId of browser.taskTabs) await browser.chrome.cdp.send("Target.closeTarget", { targetId }, undefined, 5000).catch(() => undefined);
        browser.chrome.detach();
      }
      else await browser.chrome.close();
      throw error;
    }
  }

  private async connectSession(session: Session, options: { timeoutMs: number; signal?: AbortSignal }): Promise<CdpSocket> {
    if (session.kind === "current") return session.chrome.cdp;
    const endpoint = await readDevToolsActivePort(session.chrome.target.portFile);
    return connectCdp(endpoint.port, endpoint.browserPath, options);
  }

  private ownerResult(kind: "halted" | "waiting" | "ready" | "closed", current = false): AgentBrowserCommandResult[] {
    return [{ stdout: JSON.stringify({ outcome: kind, instruction: kind === "ready" ? "The page left the sign-in/check state. Take a fresh snapshot and continue in this same session. This is not proof of authentication." : kind === "closed" ? current ? CURRENT_CHROME_ENDED : "The owner closed the Bao window. Report that this session cannot continue." : OWNER_WAIT_INSTRUCTION }), stderr: "", exitCode: 0 }];
  }

  private async activePage(session: Session): Promise<{ targetId: string; targetIds: string[]; page: OwnerPage } | undefined> {
    const tabs = await this.run(session, "tab", ["list", "--json"], 5000);
    if (tabs.exitCode !== 0) throw new Error(`Native tab list failed (exit ${tabs.exitCode}): ${tabs.stderr || tabs.stdout}`);
    const parsed = JSON.parse(tabs.stdout) as { data?: { tabs?: { active?: boolean; targetId?: string }[] } };
    const active = parsed.data?.tabs?.find((tab) => tab.active);
    if (!active?.targetId) return undefined;
    // Native tab titles can be URL-derived labels. Read the real title from Chrome, not that label.
    const signal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(2000)]);
    const cdp = await this.connectSession(session, { timeoutMs: 2000, signal });
    try {
      const { targetInfo } = await cdp.send<{ targetInfo: { url: string; title: string } }>("Target.getTargetInfo", { targetId: active.targetId }, undefined, 2000);
      session.page = { url: targetInfo.url, title: targetInfo.title };
      return { targetId: active.targetId, targetIds: parsed.data?.tabs?.flatMap((tab) => tab.targetId ? [tab.targetId] : []) ?? [], page: { url: targetInfo.url, title: targetInfo.title } };
    } finally { if (session.kind === "copy") cdp.close(); }
  }

  private async detectOwnerWall(session: Session, openedSite?: string): Promise<void> {
    if (session.ownerWait) return;
    let active = await this.activePage(session);
    if (!active) throw new Error("no active Bao page metadata");
    if (!ownerWall(active.page)) return;
    if (openedSite && ownerWall(active.page) === "login_wall" && "importLogin" in session.chrome) {
      if (await session.chrome.importLogin(new URL(active.page.url).origin, true)) {
        const retry = await this.run(session, "open", [openedSite]);
        if (retry.exitCode !== 0) throw new Error(`Bao sign-in retry failed: ${retry.stderr || retry.stdout || `exit ${retry.exitCode}`}`);
        active = await this.activePage(session);
        if (!active) throw new Error("no active Bao page metadata");
        if (!ownerWall(active.page)) return;
      }
    }
    session.ownerWait = active;
    session.ownerPage = active.page;
    session.ownerSince = Date.now();
    session.recording.ownerWaiting(true);
    await this.ownerBanner(session, active.targetId, true);
  }

  /** Writes only Bao's status banner. Never reads the form, page text, or field values. */
  private async ownerBanner(session: Session, targetId: string, waiting: boolean): Promise<void> {
    const cdp = await this.connectSession(session, { timeoutMs: 2000, signal: session.abort.signal });
    let attached: string | undefined;
    try {
      // The owner's own Chrome keeps the task tab in the background. Show it when the owner has to act in it.
      if (waiting && session.kind === "current") await cdp.send("Target.activateTarget", { targetId }, undefined, 2000);
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 2000);
      attached = sessionId;
      const expression = waiting ? `(() => {
        const banner = document.createElement('div');
        banner.id = 'bao-owner-wait'; banner.setAttribute('role', 'status');
        banner.textContent = 'Bao is waiting for you. Sign in or clear this check. The agent will continue in this window. Only URL and title are read while waiting.';
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
    return this.ownerResult("closed", session.kind === "current");
  }

  private async waitForOwner(session: Session, args: string[]): Promise<AgentBrowserCommandResult[]> {
    const deadline = Date.now() + ownerWaitTimeout(args[0] === undefined ? undefined : Number(args[0]));
    if (session.abort.signal.aborted) return this.ownerClosed(session);
    if (!session.ownerWait) {
      session.ownerWait = "pending";
      session.ownerSince = Date.now();
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
            return this.ownerResult("ready");
          }
        } catch {
          candidate = "";
          if (session.abort.signal.aborted || cdp && !cdp.isOpen) return this.ownerClosed(session);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
      }
      return session.abort.signal.aborted || cdp && !cdp.isOpen ? this.ownerClosed(session) : this.ownerResult("waiting");
    } finally {
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
      if (!frame.viewport) return;
      const box = targetBox(rect, frame.viewport);
      if (!box) return;
      await session.recording.actionPicture(step, frame.bytes, { rect: { x: box.x, y: box.y, width: box.width, height: box.height }, viewport: frame.viewport });
    } catch (error) {
      // A disconnect aborts the box read. That abort is the command's result.
      if (session.abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      // Missing action evidence must not change the native command.
    }
  }

  private async screenshot(session: Session, command: string, visual = false): Promise<{ bytes: Buffer; viewport?: { width: number; height: number } }> {
    if (command === "close" || this.disconnected || session.abort.signal.aborted) throw new Error("page closed");
    await this.detectOwnerWall(session);
    if (session.ownerWait) throw new Error("owner input is private");
    const tabs = await this.run(session, "tab", ["list", "--json"], 3000);
    if (tabs.exitCode !== 0) throw new Error(`Native tab list failed (exit ${tabs.exitCode}): ${tabs.stderr || tabs.stdout}`);
    const parsed = JSON.parse(tabs.stdout) as { data?: { tabs?: { active?: boolean; targetId?: string }[] } };
    const targetId = parsed.data?.tabs?.find((tab) => tab.active)?.targetId;
    if (!targetId) throw new Error("no active page");
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

  private async run(session: Session, command: string, args: string[], readTimeoutMs?: number): Promise<AgentBrowserCommandResult> {
    if (this.disconnected) throw new Error("agent-browser client disconnected");
    const execute = (command: string, args: string[], timeoutMs?: number) => new Promise<AgentBrowserCommandResult>((resolve, reject) => {
      const childSignal = timeoutMs === undefined ? session.abort.signal : AbortSignal.any([session.abort.signal, AbortSignal.timeout(timeoutMs)]);
      execFile(session.executable, [...session.flags, command, ...args], {
        cwd: session.stateDir, env: session.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal: childSignal,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") { reject(error); return; }
        resolve({ stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : 0 });
      });
    });
    if (session.kind === "copy") return execute(command, args, readTimeoutMs);
    return session.chrome.withConsent(async () => {
      const rememberTaskTab = async () => {
        try {
          const tabs = await execute("tab", ["list", "--json"], 5000);
          if (tabs.exitCode !== 0) throw new Error(`Native task tab list failed: ${tabs.stderr || tabs.stdout}`);
          const parsed = JSON.parse(tabs.stdout) as { data?: { tabs?: { active?: boolean; targetId?: string }[] } };
          const targetId = parsed.data?.tabs?.find((tab) => tab.active)?.targetId;
          if (!targetId) throw new Error("Native task tab has no target id");
          session.taskTabs.add(targetId);
        } catch (error) {
          process.stderr.write(`Bao task tab tracking unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      };
      const result = await execute(command, args, readTimeoutMs);
      if (command === "tab" && args[0] === "new" && result.exitCode === 0) await rememberTaskTab();
      return result;
    }, session.abort.signal, (result, context) => result.exitCode === 0 ? result : {
      ...result, stderr: `${result.stderr}${result.stderr && !result.stderr.endsWith("\n") ? "\n" : ""}${context}`,
    });
  }

  private armIdle(session: Session): void {
    clearTimeout(session.idleTimer);
    if (this.session !== session || session.removing || session.ownerWait || this.disconnected) return;
    session.idleTimer = setTimeout(() => {
      if (this.options.hasHold?.()) { this.armIdle(session); return; }
      session.outcome = { outcome: "failed", reason: "Session ended without finish_task after 10 minutes of inactivity." };
      session.workflow.unavailable(session.outcome.reason);
      void this.remove(session, this.options.keepOpen?.() === true, false)
        .then(() => {
          if (this.session === session) this.session = undefined;
        })
        .catch((error: unknown) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`));
    }, SESSION_IDLE_MS);
    session.idleTimer.unref();
  }

  private async remove(session: Session, keepOpen = false, closeTaskTabs = true): Promise<void> {
    clearTimeout(session.idleTimer);
    try {
      if (session.kind === "current" && !session.closing && !this.disconnected) this.currentEnded = true;
      await (session.removing ??= (async () => {
        session.abort.abort();
        await session.commandDone;
        session.recording.finish(session.outcome);
        if (session.ownerWait) session.workflow.unavailable("the owner wait did not finish");
        try {
          try {
            const pid = Number((await readFile(path.join(session.stateDir, "bao.pid"), "utf8")).trim());
            if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
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
            }
          } catch (error) {
            if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          } finally {
            if (session.kind === "current") {
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
    } finally {
      if (this.session === session && session.kind === "current" && session.chrome.isClosed()) this.session = undefined;
    }
  }
}
