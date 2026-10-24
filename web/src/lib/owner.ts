// Single-owner sign-in. Both variables, or neither. The secret is never committed.
import { createHash, timingSafeEqual } from "node:crypto";

export class OwnerAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OwnerAuthError";
  }
}

export interface AuthEnv {
  NODE_ENV?: string;
  BAO_AUTH_STUB?: string;
  BAO_OWNER_EMAIL?: string;
  BAO_INVITE_SECRET?: string;
}

interface Owner {
  email: string;
  secret: string;
}

export function ownerConfig(env: AuthEnv = process.env): Owner | null {
  const email = (env.BAO_OWNER_EMAIL || "").trim().toLowerCase();
  const secret = (env.BAO_INVITE_SECRET || "").trim();
  if (!email && !secret) return null;
  if (!email || !secret) {
    throw new OwnerAuthError("Set both BAO_OWNER_EMAIL and BAO_INVITE_SECRET, or neither.", 500);
  }
  return { email, secret };
}

export function assertProductionAuth(env: AuthEnv = process.env): void {
  if (env.NODE_ENV === "production" && (env.BAO_AUTH_STUB || "").trim() !== "") {
    throw new OwnerAuthError(
      "BAO_AUTH_STUB is refused in production. Use BAO_OWNER_EMAIL and BAO_INVITE_SECRET.",
      500,
    );
  }
  ownerConfig(env);
}

export function assertOwnerSignIn(email: string, secret: string | undefined, env: AuthEnv = process.env): boolean {
  const owner = ownerConfig(env);
  if (!owner) return false;
  if (email.trim().toLowerCase() !== owner.email) {
    throw new OwnerAuthError("That email is not the owner email.", 403);
  }
  if (!secretMatches(secret, owner.secret)) {
    throw new OwnerAuthError("The invite secret is missing or wrong.", 403);
  }
  return true;
}

export function assertOwnerEmail(email: string, env: AuthEnv = process.env): void {
  const owner = ownerConfig(env);
  if (!owner) return;
  if (email.trim().toLowerCase() !== owner.email) {
    throw new OwnerAuthError("That email is not the owner email.", 403);
  }
}

export function assertInviteSecret(secret: string | undefined, env: AuthEnv = process.env): void {
  const owner = ownerConfig(env);
  if (!owner) return;
  if (!secretMatches(secret, owner.secret)) {
    throw new OwnerAuthError("The invite secret is missing or wrong.", 403);
  }
}

// The link is returned only after the owner secret matches, or on a local build.
// A production process with BAO_AUTH_STUB set must not hand the link out.
export function magicLinkVisible(env: AuthEnv, ownerProved: boolean): boolean {
  if (env.NODE_ENV === "production" && (env.BAO_AUTH_STUB || "").trim() !== "") return false;
  if (ownerProved) return true;
  return env.BAO_AUTH_STUB === "1" || env.NODE_ENV !== "production";
}

export type ProtectionScope = "standard" | "all" | "off";
export type SyncUrlKind = "production-domain" | "preview" | "deployment-url";

// Vercel Deployment Protection authenticates every request to a URL it covers.
// The Mac sends a device token, which is not a Vercel login.
// Standard Protection leaves production domains open and restricts preview URLs
// and the generated deployment URL. All Deployments restricts the production
// domain as well. https://vercel.com/docs/deployment-protection
export function deviceSyncAllowed(scope: ProtectionScope, url: SyncUrlKind): boolean {
  if (scope === "off") return true;
  if (scope === "all") return false;
  return url === "production-domain";
}

function secretMatches(given: string | undefined, expected: string): boolean {
  const a = createHash("sha256").update((given || "").trim(), "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
