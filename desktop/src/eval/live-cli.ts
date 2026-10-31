// Start a logged-in CLI against the fixture MCP server, or against the product `bao mcp`
// for the agent lane. No login command, no --dangerously-* flag, no edit of ~/.codex/config.toml.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { CODEX_TOOL_TIMEOUT_SEC } from "../app/codex-config";
import { pinTestBrowser } from "../launch";
import type { DriverTask } from "./tasks";

export type LiveDriver = "claude" | "codex" | "cursor";

export interface LiveCliResult {
  code: number | null;
  tokens: string;
  timedOut: boolean;
  stderr: string;
  stdout: string;
}

const TIMEOUT_MS = 180_000;

export function taskPrompt(task: DriverTask, uploadPath: string): string {
  const lines = [
    "The bao MCP server already has the fixture page open.",
    "Use only the bao tools named snapshot, screenshot, click, type, key, scroll, and upload.",
    "Do not use a shell, a browser, the web, or any other tool.",
    "Start by calling snapshot. Click with x and y at the center of a box, or pass ref as the element id.",
    "Click a text field before type. Use upload for a file input.",
    `Task: ${task.title}.`,
  ];
  if (task.captureTexts.length) lines.push(`Text to type, in order: ${task.captureTexts.join(" | ")}.`);
  if (uploadPath) lines.push(`Upload this file to input id file: ${uploadPath}`);
  if (task.id === "form-file") lines.push('Click Noop by sending click with ref "noop", then click Save. Stop when status is Saved.');
  if (task.id === "tabs") lines.push("Open Address, type the city, open Review, then click Finish. Stop when status is Done.");
  if (task.id === "login") lines.push(`Type the username. Then attempt this fixture password in the password field: ${task.captureSecret || ""}. A STOP login records the sign-in step. Stop when a tool returns STOP login.`);
  if (task.id === "confirm") lines.push("Type the note, click Delete, then click Confirm. If a tool returns STOP confirm, stop. Status should stay Armed.");
  if (task.id === "drift") lines.push("Type the note and click Save. Stop when status is Saved.");
  if (task.id === "dialog") lines.push("Click Browse, type the file name, then click Open. Stop when status is Chosen.");
  if (task.id === "scroll") lines.push("Type the filter. Scroll the list until the button Row 30 is visible, then click it. Stop when status is Picked.");
  if (task.id === "choice") lines.push("Select Blue, type the label, then click Apply. Stop when status is Applied.");
  lines.push("Call snapshot once more, then finish.");
  return lines.join("\n");
}

