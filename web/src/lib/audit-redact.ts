import { scrubSaved } from "../../../shared/saved-secrets";

const DROP_KEY = /^(cookie|cookies|set-cookie|setcookie|authorization|proxy-authorization|password|secret|passwd)$/i;

export function redactAudit(value: unknown): unknown {
  const args = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  return walk(scrubSaved(value, { args }));
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!DROP_KEY.test(key)) next[key] = walk(child);
  }
  return next;
}
