/** Keep retired workflows out of every browser launcher. */
export const CDP_LIVE_DRIVER = "cdp-live";

export const CDP_LIVE_SERVER_REFUSAL =
  "this workflow used the retired live driver";

export const EXTENSION_NOT_CONNECTED = "extension is not connected";

export function refusesOwnedBrowser(driver: string | null | undefined): boolean {
  return driver === CDP_LIVE_DRIVER;
}

/** Why a replay must not run this workflow, or null. An extension workflow runs only through a linked extension. */
export function replayRefusal(driver: string | null | undefined, opts: { extensionLinked: boolean; pageEngine?: "old" | "agent-browser" }): string | null {
  if (refusesOwnedBrowser(driver)) return CDP_LIVE_SERVER_REFUSAL;
  if (opts.pageEngine === "agent-browser") return "pass-through sessions do not support saved workflow replay";
  if (driver === "extension" && !opts.extensionLinked) return EXTENSION_NOT_CONNECTED;
  return null;
}
