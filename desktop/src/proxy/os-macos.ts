// Client for desktop/os-helper-macos. Press and set-value take role and name.
// They do not take a coordinate.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OsTarget } from "../../../src/types";

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
  windowId?: number;
  width?: number;
  height?: number;
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

/** LaunchServices launch so TCC attributes the prompt to the app bundle. */
async function runApp(app: string, args: string[]): Promise<AxHit> {
  const dir = await mkdtemp(path.join(tmpdir(), "bao-os-"));
  const stdout = path.join(dir, "out.json");
  const stderr = path.join(dir, "err.txt");
  const result = path.join(dir, "result.json");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/open", [
        "-n", "-W", "-g", "-a", app,
        "--stdout", stdout, "--stderr", stderr,
        "--args", ...args, "--result", result,
      ], { stdio: "ignore" });
      child.on("error", reject);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`os helper timed out: ${args[0]}`));
      }, 20000);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`open exited ${code}`));
      });
    });
    const out = await readFile(result, "utf8").catch(() => readFile(stdout, "utf8"));
    const err = await readFile(stderr, "utf8").catch(() => "");
    return parseHit(out, err, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(bin: string, args: string[]): Promise<AxHit> {
  return bin.endsWith(".app") ? runApp(bin, args) : runBin(bin, args);
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

export class MacOsHelper {
  readonly calls: string[][] = [];
  constructor(readonly bin: string) {}

  private exec(args: string[]): Promise<AxHit> {
    this.calls.push(args);
    return run(this.bin, args);
  }

  permissions(prompt: boolean): Promise<AxHit> {
    return this.exec(prompt ? ["permissions", "--prompt"] : ["permissions"]);
  }

  nodes(bundle: string): Promise<AxHit> {
    return this.exec(["nodes", "--bundle", bundle]);
  }

  hit(x: number, y: number, bundle: string): Promise<AxHit> {
    return this.exec(["hit", "--x", String(x), "--y", String(y), "--allow-bundle", bundle]);
  }

  focused(bundle: string): Promise<AxHit> {
    return this.exec(["focus", "--allow-bundle", bundle]);
  }

  press(target: OsTarget): Promise<AxHit> {
    return this.exec(["press", ...identity(target)]);
  }

  setValue(target: OsTarget, value: string): Promise<AxHit> {
    return this.exec(["set-value", ...identity(target), "--value", value]);
  }

  read(target: OsTarget): Promise<AxHit> {
    return this.exec(["read", ...identity(target)]);
  }

  focusRole(bundle: string, role: string, name = ""): Promise<AxHit> {
    const args = ["focus-role", "--bundle", bundle, "--role", role];
    if (name) args.push("--name", name);
    return this.exec(args);
  }

  windows(bundle: string): Promise<AxHit> {
    return this.exec(["windows", "--bundle", bundle]);
  }

  moveWindow(bundle: string, frame: AxFrame): Promise<AxHit> {
    return this.exec([
      "move-window", "--bundle", bundle,
      "--x", String(frame.x), "--y", String(frame.y), "--w", String(frame.w), "--h", String(frame.h),
    ]);
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
