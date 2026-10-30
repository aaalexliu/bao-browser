import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** A split names a second library with data. A fallback names the empty directory Bao skipped. */
export type NoticeKind = "split" | "fallback";

export interface HomeOptions {
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  userHome?: string;
  warn?: (line: string, kind: NoticeKind) => void;
}

export class HomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeError";
  }
}

interface LibraryHomeModule {
  resolveLibraryHome(argsOrOptions?: readonly string[] | HomeOptions, env?: NodeJS.ProcessEnv): string;
  otherLibraries(root: string, argsOrOptions?: readonly string[] | HomeOptions, env?: NodeJS.ProcessEnv): string[];
  serverHomes(args?: readonly string[], env?: NodeJS.ProcessEnv): string[];
  showOnce(home: string, lines: readonly string[]): string[];
  tildePath(file: string, userHome: string): string;
  baoUserHome(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
}

const load = createRequire(__filename);

function loadLibraryHome(): LibraryHomeModule {
  // Staged app: stage-runtime.sh copies it next to home.js. Checkout: desktop/dist/desktop/src -> desktop/src.
  const candidates = [
    path.join(__dirname, "library-home.cjs"),
    path.resolve(__dirname, "../../../src/library-home.cjs"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) return load(file) as LibraryHomeModule;
  }
  throw new HomeError("bao: library home resolver is missing");
}

const lib = loadLibraryHome();

function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("bao:")) throw new HomeError(err.message);
    throw err;
  }
}

export function resolveHome(argsOrOptions: readonly string[] | HomeOptions = [], env?: NodeJS.ProcessEnv): string {
  return call(() => lib.resolveLibraryHome(argsOrOptions, env));
}

export function baoUserHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return call(() => lib.baoUserHome(env, platform));
}

export function otherLibraries(root: string, argsOrOptions: readonly string[] | HomeOptions = {}, env?: NodeJS.ProcessEnv): string[] {
  return call(() => lib.otherLibraries(root, argsOrOptions, env));
}

export function serverHomes(args: readonly string[] = [], env?: NodeJS.ProcessEnv): string[] {
  return call(() => lib.serverHomes(args, env));
}

/** Port of the running app, from server.json in the first of serverHomes that has one. */
export function serverPort(args: readonly string[] = [], env?: NodeJS.ProcessEnv): number | undefined {
  for (const home of serverHomes(args, env)) {
    const file = path.join(home, "server.json");
    if (!existsSync(file)) continue;
    try {
      const port = Number((JSON.parse(readFileSync(file, "utf8")) as { port?: number }).port);
      if (port > 0) return port;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Returns the lines not yet shown from this library and records them in it. */
export function showOnce(home: string, lines: readonly string[]): string[] {
  return lib.showOnce(home, lines);
}

export function tildePath(file: string, userHome: string): string {
  return lib.tildePath(file, userHome);
}
