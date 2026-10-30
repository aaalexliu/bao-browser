// T1 masking. content.ts and the proxy audit trail both call this so a typed
// card, SSN, or password is withheld the same way in both places.

export const SENSITIVE_AC = new Set([
  "current-password", "new-password", "cc-number", "cc-csc", "cc-exp",
  "cc-exp-month", "cc-exp-year", "one-time-code",
]);

export const SENSITIVE_RE = /pass(word|code)|\bssn\b|social.?security|credit.?card|card.?number|\bcc-?num|\bcvv\b|\bcvc\b|security.?code|\botp\b|one.?time.?code|routing.?number|\bpin\b/i;

export interface FieldHint {
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  value?: string;
}

export function luhnCard(v: string): boolean {
  const d = v.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(d)) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i]!;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

/** Value-shape net: exact SSN, or a Luhn-valid card. Field names are separate. */
export function isSensitiveValue(value: string): boolean {
  if (/^\s*\d{3}-?\d{2}-?\d{4}\s*$/.test(value)) return true;
  return luhnCard(value);
}

export function isSensitiveField(hint: FieldHint): boolean {
  if ((hint.type || "").toLowerCase() === "password") return true;
  const ac = (hint.autocomplete || "").toLowerCase().trim();
  if (SENSITIVE_AC.has(ac)) return true;
  const hay = [hint.name, hint.id, hint.autocomplete, hint.ariaLabel, hint.placeholder]
    .filter(Boolean)
    .join(" ");
  if (SENSITIVE_RE.test(hay)) return true;
  return isSensitiveValue(hint.value || "");
}

export function isSensitiveElement(el: Element): boolean {
  const input = el instanceof HTMLInputElement ? el : null;
  return isSensitiveField({
    type: input?.type || "",
    autocomplete: el.getAttribute("autocomplete") || "",
    name: el.getAttribute("name") || "",
    id: el.id || "",
    ariaLabel: el.getAttribute("aria-label") || "",
    placeholder: el.getAttribute("placeholder") || "",
    value: (el as HTMLInputElement).value || "",
  });
}

/**
 * Copy a vendor payload with sensitive strings removed. The key is omitted,
 * matching maskStep, which deletes `value` rather than storing a placeholder.
 */
export function redactPayload(value: unknown): { value: unknown; sensitive: boolean } {
  let sensitive = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (isSensitiveValue(v)) {
        sensitive = true;
        return undefined;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        const next = walk(child);
        if (next === undefined && typeof child === "string") continue;
        out[k] = next;
      }
      return out;
    }
    return v;
  };
  return { value: walk(value), sensitive };
}

/** Drop one known secret even when its shape is not a card or SSN (a password). */
export function omitSecret(value: unknown, secret: string): unknown {
  if (!secret) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v === secret ? undefined : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        const next = walk(child);
        if (next === undefined && typeof child === "string") continue;
        out[k] = next;
      }
      return out;
    }
    return v;
  };
  return walk(value);
}
