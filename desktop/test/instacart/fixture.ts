// A local HTTPS stand-in for www.instacart.com. It serves the pages the owner's
// Costco blueberries flow touches, keeps carts in memory, and logs every cart
// write and every trap hit. Pair it with launchFixtureBrowser, which maps both
// Instacart hosts to this server and every other host to NOTFOUND, so a run
// never reaches the real site.
//
// Pages:
//   /                                  store list (Costco, Safeway, Sprouts)
//   /search?k=                         stores with results
//   /store/{store}/storefront          header cart, search form, popular items
//   /store/{store}/s?k=                search results with "Add 1 ct {name}"
//   /products/{id}-{slug}?retailerSlug quantity select and "Add to cart"
//   /checkout /login /account /instacart-plus and paths under them: traps, logged on every hit
// Cart API, used by the pages: POST /api/cart/add and POST /api/cart/remove.
// Tests read state() in process. The site has no state endpoint.

import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { selfSignedCert } from "./cert";
import { STORES, TARGET, TARGET_PATH, productIn, search, storeBySlug, type StoreSlug } from "./catalog";
import {
  globalSearchPage,
  homePage,
  notFoundPage,
  productPage,
  searchPage,
  storefrontPage,
  trapPage,
  type CartLine,
  type Carts,
  type TrapKind,
  type Variant,
} from "./pages";

export { STORES, TARGET, TARGET_PATH, type CartLine, type Carts, type StoreSlug, type Variant };

export const FIXTURE_HOSTS = ["www.instacart.com", "instacart.com"] as const;
export const FIXTURE_ORIGIN = "https://www.instacart.com";

export interface CartWrite {
  /** Date.now() when the server applied the write. */
  at: number;
  op: "add" | "remove";
  store: StoreSlug;
  productId: string;
  name: string;
  qty: number;
  before: number;
  after: number;
}

export interface Hit {
  at: number;
  method: string;
  host: string;
  path: string;
  /** Sec-Purpose, set on prefetch and prerender requests. */
  purpose: string;
  /** User-Agent, so a test can tell the test browser's requests from any other client's. */
  agent: string;
}

export interface FixtureState {
  variant: Variant;
  carts: Carts;
  writes: CartWrite[];
  traps: Hit[];
  requests: Hit[];
}

export interface SeedLine {
  store: StoreSlug;
  productId: string;
  qty: number;
}

export interface InstacartFixture {
  port: number;
  /** base64 sha256 of the certificate's public key, for --ignore-certificate-errors-spki-list. */
  spki: string;
  cert: string;
  url(path?: string): string;
  /** A copy of carts and logs. */
  state(): FixtureState;
  /** Empty the carts and every log, then add the seed lines without logging them. */
  reset(seed?: SeedLine[]): void;
  /** Serve the other markup from now on. Carts and logs stay. */
  setVariant(variant: Variant): void;
  close(): Promise<void>;
}

