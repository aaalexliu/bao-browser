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

const RULES: { reason: string; re: RegExp }[] = [
  { reason: "email", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { reason: "phone", re: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/g },
  { reason: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { reason: "address", re: /\b\d{1,5}\s+(?:\S+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr)\b/gi },
  { reason: "url secret", re: /([?&](?:token|key|password|session|code)=)[^&\s]+/gi },
];

export function redactForRelease(document: unknown): { document: unknown; changes: ReleaseChange[] } {
  const secrets = secretDefaults(document);
  const cloned = stripUnsafe(JSON.parse(JSON.stringify(document)), secrets) as Record<string, unknown>;
  const changes: ReleaseChange[] = [];
  if (secrets.length) {
    changes.push({ path: "inputs", before: "[secret]", after: "", reason: "secret" });
  }
  walkFields(cloned, "", changes);
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

function walkFields(node: unknown, path: string, changes: ReleaseChange[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkFields(item, `${path}[${index}]`, changes));
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of ["default", "value", "label", "text", "name", "match"]) {
    if (typeof obj[key] !== "string") continue;
    if (key === "value" && obj[key].includes("{{") && !personalReason(obj[key])) continue;
    const current = obj[key];
    const next = redactString(current, key !== "label");
    if (!next || next.text === current) continue;
    changes.push({ path: `${path}.${key}`, before: current, after: next.text, reason: next.reason });
    if (!next.text) delete obj[key];
    else obj[key] = next.text;
  }
  for (const [key, child] of Object.entries(obj)) {
    if (child && typeof child === "object") walkFields(child, path ? `${path}.${key}` : key, changes);
  }
}

function personalReason(value: string): string {
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(value)) return rule.reason;
  }
  if (luhnSpan(value)) return "card";
  return "";
}

function redactString(value: string, blank: boolean): { text: string; reason: string } | null {
  let reason = "";
  let text = value;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (!rule.re.test(text)) continue;
    reason = reason || rule.reason;
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, rule.reason === "url secret" ? "$1[redacted]" : "");
  }
  const card = luhnSpan(text);
  if (card) {
    reason = reason || "card";
    text = text.replace(card, "");
  }
  text = text.replace(/\s{2,}/g, " ").trim();
  if (!reason) return null;
  if (blank) return { text: text && !personalReason(text) ? "" : "", reason };
  if (!text) return { text: "[redacted]", reason };
  return { text, reason };
}

function luhnSpan(value: string): string {
  const match = value.match(/(?:\d[ -]?){13,19}/);
  if (!match) return "";
  const digits = match[0].replace(/[\s-]/g, "");
  if (digits.length < 13 || digits.length > 19) return "";
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0 ? match[0] : "";
}
