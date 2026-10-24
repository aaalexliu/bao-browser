/** Stable JSON. Key order is sorted so interpret output can be compared byte for byte. */

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = sortValue(child);
  }
  return out;
}

export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const child of value) stringsIn(child, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) stringsIn(child, out);
  }
  return out;
}
