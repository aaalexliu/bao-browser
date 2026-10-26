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
