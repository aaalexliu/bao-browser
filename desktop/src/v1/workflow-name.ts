// Deterministic workflow title. The URL is the floor, so a save always has a
// name even when no model key is set. A model pass may replace it later.

import { isSensitiveValue } from "../../../src/mask";

export interface NameEvent {
  op?: string;
  beforeUrl?: string;
  afterUrl?: string;
  identity?: { name?: string; text?: string; label?: string };
}

export interface NameStep {
  action?: string;
  label?: string;
  identity?: { name?: string; text?: string; label?: string };
}

export interface NameSource {
  startUrl?: string;
  events?: NameEvent[];
  steps?: NameStep[];
  pageTitle?: string;
  secrets?: string[];
}

const VERB = /^(book|reserve|submit|save|send|search|sign in|log in|sign up|download|upload|create|add|delete|remove|pay|buy|order|check out|checkout|apply|register|subscribe|share|post|publish|schedule|confirm|place|update|edit|invite|export|import|message|print|rename|enable|disable|complete|finish|filter|sort)\b/i;
const GOAL = /^(book|reserve|submit|save|send|search|pay|buy|order|checkout|check out|apply|register|subscribe|create|add|download|upload|place|confirm|schedule|publish|share|invite|export|update)\b/i;

export function primaryHost(source: NameSource): string {
  for (const event of source.events || []) {
    if (event.op !== "navigate" && event.op !== "open") continue;
    const host = hostOf(event.afterUrl) || hostOf(event.beforeUrl);
    if (host) return host;
  }
  const counts = new Map<string, number>();
  const order: string[] = [];
  const add = (host: string) => {
    if (!host) return;
    if (!counts.has(host)) order.push(host);
    counts.set(host, (counts.get(host) || 0) + 1);
  };
  for (const event of source.events || []) {
    const seen = new Set<string>();
    for (const url of [event.beforeUrl, event.afterUrl]) {
      const host = hostOf(url);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      add(host);
    }
  }
  if (!counts.size) add(hostOf(source.startUrl));
  let best = "";
  let n = 0;
  for (const host of order) {
    const count = counts.get(host) || 0;
    if (count > n) {
      best = host;
      n = count;
    }
  }
  return best;
}

/** A human title. Never "Captured workflow". */
export function workflowFloorTitle(source: NameSource): string {
  const host = primaryHost(source);
  const phrase = obviousPhrase(source, host);
  if (phrase && host) return `${phrase} · ${host}`;
  if (phrase) return phrase;
  if (host) return host;
  return "Untitled workflow";
}

function obviousPhrase(source: NameSource, host: string): string {
  const secrets = source.secrets || [];
  const phrases: string[] = [];
  const add = (raw?: string) => {
    const phrase = phraseFrom(raw, secrets);
    if (phrase) phrases.push(phrase);
  };
  for (const event of source.events || []) {
    if (event.op !== "click" && event.op !== "confirm" && event.op !== "check" && event.op !== "select") continue;
    add(event.identity?.name);
    add(event.identity?.text);
    add(event.identity?.label);
  }
  for (const step of source.steps || []) {
    add(step.identity?.name);
    add(step.identity?.text);
    add(step.identity?.label);
    add(step.label);
  }
  const goals = phrases.filter((phrase) => GOAL.test(phrase) && words(phrase) >= 2);
  if (goals.length) return goals[goals.length - 1]!;
  const verbs = phrases.filter((phrase) => VERB.test(phrase) && words(phrase) >= 2);
  if (verbs.length) return verbs[verbs.length - 1]!;
  const title = usableTitle(source.pageTitle, host);
  if (title && VERB.test(title) && words(title) >= 2) return title;
  const single = phrases.filter((phrase) => VERB.test(phrase));
  if (single.length && title && !VERB.test(title)) return `${single[single.length - 1]} ${title}`;
  return "";
}

function phraseFrom(raw: string | undefined, secrets: string[]): string {
  if (!raw) return "";
  let text = raw.replace(/\s+/g, " ").trim();
  const quoted = text.match(/^(?:click|confirm|press|select|check|uncheck)\s+"([^"]+)"$/i);
  if (quoted?.[1]) text = quoted[1].trim();
  else {
    const loose = text.match(/^(?:click|confirm|press)\s+(.+)$/i);
    if (loose?.[1] && !/^https?:/i.test(loose[1])) text = loose[1].replace(/^"|"$/g, "").trim();
  }
  if (!text || text.length > 60 || /^https?:/i.test(text)) return "";
  if (/^(click|type|note|check|open|press key)$/i.test(text) || /^type\b/i.test(text)) return "";
  if (!VERB.test(text) || blocked(text, secrets)) return "";
  return text;
}

function usableTitle(title: string | undefined, host: string): string {
  const text = (title || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 80) return "";
  if (host && text.toLowerCase() === host.toLowerCase()) return "";
  if (/^(home|untitled|new tab|about:blank)$/i.test(text)) return "";
  if (blocked(text, [])) return "";
  return text;
}

function blocked(text: string, secrets: string[]): boolean {
  if (secrets.some((secret) => secret.length >= 4 && text.includes(secret))) return true;
  if (/\d{6,}/.test(text)) return true;
  return isSensitiveValue(text);
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hostOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}
