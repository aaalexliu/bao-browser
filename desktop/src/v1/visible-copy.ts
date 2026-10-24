// Product copy never shows this machine's listen address. Replay still opens
// the real URL. A fixture path reads as Fixture. Any other loopback path
// reads as that path.

const LOOPBACK_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/[^\s"'<>]*)?/gi;

export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

export function loopbackPlace(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!isLoopbackHost(url.hostname)) return undefined;
    const path = url.pathname || "/";
    if (path === "/" || path === "/fixture" || path.startsWith("/fixture/")) return "Fixture";
    return path;
  } catch {
    return undefined;
  }
}

/** A hostname in an ask. Loopback is the fixture, not an address. */
export function publicSite(site: string): string {
  const raw = site.trim();
  if (!raw) return "the site";
  if (isLoopbackHost(raw.split(":")[0] || raw)) return "the fixture";
  try {
    const host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname;
    if (isLoopbackHost(host)) return "the fixture";
  } catch {
    return raw;
  }
  return raw;
}

export function visibleCopy(value: string): string {
  const open = value.trim().match(/^Open\s+(https?:\/\/\S+)$/i);
  if (open) {
    const place = loopbackPlace(open[1] || "");
    if (place) return place;
  }
  return value
    .replace(LOOPBACK_URL, (url) => loopbackPlace(url) || url)
    .replace(/\b(?:127\.0\.0\.1|localhost)(?::\d+)?\b/gi, "the fixture");
}

/** A control key for a loopback origin. The product HTML never stores the listen address. */
export function controlKey(origin: string): string {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return origin;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const kind = host === "::1" ? "6" : host === "localhost" ? "l" : "4";
    const scheme = url.protocol === "https:" ? "s" : "";
    return `fixture${kind}${scheme}:${port}`;
  } catch {
    return origin;
  }
}

/** The origin a control key stands for. Other strings pass through. */
export function expandControlKey(key: string): string {
  const match = /^fixture([46l])(s)?:(\d+)$/.exec(key);
  if (!match) return key;
  const host = match[1] === "6" ? "[::1]" : match[1] === "l" ? "localhost" : "127.0.0.1";
  const protocol = match[2] ? "https:" : "http:";
  return new URL(`${protocol}//${host}:${match[3]}`).origin;
}
