import { statSync } from "node:fs";

export const RETIRED_LIVE_TOOL = {
  error: "The live_* tools were retired. Use agent_browser instead; start with command=open and args=[\"<url>\"].",
} as const;

export class McpVersionError extends Error {}

export function createMcpVersionCheck(entry: string): () => Promise<void> {
  const loaded = statSync(entry);
  return async () => {
    let installed: ReturnType<typeof statSync>;
    try { installed = statSync(entry); }
    catch { return; }
    if (installed.dev !== loaded.dev || installed.ino !== loaded.ino || installed.size !== loaded.size || installed.mtimeMs !== loaded.mtimeMs) {
      throw new McpVersionError("Bao was updated. Reconnecting its MCP server to load the installed tools.");
    }
  };
}
