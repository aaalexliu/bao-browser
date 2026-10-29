/** CDP has no per-site permission. Bao refuses every navigation outside the host list. */

export const BOOKS_HOSTS = ["books.toscrape.com"] as const;

/**
 * Instacart's own pages. Product images load as subresources and do not
 * navigate the tab, so this list does not include a CDN.
 */
export const INSTACART_HOSTS = ["instacart.com", "www.instacart.com"] as const;

export const INSTACART_PATH_BLOCK = /checkout|checkouts|place-order|place_order|\/payments?(?:\/|$)|payment-method|instacart-?plus|start-trial|free-trial|(?:^|\/)login(?:\/|$)|sign-?in|(?:^|\/)account(?:\/|$)|\/settings(?:\/|$)|\/addresses?(?:\/|$)|\/payment(?:\/|$)/i;

/** A typed string the live tools refuse before it reaches the page. */
export function insertTextRefusal(text: string, prior = ""): string | null {
  void prior;
  if (text.length === 0 || text.length > 80) return "cdp-live refused that text";
  if (/password|cvv|cvc|card number/i.test(text)) return "cdp-live does not type secrets";
  if (/^\d[\d\s-]{11,}\d$/.test(text)) return "cdp-live does not type card numbers";
  return null;
}

export function navigationRefusal(url: string, hosts: readonly string[] = BOOKS_HOSTS, origins?: readonly string[]): string | null {
  void origins;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "that url";
  }
  if (parsed.username || parsed.password) return "credentials";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "scheme";
  const host = parsed.hostname;
  if (!hosts.includes(host)) return host || "that host";
  if ((host === "instacart.com" || host === "www.instacart.com") && INSTACART_PATH_BLOCK.test(parsed.pathname)) {
    return "blocked-path";
  }
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
