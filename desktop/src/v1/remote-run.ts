// Preserve the retired driver tag so the remote path refuses it before launch.

export type RemoteDriverKind = "extension" | "cdp-live" | "playwright";

export function remoteDriverKind(driver: string | null | undefined): RemoteDriverKind {
  if (driver === "extension") return "extension";
  if (driver === "cdp-live") return "cdp-live";
  return "playwright";
}
