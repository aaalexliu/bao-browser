import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

export type PageEngineName = "old" | "agent-browser";

/** Read once when a run starts. An invalid choice never selects another engine. */
export function pageEngineName(value?: string): PageEngineName {
  if (!value || value === "old") return "old";
  if (value === "agent-browser") return value;
  throw new Error("page engine must be old or agent-browser");
}

export interface AgentBrowserOptions {
  endpoint: string;
  targetId: string;
  /** Bao's record, not upstream's browserLaunched response. Cleanup stays with this owner. */
  ownership: "bao-launched" | "external";
  executable?: string;
  commandMs?: number;
  idleMs?: number;
  lifetimeMs?: number;
}

type Data = Record<string, unknown>;
const MAX_OUTPUT = 16 * 1024 * 1024;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

export type EvaluationPhase = "page" | "startup";

type StopCause = "deadline" | "socket-error" | "socket-ended" | "output-limit" | "invalid-json" | "response-shape"
  | "response-id" | "dialog" | "tab-gone" | "renderer-revived" | "warning" | "browser-relaunch" | "action-result";

export class EngineUncertain extends Error {
  constructor(action = "command", cause: StopCause = "response-shape") {
    super(`agent-browser ${action} outcome uncertain (${cause}); run stopped; do not retry the action`);
  }
}

/** One native process, private Unix socket, fixed browser and tab. Never respawns or retries. */
export class AgentBrowserPage {
  private child: ChildProcess | undefined;
  private stopped = false;
  private stopReason = "closed";
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private sequence = 0;
  private constructor(readonly options: AgentBrowserOptions, readonly stateDir: string) {}

