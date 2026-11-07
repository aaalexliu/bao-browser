import { statSync } from "node:fs";

export const RETIRED_LIVE_TOOL = {
  error: "The live_* tools were retired. Use agent_browser instead; start with command=open and args=[\"<url>\"].",
} as const;

export class McpVersionError extends Error {}

export const MCP_UPDATE_POLL_MS = 2000;

export function createMcpVersionCheck(entry: string): () => Promise<void> {
  const identity = (): string => {
    const { dev, ino, size, mtimeMs } = statSync(entry);
    return `${dev}:${ino}:${size}:${mtimeMs}`;
  };
  const loaded = identity();
  let replacement: string | undefined;
  let seenAt = 0;
  return async () => {
    let installed: string;
    try { installed = identity(); }
    catch { replacement = undefined; return; }
    if (installed === loaded) {
      replacement = undefined;
      return;
    }
    if (installed !== replacement) {
      replacement = installed;
      seenAt = performance.now();
      return;
    }
    if (performance.now() - seenAt >= MCP_UPDATE_POLL_MS) {
      throw new McpVersionError("Bao was updated. This Bao tool server is stopping so your agent app can start the updated one. If Bao tools do not come back, restart the Bao connection in your agent app.");
    }
  };
}
