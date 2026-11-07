import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { serverPort } from "../home";

export const RETIRED_LIVE_TOOL = {
  error: "The live_* tools were retired. Use agent_browser instead; start with command=open and args=[\"<url>\"].",
} as const;

export function mcpVersion(contract: unknown): string {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

export class McpVersionError extends Error {
  constructor(message: string, readonly restart: boolean) {
    super(message);
  }
}

export function createMcpVersionCheck(version: string, entry: string, args: readonly string[], env: NodeJS.ProcessEnv): () => Promise<void> {
  const loaded = statSync(entry);
  return async () => {
    let installed: ReturnType<typeof statSync>;
    try { installed = statSync(entry); }
    catch { return; }
    if (installed.dev !== loaded.dev || installed.ino !== loaded.ino || installed.size !== loaded.size || installed.mtimeMs !== loaded.mtimeMs) {
      throw new McpVersionError("Bao was updated. Reconnecting its MCP server to load the installed tools.", true);
    }
    const port = serverPort(args, env);
    if (!port) return;
    let response: Response;
    try { response = await fetch(`http://127.0.0.1:${port}/api/mcp/version`, { signal: AbortSignal.timeout(1500) }); }
    catch { return; } // Current tools also work without a running app.
    const body = await response.json().catch(() => null) as { version?: unknown } | null;
    if (!response.ok || typeof body?.version !== "string") return;
    if (body.version !== version) throw new McpVersionError("The running Bao app is a different version from this tool server. Quit and reopen Bao.", false);
  };
}
