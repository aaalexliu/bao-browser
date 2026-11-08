// bao setup: find the coding agents and desktop apps on this Mac, let the owner pick which ones
// start Bao, and write each pick through the writers `bao agent config` and Settings already use.
// The one-command installer runs it through Contents/MacOS/bao-cli right after it places Bao.app.

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { baoUserHome } from "../home";
import { agentMain, codexConfigFile, writeConfig, type AgentIo } from "./agent-config";
import { appBundleOf, DEFAULT_APP, mcpLauncher } from "./bundle";
import { DesktopMcpInstaller, desktopMcpFile, editClaude } from "./desktop-mcp-config";

export const SETUP_USAGE = "usage: bao setup [--app /Applications/Bao.app] [--agents claude-code,codex,claude-desktop,cursor | --yes | --none]";

export const TARGET_IDS = ["claude-code", "codex", "claude-desktop", "cursor"] as const;
export type TargetId = (typeof TARGET_IDS)[number];

function isTargetId(name: string): name is TargetId {
  return (TARGET_IDS as readonly string[]).includes(name);
}

export interface Target {
  id: TargetId;
  label: string;
  /** The file Bao edits for this target. */
  file: string;
  /** What setup saw on this Mac, or "" when it saw nothing. */
  found: string;
  /** The command the file's bao entry starts, or "" when it has none. */
  command: string;
  /** Why setup cannot write this target now, or "". */
  blocked: string;
}

/** Apps Bao cannot configure yet. Setup names them with the entry to add by hand. */
export interface Other {
  label: string;
  found: string;
}

export interface Probe {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Directories searched for an executable, normally PATH. */
  pathDirs: string[];
  /** Directories searched for an app bundle, normally /Applications and ~/Applications. */
  appDirs: string[];
}

export function defaultProbe(env: NodeJS.ProcessEnv = process.env): Probe {
  const home = baoUserHome(env);
  return {
    home,
    env,
    pathDirs: (env.PATH || "").split(path.delimiter).filter(Boolean),
    appDirs: ["/Applications", path.join(home, "Applications")],
  };
}

function onPath(probe: Probe, name: string): string {
  for (const dir of probe.pathDirs) {
    const file = path.join(dir, name);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK);
        return file;
      }
    } catch {
      // Not in this directory.
    }
  }
  return "";
}

/** How to run bao from this shell: the linked command when it is on PATH, else through npx. */
export function baoCommand(probe: Probe): string {
  return onPath(probe, "bao") ? "bao" : "npx bao-browser";
}

function appBundle(probe: Probe, name: string): string {
  for (const dir of probe.appDirs) {
    const app = path.join(dir, `${name}.app`);
    if (existsSync(app)) return app;
  }
  return "";
}

function tilde(probe: Probe, file: string): string {
  return file === probe.home || file.startsWith(probe.home + path.sep) ? `~${file.slice(probe.home.length)}` : file;
}

function firstFound(probe: Probe, hints: string[]): string {
  return hints.filter(Boolean).map((hint) => (hint.startsWith("/") ? tilde(probe, hint) : hint)).join(", ");
}

function readJsonServers(file: string): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isObject(data) || !isObject(data.mcpServers)) return {};
    return data.mcpServers;
  } catch {
    return {};
  }
}

function jsonCommand(file: string): string {
  const bao = readJsonServers(file).bao;
  return isObject(bao) && typeof bao.command === "string" ? bao.command : "";
}

