// Desktop executor. A pixel is resolved against the OS accessibility tree
// unless a Chrome window owns it. The coordinate is provenance. Replay of an
// osClick goes through role + name, not this file.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { deriveWorkflow, trimTrail, type AuditOrigin, type AuditTrail } from "./audit";
import type { ActResult, Executor, NeutralAction, Observation } from "./neutral";
import { osFocus, osHit, type OsHit } from "./os";
import type { ScreenRect } from "./surface";
import { surfaceAt } from "./surface";

export interface DesktopOptions {
  bin: string;
  screen: { w: number; h: number };
  chrome?: ScreenRect[];
  /** Where unresolved crops are written. */
  cropDir?: string;
  crops?: string[];
}

async function rootPng(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("import", ["-window", "root", "png:-"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(err || `import exit ${code}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

async function pointerClick(x: number, y: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("xdotool", ["mousemove", String(Math.round(x)), String(Math.round(y)), "click", "1"]);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`xdotool exit ${code}`)));
  });
}

function osOf(hit: OsHit) {
  return {
    app: hit.app || "",
    role: hit.role || "",
    name: hit.name || "",
    path: hit.path || [],
  };
}

export class DesktopExecutor implements Executor {
  constructor(readonly trail: AuditTrail, private readonly opts: DesktopOptions) {}

  private screenArg(): string {
    return `${this.opts.screen.w}x${this.opts.screen.h}`;
  }

  async observe(origin: AuditOrigin): Promise<Observation> {
    const png = await rootPng();
    const hash = "sha256:" + createHash("sha256").update(png).digest("hex");
    const snap = { screenshot: hash, url: "desktop://screen", dom: [], ax: [] };
    this.trail.append({
      kind: "read",
      op: "screenshot",
      source: origin.source,
      raw: origin.raw,
      after: snap,
    });
    return {
      png,
      url: snap.url,
      viewport: this.opts.screen,
      dom: [],
      ax: [],
    };
  }

  async act(action: NeutralAction, origin: AuditOrigin): Promise<ActResult> {
    if (action.op === "type") return this.actType(action.text, origin);
    if (action.op === "keypress") {
      return this.recordUnresolved("osClick", origin, "keypress has no focused editable on this desktop", undefined);
    }
    if (action.op === "click") return this.actClick(action, origin);
    if (action.op === "wait") {
      await new Promise((resolve) => setTimeout(resolve, action.ms));
      return { unresolved: false };
    }
    if (action.op === "screenshot") {
      await this.observe(origin);
      return { unresolved: false };
    }
    return this.recordUnresolved(
      "osClick",
      origin,
      `${action.op} is not a desktop semantic step in this spike`,
      "x" in action ? { x: action.x, y: action.y, space: "screen" as const } : undefined,
    );
  }

  workflow(startUrl: string) {
    return deriveWorkflow(trimTrail(this.trail.events), startUrl);
  }

  private async actClick(action: Extract<NeutralAction, { op: "click" }>, origin: AuditOrigin): Promise<ActResult> {
    const provenance = action.provenance ?? { x: action.x, y: action.y, space: "screen" as const };
    const surface = surfaceAt(action.x, action.y, this.opts.chrome ?? []);
    if (surface === "dom") {
      return this.recordUnresolved(
        "osClick",
        origin,
        "point is inside a Chrome window; the DOM resolver owns it",
        provenance,
      );
    }
    const hit = await osHit(this.opts.bin, this.screenArg(), action.x, action.y);
    if (!hit.ok || !hit.app || !hit.role) {
      const crop = await this.crop(action.x, action.y);
      return this.recordUnresolved("osClick", origin, hit.reason || "no accessible at point", provenance, crop);
    }
    await pointerClick(action.x, action.y);
    const focus = await osFocus(this.opts.bin, this.screenArg());
    const png = await rootPng();
    const hash = "sha256:" + createHash("sha256").update(png).digest("hex");
    this.trail.append({
      kind: "act",
      op: "osClick",
      source: origin.source,
      raw: origin.raw,
      after: { screenshot: hash, url: "desktop://screen", dom: [], ax: [] },
      provenance,
      os: osOf(hit),
      focus: focus.ok ? {
        scope: "element",
        editable: focus.role === "text" || focus.role === "text box" || focus.role === "entry",
        axRole: focus.role,
        axName: focus.name,
      } : { scope: "page", editable: false },
    });
    return { unresolved: false };
  }

  private async actType(text: string, origin: AuditOrigin): Promise<ActResult> {
    const focus = await osFocus(this.opts.bin, this.screenArg());
    const editable = !!focus.ok && (focus.role === "text" || focus.role === "text box" || focus.role === "entry");
    if (!editable) {
      return this.recordUnresolved("osType", origin, "type has no focused editable", undefined);
    }
    this.trail.append({
      kind: "act",
      op: "osType",
      source: origin.source,
      raw: { text },
      os: osOf(focus),
      focus: { scope: "element", editable: true, axRole: focus.role, axName: focus.name },
    });
    return { unresolved: false };
  }

  private async recordUnresolved(
    op: string,
    origin: AuditOrigin,
    reason: string,
    provenance: { x: number; y: number; space: "screen" | "image" | "viewport" } | undefined,
    crop?: string,
  ): Promise<ActResult> {
    this.trail.append({
      kind: "act",
      op,
      source: origin.source,
      raw: origin.raw,
      unresolved: { reason },
      provenance,
      crop,
    });
    return { unresolved: true, reason };
  }

  private async crop(x: number, y: number): Promise<string | undefined> {
    if (!this.opts.cropDir) return undefined;
    const png = await rootPng();
    const size = 96;
    const left = Math.max(0, Math.round(x) - size / 2);
    const top = Math.max(0, Math.round(y) - size / 2);
    const cropped = await cropPng(png, left, top, size, size);
    const hash = "sha256:" + createHash("sha256").update(cropped).digest("hex");
    const file = `${this.opts.cropDir}/crop-${hash.slice(7, 15)}.png`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, cropped);
    this.opts.crops?.push(file);
    return hash;
  }
}

function cropPng(png: Buffer, x: number, y: number, w: number, h: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vf", `crop=${w}:${h}:${x}:${y}`,
      "-f", "image2pipe", "-c:v", "png", "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let err = "";
    ff.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ff.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) reject(new Error(err || `ffmpeg crop ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    ff.stdin.write(png);
    ff.stdin.end();
  });
}
