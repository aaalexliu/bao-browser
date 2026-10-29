import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface HomeOptions {
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  userHome?: string;
  warn?: (line: string) => void;
}

export class HomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeError";
  }
}

interface HomeSettings {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  userHome: string;
  warn: (line: string) => void;
}

const warned = new Set<string>();

function isArgList(value: readonly string[] | HomeOptions): value is readonly string[] {
  return Array.isArray(value);
}

export function resolveHome(argsOrOptions: readonly string[] | HomeOptions = [], env?: NodeJS.ProcessEnv): string {
  return chooseHome(normalize(argsOrOptions, env));
}

export function baoUserHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return userHomeFrom(env, platform);
}

export function otherLibraries(root: string, argsOrOptions: readonly string[] | HomeOptions = {}, env?: NodeJS.ProcessEnv): string[] {
  const settings = normalize(argsOrOptions, env);
  return legacyDirs(settings).filter((dir) => !samePath(dir, root) && hasWorkflows(dir));
}

export function serverHomes(args: readonly string[] = [], env?: NodeJS.ProcessEnv): string[] {
  const settings = normalize({ args, env });
  const home = chooseHome(settings);
  const homes = [home];
  for (const extra of legacyDirs(settings)) {
    if (!homes.some((item) => samePath(item, extra))) homes.push(extra);
  }
  return homes;
}

export function librarySplitLine(other: string, root: string): string {
  return `library data is at ${other}; using ${root}`;
}

export function tildePath(file: string, userHome: string): string {
  const root = path.resolve(userHome);
  const abs = path.resolve(file);
  if (abs === root) return "~";
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!abs.startsWith(prefix)) return abs;
  return `~/${abs.slice(prefix.length)}`;
}

function normalize(argsOrOptions: readonly string[] | HomeOptions, env?: NodeJS.ProcessEnv): HomeSettings {
  const options: HomeOptions = isArgList(argsOrOptions) ? { args: argsOrOptions, env } : argsOrOptions;
  const environment = options.env ?? env ?? process.env;
  const platform = options.platform ?? process.platform;
  return {
    args: options.args ?? [],
    env: environment,
    platform,
    cwd: options.cwd ?? process.cwd(),
    userHome: options.userHome || userHomeFrom(environment, platform),
    warn: options.warn ?? warnOnStderr,
  };
}

function chooseHome(settings: HomeSettings): string {
  const requested = readHomeFlag(settings.args) ?? nonempty(settings.env.BAO_HOME) ?? platformHome(settings.userHome, settings.platform);
  const resolved = absoluteHome(requested, settings.userHome, settings.cwd);
  const hits = legacyDirs(settings).filter((dir) => !samePath(dir, resolved) && hasWorkflows(dir));
  if (!hasWorkflows(resolved) && hits.length > 0) {
    const root = hits[0];
    if (!root) return resolved;
    emit(settings, `bao: no workflows in ${resolved}; using ${root}`);
    for (const other of hits.slice(1)) emit(settings, `bao: ${librarySplitLine(other, root)}`);
    return root;
  }
  for (const other of hits) emit(settings, `bao: ${librarySplitLine(other, resolved)}`);
  return resolved;
}

function readHomeFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--home") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new HomeError("bao: --home needs a directory");
      return value;
    }
    if (arg.startsWith("--home=")) {
      const value = arg.slice("--home=".length);
      if (!value || value.startsWith("--")) throw new HomeError("bao: --home needs a directory");
      return value;
    }
  }
  return undefined;
}

function absoluteHome(value: string, userHome: string, cwd: string): string {
  if (value.includes("\0")) throw new HomeError("bao: home path contains a null byte");
  let expanded = value;
  if (value === "~") expanded = userHome;
  else if (value.startsWith("~/")) expanded = path.join(userHome, value.slice(2));
  return path.resolve(cwd, expanded);
}

function nonempty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function userHomeFrom(env: NodeJS.ProcessEnv, platform: string): string {
  if (platform === "win32") return env.USERPROFILE || env.HOME || homedir();
  return env.HOME || "/tmp";
}

function platformHome(userHome: string, platform: string): string {
  if (platform === "darwin") return path.join(userHome, "Library", "Application Support", "bao");
  return path.join(userHome, ".local", "share", "bao");
}

function legacyDirs(settings: HomeSettings): string[] {
  return [
    path.resolve(settings.userHome, ".local", "share", "bao"),
    path.resolve(settings.cwd, ".bao-mcp"),
  ];
}

function emit(settings: HomeSettings, line: string): void {
  if (warned.has(line)) return;
  warned.add(line);
  settings.warn(line);
}

function warnOnStderr(line: string): void {
  console.error(line);
}

function hasWorkflows(dir: string): boolean {
  const folder = path.join(dir, "workflows");
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return false;
  }
  return names.some((name) => {
    if (!name.endsWith(".json")) return false;
    try {
      return statSync(path.join(folder, name)).isFile();
    } catch {
      return false;
    }
  });
}

function samePath(left: string, right: string): boolean {
  return canonical(left) === canonical(right);
}

function canonical(file: string): string {
  try {
    if (existsSync(file)) return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
  return path.resolve(file);
}
