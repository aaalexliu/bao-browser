// Sentences the UI shows. None of these fields carry a cookie value.

import { vendorPhrase } from "./bot";
import { headline, type BotCookiePolicy, type PublicImportResult, type RejectedCookie } from "./types";

export function buildReport(input: {
  imported: number;
  signedIn: boolean;
  skippedBot: { name: string; vendor: string }[];
  policy: BotCookiePolicy;
  rejected: RejectedCookie[];
  failed: RejectedCookie[];
  skippedExpired: number;
  probed: boolean;
  probeError?: boolean;
  signInUrl: string;
  keychain: { title: string; body: string } | null;
  probeHow?: "selector" | "text" | "login-url";
  includedBot: number;
  localStorageItems?: number;
  indexedDbOrigins?: number;
  localStorageNames?: string[];
  indexedDbNames?: string[];
}): PublicImportResult {
  const message = (input.keychain
    ? "Bao did not load the site, because the cookies could not be decrypted."
    : explain(input)) + storageSentence(input.localStorageItems ?? 0, input.indexedDbOrigins ?? 0) + nameSentence(input.localStorageNames ?? [], input.indexedDbNames ?? []);
  return {
    imported: input.imported,
    signedIn: input.signedIn,
    headline: headline(input.imported, input.signedIn),
    skippedBot: input.skippedBot.length,
    skippedExpired: input.skippedExpired,
    rejected: input.rejected.map(publicReject),
    failed: input.failed.map(publicReject),
    message,
    offerSignIn: !input.signedIn,
    signInUrl: input.signInUrl,
    keychain: input.keychain,
    probed: input.probed,
    localStorageItems: input.localStorageItems ?? 0,
    indexedDbOrigins: input.indexedDbOrigins ?? 0,
  };
}

function explain(input: {
  imported: number;
  signedIn: boolean;
  skippedBot: { name: string; vendor: string }[];
  policy: BotCookiePolicy;
  rejected: RejectedCookie[];
  failed: RejectedCookie[];
  probed: boolean;
  probeError?: boolean;
  probeHow?: "selector" | "text" | "login-url";
  includedBot: number;
}): string {
  const reliable = "Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated.";
  if (input.probeError) {
    return `Bao could not load the probe page. ${reliable}`;
  }
  if (!input.probed && input.imported === 0) {
    if (input.policy === "skip" && input.skippedBot.length > 0 && input.failed.length === 0 && input.rejected.length === 0) {
      const who = vendorPhrase(input.skippedBot.map((item) => item.vendor));
      return `This site only had anti-bot cookies (${who}) for Bao to see. Bao skipped them. Skipping them is the default. ${reliable}`;
    }
    if (input.failed.length > 0) return `Bao could not decrypt the cookies for this site. ${reliable}`;
    if (input.rejected.length > 0) return `Chrome rejected the cookies for this site. ${reliable}`;
    return "This profile has no cookies Bao could import for the site. Sign in once in Bao's window.";
  }
  if (input.signedIn) {
    const check = input.probeHow === "selector"
      ? "The probe found the signed-in selector."
      : input.probeHow === "text"
        ? "The probe found the signed-in text."
        : "The probe did not land on a login URL.";
    const skipped = input.skippedBot.length
      ? ` Bao skipped ${input.skippedBot.length} anti-bot ${input.skippedBot.length === 1 ? "cookie" : "cookies"}.`
      : "";
    return `${check}${skipped}`;
  }
  if (input.policy === "skip" && input.skippedBot.length > 0) {
    const who = vendorPhrase(input.skippedBot.map((item) => item.vendor));
    return [
      `This site ties the session to its anti-bot cookies (${who}).`,
      "Bao skipped those cookies. Skipping them is the default, and the site sent Bao's Chrome to a login page.",
      reliable,
      "You can include anti-bot cookies for this site and import again. They are bound to the browser that received them, so the session often still fails.",
    ].join(" ");
  }
  if (input.policy === "include" && input.includedBot > 0) {
    return [
      "Bao imported the anti-bot cookies as well.",
      "The site still sent Bao's Chrome to a login page. Those cookies are tied to the browser that received them.",
      reliable,
    ].join(" ");
  }
  return `The session did not stick. ${reliable}`;
}

function storageSentence(items: number, origins: number): string {
  if (!items && !origins) return "";
  const parts: string[] = [];
  if (items) parts.push(`${items} localStorage ${items === 1 ? "item" : "items"}`);
  if (origins) parts.push(`${origins} IndexedDB ${origins === 1 ? "origin" : "origins"}`);
  return ` Restored ${parts.join(" and ")}.`;
}

function nameSentence(keys: string[], databases: string[]): string {
  const parts: string[] = [];
  if (keys.length) parts.push(`localStorage: ${keys.join(", ")}`);
  if (databases.length) parts.push(`IndexedDB: ${databases.join(", ")}`);
  return parts.length ? ` ${parts.join(". ")}.` : "";
}

function publicReject(item: RejectedCookie): RejectedCookie {
  return { name: item.name, host: item.host, reason: item.reason };
}
