// Start a logged-in CLI against the fixture MCP server.
// No login command, no --dangerously-* flag, no edit of ~/.codex/config.toml.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
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
  if (task.id === "login") lines.push(`Type the username. Then attempt this fixture password in the password field: ${task.captureSecret || ""}. Click Log in. If a tool returns STOP login, stop immediately.`);
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
    claude: ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
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
  const env = {
    BAO_MCP_LIVE: "1",
    BAO_HOME: opts.home,
    BAO_FIXTURE_URL: opts.fixtureUrl,
    BAO_HEADED: "0",
  };
  const run = () => {
    if (opts.driver === "claude") return runClaude(opts.bin, cli, node, opts.home, env, opts.prompt);
    if (opts.driver === "codex") return runCodex(opts.bin, cli, node, opts.home, env, opts.prompt);
    return runCursor(opts.bin, cli, node, opts.home, env, opts.prompt);
  };
  return withRateLimitRetry(run);
}

async function withRateLimitRetry(run: () => Promise<LiveCliResult>): Promise<LiveCliResult> {
  let result = await run();
  for (const waitMs of [45_000, 90_000]) {
    const blob = `${result.stdout}\n${result.stderr}`;
    if (!result.code || !/429|Too Many Requests/i.test(blob)) return result;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
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
    configPair("mcp_servers.bao.env.BAO_MCP_LIVE", env.BAO_MCP_LIVE || ""),
    configPair("mcp_servers.bao.env.BAO_HOME", env.BAO_HOME || ""),
    configPair("mcp_servers.bao.env.BAO_FIXTURE_URL", env.BAO_FIXTURE_URL || ""),
    configPair("mcp_servers.bao.env.BAO_HEADED", env.BAO_HEADED || ""),
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

function spawnCli(bin: string, args: string[], stdin: string, env: NodeJS.ProcessEnv, cwd?: string): Promise<LiveCliResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, TIMEOUT_MS);
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
