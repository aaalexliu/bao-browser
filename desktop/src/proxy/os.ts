// Spawn the spike 2 AT-SPI helper. Replay commands take role and name.
// They do not take a coordinate.

import { spawn } from "node:child_process";

export interface OsNode {
  app: string;
  role: string;
  name: string;
  path: { role: string; name: string }[];
  bbox: { x: number; y: number; w: number; h: number; sw: number; sh: number };
  actions: number;
}

export interface OsHit {
  ok: boolean;
  reason?: string;
  strategy?: string;
  app?: string;
  role?: string;
  name?: string;
  path?: { role: string; name: string }[];
  bbox?: OsNode["bbox"];
  actions?: number;
  candidates?: number;
}

function run(bin: string, args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.split("\n").map((row) => row.trim()).filter((row) => row.startsWith("{") || row.startsWith("[")).pop();
      if (code !== 0 || !line) {
        reject(new Error(err.trim() || out.trim() || `os helper exit ${code}`));
        return;
      }
      resolve(JSON.parse(line));
    });
  });
}

export function osNodes(bin: string, screen: string): Promise<OsNode[]> {
  return run(bin, ["nodes", "--screen", screen]) as Promise<OsNode[]>;
}

export function osHit(bin: string, screen: string, x: number, y: number): Promise<OsHit> {
  return run(bin, ["hit", "--screen", screen, "--x", String(Math.round(x)), "--y", String(Math.round(y))]) as Promise<OsHit>;
}

export function osFocus(bin: string, screen: string): Promise<OsHit> {
  return run(bin, ["focus", "--screen", screen]) as Promise<OsHit>;
}

export function osPress(bin: string, screen: string, app: string, role: string, name: string): Promise<OsHit> {
  return run(bin, [
    "press", "--screen", screen, "--app", app, "--entry-role", role, "--entry-name", name,
  ]) as Promise<OsHit>;
}

export function osRead(bin: string, screen: string, app: string, role: string): Promise<{ ok: boolean; names: string[] }> {
  return run(bin, ["read", "--screen", screen, "--app", app, "--entry-role", role]) as Promise<{ ok: boolean; names: string[] }>;
}
