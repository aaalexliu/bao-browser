// Sharing and publishing clear personal values. The preview is the diff the
// author sees before anything becomes public or installable.

import { createHash } from "node:crypto";
import { stripUnsafe } from "./guard";

export interface ReleaseChange {
  path: string;
  before: string;
  after: string;
  reason: string;
}

export function redactForRelease(document: unknown): { document: unknown; changes: ReleaseChange[] } {
  const secrets = secretDefaults(document);
  const cloned = stripUnsafe(document, secrets) as Record<string, unknown>;
  const changes: ReleaseChange[] = [];
  if (secrets.length) {
    changes.push({ path: "inputs", before: "[secret]", after: "", reason: "secret" });
  }
  return { document: cloned, changes };
}

export function domainsOf(document: unknown): string[] {
  const hosts = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return;
    try {
      const host = new URL(value).hostname;
      if (host) hosts.add(host);
    } catch {
      /* not a url */
    }
  };
  const doc = document as { startUrl?: string; steps?: { value?: string; postcondition?: { match?: string } }[] };
  add(doc?.startUrl);
  for (const step of doc?.steps ?? []) {
    add(step.value);
    add(step.postcondition?.match);
  }
  return [...hosts];
}

export function categoryFor(document: unknown, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const host = domainsOf(document)[0] || "";
  if (host.includes("wikipedia")) return "Research";
  if (host.includes("mozilla")) return "Reference";
  if (host.includes("httpbin")) return "Forms";
  if (host === "127.0.0.1" || host === "localhost") return "Fixture";
  return "General";
}

export function releaseHash(document: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(document))).digest("hex");
}

export function summaryOf(document: unknown): string {
  const steps = (document as { steps?: { label?: string }[] }).steps ?? [];
  const labels = steps.map((step) => step.label).filter((label): label is string => !!label);
  return labels.slice(0, 8).join(", ");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = sortValue(child);
  }
  return out;
}

function secretDefaults(document: unknown): string[] {
  const out: string[] = [];
  const inputs = (document as { inputs?: { type?: string; default?: string; value?: string }[] }).inputs ?? [];
  for (const input of inputs) {
    if (input.type !== "secret") continue;
    if (input.default) out.push(input.default);
    if (input.value) out.push(input.value);
  }
  return out;
}