function tomlCommand(file: string): string {
  try {
    const data = getStaticTOMLValue(parseTOML(readFileSync(file, "utf8"), { tomlVersion: "1.0" })) as unknown;
    if (!isObject(data) || !isObject(data.mcp_servers)) return "";
    const bao = data.mcp_servers.bao;
    return isObject(bao) && typeof bao.command === "string" ? bao.command : "";
  } catch {
    return "";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Claude Code keeps user-scope MCP servers in ~/.claude.json, or in $CLAUDE_CONFIG_DIR/.claude.json. */
export function claudeCodeServersFile(probe: Probe): string {
  return path.join(probe.env.CLAUDE_CONFIG_DIR || probe.home, ".claude.json");
}

export function cursorConfigFile(home: string): string {
  return path.join(home, ".cursor", "mcp.json");
}

export function detectTargets(probe: Probe): Target[] {
  const claudeBin = onPath(probe, "claude");
  const claudeFile = claudeCodeServersFile(probe);
  const codexFile = codexConfigFile({ ...probe.env, HOME: probe.home });
  const desktopFile = desktopMcpFile(probe.home, "claude");
  const cursorFile = cursorConfigFile(probe.home);
  const codexHome = path.dirname(codexFile);
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      file: claudeFile,
      found: firstFound(probe, [claudeBin ? "claude on PATH" : "", existsSync(path.join(probe.home, ".claude")) ? path.join(probe.home, ".claude") : ""]),
      command: jsonCommand(claudeFile),
      blocked: claudeBin ? "" : "needs the claude command on PATH",
    },
    {
      id: "codex",
      label: "Codex CLI, Codex app, ChatGPT",
      file: codexFile,
      found: firstFound(probe, [onPath(probe, "codex") ? "codex on PATH" : "", appBundle(probe, "Codex"), appBundle(probe, "ChatGPT"), existsSync(codexHome) ? codexHome : ""]),
      command: tomlCommand(codexFile),
      blocked: "",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      file: desktopFile,
      found: firstFound(probe, [appBundle(probe, "Claude"), existsSync(path.dirname(desktopFile)) ? path.dirname(desktopFile) : ""]),
      command: jsonCommand(desktopFile),
      blocked: "",
    },
    {
      id: "cursor",
      label: "Cursor",
      file: cursorFile,
      found: firstFound(probe, [appBundle(probe, "Cursor"), existsSync(path.dirname(cursorFile)) ? path.dirname(cursorFile) : ""]),
      command: jsonCommand(cursorFile),
      blocked: "",
    },
  ];
}

export function detectOthers(probe: Probe): Other[] {
  const others: Other[] = [];
  const add = (label: string, found: string): void => {
    if (found) others.push({ label, found: tilde(probe, found) });
  };
  add("VS Code", appBundle(probe, "Visual Studio Code"));
  add("Windsurf", appBundle(probe, "Windsurf"));
  add("Zed", appBundle(probe, "Zed"));
  add("opencode", onPath(probe, "opencode") ? "opencode on PATH" : "");
  add("Gemini CLI", onPath(probe, "gemini") ? "gemini on PATH" : "");
  return others;
}

export interface SetupOptions {
  app: string;
  agents?: string[];
  yes: boolean;
  none: boolean;
}

export function parseSetup(argv: readonly string[], selfFile: string = __filename): SetupOptions {
  let app: string | undefined;
  let agents: string[] | undefined;
  let yes = false;
  let none = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--yes") yes = true;
    else if (arg === "--none") none = true;
    else if (arg === "--app" || arg === "--agents") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      // The real path, so /tmp and /private/tmp name one app, as the launcher sees itself.
      if (arg === "--app") app = existsSync(value) ? realpathSync(value) : path.resolve(value);
      else agents = [...(agents || []), ...value.split(",").map((part) => part.trim()).filter(Boolean)];
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if ([yes, none, agents !== undefined].filter(Boolean).length > 1) throw new Error("use only one of --agents, --yes, and --none");
  return { app: app || appBundleOf(selfFile) || DEFAULT_APP, agents, yes, none };
}

/** The targets the flags pick, or undefined when the owner should pick in the terminal. */
export function chosenByFlags(targets: readonly Target[], options: SetupOptions): Target[] | undefined {
  if (options.none) return [];
  if (options.yes) return targets.filter((target) => target.found && !target.blocked);
  if (!options.agents) return undefined;
  const ids = new Set<TargetId>();
  for (const name of options.agents) {
    if (!isTargetId(name)) throw new Error(`unknown agent: ${name}. Use ${TARGET_IDS.join(", ")}`);
    ids.add(name);
  }
  const picked = targets.filter((target) => ids.has(target.id));
  const blocked = picked.find((target) => target.blocked);
  if (blocked) throw new Error(`${blocked.label} ${blocked.blocked}`);
  return picked;
}

