import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";
import { AgentBrowserRun, type RecordedAgentBrowserCommand } from "./agent-browser-record";
import { agentBrowserExecutable } from "./agent-browser";
import { chromeProfilesRoot, openCopiedChromeForProxy } from "./chrome-profile-copy";
import { ownerWall, ownerCanResume, ownerWaitTimeout, OWNER_WAIT_INSTRUCTION, type OwnerPage } from "../cdp-live/owner-wait";

export const AGENT_BROWSER_COMMANDS = ["open", "snapshot", "click", "fill", "press", "scroll", "tab", "screenshot", "wait_for_owner", "close"] as const;
export type AgentBrowserCommand = typeof AGENT_BROWSER_COMMANDS[number];
export interface AgentBrowserCommandResult { stdout: string; stderr: string; exitCode: number }

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

interface Session {
  chrome: Awaited<ReturnType<typeof openCopiedChromeForProxy>>;
  stateDir: string;
  executable: string;
  flags: string[];
  env: NodeJS.ProcessEnv;
  abort: AbortController;
  recording: AgentBrowserRun;
  ownerWait?: { targetId: string; page: OwnerPage } | "pending";
  commandDone?: Promise<void>;
  closing?: boolean;
  removing?: Promise<void>;
}

export class AgentBrowserProxy {
  private session: Session | undefined;
  private disconnected = false;
  private starting: Promise<Session> | undefined;
  private pendingCloses = 0;
  private latest: { runId: string; step: RecordedAgentBrowserCommand } | undefined;

  get lastCommand(): typeof this.latest { return this.latest; }
  get activeRunId(): string | undefined { return this.session?.recording.id; }

  constructor(private readonly options: { home: string; sourceRoot?: string; directory?: string; executable?: string; keepOpen?: () => boolean }) {}

  queueClose(args: unknown = []): () => void {
    validateAgentBrowserCommand("close", args);
    this.pendingCloses++;
    return () => { this.pendingCloses--; };
  }

