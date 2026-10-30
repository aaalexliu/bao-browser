// Names of well-known bot-manager cookies. Skip is the default: these values
// are tied to the browser that received them. Bao does not spoof a fingerprint,
// solve a captcha, or strip automation flags to make them work somewhere else.

export interface BotMatch {
  vendor: string;
}

const RULES: { vendor: string; test: (name: string) => boolean }[] = [
  { vendor: "Imperva", test: (name) => name === "reese84" || name === "___utmvc" || /^(visid_incap_|incap_ses_|nlbi_)/.test(name) },
  { vendor: "Akamai", test: (name) => name === "_abck" || name === "bm_sz" || name === "ak_bmsc" || name === "bm_sv" || name === "bm_mi" || name === "bm_so" },
  { vendor: "Cloudflare", test: (name) => name === "cf_clearance" || name === "__cf_bm" || name.startsWith("cf_chl_") },
  { vendor: "DataDome", test: (name) => name === "datadome" },
  { vendor: "HUMAN", test: (name) => name === "_px" || name === "_px2" || name === "_px3" || name === "_pxvid" || name === "_pxhd" || name === "pxcts" },
  { vendor: "Kasada", test: (name) => name.startsWith("KP_UIDz") },
];

export function classifyBotCookie(name: string): BotMatch | null {
  for (const rule of RULES) {
    if (rule.test(name)) return { vendor: rule.vendor };
  }
  return null;
}

export function vendorPhrase(vendors: string[]): string {
  const names = [...new Set(vendors)];
  if (names.length === 0) return "its anti-bot cookies";
  if (names.length === 1) return names[0] ?? "its anti-bot cookies";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