export interface SetupIo extends AgentIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/** Text cut to fit room columns, so no drawn line wraps. */
function clip(text: string, room: number): string {
  if (text.length <= room) return text;
  return room > 0 ? `${text.slice(0, room - 1)}…` : "";
}

/** One line in at most width columns: plain then dim, clipped as one. */
function line(plain: string, dim: string, width: number): string {
  const text = clip(plain + dim, width);
  return `${text.slice(0, plain.length)}\u001b[2m${text.slice(plain.length)}\u001b[0m`;
}

function row(target: Target, checked: boolean, here: boolean, launcher: string, width: number): string {
  const box = target.blocked ? "[-]" : checked ? "[x]" : "[ ]";
  const state = target.command ? target.command === launcher ? "set up" : "set up for another Bao" : target.found ? `found: ${target.found}` : "not found on this Mac";
  const note = target.blocked ? ` (${target.blocked})` : "";
  return `${here ? "\u001b[36m›\u001b[0m" : " "} ${line(`${box} ${target.label.padEnd(30)} `, `${state}${note}`, width - 2)}`;
}

/** A keyboard multi-select in the terminal. Resolves null when the owner cancels. */
export function pickInTerminal(targets: readonly Target[], launcher: string, io: SetupIo): Promise<Target[] | null> {
  const checked = targets.map((target) => !!target.found && !target.blocked);
  let at = 0;
  const lines = targets.length + 2;
  const draw = (first: boolean): void => {
    const width = (io.stdout.columns || 80) - 1;
    if (!first) io.stdout.write(`\u001b[${lines}A`);
    io.stdout.write(`\u001b[2K${line("Which apps should start Bao? ", "↑↓ space enter esc", width)}\n`);
    targets.forEach((target, i) => io.stdout.write(`\u001b[2K${row(target, checked[i]!, i === at, launcher, width)}\n`));
    io.stdout.write("\u001b[2K\n");
  };
  return new Promise((resolve) => {
    emitKeypressEvents(io.stdin);
    io.stdin.setRawMode(true);
    io.stdin.resume();
    io.stdout.write("\u001b[?25l");
    draw(true);
    const done = (result: Target[] | null): void => {
      io.stdin.off("keypress", onKey);
      io.stdin.setRawMode(false);
      io.stdin.pause();
      io.stdout.write("\u001b[?25h");
      resolve(result);
    };
    const onKey = (_text: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
      const name = key?.name;
      if (name === "up") at = (at + targets.length - 1) % targets.length;
      else if (name === "down") at = (at + 1) % targets.length;
      else if (name === "space") {
        if (!targets[at]!.blocked) checked[at] = !checked[at];
      } else if (name === "return" || name === "enter") {
        done(targets.filter((_, i) => checked[i]));
        return;
      } else if (name === "escape" || (key?.ctrl && name === "c")) {
        done(null);
        return;
      } else return;
      draw(false);
    };
    io.stdin.on("keypress", onKey);
  });
}

