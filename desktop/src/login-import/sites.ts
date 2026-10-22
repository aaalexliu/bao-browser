// Per-site probe URL, signed-in check, and bot-cookie policy. Skip is the default.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { BotCookiePolicy, SiteLoginConfig } from "./types";

interface FileShape {
  sites: SiteLoginConfig[];
}

export class SiteStore {
  constructor(private readonly file: string) {}

  list(): SiteLoginConfig[] {
    return this.read().sites;
  }

  get(origin: string): SiteLoginConfig {
    const found = this.read().sites.find((site) => site.origin === origin);
    return found ?? { origin, probeUrl: origin, signedInSelector: "", signedInText: "", botCookies: "skip", origins: [] };
  }

  has(origin: string): boolean {
    return this.read().sites.some((site) => site.origin === origin);
  }

  save(record: SiteLoginConfig): SiteLoginConfig {
    const next = normalize(record);
    const data = this.read();
    const index = data.sites.findIndex((site) => site.origin === next.origin);
    if (index >= 0) data.sites[index] = next;
    else data.sites.push(next);
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(data, null, 2));
    return next;
  }

  private read(): FileShape {
    if (!existsSync(this.file)) return { sites: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as FileShape;
      return { sites: Array.isArray(parsed.sites) ? parsed.sites.map(normalize) : [] };
    } catch {
      return { sites: [] };
    }
  }
}

export function siteOrigin(site: string): string {
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    throw new Error("The site must be an http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The site must be an http or https URL.");
  }
  if (!url.hostname) throw new Error("The site must name a host.");
  return url.origin;
}

export function siteHost(site: string): string {
  return new URL(siteOrigin(site)).hostname;
}

function normalize(record: SiteLoginConfig): SiteLoginConfig {
  const origin = siteOrigin(record.origin);
  const botCookies: BotCookiePolicy = record.botCookies === "include" ? "include" : "skip";
  let probeUrl = record.probeUrl?.trim() || origin;
  try {
    const parsed = new URL(probeUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") probeUrl = origin;
  } catch {
    probeUrl = origin;
  }
  return {
    origin,
    probeUrl,
    signedInSelector: (record.signedInSelector || "").trim(),
    signedInText: (record.signedInText || "").trim(),
    botCookies,
    origins: sameHostOrigins(origin, record.origins),
  };
}

function sameHostOrigins(origin: string, listed: string[] | undefined): string[] {
  const host = new URL(origin).hostname;
  const out: string[] = [];
  for (const item of listed || []) {
    if (typeof item !== "string" || !item.trim()) continue;
    try {
      const next = siteOrigin(item.trim());
      if (new URL(next).hostname !== host) continue;
      if (!out.includes(next)) out.push(next);
    } catch {
      // A bad extra origin is dropped. The clicked site is still the one we read.
    }
  }
  return out;
}
