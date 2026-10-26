// Replay asks for one origin. Allow all sites is a separate button on that page.
// A query string cannot name a wildcard. Nothing is granted at install.

export const DEFAULT_HOST_GRANT_MS = 90_000;
export const MAX_HOST_GRANT_MS = 10 * 60 * 1000;

/** Optional host permissions. Requested only from the Allow all sites click. */
export const ALL_SITE_ORIGINS = ["http://*/*", "https://*/*"] as const;

export type HostAccess = "all" | "site" | "none";

export type GrantPlan =
  | { action: "skip" }
  | { action: "prompt" }
  | { action: "needs_human"; message: string };

/** A single http(s) origin. Wildcards and <all_urls> are rejected. */
export function specificHost(pattern: string): boolean {
  return /^https?:\/\/(?!\*)[^/*]+\/\*$/.test(pattern);
}

export function allSiteOrigin(pattern: string): boolean {
  return pattern === "http://*/*" || pattern === "https://*/*";
}

/** Origins from an allow-page query string. Wildcards are dropped. */
export function specificOrigins(listed: string | null | undefined): string[] {
  if (!listed) return [];
  return listed.split(",").map((item) => item.trim()).filter((item) => specificHost(item));
}

export function hostGrantWait(value: unknown): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(raw, MAX_HOST_GRANT_MS);
  return DEFAULT_HOST_GRANT_MS;
}

export function hostGrantMessage(pattern: string, reason: "timeout" | "denied"): string {
  const tail = reason === "timeout"
    ? "The site was not granted in time."
    : "Chrome did not grant the site.";
  return `Allow Bao on ${pattern} in the Chrome window. Click Allow all sites or Only this site. ${tail}`;
}

export function isHostGrantMessage(message: string): boolean {
  if (!message.startsWith("Allow Bao on ")) return false;
  return message.includes("Click Allow all sites or Only this site.")
    || message.includes("Click Allow sites.");
}

export function hostAccessMode(value: unknown): HostAccess {
  return value === "all" || value === "site" || value === "none" ? value : "none";
}

/** Either wildcard is all sites, so Revoke stays available if one scheme is left. A single origin is per site. */
export function hostAccessFromOrigins(origins: readonly string[]): HostAccess {
  if (origins.some((origin) => allSiteOrigin(origin))) return "all";
  if (origins.some((origin) => specificHost(origin))) return "site";
  return "none";
}

export function hostAccessLabel(access: HostAccess): string {
  if (access === "all") return "all sites";
  if (access === "site") return "per site";
  return "none";
}

/** A granted wildcard covers later origins of that scheme. Replay then skips the prompt. */
export function grantedCovers(pattern: string, granted: readonly string[]): boolean {
  if (granted.includes(pattern)) return true;
  if (pattern.startsWith("https://") && granted.includes("https://*/*")) return true;
  if (pattern.startsWith("http://") && granted.includes("http://*/*")) return true;
  return false;
}

/**
 * All-sites covers every later origin, so replay does not open allow.html.
 * After revoke, a missing origin prompts again. A timeout is needs_human.
 */
export function hostGrantPlan(pattern: string, granted: readonly string[], grantMs: number): GrantPlan {
  if (!specificHost(pattern)) {
    return { action: "needs_human", message: "refusing a broad host permission" };
  }
  if (grantedCovers(pattern, granted)) return { action: "skip" };
  if (grantMs <= 0) return { action: "needs_human", message: hostGrantMessage(pattern, "timeout") };
  return { action: "prompt" };
}

/** A secret is typed only when the tab is still on the origin the workflow opened. */
export function secretStaysOnWorkflowOrigin(tabUrl: string, workflowOrigin: string): boolean {
  if (!workflowOrigin) return false;
  try {
    const tab = new URL(tabUrl);
    const pinned = new URL(workflowOrigin);
    if (tab.protocol !== "http:" && tab.protocol !== "https:") return false;
    if (pinned.protocol !== "http:" && pinned.protocol !== "https:") return false;
    return tab.origin === pinned.origin;
  } catch {
    return false;
  }
}
