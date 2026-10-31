// Client for desktop/os-helper-macos. Press and set-value take role and name.
// They do not take a coordinate.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OsTarget } from "../../../src/types";

/** The helper Bao.app launches. A dev checkout has no nested bundle until package-app.sh copies one. */
export function bundledHelperApp(): string | undefined {
  const fromEnv = process.env.BAO_OS_HELPER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const nested = path.resolve(process.cwd(), "..", "BaoOSHelper.app");
  if (existsSync(path.join(nested, "Contents", "MacOS", "BaoOSHelper"))) return nested;
  return undefined;
}

export interface AxFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AxNode {
  role: string;
  subrole: string;
  title: string;
  description: string;
  identifier: string;
  name: string;
  value: string;
  actions: string[];
  frame: AxFrame | null;
  path: { role: string; name: string }[];
  pid: number;
  app: string;
  useful: boolean;
}

export interface AxHit {
  ok: boolean;
  useful?: boolean;
  reason?: string;
  error?: string;
  strategy?: string;
  element?: AxNode;
  value?: string;
  nodes?: AxNode[];
  geometry?: { screen_w: number; screen_h: number; flip_y: boolean };
  accessibility?: boolean;
  screenCapture?: boolean;
  exe?: string;
  parentExe?: string;
  prompted?: boolean;
  before?: AxFrame;
  after?: AxFrame;
  resized?: boolean;
  sizeError?: string | null;
  windowId?: number;
  width?: number;
  height?: number;
  pid?: number;
  tabId?: string;
  restored?: number;
  found?: boolean;
  locked?: boolean;
  windows?: { id: number; layer: number; x: number; y: number; w: number; h: number }[];
}

function parseHit(out: string, err: string, code: number | null): AxHit {
  const line = out.trim();
  if (!line) throw new Error(err.trim() || `os helper exit ${code}`);
  let parsed: AxHit;
  try {
    parsed = JSON.parse(line) as AxHit;
  } catch {
    throw new Error(err.trim() || line);
  }
  if (code !== 0 || parsed.ok === false) {
    throw new Error(parsed.error || err.trim() || `os helper exit ${code}`);
  }
  return parsed;
}

function runBin(bin: string, args: string[]): Promise<AxHit> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`os helper timed out: ${args[0]}`));
    }, 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      try { resolve(parseHit(out, err, code)); } catch (e) { reject(e); }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** LaunchServices launch so TCC attributes the prompt to the app bundle.
 * `open -W` can return before the helper finishes, so the result file is polled. */
