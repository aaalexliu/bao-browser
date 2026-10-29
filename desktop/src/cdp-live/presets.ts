import { BOOKS_HOSTS, INSTACART_HOSTS, INSTACART_PATH_BLOCK } from "./allowlist";

export const PRESET_NAMES = ["generic", "instacart", "books"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface GuardPreset {
  hosts: readonly string[];
  start: string;
  deny: string;
  commit: string;
  stopPath: string;
  reached: string;
}

/** Shared with clickForbidden so the Instacart preset and the page guard match. */
export const INSTACART_DENY = "checkout|place order|review order|free trial|instacart\\s*\\+|start trial|try plus|add address|change address|edit address|delivery address|confirm address|payment|credit card|\\bcvv\\b|\\bcvc\\b|delivery time|delivery window|schedule delivery|\\btip\\b|settings|log in|sign in|sign up|password|one[- ]time code|verification code|authenticator";

export const GUARD_PRESETS: Record<PresetName, GuardPreset> = {
  generic: {
    hosts: [],
    start: "",
    deny: "password|sign in|log in|create account|subscribe|delete account",
    commit: "place(?:\\s+\\w+){0,3}\\s+order|pay now|confirm purchase|submit order|buy now",
    stopPath: "/checkout|/login|/signin|/sign-in|/account|/payment",
    reached: "checkout|place order|confirm",
  },
  instacart: {
    hosts: INSTACART_HOSTS,
    start: "https://www.instacart.com/",
    deny: INSTACART_DENY,
    commit: "checkout|place(?:\\s+\\w+){0,3}\\s+order|pay now|review order|start trial|try plus",
    stopPath: INSTACART_PATH_BLOCK.source,
    reached: "your cart|cart",
  },
  books: {
    hosts: BOOKS_HOSTS,
    start: "https://books.toscrape.com/",
    deny: "sign in|log in|password|register",
    commit: "checkout|place(?:\\s+\\w+){0,3}\\s+order|proceed to checkout",
    stopPath: "/login|/account",
    reached: "basket",
  },
};

export function presetName(value: string): PresetName | null {
  return (PRESET_NAMES as readonly string[]).includes(value) ? value as PresetName : null;
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
