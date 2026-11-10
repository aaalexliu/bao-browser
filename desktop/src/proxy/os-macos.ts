// Client for desktop/os-helper-macos. Press and set-value take role and name.
// They do not take a coordinate.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { OsTarget } from "../../../shared/types";

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
  windowId?: number | string;
  frame?: number[];
  width?: number;
  height?: number;
  pid?: number;
  tabId?: string;
  restored?: number;
  found?: boolean;
  pressed?: boolean;
  permitted?: boolean;
  denied?: boolean;
  wouldPrompt?: boolean;
  url?: string;
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
    throw helperError(parsed.error || err.trim() || `os helper exit ${code}`);
  }
  return parsed;
}

const HELPER_TOO_OLD = "BaoOSHelper is older than this Bao; rebuild it";

function helperError(message: string): Error {
  if (/unknown command/.test(message)) return new Error(HELPER_TOO_OLD);
  return new Error(message);
}

function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function accepted(command: string | undefined, hit: AxHit): AxHit {
  if ((command === "permissions" || command === "permissions-ax") && !(hit.exe && hit.parentExe && canonical(hit.exe) === canonical(hit.parentExe))) {
    throw new Error(HELPER_TOO_OLD);
  }
  return hit;
}

/** The executable inside a helper bundle. */
export function helperExecutable(bin: string): string {
  return bin.endsWith(".app") ? path.join(bin, "Contents", "MacOS", path.basename(bin, ".app")) : bin;
}

function killGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group already exited */ }
}

/** Spawns the helper directly, not through LaunchServices. BaoOSHelper respawns itself as its own
 * responsible process, so TCC still checks the helper's grant. The helper leads its own process
 * group, and a timeout kills that group, so no helper outlives the call. */
function run(bin: string, args: string[], timeoutMs = bin.endsWith(".app") ? 45_000 : 20_000): Promise<AxHit> {
  const exe = helperExecutable(bin);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", (error) => settle(() => reject(new Error(`could not start ${path.basename(exe)}: ${error.message}`))));
    const timer = setTimeout(() => settle(() => {
      killGroup(child);
      reject(new Error(`os helper timed out: ${args[0]}`));
    }), timeoutMs);
    child.on("close", (code) => settle(() => {
      try { resolve(accepted(args[0], parseHit(out, err, code))); } catch (e) { reject(e); }
    }));
  });
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

  press(target: OsTarget, pid?: number): Promise<AxHit> {
    const args = ["press", ...identity(target)];
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