export function trapKind(pathname: string): TrapKind | undefined {
  const under = (prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`);
  if (under("/checkout")) return "checkout";
  if (under("/login")) return "login";
  if (under("/account/addresses")) return "addresses";
  if (under("/account")) return "account";
  if (under("/instacart-plus")) return "trial";
  return undefined;
}

function emptyCarts(): Carts {
  return { costco: [], safeway: [], sprouts: [] };
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > 16_384) return undefined;
    chunks.push(buf);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function positiveInt(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : undefined;
}

export async function startInstacartFixture(opts: { variant?: Variant; seed?: SeedLine[] } = {}): Promise<InstacartFixture> {
  const tls = selfSignedCert(FIXTURE_HOSTS);
  let variant: Variant = opts.variant ?? "base";
  let carts = emptyCarts();
  let writes: CartWrite[] = [];
  let traps: Hit[] = [];
  let requests: Hit[] = [];

  const seedCarts = (seed: SeedLine[]): void => {
    for (const line of seed) {
      const store = storeBySlug(line.store);
      const item = store && productIn(store, line.productId);
      if (!store || !item || !positiveInt(line.qty, 50)) throw new Error(`bad seed line ${JSON.stringify(line)}`);
      carts[store.slug].push({ productId: item.id, name: item.name, price: item.price, qty: line.qty });
    }
  };
  seedCarts(opts.seed ?? []);

  const cartWrite = async (req: IncomingMessage, res: ServerResponse, op: "add" | "remove"): Promise<void> => {
    const body = await readJson(req);
    const store = storeBySlug(String(body?.store ?? ""));
    const item = store && productIn(store, String(body?.productId ?? ""));
    if (!store || !item) return sendJson(res, 400, { ok: false, error: "unknown store or product" });
    const lines = carts[store.slug];
    const line = lines.find((entry) => entry.productId === item.id);
    const before = line?.qty ?? 0;
    let qty: number | undefined;
    if (op === "add") {
      qty = body?.qty === undefined ? 1 : positiveInt(body.qty, 50);
      if (!qty) return sendJson(res, 400, { ok: false, error: "qty must be 1 to 50" });
      if (line) line.qty += qty;
      else lines.push({ productId: item.id, name: item.name, price: item.price, qty });
    } else {
      if (!line) return sendJson(res, 404, { ok: false, error: "not in cart" });
      qty = body?.qty === undefined ? before : positiveInt(body.qty, 50);
      if (!qty) return sendJson(res, 400, { ok: false, error: "qty must be 1 to 50" });
      line.qty = Math.max(0, line.qty - qty);
      if (line.qty === 0) lines.splice(lines.indexOf(line), 1);
    }
    const after = lines.find((entry) => entry.productId === item.id)?.qty ?? 0;
    writes.push({ at: Date.now(), op, store: store.slug, productId: item.id, name: item.name, qty, before, after });
    sendJson(res, 200, { ok: true, carts });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method || "GET";
    const host = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    const url = new URL(req.url || "/", FIXTURE_ORIGIN);
    const purpose = String(req.headers["sec-purpose"] || req.headers.purpose || "");
    const agent = String(req.headers["user-agent"] || "");
    const hit: Hit = { at: Date.now(), method, host, path: `${url.pathname}${url.search}`, purpose, agent };
    requests.push(hit);
    if (!(FIXTURE_HOSTS as readonly string[]).includes(host)) return send(res, 421, "text/plain", "misdirected request");
    if (host === "instacart.com") return send(res, 301, "text/plain", "moved", { location: `${FIXTURE_ORIGIN}${hit.path}` });
    const ctx = { variant, carts };
    const trap = trapKind(url.pathname);
    if (trap) {
      traps.push(hit);
      return send(res, 200, "text/html; charset=utf-8", trapPage(ctx, trap));
    }
    if (url.pathname === "/api/cart/add" || url.pathname === "/api/cart/remove") {
      if (method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
      return cartWrite(req, res, url.pathname.endsWith("/add") ? "add" : "remove");
    }
    if (method !== "GET" && method !== "HEAD") return send(res, 405, "text/plain", "method not allowed");
    const html = (status: number, body: string): void => send(res, status, "text/html; charset=utf-8", body);
    if (url.pathname === "/") return html(200, homePage(ctx));
    if (url.pathname === "/search") {
      const query = url.searchParams.get("k") || "";
      const hits = STORES.map((store) => ({ store, count: search(store, query).length })).filter((row) => row.count > 0);
      return html(200, globalSearchPage(ctx, query, hits));
    }
    const storePage = url.pathname.match(/^\/store\/([a-z]+)\/(storefront|s)$/);
    const store = storePage ? storeBySlug(storePage[1] || "") : undefined;
    if (store && storePage?.[2] === "storefront") return html(200, storefrontPage(ctx, store));
    if (store && storePage?.[2] === "s") {
      const query = url.searchParams.get("k") || "";
      return html(200, searchPage(ctx, store, query, search(store, query)));
    }
    const productMatch = url.pathname.match(/^\/products\/(\d+)-[a-z0-9-]+$/);
    if (productMatch) {
      const retailer = storeBySlug(url.searchParams.get("retailerSlug") || "costco");
      const item = retailer && productIn(retailer, productMatch[1] || "");
      if (retailer && item && url.pathname === `/products/${item.id}-${item.slug}`) return html(200, productPage(ctx, retailer, item));
    }
    return html(404, notFoundPage(ctx));
  };

  const server: Server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, "text/plain", err instanceof Error ? err.message : String(err));
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port missing");

  return {
    port: address.port,
    spki: tls.spki,
    cert: tls.cert,
    url: (path = "/") => `${FIXTURE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`,
    state: () => structuredClone({ variant, carts, writes, traps, requests }),
    reset: (seed = []) => {
      carts = emptyCarts();
      writes = [];
      traps = [];
      requests = [];
      seedCarts(seed);
    },
    setVariant: (next) => {
      variant = next;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
