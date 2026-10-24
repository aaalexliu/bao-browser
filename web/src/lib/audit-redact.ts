// What may be stored for a remote job. Cookies, secrets, resume capabilities,
// and screenshot bytes stay out of the audit row.

const DROP_KEY = /^(cookie|cookies|set-cookie|setcookie|authorization|proxy-authorization|password|secret|passwd)$/i;
const RESUME_KEY = /^(resume|resume_token)$/i;
const SHOT_KEY = /^(screenshot|png|image|image_data)$/i;

export interface RedactOptions {
  /** The caller of /mcp still needs the resume token. The audit row does not. */
  keepResume?: boolean;
  keepScreenshot?: boolean;
}

export function redactAudit(value: unknown, options: RedactOptions = {}): unknown {
  return walk(value, options);
}

function walk(value: unknown, options: RedactOptions): unknown {
  if (typeof value === "string") {
    if (value.startsWith("iVBORw0KGgo") || value.includes("iVBORw0KGgo")) return "redacted";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, options));
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEY.test(key)) continue;
    if (RESUME_KEY.test(key) && !options.keepResume) continue;
    if (SHOT_KEY.test(key) && !options.keepScreenshot) continue;
    next[key] = walk(child, options);
  }
  return next;
}
