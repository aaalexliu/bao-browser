import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** The only Chrome profile file this driver reads. A test points BAO_CHROME_USER_DATA at a fixture. */
export function devToolsActivePortFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BAO_CHROME_USER_DATA?.trim();
  const root = override ? path.resolve(override) : path.join(homedir(), "Library", "Application Support", "Google", "Chrome");
  return path.join(root, "DevToolsActivePort");
}

export const DEVTOOLS_ACTIVE_PORT = devToolsActivePortFile();

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

export async function readDevToolsActivePort(file = devToolsActivePortFile()): Promise<DevToolsEndpoint> {
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

/** Loopback TCP ports this pid listens on. Empty when it listens on none. Other addresses are ignored. */
export function parseListenPorts(text: string, pid: number): number[] {
  const ports: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("(LISTEN)")) continue;
    const parts = line.trim().split(/\s+/);
    if (Number(parts[1]) !== pid) continue;
    const match = /127\.0\.0\.1:(\d+)/.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    if (port >= 1 && port <= 65535) ports.push(port);
  }
  return ports;
}

/** Ports this pid listens on. Rejects when lsof itself fails, so a failure is not read as "no port". */
export function listenPorts(pid: number, platform = process.platform): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile(listenPidBin(platform), ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], { timeout: 5000 }, (err, stdout) => {
      if (err && (err as { code?: unknown }).code !== 1) {
        reject(new Error(`Bao could not check which ports process ${pid} listens on: ${err.message}`));
        return;
      }
      resolve(parseListenPorts(stdout, pid));
    });
  });
}

export interface VersionProbe {
  status: number;
  body: string;
}

/** The browser path from a /json/version body, when that body names one. */
export function browserPathFromVersion(body: string): string | undefined {
  let parsed: { webSocketDebuggerUrl?: unknown };
  try { parsed = JSON.parse(body) as { webSocketDebuggerUrl?: unknown }; }
  catch { return undefined; }
  if (typeof parsed.webSocketDebuggerUrl !== "string") return undefined;
  try {
    const browserPath = new URL(parsed.webSocketDebuggerUrl).pathname;
    return browserPath.startsWith("/devtools/browser") ? browserPath : undefined;
  } catch { return undefined; }
}

/**
 * The endpoint a version probe names. A command-line port returns 200 and a /devtools/browser path.
 * chrome://inspect approval mode returns an empty 404 and accepts /devtools/browser with no guid.
 */
export function endpointFromVersion(port: number, status: number, body: string): DevToolsEndpoint | undefined {
  if (status === 200) {
    const browserPath = browserPathFromVersion(body);
    return browserPath ? { port, browserPath } : undefined;
  }
  if (status === 404 && body === "") return { port, browserPath: "/devtools/browser" };
  return undefined;
}

/** GET /json/version on a loopback port. Undefined when the port does not answer. Does not open a WebSocket. */
export async function probeDevToolsVersion(port: number): Promise<VersionProbe | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    });
    return { status: response.status, body: (await response.text()).slice(0, 4096) };
  } catch {
    return undefined;
  }
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
