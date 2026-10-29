/** CDP has no per-site permission. Bao refuses every navigation outside the host list. */

export const BOOKS_HOSTS = ["books.toscrape.com"] as const;

/**
 * Instacart's own pages. Product images load as subresources and do not
 * navigate the tab, so this list does not include a CDN.
 */
export const INSTACART_HOSTS = ["instacart.com", "www.instacart.com"] as const;

export const INSTACART_PATH_BLOCK = /checkout|checkouts|place-order|place_order|\/payments?(?:\/|$)|payment-method|instacart-?plus|start-trial|free-trial|(?:^|\/)login(?:\/|$)|sign-?in|(?:^|\/)account(?:\/|$)|account-settings|\/settings(?:\/|$)|\/addresses?(?:\/|$)|\/payment(?:\/|$)/i;

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

function luhn(value: string): boolean {
  if (!/^\d{13,19}$/.test(value)) return false;
  let sum = 0;
  let alt = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let n = value.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** A typed string the live tools refuse before it reaches the page. `prior` is the field's current value. */
export function insertTextRefusal(text: string, prior = ""): string | null {
  if (text.length === 0 || text.length > 80) return "cdp-live refused that text";
  if (/password|cvv|cvc|card number/i.test(text)) return "cdp-live does not type secrets";
  const combined = `${prior}${text}`;
  if (/^\d[\d\s-]{11,}\d$/.test(text) || luhn(digitsOf(combined))) return "cdp-live does not type card numbers";
  if (/^\d{3}-\d{2}-\d{4}$/.test(combined.replace(/\s/g, ""))) return "cdp-live does not type secrets";
  return null;
}

export function navigationRefusal(url: string, hosts: readonly string[] = BOOKS_HOSTS, origins?: readonly string[]): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "that url";
  }
  if (parsed.username || parsed.password) return "credentials";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "scheme";
  const host = parsed.hostname;
  if (origins && origins.length) {
    if (!origins.includes(parsed.origin)) return host || "that host";
  } else if (!hosts.includes(host)) {
    return host || "that host";
  }
  const haystack = `${parsed.pathname}${parsed.hash}`;
  if ((host === "instacart.com" || host === "www.instacart.com") && INSTACART_PATH_BLOCK.test(haystack)) {
    return "blocked-path";
  }
  return null;
}

/** Pathname and hash, so `#/checkout` is the same stop as `/checkout`. */
export function stopPathHit(url: string, stopPath: string): boolean {
  if (!stopPath) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  try {
    return new RegExp(stopPath, "i").test(`${parsed.pathname}${parsed.hash}`);
  } catch {
    return false;
  }
}

/** The start origin keeps its port. Other preset hosts use the default http and https origins. */
export function originsFor(start: string, hosts: readonly string[]): string[] {
  const parsed = new URL(start);
  const origins = new Set<string>([parsed.origin]);
  for (const host of hosts) {
    if (!host || host === parsed.hostname) continue;
    origins.add(`https://${host}`);
    origins.add(`http://${host}`);
  }
  return [...origins];
}

/** Refusal the live entry can show. A blocked Instacart path stays `blocked-path`. */
export function navigationGuard(
  url: string,
  hosts: readonly string[],
  origins: readonly string[],
  stopPath = "",
): string | null {
  const refusal = navigationRefusal(url, hosts, origins.length ? origins : undefined);
  if (refusal === "blocked-path") return "blocked-path";
  if (refusal) return "url is not on the host list";
  if (stopPathHit(url, stopPath)) return "stop-path";
  return null;
}

export function navigationAllowed(url: string, hosts: readonly string[] = BOOKS_HOSTS): boolean {
  return navigationRefusal(url, hosts) == null;
}

/** about:blank is the empty window this driver opens. It is not a site navigation. */
export function openerAllowed(url: string, hosts: readonly string[] = BOOKS_HOSTS): boolean {
  return url === "about:blank" || navigationAllowed(url, hosts);
}

export function publicHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
