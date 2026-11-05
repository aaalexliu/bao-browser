import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { agentBrowserExecutable } from "./agent-browser";
import { chromeProfilesRoot, openCopiedChrome } from "./chrome-profile-copy";

export const AGENT_BROWSER_COMMANDS = ["open", "snapshot", "click", "fill", "press", "scroll", "tab", "screenshot", "close"] as const;
export type AgentBrowserCommand = typeof AGENT_BROWSER_COMMANDS[number];
export interface AgentBrowserCommandResult { stdout: string; stderr: string; exitCode: number }

const FIXED_OPTIONS = new Set([
  "--session", "--namespace", "--profile", "--executable-path", "--headed", "--cdp", "--auto-connect",
  "--provider", "-p", "--engine", "--config", "--args", "--idle-timeout", "--all",
]);

interface Session {
  chrome: Awaited<ReturnType<typeof openCopiedChrome>>;
  stateDir: string;
  executable: string;
  flags: string[];
  env: NodeJS.ProcessEnv;
}

export class AgentBrowserProxy {
  private session: Session | undefined;

  constructor(private readonly options: { home: string; sourceRoot?: string; directory?: string; executable?: string }) {}

  // All forwarded commands and their raw results cross this boundary. Recording belongs here next.
  async execute(command: unknown, args: unknown = []): Promise<AgentBrowserCommandResult[]> {
    if (!AGENT_BROWSER_COMMANDS.includes(command as AgentBrowserCommand)) throw new Error("unknown agent-browser command");
    if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) {
      throw new Error("agent-browser args must be an array of strings");
    }
    if (args.some((arg) => FIXED_OPTIONS.has(arg.split("=", 1)[0]!))) {
      throw new Error("Bao fixes the agent-browser session, browser, headed mode, profile, and lifetime");
    }
    if (!this.session) {
      if (command !== "open") throw new Error("start agent-browser with open before sending commands");
      this.session = await this.start();
    }
    if (command === "close") {
      try { return [await this.run(this.session, "close", args)]; }
      finally { await this.remove(); }
    }
    const result = await this.run(this.session, command as string, args);
    if (command === "open" && result.exitCode === 0) {
      // Keep the native list intact, including stable tab ids and every restored tab on the site's host.
      return [result, await this.run(this.session!, "tab", ["list"])];
    }
    return [result];
  }

  async close(): Promise<void> {
    if (!this.session) return;
    const [result] = await this.execute("close");
    if (result!.exitCode !== 0) throw new Error("agent-browser close failed");
  }

  private async start(): Promise<Session> {
    const executable = agentBrowserExecutable(this.options.executable);
    if (process.env.BAO_TEST_BROWSER && !this.options.sourceRoot) throw new Error("tests must supply a throwaway Chrome profile source");
    const chrome = await openCopiedChrome({
      sourceRoot: this.options.sourceRoot ?? chromeProfilesRoot(), directory: this.options.directory || "Default", home: this.options.home,
      loadExtensions: true,
    });
    let stateDir: string | undefined;
    try {
      stateDir = await mkdtemp(path.join(tmpdir(), "bao-proxy-"));
      const config = path.join(stateDir, "config.json");
      await writeFile(config, "{}", { mode: 0o600 });
      const endpoint = await readDevToolsActivePort(chrome.target.portFile);
      return {
        chrome, stateDir, executable,
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

  private run(session: Session, command: string, args: string[]): Promise<AgentBrowserCommandResult> {
    return new Promise((resolve, reject) => {
      execFile(session.executable, [...session.flags, command, ...args], {
        cwd: session.stateDir, env: session.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") { reject(error); return; }
        resolve({ stdout, stderr, exitCode: typeof error?.code === "number" ? error.code : 0 });
      });
    });
  }

  private async remove(): Promise<void> {
    const session = this.session!;
    await session.chrome.close();
    await rm(session.stateDir, { recursive: true, force: true });
    this.session = undefined;
  }
}
