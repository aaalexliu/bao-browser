/** cdp-live never starts Bao's Chrome. workflowDriver still maps unknown names to Playwright. */
export const CDP_LIVE_DRIVER = "cdp-live";

export const CDP_LIVE_SERVER_REFUSAL =
  "a cdp-live workflow replays only in the live Chrome, through the running Bao app or bao mcp's run_workflow, never in Bao's own Chrome";

export const EXTENSION_NOT_CONNECTED = "extension is not connected";

export function refusesOwnedBrowser(driver: string | null | undefined): boolean {
  return driver === CDP_LIVE_DRIVER;
}

/** Why a replay must not run this workflow, or null. An extension workflow runs only through a linked extension. */
export function replayRefusal(driver: string | null | undefined, opts: { extensionLinked: boolean; pageEngine?: "old" | "agent-browser" }): string | null {
  if (refusesOwnedBrowser(driver)) return CDP_LIVE_SERVER_REFUSAL;
  if (opts.pageEngine === "agent-browser") return "profile-copy runs use a recorded live workflow; start one with Bao's live tools";
  if (driver === "extension" && !opts.extensionLinked) return EXTENSION_NOT_CONNECTED;
  return null;
}
