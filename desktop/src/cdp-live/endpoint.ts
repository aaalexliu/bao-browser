import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** The only Chrome profile file this driver reads. */
export const DEVTOOLS_ACTIVE_PORT = path.join(
  homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "DevToolsActivePort",
);

export interface DevToolsEndpoint {
  port: number;
  browserPath: string;
}

export function assertActivePortFile(file: string): void {
  if (path.basename(file) !== "DevToolsActivePort") {
    throw new Error("refusing to read anything except DevToolsActivePort");
  }
}

export function parseDevToolsActivePort(text: string): DevToolsEndpoint {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const port = Number(lines[0]);
  const browserPath = lines[1] || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DevToolsActivePort has no port");
  }
  if (!browserPath.startsWith("/devtools/browser")) {
    throw new Error("DevToolsActivePort path is not the browser target");
  }
  return { port, browserPath };
}

export async function readDevToolsActivePort(file = DEVTOOLS_ACTIVE_PORT): Promise<DevToolsEndpoint> {
  assertActivePortFile(file);
  const text = await readFile(file, "utf8");
  return parseDevToolsActivePort(text);
}

/** Pid of the Chrome listening on this loopback port. Other Chrome processes are ignored. */
export function parseListenPid(text: string, port: number): number | null {
  for (const line of text.split("\n")) {
    if (!line.includes(`127.0.0.1:${port}`) || !line.includes("(LISTEN)")) continue;
    const parts = line.trim().split(/\s+/);
    const name = parts[0] || "";
    if (!/^Google/i.test(name) && !/chrome/i.test(name)) continue;
    const pid = Number(parts[1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** Absolute on macOS: a background agent PATH of /usr/bin:/bin cannot see /usr/sbin/lsof. */
export function listenPidBin(platform: string): string {
  return platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
}

/** Undefined when nothing listens on the port. Rejects when lsof itself fails, so a failure is not read as "not listening". */
export function listenPid(port: number, platform = process.platform): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    execFile(listenPidBin(platform), ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { timeout: 5000 }, (err, stdout) => {
      // lsof exits 1 when nothing matches. Any other failure is not an answer.
      if (err && (err as { code?: unknown }).code !== 1) {
        reject(new Error(`Bao could not check which process listens on port ${port}: ${err.message}`));
        return;
      }
      const pid = parseListenPid(stdout, port);
      resolve(pid ?? undefined);
    });
  });
}
