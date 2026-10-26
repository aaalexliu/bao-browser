/** CDP has no per-site permission. Bao refuses every navigation that is not this host. */
export const ALLOWED_HOST = "books.toscrape.com";

export function navigationAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.hostname === ALLOWED_HOST;
}

/** about:blank is the empty window this driver opens. It is not a site navigation. */
export function openerAllowed(url: string): boolean {
  return url === "about:blank" || navigationAllowed(url);
}

export function publicHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
