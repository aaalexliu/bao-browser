// Chrome rejects an entire Storage.setCookies batch when one cookie is invalid.
// Network.setCookie is one cookie per call, so a bad __Host- row does not drop
// the session cookie that follows it.

import type { DecryptedCookie } from "./read";

export interface SetCookieCall {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

export interface CookieSetter {
  setOne(cookie: SetCookieCall): Promise<{ success: boolean }>;
}

export interface SetOutcome {
  name: string;
  host: string;
  ok: boolean;
  reason?: string;
}

export function toSetCookie(cookie: DecryptedCookie): { ok: true; call: SetCookieCall } | { ok: false; reason: string } {
  const hostOnly = !cookie.hostKey.startsWith(".");
  const host = cookie.hostKey.replace(/^\./, "");
  const path = cookie.path.startsWith("/") ? cookie.path : `/${cookie.path}`;
  if (cookie.name.startsWith("__Host-") && (!cookie.secure || path !== "/" || !hostOnly)) {
    return { ok: false, reason: "__Host- cookies need Secure, Path=/, and no Domain" };
  }
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) {
    return { ok: false, reason: "__Secure- cookies need Secure" };
  }
  const sameSite = mapSameSite(cookie.sameSite);
  if (sameSite === "None" && !cookie.secure) {
    return { ok: false, reason: "SameSite=None cookies need Secure" };
  }
  const call: SetCookieCall = {
    name: cookie.name,
    value: cookie.value,
    url: `${cookie.secure ? "https" : "http"}://${host}${path}`,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
  if (!hostOnly) call.domain = cookie.hostKey.startsWith(".") ? cookie.hostKey : `.${cookie.hostKey}`;
  if (sameSite) call.sameSite = sameSite;
  if (cookie.expiresUnix && cookie.expiresUnix > 0) call.expires = cookie.expiresUnix;
  if (cookie.partitionKey) call.partitionKey = cookie.partitionKey;
  return { ok: true, call };
}

export async function setCookiesOneAtATime(setter: CookieSetter, cookies: DecryptedCookie[]): Promise<SetOutcome[]> {
  const outcomes: SetOutcome[] = [];
  for (const cookie of cookies) {
    const prepared = toSetCookie(cookie);
    if (!prepared.ok) {
      outcomes.push({ name: cookie.name, host: cookie.hostKey, ok: false, reason: prepared.reason });
      continue;
    }
    try {
      const result = await setter.setOne(prepared.call);
      outcomes.push({
        name: cookie.name,
        host: cookie.hostKey,
        ok: result.success === true,
        reason: result.success === true ? undefined : "Chrome rejected this cookie",
      });
    } catch {
      outcomes.push({ name: cookie.name, host: cookie.hostKey, ok: false, reason: "Chrome rejected this cookie" });
    }
  }
  return outcomes;
}

export function cdpCookieSetter(send: (method: string, params: SetCookieCall) => Promise<{ success?: boolean }>): CookieSetter {
  return {
    async setOne(cookie) {
      const result = await send("Network.setCookie", cookie);
      return { success: result.success === true };
    },
  };
}

function mapSameSite(value: number): "Strict" | "Lax" | "None" | undefined {
  if (value === 0) return "None";
  if (value === 1) return "Lax";
  if (value === 2) return "Strict";
  return undefined;
}
