// Opens Bao's native permission window, and reads the two grants it shows.
// The window process is a disclaimed Bao copy, so macOS asks about Bao.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const PERMISSION_HEADLESS = "No screen here, so Bao did not open its permission window. On this Mac, run bao setup.";
export const ACCESSIBILITY_GRANT = "Device Control and Data Access";
export const ACCESSIBILITY_BLOCK = "Device Control and Data Access is not on for Bao";

export interface MacGrantReport {
  accessibility: boolean;
  chromeFolder: "allowed" | "denied" | "missing";
}

export interface PermissionWindowResult {
  opened: boolean;
  line: string;
}

export function permissionBinary(app: string): string {
  return path.join(app, "Contents", "MacOS", "bao");
}

export function readMacGrants(app: string, env: NodeJS.ProcessEnv = process.env): MacGrantReport | undefined {
  const bao = permissionBinary(app);
  if (!existsSync(bao)) return undefined;
  const result = spawnSync(bao, ["--permissions", "--check"], { encoding: "utf8", timeout: 15_000, env });
  if (result.status !== 0 || !result.stdout) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { accessibility?: unknown; chromeFolder?: unknown };
    if (typeof parsed.accessibility !== "boolean") return undefined;
    if (parsed.chromeFolder !== "allowed" && parsed.chromeFolder !== "denied" && parsed.chromeFolder !== "missing") return undefined;
    return { accessibility: parsed.accessibility, chromeFolder: parsed.chromeFolder };
  } catch {
    return undefined;
  }
}

export function openPermissionWindow(app: string): Promise<PermissionWindowResult> {
  const bao = permissionBinary(app);
  if (!existsSync(bao)) return Promise.resolve({ opened: false, line: PERMISSION_HEADLESS });
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bao, ["--permissions"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ opened: false, line: error instanceof Error ? error.message : PERMISSION_HEADLESS });
      return;
    }
    let text = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: PermissionWindowResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", (error) => finish({ opened: false, line: error.message || PERMISSION_HEADLESS }));
    child.on("close", () => finish({ opened: false, line: text.trim() || PERMISSION_HEADLESS }));
    timer = setTimeout(() => {
      finish({ opened: true, line: "" });
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }, 800);
  });
}

export function accessibilityMissing(opened: boolean): string {
  return opened
    ? `${ACCESSIBILITY_BLOCK}. Bao opened its permission window. Drag Bao into the list, then turn it on.`
    : `${ACCESSIBILITY_BLOCK}. On this Mac, run bao setup.`;
}

/** Opens the window unless this is a test, or this process is not a Bao.app. */
export async function presentMissingMacPermission(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.BAO_TEST_BROWSER || env.BAO_LANE === "hermetic") return false;
  const app = /^(.*\.app)\/Contents\/MacOS\/bao$/.exec(env.BAO_RESPONSIBLE_EXE || "")?.[1];
  if (!app) return false;
  return (await openPermissionWindow(app)).opened;
}
