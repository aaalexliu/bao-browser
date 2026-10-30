// bao agent config claude|codex: the bao MCP entry for an agent, pointing at the bao-mcp
// launcher inside Bao.app, with bao's tools pre-approved so the agent runs them without asking.
// It prints the entry. Only --write changes the agent's own config.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { baoUserHome } from "../home";
import { shellWord } from "../mcp/live-proxy";
import { DEFAULT_APP, mcpLauncher } from "./bundle";
import { allowBaoTools, CLAUDE_BAO_RULE, ClaudeSettingsError } from "./claude-settings";
import { codexServerBlock, upsertCodexServer } from "./codex-config";

export const AGENT_USAGE = "usage: bao agent config claude|codex [--write] [--app /Applications/Bao.app]";

const AGENTS = ["claude", "codex"] as const;
type Agent = (typeof AGENTS)[number];

export interface AgentIo {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
}

interface Request {
  agent: Agent;
  write: boolean;
  launcher: string;
}

/**
 * The claude arguments that add bao to Claude Code's user config. There is no timeout entry:
 * Claude Code 2.1.308 waits up to 100,000,000 ms for an MCP tool call, and 30 minutes for a
 * silent stdio server, so the Allow press fits already. A per-server timeout would only shorten that.
 */
export function claudeAddArgs(launcher: string): string[] {
  return ["mcp", "add", "--scope", "user", "bao", "--", launcher];
}

/** Claude Code's user settings: $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json. */
export function claudeSettingsFile(env: NodeJS.ProcessEnv): string {
  const home = env.CLAUDE_CONFIG_DIR || path.join(baoUserHome(env), ".claude");
  return path.join(home, "settings.json");
}

/** The config.toml Codex reads: $CODEX_HOME/config.toml, else ~/.codex/config.toml. */
export function codexConfigFile(env: NodeJS.ProcessEnv): string {
  const home = env.CODEX_HOME || path.join(baoUserHome(env), ".codex");
  return path.join(home, "config.toml");
}

export function agentMain(argv: readonly string[], io: AgentIo = defaultIo()): number {
  let request: Request;
  try {
    request = parse(argv);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n${AGENT_USAGE}\n`);
    return 1;
  }
  const ready = isExecutable(request.launcher);
  const entry = request.agent === "claude" ? claudeEntry(request.launcher, io.env) : codexServerBlock(request.launcher);
  if (!request.write) {
    io.out(entry);
    if (!ready) io.err(`${missing(request.launcher)}\n`);
    return 0;
  }
  if (!ready) {
    io.err(`${missing(request.launcher)} Nothing was written.\n`);
    return 1;
  }
  return request.agent === "claude" ? writeClaude(request, entry, io) : writeCodex(request, entry, io);
}

function parse(argv: readonly string[]): Request {
  const [sub, agent, ...rest] = argv;
  if (sub !== "config") throw new Error(sub ? `unknown agent command: ${sub}` : "missing agent command");
  if (!AGENTS.includes(agent as Agent)) throw new Error(agent ? `unknown agent: ${agent}` : "missing agent: claude or codex");
  let write = false;
  let app: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--write") write = true;
    else if (arg === "--app") {
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--app needs a path");
      app = value;
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  const bundle = app ? path.resolve(app) : DEFAULT_APP;
  return { agent: agent as Agent, write, launcher: mcpLauncher(bundle) };
}

function claudeEntry(launcher: string, env: NodeJS.ProcessEnv): string {
  const add = ["claude", ...claudeAddArgs(launcher)].map(shellWord).join(" ");
  return `${add}\n# Then add "${CLAUDE_BAO_RULE}" to permissions.allow in ${claudeSettingsFile(env)}\n`;
}

function writeClaude(request: Request, entry: string, io: AgentIo): number {
  // Read the settings before the MCP entry changes, so settings bao cannot edit leave both alone.
  const file = claudeSettingsFile(io.env);
  let before: string;
  let after: string;
  try {
    before = existsSync(file) ? readFileSync(file, "utf8") : "";
    after = allowBaoTools(before);
  } catch (err) {
    const why = err instanceof ClaudeSettingsError ? ` ${err.message}` : `: ${message(err)}`;
    io.err(`${file}${why}. Nothing was written. Run this yourself:\n${entry}`);
    return 1;
  }
  // claude mcp add refuses a name that is taken. A failed remove only means there was no user entry.
  const removed = spawnSync("claude", ["mcp", "remove", "--scope", "user", "bao"], { env: io.env, encoding: "utf8" });
  if (removed.error) {
    const why = (removed.error as NodeJS.ErrnoException).code === "ENOENT" ? "claude is not on PATH." : removed.error.message;
    io.err(`${why} Nothing was written. Run this yourself:\n${entry}`);
    return 1;
  }
  const added = spawnSync("claude", claudeAddArgs(request.launcher), { env: io.env, encoding: "utf8" });
  if (added.stdout) io.out(added.stdout);
  if (added.stderr) io.err(added.stderr);
  if (added.error || added.status !== 0) {
    const lost = removed.status === 0 ? " The earlier bao entry was removed, so Claude Code has no bao server now." : "";
    io.err(`claude mcp add failed.${lost} Run this yourself:\n${entry}`);
    return 1;
  }
  if (removed.status === 0) io.out("Replaced the earlier bao entry in Claude Code's user config.\n");
  if (after === before) {
    io.out(`${file} already allows ${CLAUDE_BAO_RULE}.\n`);
    return 0;
  }
  try {
    writeConfig(file, after);
  } catch (err) {
    io.err(`${file}: ${message(err)}. Claude Code has the bao server but will ask before each bao tool. Add "${CLAUDE_BAO_RULE}" to permissions.allow there by hand.\n`);
    return 1;
  }
  io.out(`Added ${CLAUDE_BAO_RULE} to permissions.allow in ${file}, so Claude Code runs bao's tools without asking.\n`);
  return 0;
}

function writeCodex(request: Request, entry: string, io: AgentIo): number {
  const file = codexConfigFile(io.env);
  let changed = false;
  try {
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const after = upsertCodexServer(before, request.launcher);
    changed = after !== before;
    if (changed) writeConfig(file, after);
  } catch (err) {
    io.err(`${file}: ${message(err)}. Nothing was written. Put this table in by hand:\n${entry}`);
    return 1;
  }
  io.out(changed ? `Wrote this table to ${file}:\n${entry}` : `${file} already has this bao entry. Nothing changed.\n`);
  return 0;
}

/** Replaces file whole, through a temp file. A linked file, such as one a dotfiles manager owns, keeps its link. The write goes to the file it names. */
function writeConfig(file: string, text: string): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.bao-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: existsSync(target) ? statSync(target).mode & 0o777 : 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function missing(launcher: string): string {
  return `${launcher} is missing. Install a Bao.app built with bao-mcp (docs/mac-build.md), or pass --app with the Bao.app to use.`;
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultIo(): AgentIo {
  return {
    env: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}
