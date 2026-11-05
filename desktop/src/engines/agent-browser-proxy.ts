import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";
import { AgentBrowserRun } from "./agent-browser-record";
import { agentBrowserExecutable } from "./agent-browser";
import { chromeProfilesRoot, openCopiedChromeForProxy } from "./chrome-profile-copy";

export const AGENT_BROWSER_COMMANDS = ["open", "snapshot", "click", "fill", "press", "scroll", "tab", "screenshot", "close"] as const;
export type AgentBrowserCommand = typeof AGENT_BROWSER_COMMANDS[number];
export interface AgentBrowserCommandResult { stdout: string; stderr: string; exitCode: number }

const FIXED_OPTIONS = new Set([
  "--session", "--namespace", "--profile", "--executable-path", "--headed", "--cdp", "--auto-connect",
  "--provider", "-p", "--engine", "--config", "--args", "--idle-timeout", "--all",
]);

interface Session {
  chrome: Awaited<ReturnType<typeof openCopiedChromeForProxy>>;
  stateDir: string;
  executable: string;
  flags: string[];
  env: NodeJS.ProcessEnv;
  abort: AbortController;
  recording: AgentBrowserRun;
  commandDone?: Promise<void>;
  closing?: boolean;
  removing?: Promise<void>;
}

export class AgentBrowserProxy {
  private session: Session | undefined;
  private disconnected = false;

  constructor(private readonly options: { home: string; sourceRoot?: string; directory?: string; executable?: string }) {}

  async execute(command: unknown, args: unknown = []): Promise<AgentBrowserCommandResult[]> {
    if (!AGENT_BROWSER_COMMANDS.includes(command as AgentBrowserCommand)) throw new Error("unknown agent-browser command");
    if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) {
      throw new Error("agent-browser args must be an array of strings");
    }
    if (args.some((arg) => FIXED_OPTIONS.has(arg.split("=", 1)[0]!))) {
      throw new Error("Bao fixes the agent-browser session, browser, headed mode, profile, and lifetime");
    }
    if (this.session?.removing) await this.session.removing;
    if (this.disconnected) throw new Error("agent-browser client disconnected");
    if (!this.session && command !== "open") throw new Error("start agent-browser with open before sending commands");
    const recording = this.session?.recording ?? new AgentBrowserRun(this.options.home);
    const step = recording.begin(command as string, args);
    if (!this.session) {
      try {
        const session = await this.start(recording);
        this.session = session;
        void session.chrome.closed.then(() => session.closing ? undefined : this.remove(session)).catch(() => undefined);
      } catch (error) {
        await recording.complete(step, [], this.options.home, async () => { throw error; }, error);
        recording.finish();
        throw error;
      }
    }
    const session = this.session;
    if (command === "close") session.closing = true;
    let commandDone!: () => void;
    session.commandDone = new Promise<void>((resolve) => { commandDone = resolve; });
    const results: AgentBrowserCommandResult[] = [];
    let failure: unknown;
    try {
      results.push(await this.run(session, command as string, args));
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
        await session.recording.complete(step, results, session.stateDir, () => this.screenshot(session, command as string), failure);
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

  async close(): Promise<void> {
    if (!this.session) return;
    if (this.disconnected || this.session.removing) {
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

  private async screenshot(session: Session, command: string): Promise<Buffer> {
    if (command === "close" || this.disconnected || session.abort.signal.aborted) throw new Error("page closed");
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
      const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId, 3000);
      return Buffer.from(data, "base64");
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

  private remove(session: Session): Promise<void> {
    return session.removing ??= (async () => {
      session.abort.abort();
      await session.commandDone;
      session.recording.finish();
      try {
        const pid = Number((await readFile(path.join(session.stateDir, "bao.pid"), "utf8")).trim());
        if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) process.kill(pid, "SIGTERM");
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      } finally {
        await session.chrome.close();
        await rm(session.stateDir, { recursive: true, force: true });
        if (this.session === session) this.session = undefined;
      }
    })();
  }
}