/** Cursor reads the same mcpServers shape as Claude Desktop, so the Claude Desktop edit writes it. */
function writeCursor(file: string, launcher: string, io: AgentIo): boolean {
  let before = "";
  try {
    before = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      io.err(`${file}: ${(err as Error).message}. Nothing was written.\n`);
      return false;
    }
  }
  let after: string;
  try {
    after = editClaude(before, launcher).text;
  } catch (err) {
    io.err(`${file}: ${(err as Error).message} Nothing was written.\n`);
    return false;
  }
  if (after === before) {
    io.out(`${file} already starts this Bao. Nothing changed.\n`);
    return true;
  }
  let backup = "";
  try {
    if (before) {
      backup = `${file}.bao-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      writeFileSync(backup, before, { mode: statSync(file).mode & 0o777 });
    }
    writeConfig(file, after);
  } catch (err) {
    io.err(`${file}: ${(err as Error).message}. Nothing was written.\n`);
    return false;
  }
  if (backup) io.out(`Saved the old file as ${backup}.\n`);
  io.out(`Added bao to ${file}.\n`);
  return true;
}

function writeClaudeDesktop(home: string, launcher: string, io: AgentIo): boolean {
  try {
    const installer = new DesktopMcpInstaller(home, launcher);
    const preview = installer.preview("claude");
    if (!preview.token) {
      io.out(`${preview.file} already starts this Bao. Nothing changed.\n`);
      return true;
    }
    const done = installer.confirm(preview.token);
    io.out(`${preview.action === "update" ? "Updated" : "Added"} bao in ${done.file}.${done.backup ? ` Saved the old file as ${done.backup}.` : ""}\n`);
    return true;
  } catch (err) {
    io.err(`${(err as Error).message}\n`);
    return false;
  }
}

export function applyTarget(target: Target, app: string, home: string, io: AgentIo): boolean {
  const launcher = mcpLauncher(app);
  switch (target.id) {
    case "claude-code":
      return agentMain(["config", "claude", "--write", "--app", app], io) === 0;
    case "codex":
      return agentMain(["config", "codex", "--write", "--app", app], io) === 0;
    case "claude-desktop":
      return writeClaudeDesktop(home, launcher, io);
    case "cursor":
      return writeCursor(target.file, launcher, io);
  }
}

const RESTART: Record<TargetId, string> = {
  "claude-code": "start a new Claude Code session",
  codex: "restart Codex or ChatGPT",
  "claude-desktop": "quit and reopen Claude Desktop",
  cursor: "reload Cursor",
};

export async function setupMain(argv: readonly string[], io: SetupIo = defaultIo(), probe: Probe = defaultProbe(io.env)): Promise<number> {
  let options: SetupOptions;
  try {
    options = parseSetup(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n${SETUP_USAGE}\n`);
    return 1;
  }
  const launcher = mcpLauncher(options.app);
  try {
    accessSync(launcher, constants.X_OK);
  } catch {
    io.err(`${launcher} is missing. Install Bao first, or pass --app with the Bao.app to use.\n`);
    return 1;
  }
  const targets = detectTargets(probe);
  const others = detectOthers(probe);
  const bao = baoCommand(probe);
  let chosen: Target[] | null | undefined;
  try {
    chosen = chosenByFlags(targets, options);
  } catch (err) {
    io.err(`${(err as Error).message}\n`);
    return 1;
  }
  if (chosen === undefined) {
    if (!io.stdin.isTTY || !io.stdout.isTTY) {
      io.out(`No terminal to ask in, so Bao changed no agent config. Run one of these:\n${targets.map((target) => `  ${bao} setup --agents ${target.id}`).join("\n")}\n`);
      return 0;
    }
    chosen = await pickInTerminal(targets, launcher, io);
  }
  if (options.yes) {
    for (const target of targets.filter((item) => item.found && item.blocked)) io.out(`Skipped ${target.label}: it ${target.blocked}.\n`);
  }
  if (!chosen || chosen.length === 0) {
    io.out(`No app was changed. Run \`${bao} setup\` any time to add Bao to an agent.\n`);
    return 0;
  }
  let failed = 0;
  const ready: Target[] = [];
  for (const target of chosen) {
    io.out(`\n== ${target.label}\n`);
    if (applyTarget(target, options.app, probe.home, io)) ready.push(target);
    else failed += 1;
  }
  if (others.length) {
    io.out(`\nAlso on this Mac: ${others.map((other) => other.label).join(", ")}. Bao cannot edit ${others.length === 1 ? "its" : "their"} config yet. Add a stdio MCP server named bao with this command:\n  ${launcher}\n`);
  }
  if (ready.length) {
    io.out(`\nBao is ready in ${ready.map((target) => target.label).join("; ")}.\n`);
    io.out(`Next: ${[...new Set(ready.map((target) => RESTART[target.id]))].join(", ")}. Then ask: "Use Bao to open example.com and tell me the page title."\n`);
  }
  return failed ? 1 : 0;
}

function defaultIo(): SetupIo {
  return {
    env: process.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    stdin: process.stdin,
    stdout: process.stdout,
  };
}
