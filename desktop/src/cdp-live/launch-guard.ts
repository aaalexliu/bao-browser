/** cdp-live never starts Bao's Chrome. workflowDriver still maps unknown names to Playwright. */
export const CDP_LIVE_DRIVER = "cdp-live";

export const CDP_LIVE_SERVER_REFUSAL = "cdp-live attaches to the running Chrome; use the live attach";

export function refusesOwnedBrowser(driver: string | null | undefined): boolean {
  return driver === CDP_LIVE_DRIVER;
}
