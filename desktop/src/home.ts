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

const warned = new Set<string>();

function isArgList(value: readonly string[] | HomeOptions): value is readonly string[] {
  return Array.isArray(value);
}

export function resolveHome(argsOrOptions: readonly string[] | HomeOptions = [], env?: NodeJS.ProcessEnv): string {
  const options: HomeOptions = isArgList(argsOrOptions) ? { args: argsOrOptions, env } : argsOrOptions;
  const args = options.args ?? [];
  const environment = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome || userHomeFrom(environment, platform);
  const home = flagged(args, "--home") || nonempty(environment.BAO_HOME) || platformHome(userHome, platform);
  warnLegacy(home, userHome, cwd, options.warn ?? warnOnStderr);
  return home;
}

function nonempty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function flagged(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return nonempty(args[index + 1]);
}

function userHomeFrom(env: NodeJS.ProcessEnv, platform: string): string {
  const named = platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME;
  return named || homedir();
}

function platformHome(userHome: string, platform: string): string {
  if (platform === "darwin") return path.join(userHome, "Library", "Application Support", "bao");
  return path.join(userHome, ".local", "share", "bao");
}

function warnLegacy(home: string, userHome: string, cwd: string, warn: (line: string) => void): void {
  const legacies = [
    path.join(userHome, ".local", "share", "bao"),
    path.join(cwd, ".bao-mcp"),
  ];
  for (const legacy of legacies) {
    if (samePath(legacy, home) || !hasData(legacy)) continue;
    const line = `bao: library data is at ${legacy}; using ${home}`;
    if (warned.has(line)) continue;
    warned.add(line);
    warn(line);
  }
}

function warnOnStderr(line: string): void {
  console.error(line);
}

function hasData(dir: string): boolean {
  try {
    const stat = statSync(dir);
    if (stat.isDirectory()) return readdirSync(dir).length > 0;
    return stat.isFile();
  } catch {
    return false;
  }
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