async function runApp(app: string, args: string[], timeoutMs = 45000): Promise<AxHit> {
  const dir = await mkdtemp(path.join(tmpdir(), "bao-os-"));
  const stdout = path.join(dir, "out.json");
  const stderr = path.join(dir, "err.txt");
  const result = path.join(dir, "result.json");
  const started = Date.now();
  try {
    const child = spawn("/usr/bin/open", [
      "-n", "-W", "-g", "-a", app,
      "--stdout", stdout, "--stderr", stderr,
      "--args", ...args, "--result", result,
    ], { stdio: "ignore" });
    let closed: number | null | undefined;
    child.on("error", () => { closed = -1; });
    child.on("close", (code) => { closed = code ?? -1; });
    let out = "";
    while (Date.now() - started < timeoutMs) {
      out = await readFile(result, "utf8").catch(() => "");
      if (!out.trim()) out = await readFile(stdout, "utf8").catch(() => "");
      if (out.trim()) {
        try { JSON.parse(out); break; } catch { /* the helper is still writing the result */ }
      }
      if (typeof closed === "number" && closed !== 0 && out.trim()) break;
      await sleep(80);
    }
    const err = await readFile(stderr, "utf8").catch(() => "");
    if (!out.trim()) throw new Error(err.trim() || `os helper produced no result for ${args[0]}`);
    return parseHit(out, err, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(bin: string, args: string[], timeoutMs?: number): Promise<AxHit> {
  return bin.endsWith(".app") ? runApp(bin, args, timeoutMs) : runBin(bin, args);
}

function identity(target: OsTarget): string[] {
  const args = ["--bundle", target.app, "--role", target.role, "--name", target.name];
  if (target.subrole) args.push("--subrole", target.subrole);
  if (target.path.length) {
    const path = target.path.map((seg) => ({ role: seg.role, name: seg.name ?? "" }));
    args.push("--path", JSON.stringify(path));
  }
  return args;
}

export const HELPER_SHOT_COMMAND = "shot";
export const LIVE_CHROME_SHOT_ERROR = "live Chrome does not use screen recording";

export class MacOsHelper {
  readonly calls: string[][] = [];
  refuseWindowShot = false;
  constructor(readonly bin: string) {}

  exec(args: string[], timeoutMs?: number): Promise<AxHit> {
    if (this.refuseWindowShot && args[0] === HELPER_SHOT_COMMAND) {
      return Promise.reject(new Error(LIVE_CHROME_SHOT_ERROR));
    }
    this.calls.push(args);
    return run(this.bin, args, timeoutMs);
  }

  permissions(prompt: boolean): Promise<AxHit> {
    return this.exec(prompt ? ["permissions", "--prompt"] : ["permissions"]);
  }

  nodes(bundle: string, pid?: number): Promise<AxHit> {
    const args = ["nodes", "--bundle", bundle];
    if (pid) args.push("--pid", String(pid));
    return this.exec(args, 90_000);
  }

  hit(x: number, y: number, bundle: string): Promise<AxHit> {
    return this.exec(["hit", "--x", String(x), "--y", String(y), "--allow-bundle", bundle]);
  }

  focused(bundle: string): Promise<AxHit> {
    return this.exec(["focus", "--allow-bundle", bundle]);
  }

  press(target: OsTarget, pid?: number, valuePrefix?: string): Promise<AxHit> {
    const args = ["press", ...identity(target)];
    if (pid) args.push("--pid", String(pid));
    if (valuePrefix) args.push("--value-prefix", valuePrefix);
    return this.exec(args, 90_000);
  }

  showMenu(target: OsTarget, pid?: number): Promise<AxHit> {
    const args = ["show-menu", ...identity(target)];
    if (pid) args.push("--pid", String(pid));
    return this.exec(args, 90_000);
  }

  screenLocked(): Promise<boolean> {
    return this.exec(["screen-locked"]).then((hit) => hit.locked === true);
  }

  key(bundle: string, combo: string): Promise<AxHit> {
    return this.exec(["key", "--bundle", bundle, "--combo", combo]);
  }

  setValue(target: OsTarget, value: string): Promise<AxHit> {
    return this.exec(["set-value", ...identity(target), "--value", value]);
  }

  read(target: OsTarget): Promise<AxHit> {
    return this.exec(["read", ...identity(target)], 90_000);
  }

  cgKey(bundle: string, combo: string, pid?: number, tap?: "hid" | "session" | "pid"): Promise<AxHit> {
    const args = ["cg-key", "--bundle", bundle, "--combo", combo];
    if (pid) args.push("--pid", String(pid));
    if (tap && tap !== "hid") args.push("--tap", tap);
    return this.exec(args);
  }

  cgType(bundle: string, text: string, pid?: number): Promise<AxHit> {
    const args = ["cg-type", "--bundle", bundle, "--text", text];
    if (pid) args.push("--pid", String(pid));
    return this.exec(args);
  }

  raiseWindow(bundle: string, title: string, pid?: number): Promise<AxHit> {
    const args = ["raise-window", "--bundle", bundle, "--title", title];
    if (pid) args.push("--pid", String(pid));
    return this.exec(args);
  }

  focusRole(bundle: string, role: string, name = ""): Promise<AxHit> {
    const args = ["focus-role", "--bundle", bundle, "--role", role];
    if (name) args.push("--name", name);
    return this.exec(args);
  }

  windows(bundle: string): Promise<AxHit> {
    return this.exec(["windows", "--bundle", bundle]);
  }

  moveWindow(bundle: string, frame: AxFrame, opts?: { pid?: number; frontmost?: boolean }): Promise<AxHit> {
    const args = ["move-window"];
    if (bundle) args.push("--bundle", bundle);
    if (opts?.pid) args.push("--pid", String(opts.pid));
    if (opts?.frontmost) args.push("--frontmost");
    args.push("--x", String(frame.x), "--y", String(frame.y), "--w", String(frame.w), "--h", String(frame.h));
    return this.exec(args);
  }

  shot(bundle: string, out: string): Promise<AxHit> {
    return this.exec(["shot", "--bundle", bundle, "--out", out]);
  }
}

export function targetFrom(node: AxNode, screen: { w: number; h: number }): OsTarget {
  return {
    platform: "macos",
    app: node.app,
    role: node.role,
    subrole: node.subrole || undefined,
    name: node.name,
    title: node.title || undefined,
    description: node.description || undefined,
    identifier: node.identifier || undefined,
    path: node.path.map((seg) => ({ role: seg.role, name: seg.name })),
    bbox: node.frame
      ? { x: node.frame.x, y: node.frame.y, w: node.frame.w, h: node.frame.h, sw: screen.w, sh: screen.h }
      : undefined,
  };
}
