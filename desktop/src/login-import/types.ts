// Public shapes for "import this site's login". Cookie values never appear here.

export interface ImportClick {
  site: string;
  clicked: true;
}

export type BotCookiePolicy = "skip" | "include";

export interface SiteLoginConfig {
  origin: string;
  probeUrl: string;
  signedInSelector: string;
  signedInText: string;
  botCookies: BotCookiePolicy;
  /** Extra origins on the same host. Other hosts are ignored. */
  origins: string[];
}

export interface PublicProfile {
  directory: string;
  name: string;
  email: string;
  avatarDataUrl: string | null;
  matching: number;
  expired: number;
  botManager: number;
  willImport: number;
  localStorageItems: number;
  indexedDbOrigins: number;
  cookieDb: "network" | "legacy" | "missing";
}

export interface PublicPreview {
  site: string;
  host: string;
  botCookies: BotCookiePolicy;
  profiles: PublicProfile[];
  chromeFound: boolean;
  keychainNote: { title: string; body: string } | null;
}

export interface RejectedCookie {
  name: string;
  host: string;
  reason: string;
}

export interface PublicImportResult {
  imported: number;
  signedIn: boolean;
  headline: string;
  skippedBot: number;
  skippedExpired: number;
  rejected: RejectedCookie[];
  failed: RejectedCookie[];
  message: string;
  offerSignIn: boolean;
  signInUrl: string;
  keychain: { title: string; body: string } | null;
  probed: boolean;
  localStorageItems: number;
  indexedDbOrigins: number;
}

export class ConsentRequired extends Error {
  constructor() {
    super("Bao reads a Chrome profile only after you click import for one site.");
    this.name = "ConsentRequired";
  }
}

export function headline(imported: number, signedIn: boolean): string {
  return `Imported ${imported}. Signed in: ${signedIn ? "yes" : "no"}.`;
}
