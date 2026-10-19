// Client for desktop/os-helper-macos. Press and set-value take role and name.
// They do not take a coordinate.

import { spawn } from "node:child_process";
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

function run(bin: string, args: string[]): Promise<AxHit> {
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
      const line = out.trim();
      if (!line) {
        reject(new Error(err.trim() || `os helper exit ${code}`));
        return;
      }
      let parsed: AxHit;
      try {
        parsed = JSON.parse(line) as AxHit;
      } catch {
        reject(new Error(err.trim() || line));
        return;
      }
      if (code !== 0 || parsed.ok === false) {
        reject(new Error(parsed.error || err.trim() || `os helper exit ${code}`));
        return;
      }
      resolve(parsed);
    });
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