  async execute(command: unknown, args: unknown = [], visual = false): Promise<AgentBrowserCommandResult[]> {
    this.latest = undefined;
    validateAgentBrowserCommand(command, args);
    if (command === "close") {
      if (this.session) this.session.closing = true;
      if (this.disconnected) {
        await this.end(true);
        return [{ stdout: "", stderr: "", exitCode: 0 }];
      }
    }
    if (this.session?.removing) await this.session.removing;
    if (this.disconnected) throw new Error("agent-browser client disconnected");
    if (!this.session && command === "close") return [{ stdout: "", stderr: "", exitCode: 0 }];
    if (!this.session && command !== "open") throw new Error("start agent-browser with open before sending commands");
    if (this.session?.abort.signal.aborted) {
      if (command === "close") await this.remove(this.session);
      return this.ownerResult("closed");
    }
    if (command === "wait_for_owner") {
      if (args.length > 1) throw new Error("wait_for_owner accepts only an optional timeout in milliseconds");
      ownerWaitTimeout(args[0] === undefined ? undefined : Number(args[0]));
    }
    if (this.session && command !== "close" && command !== "wait_for_owner") {
      await this.detectOwnerWall(this.session);
      if (this.session.ownerWait) return this.ownerResult("halted");
    }
    const recording = this.session?.recording ?? new AgentBrowserRun(this.options.home);
    const step = recording.begin(command as string, args);
    this.latest = { runId: recording.id, step };
    if (!this.session) {
      try {
        const session = await (this.starting = this.start(recording));
        this.session = session;
        void session.chrome.closed.then(() => session.closing ? undefined : this.remove(session)).catch(() => undefined);
      } catch (error) {
        await recording.complete(step, [], this.options.home, async () => { throw error; }, error);
        recording.finish();
        throw error;
      } finally {
        this.starting = undefined;
      }
    }
    const session = this.session;
    let commandDone!: () => void;
    session.commandDone = new Promise<void>((resolve) => { commandDone = resolve; });
    const results: AgentBrowserCommandResult[] = [];
    let failure: unknown;
    try {
      if (this.disconnected) throw new Error("agent-browser client disconnected");
      if (command === "wait_for_owner") {
        results.push(...await this.waitForOwner(session, args));
        return results;
      }
      if (visual && (command === "click" || command === "fill") && args[0]) {
        await this.captureTarget(session, step, args[0]);
        if (session.ownerWait) { results.push(...this.ownerResult("halted")); return results; }
      }
      results.push(command === "close" && session.chrome.isClosed()
        ? { stdout: "", stderr: "", exitCode: 0 }
        : await this.run(session, command as string, args));
      if (command !== "close" && results[0]!.exitCode === 0) {
        await this.detectOwnerWall(session);
        if (session.ownerWait) {
          results.splice(0, results.length, ...this.ownerResult("halted"));
          return results;
        }
      }
      if (command === "open" && results[0]!.exitCode === 0) {
        // Keep the native list intact, including stable tab ids and every restored tab on the site's host.
        results.push(await this.run(session, "tab", ["list"]));
      }
      return results;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await session.recording.complete(step, results, session.stateDir, async () => (await this.screenshot(session, command as string, visual)).bytes, failure, !!session.ownerWait || command === "wait_for_owner");
      } finally {
        commandDone();
        if (command === "close") await this.remove(session);
      }
    }
  }

  disconnect(): void {
    this.disconnected = true;
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

  private async start(recording: AgentBrowserRun): Promise<Session> {
    const executable = agentBrowserExecutable(this.options.executable);
    if (process.env.BAO_TEST_BROWSER && !this.options.sourceRoot) throw new Error("tests must supply a throwaway Chrome profile source");
    const chrome = await openCopiedChromeForProxy({
      sourceRoot: this.options.sourceRoot ?? chromeProfilesRoot(), directory: this.options.directory || "Default", home: this.options.home,
      detached: this.options.keepOpen?.() === true,
    });
    let stateDir: string | undefined;
    try {
      stateDir = await mkdtemp(path.join(tmpdir(), "bao-proxy-"));
      const config = path.join(stateDir, "config.json");
      await writeFile(config, "{}", { mode: 0o600 });
      const endpoint = await readDevToolsActivePort(chrome.target.portFile);
      return {
        chrome, stateDir, executable, abort: new AbortController(), recording,
        flags: ["--session", "bao", "--config", config, "--cdp", `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`,
          "--idle-timeout", "0"],
        env: {
          HOME: stateDir, TMPDIR: stateDir, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
          AGENT_BROWSER_SOCKET_DIR: stateDir, AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0", BAO_HEAL_CURSOR_ACCOUNT: "0",
          ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        },
      };
    } catch (error) {
      if (stateDir) await rm(stateDir, { recursive: true, force: true });
      await chrome.close();
      throw error;
    }
  }

  private ownerResult(kind: "halted" | "waiting" | "ready" | "closed"): AgentBrowserCommandResult[] {
    return [{ stdout: JSON.stringify({ outcome: kind, instruction: kind === "ready" ? "The page left the sign-in/check state. Take a fresh snapshot and continue in this same session. This is not proof of authentication." : kind === "closed" ? "The owner closed the Bao window. Report that this session cannot continue." : OWNER_WAIT_INSTRUCTION }), stderr: "", exitCode: 0 }];
  }

  private async activePage(session: Session): Promise<{ targetId: string; page: OwnerPage } | undefined> {
    const signal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(5000)]);
    const tabs = await this.run(session, "tab", ["list", "--json"], signal);
    const parsed = JSON.parse(tabs.stdout) as { data?: { tabs?: { active?: boolean; targetId?: string }[] } };
    const active = parsed.data?.tabs?.find((tab) => tab.active);
    if (!active?.targetId) return undefined;
    // Native tab titles can be URL-derived labels. Read the real title from Chrome, not that label.
    const endpoint = await readDevToolsActivePort(session.chrome.target.portFile);
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 2000, signal });
    try {
      const { targetInfo } = await cdp.send<{ targetInfo: { url: string; title: string } }>("Target.getTargetInfo", { targetId: active.targetId }, undefined, 2000);
      return { targetId: active.targetId, page: { url: targetInfo.url, title: targetInfo.title } };
    } finally { cdp.close(); }
  }

  private async detectOwnerWall(session: Session): Promise<void> {
    if (session.ownerWait) return;
    const active = await this.activePage(session);
    if (!active) throw new Error("no active Bao page metadata");
    if (!ownerWall(active.page)) return;
    session.ownerWait = active;
    session.recording.ownerWaiting(true);
    await this.ownerBanner(session, active.targetId, true);
  }

  /** Writes only Bao's status banner. Never reads the form, page text, or field values. */
  private async ownerBanner(session: Session, targetId: string, waiting: boolean): Promise<void> {
    const endpoint = await readDevToolsActivePort(session.chrome.target.portFile);
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 2000, signal: session.abort.signal });
    try {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 2000);
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
    } finally { cdp.close(); }
  }

  private ownerClosed(session: Session): AgentBrowserCommandResult[] {
    session.abort.abort();
    session.ownerWait = undefined;
    session.recording.finish("session_closed");
    return this.ownerResult("closed");
  }

  private async waitForOwner(session: Session, args: string[]): Promise<AgentBrowserCommandResult[]> {
    const deadline = Date.now() + ownerWaitTimeout(args[0] === undefined ? undefined : Number(args[0]));
    if (session.abort.signal.aborted) return this.ownerClosed(session);
    session.ownerWait ??= "pending";
    session.recording.ownerWaiting(true);
    let cdp: CdpSocket | undefined;
    const onAbort = () => cdp?.close();
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
            await this.ownerBanner(session, active.targetId, true);
          }
          const waiting = session.ownerWait;
          if (!cdp) {
            const endpoint = await readDevToolsActivePort(session.chrome.target.portFile);
            cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 2000, signal: session.abort.signal });
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
      cdp?.close();
    }
  }

  private async captureTarget(session: Session, step: RecordedAgentBrowserCommand, target: string): Promise<void> {
    try {
      const signal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(3000)]);
      const result = await this.run(session, "get", ["box", target, "--json"], signal);
      if (result.exitCode !== 0) return;
      const { data } = JSON.parse(result.stdout) as { data?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } };
      if (!data) return;
      const { x, y, width, height } = data;
      if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number"
          || ![x, y, width, height].every(Number.isFinite)) return;
      const rect = { x, y, width, height };
      const frame = await this.screenshot(session, step.native.command, true);
      if (!frame.viewport || rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0
          || rect.x + rect.width > frame.viewport.width || rect.y + rect.height > frame.viewport.height) return;
      await session.recording.actionPicture(step, frame.bytes, { rect, viewport: frame.viewport });
    } catch {
      // Missing action evidence must not change the native command.
    }
  }

  private async screenshot(session: Session, command: string, visual = false): Promise<{ bytes: Buffer; viewport?: { width: number; height: number } }> {
    if (command === "close" || this.disconnected || session.abort.signal.aborted) throw new Error("page closed");
    await this.detectOwnerWall(session);
    if (session.ownerWait) throw new Error("owner input is private");
    const signal = AbortSignal.any([session.abort.signal, AbortSignal.timeout(3000)]);
    let cdp: CdpSocket | undefined;
    const close = () => cdp?.close();
    signal.addEventListener("abort", close, { once: true });
    try {
      const tabs = await this.run(session, "tab", ["list", "--json"], signal);
      const parsed = JSON.parse(tabs.stdout) as { data?: { tabs?: { active?: boolean; targetId?: string }[] } };
      const targetId = parsed.data?.tabs?.find((tab) => tab.active)?.targetId;
      if (!targetId) throw new Error("no active page");
      const endpoint = await readDevToolsActivePort(session.chrome.target.portFile);
      cdp = await connectCdp(endpoint.port, endpoint.browserPath, { signal, timeoutMs: 3000 });
      if (signal.aborted) throw new Error("screenshot timed out");
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 3000);
      const metrics = visual ? await cdp.send<{ cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }>("Page.getLayoutMetrics", {}, sessionId, 3000) : undefined;
      const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", metrics ? { format: "jpeg", quality: 75, clip: { x: metrics.cssLayoutViewport.pageX, y: metrics.cssLayoutViewport.pageY, width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight, scale: 1 } } : { format: "png" }, sessionId, 3000);
      return { bytes: Buffer.from(data, "base64"), viewport: metrics ? { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight } : undefined };
    } finally {
      signal.removeEventListener("abort", close);
      cdp?.close();
    }
  }

  private run(session: Session, command: string, args: string[], signal = session.abort.signal): Promise<AgentBrowserCommandResult> {
    if (this.disconnected) return Promise.reject(new Error("agent-browser client disconnected"));
    return new Promise((resolve, reject) => {
      execFile(session.executable, [...session.flags, command, ...args], {
        cwd: session.stateDir, env: session.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") { reject(error); return; }
        resolve({ stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : 0 });
      });
    });
  }

  private async remove(session: Session, keepOpen = false): Promise<void> {
    await (session.removing ??= (async () => {
      session.abort.abort();
      await session.commandDone;
      session.recording.finish();
      try {
        const pid = Number((await readFile(path.join(session.stateDir, "bao.pid"), "utf8")).trim());
        if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) process.kill(pid, "SIGTERM");
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      } finally {
        if (keepOpen && !session.closing && this.pendingCloses === 0 && !session.chrome.isClosed()) await session.chrome.keepOpen();
        else await session.chrome.close();
        await rm(session.stateDir, { recursive: true, force: true });
      }
    })());
    if ((session.closing || this.pendingCloses > 0) && !session.chrome.isClosed()) {
      session.closing = true;
      await session.chrome.close();
    }
    if (this.session === session && session.chrome.isClosed()) this.session = undefined;
  }
}
