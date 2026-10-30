// Driver choice for a remote run. workflowDriver is unchanged: absent and
// cdp-live still map to Playwright there. This function is the remote path.
// A cdp-live run goes through run_workflow with the app's live runner,
// replayLiveWorkflow in desktop/src/cdp-live/live-replay.ts.

export type RemoteDriverKind = "extension" | "cdp-live" | "playwright";

export function remoteDriverKind(driver: string | null | undefined): RemoteDriverKind {
  if (driver === "extension") return "extension";
  if (driver === "cdp-live") return "cdp-live";
  return "playwright";
}
