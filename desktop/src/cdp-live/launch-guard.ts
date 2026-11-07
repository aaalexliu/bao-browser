/** Keep retired workflows out of every browser launcher. */
export const CDP_LIVE_DRIVER = "cdp-live";

export const CDP_LIVE_SERVER_REFUSAL =
  "this workflow used the retired live driver";

export const EXTENSION_NOT_CONNECTED = "extension is not connected";

export function refusesOwnedBrowser(driver: string | null | undefined): boolean {
  return driver === CDP_LIVE_DRIVER;
}

export interface ReplayContext {
  extensionLinked: boolean;
  pageEngine?: "old" | "agent-browser";
}

export function workflowSearchEligible(workflow: { driver?: string | null; provenance?: string }, context: ReplayContext): boolean {
  return workflow.provenance !== "fixture" && !replayRefusal(workflow.driver, context);
}

export function replayRefusal(driver: string | null | undefined, opts: ReplayContext): string | null {
  if (refusesOwnedBrowser(driver)) return CDP_LIVE_SERVER_REFUSAL;
  if (opts.pageEngine === "agent-browser") return "pass-through sessions do not support saved workflow replay";
  if (driver === "extension" && !opts.extensionLinked) return EXTENSION_NOT_CONNECTED;
  return null;
}
