// Per-site trust for ordinary clicks and typing.
// Confirm and login stay on the confirm policy and do not read this.

import type { WorkflowStep } from "./schema";

export type SiteTrustMode = "ask" | "allow";

export function originOf(startUrl: string | undefined): string {
  if (!startUrl) return "";
  try {
    const url = new URL(startUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function trustMode(
  settings: { siteTrust?: Record<string, string> } | undefined,
  origin: string,
): SiteTrustMode | undefined {
  const mode = origin ? settings?.siteTrust?.[origin] : undefined;
  return mode === "ask" || mode === "allow" ? mode : undefined;
}

/** A confirm or login step. Site trust does not press it. */
export function consequential(step: Pick<WorkflowStep, "action" | "human">): boolean {
  return step.action === "confirm" || step.action === "login" || step.human === true;
}

export function sitesForTrust(
  workflows: { startUrl?: string }[],
  stored: Record<string, string> | undefined,
): { origin: string; mode: SiteTrustMode }[] {
  const origins = new Set<string>();
  for (const workflow of workflows) {
    const origin = originOf(workflow.startUrl);
    if (origin) origins.add(origin);
  }
  for (const origin of Object.keys(stored || {})) {
    if (originOf(origin) === origin) origins.add(origin);
  }
  return [...origins].sort().map((origin) => ({
    origin,
    mode: stored?.[origin] === "ask" ? "ask" : "allow",
  }));
}

export function cleanSiteTrust(value: unknown): Record<string, SiteTrustMode> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const next: Record<string, SiteTrustMode> = {};
  for (const [origin, mode] of Object.entries(value as Record<string, unknown>)) {
    if ((mode === "ask" || mode === "allow") && originOf(origin) === origin) next[origin] = mode;
  }
  return next;
}
