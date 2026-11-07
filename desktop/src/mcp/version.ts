import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { serverPort } from "../home";

export const RETIRED_LIVE_TOOL = {
  code: "tool_retired",
  replacement: "agent_browser",
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
  const loaded = readFileSync(entry, "utf8");
  return async () => {
    let installed: string;
    try { installed = readFileSync(entry, "utf8"); }
    catch { throw new McpVersionError("Bao was updated. Reconnecting its MCP server to load the installed tools.", true); }
    if (installed !== loaded) throw new McpVersionError("Bao was updated. Reconnecting its MCP server to load the installed tools.", true);
    const port = serverPort(args, env);
    if (!port) return;
    let response: Response;
    try { response = await fetch(`http://127.0.0.1:${port}/api/mcp/version`, { signal: AbortSignal.timeout(1500) }); }
    catch { return; } // Current tools also work without a running app.
    if (response.status === 404) throw new McpVersionError("The running Bao app predates MCP version checks. Update and reopen Bao before using its tools.", false);
    const body = await response.json().catch(() => null) as { version?: unknown } | null;
    if (!response.ok || typeof body?.version !== "string") throw new McpVersionError("The running Bao app returned no MCP version. Reopen Bao before using its tools.", false);
    if (body.version !== version) throw new McpVersionError("Bao's app and MCP tool versions differ. Reconnecting its MCP server to load the installed tools.", true);
  };
}
