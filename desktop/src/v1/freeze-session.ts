// Local fixture session. The cookie is a random token. The password is never stored.

import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "bao_freeze";
export const PENDING_COOKIE = "bao_freeze_pending";
export const SESSION_TTL_MS = 30 * 60 * 1000;

export interface FreezeSession {
  token: string;
  user: string;
  exp: number;
}

export type SessionStatus = "missing" | "expired" | "ok";

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** A present token that is unknown or past `exp` is expired. No token is missing. */
export function sessionStatus(
  token: string | undefined,
  sessions: ReadonlyMap<string, { exp: number }>,
  now: number,
): SessionStatus {
  if (!token) return "missing";
  const session = sessions.get(token);
  if (!session || session.exp <= now) return "expired";
  return "ok";
}

export function newToken(): string {
  return randomBytes(18).toString("hex");
}

export function sessionExpiry(now: number, ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return now - 1;
  return now + Math.min(ttlMs, SESSION_TTL_MS);
}

/** Only a local /freeze path. Anything else stays on /freeze. */
export function safeNext(value: string | undefined): string {
  if (!value) return "/freeze";
  if (!value.startsWith("/freeze")) return "/freeze";
  if (value.startsWith("//") || value.includes("\\") || value.includes("://")) return "/freeze";
  return value.slice(0, 200);
}

export function loginRedirect(nextPath: string, verify: boolean): string {
  const params = new URLSearchParams();
  params.set("next", safeNext(nextPath));
  if (verify) params.set("verify", "1");
  return `/login?${params.toString()}`;
}

export function cookieHeader(name: string, token: string, maxAgeSec: number): string {
  const age = Math.max(0, Math.floor(maxAgeSec));
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`;
}

/** The verify stage is in the file only while the flag is on. */
export function loginDocument(template: string, verify: boolean): string {
  if (verify) return template;
  return template.replace(/<section id="stage-code"[\s\S]*?<\/section>\s*/, "");
}
