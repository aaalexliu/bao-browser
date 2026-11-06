/** Browser-safe types and display helpers for historical live-session records. */

export interface AuditRow {
  action: string;
  label: string;
  path: string;
  isTrusted: boolean | null;
  ms: number;
  at: number;
  shot: string;
  via: "ax" | "cdp";
}

export interface LiveStep {
  name: string;
  status: string;
  ms: number;
}

export interface LiveToolTiming {
  id: string;
  name: string;
  startedAt: number;
  ms: number;
  spans: Record<string, number>;
}

export interface LiveNavigationBlock {
  url: string;
  reason: "login_wall" | "stop-path";
}

export interface LiveSessionRecord {
  id: string;
  intent: string;
  allowCommit?: boolean;
  status: "running" | "passed" | "needs_human" | "failed" | "idle";
  host: string;
  updatedAt: number;
  steps: LiveStep[];
  audit: AuditRow[];
  tools?: LiveToolTiming[];
  note: string;
  navigationFailure?: { url: string; errorCode: string };
  navigationBlock?: LiveNavigationBlock;
}

export function shotName(index: number): string {
  return `shot-${String(index).padStart(3, "0")}.png`;
}

export function shotNameOk(name: string): boolean {
  return /^shot-\d{3}\.png$/.test(name);
}

export function liveShotUrl(name: string): string {
  return shotNameOk(name) ? `/api/live-session/shots/${name}` : "";
}

export const AUDIT_PAGE_SIZE = 40;

/** One window of a log. The file keeps every row; the view asks for a page. */
export function auditPage<T>(rows: readonly T[], page?: number, size = AUDIT_PAGE_SIZE): {
  rows: T[];
  page: number;
  pages: number;
  total: number;
} {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size) || 1);
  const last = pages - 1;
  const index = page == null ? last : Math.min(Math.max(0, Math.floor(page)), last);
  const start = index * size;
  return { rows: rows.slice(start, start + size), page: index, pages, total };
}

export function redactLabel(text: string): string {
  const clean = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\$\d+(?:\.\d{2})?/g, "")
    .replace(/\b\d{3,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (/@|\bstreet\b|\bavenue\b|\broad\b|\bapt\b|\bssn\b|\bpassword\b/i.test(clean)) return "";
  return clean.slice(0, 80);
}

function auditLabel(action: string, label: string): string {
  if (action === "start" || action === "navigate") {
    try {
      const url = new URL(label);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return `${url.origin}${redactLabel(url.pathname)}`.slice(0, 80);
      }
    } catch { /* A start result can be a page title rather than a URL. */ }
  }
  return redactLabel(label);
}

export function publicLiveSession(value: unknown): LiveSessionRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<LiveSessionRecord>;
  const status = raw.status;
  if (status !== "running" && status !== "passed" && status !== "needs_human" && status !== "failed" && status !== "idle") {
    return null;
  }
  const audit = Array.isArray(raw.audit) ? raw.audit.map((row) => ({
    action: redactLabel(String(row?.action || "")).slice(0, 40),
    label: auditLabel(String(row?.action || ""), String(row?.label || "")),
    path: String(row?.path || "").startsWith("/") ? String(row.path).slice(0, 120) : "",
    isTrusted: row?.isTrusted === true ? true : row?.isTrusted === false ? false : null,
    ms: Number.isFinite(row?.ms) ? Math.max(0, Math.round(Number(row.ms))) : 0,
    at: Number.isFinite(row?.at) ? Math.round(Number(row.at)) : 0,
    shot: shotNameOk(String(row?.shot || "")) ? String(row.shot) : "",
    via: row?.via === "ax" ? "ax" as const : "cdp" as const,
  })) : [];
  const failure = raw.navigationFailure;
  const navigationFailure = failure && typeof failure.url === "string" && /^(?:https?:|chrome-error:)/.test(failure.url)
    && typeof failure.errorCode === "string" && /^(?:(?:net::)?ERR_[A-Z0-9_]+|unknown)$/.test(failure.errorCode)
    ? { url: failure.url, errorCode: failure.errorCode } : undefined;
  const block = raw.navigationBlock;
  const navigationBlock = block && typeof block.url === "string" && /^https?:/.test(block.url)
    && (block.reason === "login_wall" || block.reason === "stop-path") ? { url: block.url, reason: block.reason } : undefined;
  const steps = Array.isArray(raw.steps) ? raw.steps.map((step) => ({
    name: redactLabel(String(step?.name || "")).slice(0, 40),
    status: String(step?.status || "").slice(0, 20),
    ms: Number.isFinite(step?.ms) ? Math.max(0, Math.round(Number(step.ms))) : 0,
  })) : [];
  return {
    id: String(raw.id || "").replace(/[^\w.-]/g, "").slice(0, 40),
    intent: redactLabel(String(raw.intent || "")).slice(0, 160),
    ...(raw.allowCommit === true ? { allowCommit: true } : {}),
    status: navigationFailure ? "failed" : navigationBlock ? "needs_human" : status,
    ...(navigationFailure ? { navigationFailure } : {}),
    ...(navigationBlock ? { navigationBlock } : {}),
    host: /^[\w.-]+$/.test(String(raw.host || "")) ? String(raw.host) : "",
    updatedAt: Number.isFinite(raw.updatedAt) ? Math.round(Number(raw.updatedAt)) : 0,
    steps,
    audit,
    ...(Array.isArray(raw.tools) ? { tools: raw.tools.map((tool) => ({
      id: String(tool.id || "").replace(/[^\w.-]/g, "").slice(0, 80),
      name: String(tool.name || "").replace(/[^\w]/g, "").slice(0, 40),
      startedAt: Number.isFinite(tool.startedAt) ? tool.startedAt : 0,
      ms: Number.isFinite(tool.ms) ? Math.max(0, tool.ms) : 0,
      spans: Object.fromEntries(Object.entries(tool.spans || {}).filter(([key, ms]) => /^[a-z]+$/.test(key) && Number.isFinite(ms) && ms >= 0)),
    })) } : {}),
    note: navigationFailure ? `Navigation failed: ${navigationFailure.errorCode} at ${navigationFailure.url}` : redactLabel(String(raw.note || "")).slice(0, 160),
  };
}
