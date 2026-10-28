// Driver choice for a remote run. workflowDriver is unchanged: absent and
// cdp-live still map to Playwright there. This function is the remote path.

import { CDP_LIVE_SERVER_REFUSAL } from "../cdp-live/launch-guard";
import { openLiveWindow } from "../cdp-live/driver";
import { DEVTOOLS_ACTIVE_PORT, readDevToolsActivePort } from "../cdp-live/endpoint";
import { connectCdp } from "../cdp-live/socket";
import { unavailableHeal } from "./heal";
import { replay } from "./replay";
import type { Library } from "./store";

export type RemoteDriverKind = "extension" | "cdp-live" | "playwright";

export function remoteDriverKind(driver: string | null | undefined): RemoteDriverKind {
  if (driver === "extension") return "extension";
  if (driver === "cdp-live") return "cdp-live";
  return "playwright";
}

function portFile(env: NodeJS.ProcessEnv): string {
  return env.BAO_CDP_PORT_FILE || DEVTOOLS_ACTIVE_PORT;
}

/**
 * Attach to a Chrome that is already listening. This does not launch a browser.
 * Tests set BAO_CDP_PORT_FILE to a throwaway DevToolsActivePort. The default
 * path is the installed Chrome file, and only a cdp-live workflow reads it.
 */
export async function runCdpLiveWorkflow(
  library: Library,
  id: string,
  inputs: Record<string, string | number>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  let workflow;
  try {
    workflow = library.read(id);
  } catch (err) {
    return { outcome: "failed", workflowId: id, reason: err instanceof Error ? err.message : "workflow" };
  }
  if (workflow.driver !== "cdp-live") {
    return { outcome: "failed", workflowId: id, reason: CDP_LIVE_SERVER_REFUSAL };
  }
  try {
    const endpoint = await readDevToolsActivePort(portFile(env));
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 20_000 });
    try {
      const driver = await openLiveWindow(cdp);
      try {
        if (workflow.startUrl.startsWith("http")) await driver.goto(workflow.startUrl);
        const result = await replay(workflow, inputs, driver, {
          runId: `relay-cdp-${Date.now().toString(36)}`,
          now: () => Date.now(),
          heal: unavailableHeal(),
          siteTrust: "allow",
          holdForPerson: false,
        });
        const outcome = result.status === "passed" ? "ok" : result.status === "paused" ? "needs_human" : "failed";
        return {
          outcome,
          status: result.status,
          workflowId: id,
          runId: result.runId,
          outputs: result.outputs,
          reason: result.failure?.reason,
        };
      } finally {
        await driver.end().catch(() => undefined);
      }
    } finally {
      cdp.close();
    }
  } catch (err) {
    return { outcome: "failed", workflowId: id, reason: err instanceof Error ? err.message : String(err) };
  }
}
