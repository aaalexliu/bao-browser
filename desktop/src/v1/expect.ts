// Infer a step check from effects the trail recorded.
// Order: text that appeared in the target subtree, then a value or checked
// change, then a URL change. A URL template uses a param only when the
// recorded URL contained that typed value as a query value or path segment.
// When none of those happened, the step expects the page to settle and is
// marked low-confidence. A browser error page is not an effect.

import type { Expectation, Identity, Postcondition, WorkflowStep } from "./schema";

export const SETTLED_EXPECT = "no error and the page settled";

export interface KnownTyped {
  name: string;
  value: string;
}

export interface ExpectEvent {
  op: string;
  performed?: boolean;
  value?: string;
  checked?: boolean;
  beforeUrl?: string;
  afterUrl?: string;
  afterText?: string;
  subtreeBefore?: string;
  subtreeAfter?: string;
  valueBefore?: string;
  valueAfter?: string;
  identity?: Identity;
}

export interface ExpectResult {
  postcondition?: Postcondition;
  expect?: Expectation;
  confidence?: "low";
}

export function inferExpect(
  event: ExpectEvent,
  opts: { input?: string; secret?: boolean; known: readonly KnownTyped[]; secrets: readonly string[] },
): ExpectResult {
  if (event.performed === false) {
    if (!event.identity) return {};
    return { postcondition: { kind: "element", identity: event.identity, timeoutMs: 4000 } };
  }
  const secrets = opts.secrets.filter(Boolean);
  const known = opts.known.filter((item) => item.value && !secrets.includes(item.value));
  if (opts.input && event.value && !opts.secret && !secrets.includes(event.value)) {
    known.push({ name: opts.input, value: event.value });
  }
  const errorPage = isBrowserError(event.afterUrl);
  if (!errorPage) {
    const appeared = scrub(appearedText(event.subtreeBefore, event.subtreeAfter), secrets);
    if (appeared) return textCheck(templateText(appeared, known));
    const after = scrub(event.afterText, secrets);
    if (after && after !== ownLabel(event.identity)) return textCheck(templateText(after, known));
  }
  if (!opts.secret && isTypeOp(event.op) && event.value && !secrets.includes(event.value)) {
    return valueCheck(opts.input ? `{{${opts.input}}}` : event.value);
  }
  if (!opts.secret && event.valueBefore != null && event.valueAfter != null && event.valueBefore !== event.valueAfter) {
    const next = scrub(event.valueAfter, secrets);
    if (next) return valueCheck(templateText(next, known));
  }
  if (typeof event.checked === "boolean" && event.identity) {
    return {
      expect: {
        kind: "state",
        state: event.checked ? "checked" : "unchecked",
        identity: event.identity,
        timeoutMs: 4000,
      },
    };
  }
  if (!errorPage) {
    const url = urlCheck(event.beforeUrl, event.afterUrl, known, secrets);
    if (url) return { postcondition: { kind: "url", match: url, timeoutMs: 8000 }, expect: { kind: "url", match: url, timeoutMs: 8000 } };
  }
  return {
    expect: { kind: "settled", match: SETTLED_EXPECT, timeoutMs: 4000 },
    confidence: "low",
  };
}

export function applyExpect(
  step: WorkflowStep,
  event: ExpectEvent,
  opts: { input?: string; secret?: boolean; known: readonly KnownTyped[]; secrets: readonly string[] },
): WorkflowStep {
  const result = inferExpect({ ...event, identity: step.identity ?? event.identity }, opts);
  return {
    ...step,
    ...(result.postcondition ? { postcondition: result.postcondition } : {}),
    ...(result.expect ? { expect: result.expect } : {}),
    ...(result.confidence ? { confidence: result.confidence } : {}),
  };
}

function textCheck(match: string): ExpectResult {
  return {
    postcondition: { kind: "text", match, timeoutMs: 4000 },
    expect: { kind: "text", match, timeoutMs: 4000 },
  };
}

function valueCheck(match: string): ExpectResult {
  return { postcondition: { kind: "value", match, timeoutMs: 4000 } };
}

function isTypeOp(op: string): boolean {
  return op === "type" || op === "input" || op === "osType" || op === "osSetValue";
}

function ownLabel(identity: Identity | undefined): string {
  return flat(identity?.text || identity?.name || identity?.label || "");
}

function appearedText(before: string | undefined, after: string | undefined): string | undefined {
  if (after == null || before == null) return undefined;
  const next = flat(after);
  const prev = flat(before);
  if (!next || next === "\u0000" || next === prev) return undefined;
  if (!prev) return next.slice(0, 80);
  if (next.startsWith(prev) && /^\s/.test(next.slice(prev.length))) {
    const extra = next.slice(prev.length).trim();
    return extra ? extra.slice(0, 80) : undefined;
  }
  return next.slice(0, 80);
}

function templateText(text: string, known: readonly KnownTyped[]): string {
  const exact = [...known].reverse().find((item) => item.value === text);
  if (exact) return `{{${exact.name}}}`;
  const inner = [...known].reverse().find((item) => item.value.length >= 3 && text.includes(item.value));
  if (!inner) return text;
  return text.split(inner.value).join(`{{${inner.name}}}`);
}

function urlCheck(
  beforeUrl: string | undefined,
  afterUrl: string | undefined,
  known: readonly KnownTyped[],
  secrets: string[],
): string | undefined {
  if (!beforeUrl || !afterUrl || beforeUrl === afterUrl) return undefined;
  const cleaned = scrub(afterUrl, secrets);
  if (!cleaned || isBrowserError(cleaned)) return undefined;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const query: string[] = [];
  let templated = false;
  for (const [key, raw] of url.searchParams) {
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep the raw value */ }
    const hit = [...known].reverse().find((item) => item.value === decoded);
    if (hit) {
      templated = true;
      query.push(`${key}={{${hit.name}}}`);
    } else {
      query.push(`${key}=${raw}`);
    }
  }
  const segments = url.pathname.split("/");
  const path = segments.map((seg) => {
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch { /* keep the raw segment */ }
    const hit = [...known].reverse().find((item) => item.value && item.value === decoded);
    if (!hit) return seg;
    templated = true;
    return `{{${hit.name}}}`;
  }).join("/");
  if (templated) {
    const templatedQuery = query.filter((part) => part.includes("{{"));
    if (templatedQuery.length && path.split("/").some((seg) => seg.includes("{{"))) {
      return `${path}?${templatedQuery.join("&")}`;
    }
    if (templatedQuery.length) return templatedQuery.join("&");
    return path;
  }
  if (!path || path === "/") return undefined;
  return path;
}

export function isBrowserError(url: string | undefined): boolean {
  if (!url) return false;
  return /^chrome-error:/i.test(url) || /chromewebdata/i.test(url) || /^about:neterror/i.test(url);
}

function scrub(value: string | undefined, secrets: readonly string[]): string | undefined {
  if (!value) return undefined;
  let out = value;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("");
  }
  const flatText = out.trim();
  return flatText ? out : undefined;
}

function flat(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
