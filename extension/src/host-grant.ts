// One site at a time. Replay may ask for this shape and nothing broader.

export const DEFAULT_HOST_GRANT_MS = 90_000;
export const MAX_HOST_GRANT_MS = 10 * 60 * 1000;

/** A single http(s) origin. Wildcards and <all_urls> are rejected. */
export function specificHost(pattern: string): boolean {
  return /^https?:\/\/(?!\*)[^/*]+\/\*$/.test(pattern);
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
  return `Allow Bao on ${pattern} in the Chrome window. Click Allow sites. ${tail}`;
}

export function isHostGrantMessage(message: string): boolean {
  return message.startsWith("Allow Bao on ") && message.includes("Click Allow sites.");
}
