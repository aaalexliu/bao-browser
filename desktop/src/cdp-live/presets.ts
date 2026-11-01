import { BOOKS_HOSTS, INSTACART_HOSTS, INSTACART_PATH_BLOCK } from "./allowlist";

export const PRESET_NAMES = ["generic", "instacart", "books", "experian"] as const;
export const EXPERIAN_HOSTS = ["www.experian.com", "usa.experian.com"] as const;
const GENERIC_STOP_PATH = "/(?:checkout|login|signin|sign-in|account|payment)(?:/|$|[?#])";
export type PresetName = (typeof PRESET_NAMES)[number];

export interface GuardPreset {
  hosts: readonly string[];
  start: string;
  deny: string;
  commit: string;
  /** Submit-button labels this site uses for actions that buy nothing. Every other form submit is a commit. */
  submit: string;
  stopPath: string;
  reached: string;
}

/** Labels that are a commit under every preset and every explicit flag. */
export const COMMIT_FLOOR = "\\bcheck\\s?outs?\\b|place(?:\\s+\\w+){0,3}\\s+order|pay now|confirm purchase|submit order|complete (?:purchase|order)|buy now";

/** Shared with clickForbidden so the Instacart preset and the page guard match. */
export const INSTACART_DENY = "checkout|place order|review order|free trial|instacart\\s*\\+|start trial|try plus|add address|change address|edit address|delivery address|confirm address|payment|credit card|\\bcvv\\b|\\bcvc\\b|delivery time|delivery window|schedule delivery|\\btip\\b|settings|log in|sign in|sign up|password|one[- ]time code|verification code|authenticator";

export const GUARD_PRESETS: Record<PresetName, GuardPreset> = {
  generic: {
    hosts: [],
    start: "",
    deny: "password|sign in|log in|sign out|log out|create account|subscribe|delete account",
    commit: "place(?:\\s+\\w+){0,3}\\s+order|pay now|confirm purchase|submit order|buy now",
    submit: "",
    stopPath: GENERIC_STOP_PATH,
    reached: "checkout|place order|confirm",
  },
  instacart: {
    hosts: INSTACART_HOSTS,
    start: "https://www.instacart.com/",
    deny: INSTACART_DENY,
    commit: "checkout|place(?:\\s+\\w+){0,3}\\s+order|pay now|review order|start trial|try plus",
    submit: "^(?:add|add to cart|add item|add \\d+ (?:ct|items?|pkg|ea|each)\\b.*|search|(?:decrease|decrement|increase|increment)\\b.*|remove\\b(?!.*\\ball\\b).*)$",
    stopPath: INSTACART_PATH_BLOCK.source,
    reached: "your cart|cart",
  },
  experian: {
    hosts: EXPERIAN_HOSTS,
    start: "https://usa.experian.com/member",
    deny: "dispute|sign out|log out|cancel|delete account|password",
    commit: COMMIT_FLOOR,
    submit: "^(?:freeze|unfreeze|lift|thaw|lock|unlock)\\b.*$",
    stopPath: GENERIC_STOP_PATH,
    reached: "",
  },
  books: {
    hosts: BOOKS_HOSTS,
    start: "https://books.toscrape.com/",
    deny: "sign in|log in|password|register",
    commit: "checkout|place(?:\\s+\\w+){0,3}\\s+order|proceed to checkout",
    submit: "^(?:add to basket|search)$",
    stopPath: "/login|/account",
    reached: "basket",
  },
};

export function presetName(value: string): PresetName | null {
  return (PRESET_NAMES as readonly string[]).includes(value) ? value as PresetName : null;
}

/**
 * The preset for a live session's start url. A known host always gets its own
 * preset, so an agent cannot drop www.instacart.com to generic. Other hosts use
 * the preset asked for, else generic. Null means the asked name is unknown.
 */
export function presetForUrl(url: string, asked = ""): PresetName | null {
  if (asked && !presetName(asked)) return null;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if ((INSTACART_HOSTS as readonly string[]).includes(host)) return "instacart";
  if ((BOOKS_HOSTS as readonly string[]).includes(host)) return "books";
  if ((EXPERIAN_HOSTS as readonly string[]).includes(host)) return "experian";
  return presetName(asked) || "generic";
}

export function guardPreset(name: string): GuardPreset {
  const found = presetName(name);
  if (!found) throw new Error(`unknown preset ${name}`);
  return GUARD_PRESETS[found];
}

export interface GuardFlags {
  hosts: string[];
  start: string;
  deny: string;
  commit: string;
  stopPath: string;
  reached: string;
}

/** Explicit flags replace the preset. A preset supplies the rest. */
export function resolveGuardFlags(input: {
  preset?: string;
  hosts?: string[];
  start?: string;
  deny?: string;
  commit?: string;
  stopPath?: string;
  reached?: string;
}): GuardFlags {
  const base = input.preset ? guardPreset(input.preset) : {
    hosts: [] as readonly string[],
    start: "",
    deny: "",
    commit: "",
    stopPath: "",
    reached: "",
  };
  return {
    hosts: input.hosts && input.hosts.length ? [...input.hosts] : [...base.hosts],
    start: input.start || base.start,
    deny: input.deny || base.deny,
    commit: input.commit || base.commit,
    stopPath: input.stopPath || base.stopPath,
    reached: input.reached || base.reached,
  };
}
