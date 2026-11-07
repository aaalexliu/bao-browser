const DROP_KEY = /^(cookie|cookies|set-cookie|setcookie|authorization|proxy-authorization|password|secret|passwd)$/i;

export function redactAudit(value: unknown): unknown {
  return walk(value);
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