  static async open(options: AgentBrowserOptions): Promise<AgentBrowserPage> {
    for (const [name, value, max] of [["commandMs", options.commandMs, 30_000], ["idleMs", options.idleMs, 10 * 60_000], ["lifetimeMs", options.lifetimeMs, 2 * 60 * 60_000]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 1 || value > max)) throw new Error(`invalid agent-browser ${name}`);
    }
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || !/^\/devtools\/browser\/[\w-]+$/.test(endpoint.pathname)
      || endpoint.search || endpoint.hash || !/^[a-fA-F0-9]+$/.test(options.targetId)) {
      throw new Error("agent-browser requires an exact loopback browser endpoint and target");
    }
    if (process.platform === "win32") throw new Error("agent-browser trial requires Unix sockets");
    const executable = options.executable || process.env.BAO_AGENT_BROWSER
      || path.resolve(__dirname, "../../../agent-browser/agent-browser");
    if (!path.isAbsolute(executable) || !existsSync(executable)) throw new Error("pinned native agent-browser is missing; stage it before selecting this engine");
    try { accessSync(executable, constants.X_OK); }
    catch { throw new Error("pinned native agent-browser is not executable; stage it before selecting this engine"); }
    const stateDir = await mkdtemp("/tmp/bao-ab-");
    await chmod(stateDir, 0o700);
    const page = new AgentBrowserPage(options, stateDir);
    try {
      // Do not inherit keys, proxy/provider settings, config, PATH wrappers, or account homes.
      page.child = spawn(executable, [], {
        cwd: stateDir,
        env: {
          HOME: stateDir, TMPDIR: stateDir, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
          AGENT_BROWSER_DAEMON: "1", AGENT_BROWSER_SESSION: "bao",
          AGENT_BROWSER_SOCKET_DIR: stateDir, AGENT_BROWSER_CDP: options.endpoint,
          AGENT_BROWSER_EXECUTABLE_PATH: "/nonexistent/bao-no-browser-launch",
          AGENT_BROWSER_NO_WEBMCP: "1", AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0",
          AGENT_BROWSER_DEFAULT_TIMEOUT: "8000", AGENT_BROWSER_IDLE_TIMEOUT_MS: String(2 * 60 * 60_000),
          BAO_HEAL_CURSOR_ACCOUNT: "0",
        },
        // Raw engine output can contain typed text. Report only safe process status.
        stdio: "ignore",
      });
      page.child.on("error", (error: NodeJS.ErrnoException) => { page.stopped = true; page.stopReason = `spawn ${error.code || "error"}`; });
      page.child.on("exit", (code, signal) => { if (!page.stopped) page.stopReason = `exit ${code} signal ${signal}`; page.stopped = true; });
      page.timer = setTimeout(() => { page.stopReason = "lifetime exceeded"; page.stopped = true; page.child?.kill("SIGKILL"); }, options.lifetimeMs ?? 2 * 60 * 60_000);
      page.timer.unref();
      const deadline = Date.now() + 5_000;
      while (!existsSync(page.socketPath) && !page.stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      if (!existsSync(page.socketPath)) throw new Error(`agent-browser socket unavailable: ${page.stopped ? page.stopReason : "startup deadline exceeded"}`);
      await page.request("launch", { cdpUrl: options.endpoint, noWebmcp: true });
      await page.request("tab_switch", { tabId: options.targetId, pinTab: true });
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  private get socketPath(): string { return path.join(this.stateDir, "bao.sock"); }

  touch(): void {
    clearTimeout(this.idleTimer);
    if (this.stopped) return;
    this.idleTimer = setTimeout(() => {
      this.stopReason = "idle timeout";
      this.stopped = true;
      this.child?.kill("SIGKILL");
    }, this.options.idleMs ?? 10 * 60_000);
    this.idleTimer.unref();
  }

  private async request(action: string, fields: Data = {}, deadlineMs?: number): Promise<Data> {
    if (this.stopped) throw new Error(`agent-browser run stopped: ${this.stopReason}`);
    if (this.busy) throw new Error(`agent-browser concurrent ${action} command refused`);
    this.busy = true;
    this.touch();
    const id = String(++this.sequence);
    try {
      return await new Promise<Data>((resolve, reject) => {
        const socket = createConnection(this.socketPath);
        let bytes = Buffer.alloc(0);
        let finished = false;
        const finish = (error?: Error, data?: Data) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          socket.destroy();
          if (error) reject(error); else resolve(data!);
        };
        const uncertain = (cause: StopCause) => {
          if (finished) return;
          this.stopReason = `uncertain ${action} (${cause})`;
          this.stopped = true;
          this.child?.kill("SIGKILL");
          finish(new EngineUncertain(action, cause));
        };
        // Native navigation waits up to 25 seconds even when its general wait env is shorter.
        const timer = setTimeout(() => uncertain("deadline"), this.options.commandMs ?? deadlineMs ?? (action === "navigate" ? 30_000 : 12_000));
        socket.once("error", () => uncertain("socket-error"));
        socket.once("end", () => { if (!finished) uncertain("socket-ended"); });
        socket.once("connect", () => socket.write(JSON.stringify({ ...fields, id, action }) + "\n"));
        socket.on("data", (chunk) => {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > MAX_OUTPUT) return uncertain("output-limit");
          const newline = bytes.indexOf(10);
          if (newline < 0) return;
          try {
            const reply: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
            if (!reply || typeof reply !== "object") return uncertain("response-shape");
            const value = reply as Data;
            if (value.id !== id) return uncertain("response-id");
            if (typeof value.success !== "boolean") return uncertain("response-shape");
            if (!value.success) {
              // Upstream errors can echo page text or typed values. Never include them in Bao logs.
              this.stopped = true;
              this.stopReason = `${action} failed`;
              this.child?.kill("SIGKILL");
              return finish(new Error(`agent-browser ${action} failed; run stopped (no retry)`));
            }
            if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) return uncertain("response-shape");
            const data = value.data as Data;
            const lifecycle = data.lifecycle as Data | undefined;
            if (data.dialogOpened === true || data.dialogBlocked === true) return uncertain("dialog");
            if (data.tabGone === true) return uncertain("tab-gone");
            if (data.revived === true) return uncertain("renderer-revived");
            if (value.warnings) return uncertain("warning");
            if (action !== "launch" && (lifecycle?.launched === true || lifecycle?.relaunchedBrowser === true)) return uncertain("browser-relaunch");
            const expected: Record<string, string> = { click: "clicked", press: "pressed", screenshot: "path" };
            const field = expected[action];
            if ((action === "tab_switch" && data.targetId !== this.options.targetId)
              || (field && typeof data[field] !== "string")
              || (action === "evaluate" && !("result" in data))
              || (action === "keyboard" && data.inserted !== true)) return uncertain("action-result");
            finish(undefined, data);
          } catch { uncertain("invalid-json"); }
        });
      });
    } finally { this.busy = false; this.touch(); }
  }

  async evaluate<T>(script: string, phase: EvaluationPhase = "page"): Promise<T> {
    // Upstream CDP waits 30 seconds; allow five more for its response during startup.
    const data = await this.request("evaluate", { script }, phase === "startup" ? 35_000 : undefined);
    return data.result as T;
  }

  private async unique(selector?: string): Promise<void> {
    const result = await this.evaluate<{ count: number; credential: boolean }>(`(() => {
      const all = (root, selector) => [...root.querySelectorAll(selector), ...[...root.querySelectorAll('*')].flatMap(el => el.shadowRoot ? all(el.shadowRoot, selector) : [])];
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      const nodes = ${selector === undefined ? "[active].filter(Boolean)" : `all(document, ${JSON.stringify(selector)})`};
      const el = nodes[0];
      const credential = el && (el.type === 'password' || /username|current-password|new-password|one-time-code|cc-number|cc-csc/.test(el.autocomplete || ''));
      return { count: nodes.length, credential: !!credential };
    })()`);
    if (!result || typeof result.count !== "number" || typeof result.credential !== "boolean") {
      this.stopped = true;
      this.child?.kill("SIGKILL");
      throw new EngineUncertain();
    }
    if (result.count !== 1) throw new Error("agent-browser requires one unique live element");
    if (result.credential) throw new Error("agent-browser trial refuses credential fields");
  }

  async click(selector: string): Promise<void> { await this.unique(selector); await this.request("click", { selector }); }
  async insertText(value: string): Promise<void> { await this.unique(); await this.request("keyboard", { subaction: "insertText", text: value }); }
  async key(key: string): Promise<void> { await this.unique(); await this.request("press", { key }); }
  async goto(url: string): Promise<void> { await this.request("navigate", { url, waitUntil: "domcontentloaded" }); }

  async screenshot(): Promise<Buffer> {
    const file = path.join(this.stateDir, `page-${randomUUID()}.png`);
    const data = await this.request("screenshot", { path: file, format: "png" });
    if (data.path !== file) throw new Error("agent-browser screenshot path mismatch");
    try {
      const png = await readFile(file);
      if (!png.subarray(0, 8).equals(PNG)) throw new Error("agent-browser screenshot is not PNG");
      return png;
    } finally { await rm(file, { force: true }); }
  }

  /** Disconnect by ending only our child. Never send close/Browser.close, even for owned Chrome. */
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.idleTimer);
    const child = this.child;
    if (child?.pid && child.exitCode == null && child.signalCode == null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("agent-browser did not exit after SIGKILL")), 2000); })]);
      } finally { clearTimeout(timer); }
    }
    await rm(this.stateDir, { recursive: true, force: true });
  }
}