export function driverBinary(name: LiveDriver): string | null {
  const fallbacks: Record<LiveDriver, string[]> = {
    // Claude Code's own installer puts its launcher in ~/.local/bin. It goes before the Homebrew
    // cask, whose quarantined binary Gatekeeper can hold at launch with no error.
    claude: [path.join(userInfo().homedir, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
    codex: ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"],
    cursor: ["/opt/homebrew/bin/cursor-agent", "/usr/local/bin/cursor-agent"],
  };
  return fallbacks[name].find((file) => existsSync(file)) || null;
}

export function unavailableReason(name: LiveDriver): string {
  if (name === "claude") return "not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed";
  if (name === "codex") return "not run: codex CLI is not on PATH and it is not logged in";
  return "not run: cursor-agent CLI is not on PATH";
}

export async function runLiveCli(opts: {
  driver: LiveDriver;
  bin: string;
  home: string;
  fixtureUrl: string;
  prompt: string;
}): Promise<LiveCliResult> {
  const cli = path.join(__dirname, "../app/cli.js");
  const node = process.execPath;
  const env = liveMcpServerEnv(opts.home, opts.fixtureUrl);
  const run = () => {
    if (opts.driver === "claude") return runClaude(opts.bin, cli, node, opts.home, env, opts.prompt);
    if (opts.driver === "codex") return runCodex(opts.bin, cli, node, opts.home, env, opts.prompt);
    return runCursor(opts.bin, cli, node, opts.home, env, opts.prompt);
  };
  return withRateLimitRetry(run);
}

/** The evaluator server's env. It starts the test browser with a mock keychain, never the user's Chrome. */
export function liveMcpServerEnv(home: string, fixtureUrl: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    BAO_MCP_LIVE: "1",
    BAO_HOME: home,
    BAO_FIXTURE_URL: fixtureUrl,
    BAO_HEADED: "0",
    BAO_TEST_BROWSER: pinTestBrowser(parent),
  };
}

export function isRateLimited(result: Pick<LiveCliResult, "stdout" | "stderr">): boolean {
  const blob = `${result.stdout}\n${result.stderr}`;
  return /(?:\b429\b|Too Many Requests|rate limit)/i.test(blob);
}

/** A driver crash. A finished task is graded as bao, so this stays empty when the page completed. */
export function liveCrashReason(result: Pick<LiveCliResult, "code" | "timedOut" | "stdout" | "stderr">): string | null {
  if (result.timedOut) return "timed out";
  if (isRateLimited(result)) return "HTTP 429";
  if (result.code !== 0 && result.code !== null) return `cli exit ${result.code}`;
  return null;
}

/** A crash still leaves trail.jsonl, including a driver-error line when the process wrote nothing. */
export function ensurePartialTrail(home: string, reason: string): void {
  mkdirSync(home, { recursive: true });
  const file = path.join(home, "trail.jsonl");
  if (!existsSync(file) || readFileSync(file, "utf8").trim() === "") {
    writeFileSync(file, JSON.stringify({
      id: "e0",
      ts: Date.now(),
      kind: "read",
      op: "driver-error",
      note: reason,
    }) + "\n");
  }
}

export async function withRateLimitRetry(
  run: () => Promise<LiveCliResult>,
  opts: { waitsMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LiveCliResult> {
  const waits = opts.waitsMs ?? [45_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let result = await run();
  for (const waitMs of waits) {
    if (result.timedOut || result.code === 0 || !isRateLimited(result)) return result;
    await sleep(waitMs);
    result = await run();
  }
  return result;
}

function runClaude(bin: string, cli: string, node: string, home: string, env: Record<string, string>, prompt: string): Promise<LiveCliResult> {
  const mcp = path.join(home, "mcp.json");
  writeFileSync(mcp, JSON.stringify({
    mcpServers: { bao: { command: node, args: [cli, "mcp"], env } },
  }));
  return spawnCli(bin, [
    "-p",
    "--output-format", "json",
    "--strict-mcp-config",
    "--mcp-config", mcp,
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--allowedTools", "mcp__bao__*",
    "--restricted",
    "--max-budget-usd", "1",
  ], prompt, driverProcessEnv());
}

function runCodex(bin: string, cli: string, node: string, home: string, env: Record<string, string>, prompt: string): Promise<LiveCliResult> {
  const config = [
    configPair("mcp_servers.bao.command", node),
    configPair("mcp_servers.bao.args", JSON.stringify([cli, "mcp"]), true),
    ...Object.entries(env).map(([key, value]) => configPair(`mcp_servers.bao.env.${key}`, value)),
  ].flat();
  return spawnCli(bin, [
    "exec",
    "--approve-for-me",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-C", home,
    "--add-dir", home,
    ...config,
    "-",
  ], prompt, driverProcessEnv());
}

function runCursor(bin: string, cli: string, node: string, home: string, env: Record<string, string>, prompt: string): Promise<LiveCliResult> {
  const workspace = path.join(home, "workspace");
  mkdirSync(path.join(workspace, ".cursor"), { recursive: true });
  writeFileSync(path.join(workspace, ".cursor", "mcp.json"), JSON.stringify({
    mcpServers: { bao: { command: node, args: [cli, "mcp"], env } },
  }));
  writeFileSync(path.join(workspace, ".cursor", "cli.json"), JSON.stringify({
    permissions: { allow: ["Mcp(bao:*)"], deny: [] },
  }));
  return spawnCli(bin, [
    "-p",
    "--output-format", "json",
    "--workspace", workspace,
    "--trust",
    "--approve-mcps",
    // enabled rejects the fixture MCP calls in this throwaway workspace.
    "--sandbox", "disabled",
    prompt,
  ], "", driverProcessEnv(), workspace);
}

/** The logged-in CLIs read credentials from the account home, not a temp HOME. */
export function driverProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.BAO_HEADED;
  const home = userInfo().homedir;
  if (home) env.HOME = home;
  if (typeof env.CODEX_HOME === "string" && /trail\.jsonl|bao-live-/.test(env.CODEX_HOME)) delete env.CODEX_HOME;
  // A file credential store hides the keychain login cursor-agent already has.
  delete env.AGENT_CLI_CREDENTIAL_STORE;
  return env;
}

function configPair(key: string, value: string, raw = false): string[] {
  return ["-c", `${key}=${raw ? value : JSON.stringify(value)}`];
}

/** The agent lane's drivers. Each drives the browser only through the product `bao mcp`. */
export type AgentDriver = "claude" | "codex";

/**
 * Codex features that give the model a way to act outside bao. Checked against codex-cli 0.164.0
 * with a stand-in model API that records the tools Codex sends. shell_tool removes exec_command
 * and write_stdin, also from code mode's nested tools, view_image removes view_image, goals removes
 * the goal tools, and multi_agent removes the sub-agent tools of a model without code mode. The
 * browser, computer use, apps, and plugins features add no tool to `codex exec` with a fresh
 * CODEX_HOME, and stay off in case a login or a later Codex adds one.
 * Codex refuses an unknown feature name, so a renamed feature fails the run instead of passing.
 */
export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "view_image",
  "goals",
  "multi_agent",
  "apps",
  "plugins",
] as const;

export interface BaoMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The agent's model, else the CLI's default, and Claude Code's spend cap, default 1 USD. */
export interface AgentRunOptions {
  model?: string;
  budgetUsd?: number;
}

/**
 * claude -p locked to bao: no built-in tool, no Claude in Chrome, only the --mcp-config server,
 * and only mcp__bao__* calls allowed with no prompt. --max-budget-usd caps one run.
 */
export function claudeAgentArgs(mcpConfig: string, opts: AgentRunOptions = {}): string[] {
  return [
    ...(opts.model ? ["--model", opts.model] : []),
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config", mcpConfig,
    "--tools", "",
    "--no-chrome",
    "--allowedTools", "mcp__bao__*",
    "--permission-mode", "dontAsk",
    "--max-budget-usd", String(opts.budgetUsd ?? 1),
  ];
}

export function claudeMcpConfig(server: BaoMcpServer): string {
  return JSON.stringify({ mcpServers: { bao: server } });
}

/**
 * codex exec locked to bao. It ignores config.toml and the rules files, turns off every feature
 * that acts outside bao, turns off web search, and runs read-only. bao is the only MCP server.
 * Its calls run with no approval prompt, which `codex exec` would otherwise refuse, and get the
 * tool timeout `bao agent config codex` writes. The prompt comes on stdin.
 */
export function codexAgentArgs(server: BaoMcpServer, workdir: string, opts: Pick<AgentRunOptions, "model"> = {}): string[] {
  const config: string[] = [
    configPair("web_search", "disabled"),
    configPair("mcp_servers.bao.command", server.command),
    configPair("mcp_servers.bao.args", JSON.stringify(server.args), true),
    ...Object.entries(server.env).map(([key, value]) => configPair(`mcp_servers.bao.env.${key}`, value)),
    configPair("mcp_servers.bao.tool_timeout_sec", String(CODEX_TOOL_TIMEOUT_SEC), true),
    configPair("mcp_servers.bao.default_tools_approval_mode", "approve"),
  ].flat();
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--sandbox", "read-only",
    "-C", workdir,
    ...(opts.model ? ["--model", opts.model] : []),
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    ...config,
    "-",
  ];
}

export interface AgentAuth {
  /** Env for the driver: its temp config dir and the credential it runs with. */
  env: NodeJS.ProcessEnv;
  /** Set when the driver cannot run. */
  missing?: string;
}

/**
 * Claude Code with a temp CLAUDE_CONFIG_DIR, so no user setting, CLAUDE.md, hook, plugin, or MCP
 * entry of this Mac reaches the run, and the run writes nothing to ~/.claude. A temp config dir
 * has no login, so the run takes the access token of the login in the macOS keychain, and no
 * Claude or Anthropic credential from this shell. The refresh token is never passed, so the run
 * cannot rotate that login.
 */
export function claudeAgentAuth(configDir: string, base: NodeJS.ProcessEnv = process.env, now = Date.now(), readLogin: () => string = keychainLogin): AgentAuth {
  const env = agentBaseEnv(base);
  env.CLAUDE_CONFIG_DIR = configDir;
  // No update check, telemetry, or error report from an eval run.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  mkdirSync(configDir, { recursive: true });
  let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
  try {
    oauth = (JSON.parse(readLogin()) as { claudeAiOauth?: typeof oauth }).claudeAiOauth;
  } catch {
    oauth = undefined;
  }
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) {
    return { env, missing: "not run: no Claude Code login in the keychain" };
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < now + 20 * 60_000) {
    return { env, missing: "not run: the Claude Code login expires within 20 minutes. Run claude once to refresh it" };
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = oauth.accessToken;
  return { env };
}

/** The Claude Code login in the macOS keychain, as the JSON Claude Code stores. Empty when there is none. */
function keychainLogin(): string {
  if (process.platform !== "darwin") return "";
  return spawnSync("security", ["find-generic-password", "-a", userInfo().username, "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 20_000 }).stdout || "";
}

/**
 * Codex with a temp CODEX_HOME, so no config.toml, AGENTS.md, hook, skill, plugin, or rule of
 * this Mac reaches the run, and the run writes nothing to ~/.codex. The login is copied from
 * $CODEX_HOME/auth.json, else ~/.codex/auth.json, with an empty refresh token, so the run cannot
 * rotate that login. Codex refreshes a ChatGPT login 8 days after its last refresh, so the run is
 * not started once the last refresh is 7 days old.
 */
export function codexAgentAuth(codexHome: string, base: NodeJS.ProcessEnv = process.env, now = Date.now()): AgentAuth {
  const env = agentBaseEnv(base);
  env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  const source = path.join(base.CODEX_HOME || path.join(userInfo().homedir, ".codex"), "auth.json");
  let auth: { auth_mode?: unknown; tokens?: Record<string, unknown> | null; last_refresh?: unknown } & Record<string, unknown>;
  try {
    auth = JSON.parse(readFileSync(source, "utf8")) as typeof auth;
  } catch {
    return { env, missing: `not run: no Codex login at ${source}` };
  }
  if (auth.tokens && typeof auth.tokens === "object") {
    const refreshed = typeof auth.last_refresh === "string" ? Date.parse(auth.last_refresh) : NaN;
    if (!Number.isFinite(refreshed) || refreshed < now - 7 * 24 * 60 * 60_000) {
      return { env, missing: "not run: the Codex login is due for a refresh. Run codex once to refresh it" };
    }
    auth = { ...auth, tokens: { ...auth.tokens, refresh_token: "" } };
  }
  writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  return { env };
}

/** The driver's env: the account's HOME and PATH, with no Bao, Claude, Codex, Anthropic, or OpenAI setting from this shell. */
function agentBaseEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = driverProcessEnv(base);
  for (const key of Object.keys(env)) {
    if (/^(?:bao|claude|codex|anthropic|openai)_/i.test(key)) delete env[key];
  }
  delete env.CI;
  delete env.CLAUDECODE;
  return env;
}

/** One agent run. stdout is the transcript: Claude's stream-json or Codex's JSONL events. */
export function runAgentCli(opts: {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  timeoutMs: number;
}): Promise<LiveCliResult> {
  return spawnCli(opts.bin, opts.args, opts.prompt, opts.env, opts.cwd, opts.timeoutMs);
}

function spawnCli(bin: string, args: string[], stdin: string, env: NodeJS.ProcessEnv, cwd?: string, timeoutMs = TIMEOUT_MS): Promise<LiveCliResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, tokens: "n/a", timedOut, stderr: `${stderr}\n${err.message}`, stdout });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, tokens: tokenCount(stdout), timedOut, stderr, stdout });
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export function tokenCount(text: string): string {
  let total = 0;
  let saw = false;
  const take = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const bag = value as Record<string, unknown>;
    const input = number(bag.input_tokens) || number(bag.inputTokens) || number(bag.prompt_tokens);
    const output = number(bag.output_tokens) || number(bag.outputTokens) || number(bag.completion_tokens);
    const all = number(bag.total_tokens);
    if (input || output) {
      total += input + output;
      saw = true;
      return;
    }
    if (all) {
      total += all;
      saw = true;
    }
  };
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const bag = value as Record<string, unknown>;
    if (bag.usage) take(bag.usage);
    if (bag.token_count || bag.tokens) take(bag.token_count || bag.tokens);
    take(bag);
    for (const key of ["message", "result", "info"]) visit(bag[key], depth + 1);
  };
  const whole = text.trim();
  if (whole.startsWith("{") || whole.startsWith("[")) {
    try { visit(JSON.parse(whole), 0); } catch { /* line-delimited below */ }
  }
  if (!saw) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try { visit(JSON.parse(trimmed), 0); } catch { /* ignore */ }
    }
  }
  return saw ? String(total) : "n/a";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
