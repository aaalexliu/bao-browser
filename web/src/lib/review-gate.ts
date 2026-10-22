// Publishing runs the public copy in a clean browser. That pass stamps Verified.
// A passed replay on a Mac also moves last green.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PLAIN_REASONS: Record<string, string> = {
  "below-threshold": "bao couldn't find this control confidently enough.",
  "no-candidates": "bao couldn't find this control.",
  "lookup miss": "bao couldn't find this control.",
  tie: "bao found more than one control and couldn't choose.",
  "app-mismatch": "bao was looking in the wrong app.",
};

export function plainReplayReason(reason: string): string {
  const text = reason.trim();
  return PLAIN_REASONS[text] || text;
}

export interface GateResult {
  ok: boolean;
  stepId?: string;
  stepLabel?: string;
  reason?: string;
}

type GateRunner = (document: unknown, samples: Record<string, string>) => Promise<GateResult>;

let custom: GateRunner | null = null;

export function setPublishGate(runner: GateRunner | null): void {
  custom = runner;
}

export async function runPublishGate(document: unknown, samples: Record<string, string> = {}): Promise<GateResult> {
  if (custom) return custom(document, samples);
  return spawnGate(document, samples);
}

function gateScript(): string {
  const candidates = [
    path.join(process.cwd(), "desktop/dist/desktop/src/v1/publish-gate.js"),
    path.join(process.cwd(), "../desktop/dist/desktop/src/v1/publish-gate.js"),
  ];
  return candidates.find((file) => existsSync(file)) || candidates[0]!;
}

function repoRoot(): string {
  const here = process.cwd();
  if (existsSync(path.join(here, "desktop"))) return here;
  return path.join(here, "..");
}

function spawnGate(document: unknown, samples: Record<string, string>): Promise<GateResult> {
  const script = gateScript();
  if (!existsSync(script)) {
    return Promise.resolve({
      ok: false,
      stepId: "start",
      stepLabel: "Open the public site",
      reason: "review runner is not built",
    });
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: repoRoot(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.on("close", () => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString("utf8").trim();
      try {
        const parsed = JSON.parse(text) as GateResult;
        resolve(parsed && typeof parsed.ok === "boolean" ? parsed : {
          ok: false,
          stepId: "start",
          stepLabel: "Open the public site",
          reason: text || Buffer.concat(err).toString("utf8").slice(0, 300) || "replay failed",
        });
      } catch {
        resolve({
          ok: false,
          stepId: "start",
          stepLabel: "Open the public site",
          reason: text || Buffer.concat(err).toString("utf8").slice(0, 300) || "replay failed",
        });
      }
    });
    child.stdin.end(JSON.stringify({ document, samples }));
  });
}
