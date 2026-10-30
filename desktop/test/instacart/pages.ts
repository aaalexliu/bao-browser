// HTML for the Instacart fixture. Labels follow instacart.com and the shapes
// desktop/src/cdp-live/instacart.ts reads: "Add 1 ct {name}", a header cart
// labelled "View Cart. Items in cart: N", and "Distinct items in cart" store
// summaries. The product page follows the owner's screenshot.
//
// Two variants share every accessible name. "drift" renames every class and
// test id and moves blocks: header rows, sidebar side, card parts, product
// page columns, and store order.

import { STORES, productPath, type Product, type Store, type StoreSlug } from "./catalog";

export type Variant = "base" | "drift";

export interface CartLine {
  productId: string;
  name: string;
  price: number;
  qty: number;
}

export type Carts = Record<StoreSlug, CartLine[]>;

const KEYS = [
  "page", "header", "headerRow", "menu", "logo", "search", "searchIcon", "searchInput", "searchClear",
  "modes", "mode", "eta", "login", "cart", "cartFee", "cartCount", "layout", "sidebar", "storeBadge",
  "storeDot", "sideLinks", "main", "home", "title", "lede", "stores", "storeCard", "grid", "card", "cardShell",
  "cardMedia", "cardImageLink", "cardImage", "cardActions", "cardInfo", "price", "priceShown", "name",
  "size", "stock", "add", "stepper", "step", "stepQty", "sr", "pdp", "panel", "back", "pdpGrid",
  "gallery", "thumbs", "thumb", "hero", "info", "brandLink", "attrs", "buy", "buyPrice", "qtyLabel",
  "qtySelect", "addToCart", "inCart", "save", "related", "cartPanel", "cartHead", "cartClose",
  "cartBody", "cartStore", "cartLine", "cartName", "cartPrice", "checkout", "empty", "trap", "trapButton",
  "field", "results",
] as const;

export type ClassKey = typeof KEYS[number];
export type Classes = Record<ClassKey, string>;

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 7);
}

/** Hashed class names like a CSS-in-JS build. Each variant gets its own set. */
export function classNames(variant: Variant): Classes {
  const prefix = variant === "base" ? "e-" : "css-";
  const out = {} as Classes;
  for (const key of KEYS) out[key] = `${prefix}${fnv(`${variant}:${key}`)}`;
  return out;
}

const TEST_IDS: Record<Variant, Record<"card" | "addToCart" | "cart" | "search" | "store", string>> = {
  base: { card: "item-card", addToCart: "add-to-cart-button", cart: "cart-button", search: "search-input", store: "store-card" },
  drift: { card: "product-tile", addToCart: "pdp-add", cart: "header-cart", search: "search-bar-input", store: "retailer-card" },
};

// The functions from here to SHARED run on the server and, through
// Function.prototype.toString, in the page. They may only use each other.

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch] || ch);
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function icon(name: string): string {
  const paths: Record<string, string> = {
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
    cart: "M3 4h2l2.4 11h10.2L20 8H6.2M9 20a1 1 0 1 0 0-.01M17 20a1 1 0 1 0 0-.01",
    search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M16.5 16.5L21 21",
    close: "M6 6l12 12M18 6L6 18",
    back: "M20 12H5M11 6l-6 6l6 6",
    menu: "M4 7h16M4 12h16M4 17h16",
    clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2",
    info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v6M12 7.5v.5",
    bookmark: "M7 4h10v16l-5-4l-5 4z",
    stock: "M4 7h16M7 12h10M10 17h4",
  };
  return `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name] || ""}"/></svg>`;
}

/** The group label puts the count right after "quantity": bao's reader takes the first "quantity N" among a row's aria labels. */
function actionsHtml(c: Record<string, string>, store: string, item: { id: string; name: string }, qty: number): string {
  const data = `data-store="${esc(store)}" data-product="${esc(item.id)}"`;
  if (qty < 1) {
    return `<button type="button" class="${c.add}" aria-label="Add 1 ct ${esc(item.name)}" data-op="add" ${data}>${icon("plus")}<span>Add</span></button>`;
  }
  const less = qty === 1
    ? `<button type="button" class="${c.step}" aria-label="Remove ${esc(item.name)}" data-op="remove" ${data}>${icon("trash")}</button>`
    : `<button type="button" class="${c.step}" aria-label="Decrement quantity of ${esc(item.name)}" data-op="decrement" ${data}>${icon("minus")}</button>`;
  return `<div class="${c.stepper}" role="group" aria-label="${esc(item.name)}, quantity ${qty}">${less}`
    + `<span class="${c.stepQty}">${qty} ct</span>`
    + `<button type="button" class="${c.step}" aria-label="Increment quantity of ${esc(item.name)}" data-op="increment" ${data}>${icon("plus")}</button></div>`;
}

function cartButtonHtml(c: Record<string, string>, count: number): string {
  return `<span class="${c.cartFee}">$0 delivery fee on $35</span>${icon("cart")}<span class="${c.cartCount}">${count}</span>`;
}

function cartBodyHtml(
  c: Record<string, string>,
  stores: { slug: string; name: string }[],
  carts: Record<string, { productId: string; name: string; price: number; qty: number }[]>,
  only: string,
): string {
  const parts: string[] = [];
  for (const store of stores) {
    if (only && store.slug !== only) continue;
    const lines = carts[store.slug] || [];
    if (!lines.length) continue;
    const subtotal = lines.reduce((sum, line) => sum + line.price * line.qty, 0);
    const rows = lines.map((line) => `<li class="${c.cartLine}"><span class="${c.cartName}">${esc(line.name)}</span>`
      + `<span class="${c.cartPrice}">${money(line.price * line.qty)}</span>`
      + `<div class="${c.cardActions}">${actionsHtml(c, store.slug, { id: line.productId, name: line.name }, line.qty)}</div></li>`).join("");
    parts.push(`<section class="${c.cartStore}" aria-label="${esc(store.name)}. Distinct items in cart: ${lines.length}">`
      + `<h3>${esc(store.name)}</h3><ul>${rows}</ul>`
      + `<a class="${c.checkout}" href="/checkout?store=${esc(store.slug)}">Go to checkout <span>${money(subtotal)}</span></a></section>`);
  }
  if (!parts.length) return `<div class="${c.empty}"><p><strong>Your cart is empty</strong></p><p>Items you add will appear here</p></div>`;
  return parts.join("");
}

const SHARED = [esc, money, icon, actionsHtml, cartButtonHtml, cartBodyHtml].map(String).join("\n");

/** The page script: cart writes, the cart panel, and small header toggles. Writes go to /api/cart. */
function client(): void {
  const data = JSON.parse(document.getElementById("fixture-data")?.textContent || "{}") as {
    c: Record<string, string>;
    store: string;
    stores: { slug: string; name: string }[];
    carts: Record<string, { productId: string; name: string; price: number; qty: number }[]>;
    names: Record<string, string>;
  };
  const c = data.c;
  let carts = data.carts;
  const qtyOf = (store: string, id: string): number => (carts[store] || []).find((line) => line.productId === id)?.qty || 0;
  const count = (): number => Object.entries(carts)
    .filter(([slug]) => !data.store || slug === data.store)
    .reduce((sum, [, lines]) => sum + lines.reduce((n, line) => n + line.qty, 0), 0);
  const render = (): void => {
    const total = count();
    document.querySelectorAll("[data-cart-button]").forEach((button) => {
      button.setAttribute("aria-label", `View Cart. Items in cart: ${total}`);
      button.innerHTML = cartButtonHtml(c, total);
    });
    document.querySelectorAll<HTMLElement>("[data-actions]").forEach((slot) => {
      const store = slot.dataset.store || "";
      const id = slot.dataset.actions || "";
      slot.innerHTML = actionsHtml(c, store, { id, name: data.names[id] || "" }, qtyOf(store, id));
    });
    document.querySelectorAll<HTMLElement>("[data-in-cart]").forEach((slot) => {
      const qty = qtyOf(slot.dataset.store || "", slot.dataset.inCart || "");
      slot.textContent = qty ? `${qty} in cart` : "";
    });
    const body = document.querySelector("[data-cart-body]");
    if (body) body.innerHTML = cartBodyHtml(c, data.stores, carts, data.store);
  };
  const write = async (op: "add" | "remove", payload: Record<string, unknown>): Promise<void> => {
    const response = await fetch(`/api/cart/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as { ok: boolean; carts?: typeof carts };
    if (result.ok && result.carts) carts = result.carts;
    render();
  };
  const panel = document.querySelector<HTMLElement>("[data-cart-dialog]");
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-op]") : null;
    if (!target) return;
    const op = target.dataset.op || "";
    const store = target.dataset.store || "";
    const productId = target.dataset.product || "";
    if (op === "open-cart" && panel) {
      panel.hidden = !panel.hidden;
    } else if (op === "close-cart" && panel) {
      panel.hidden = true;
    } else if (op === "add") {
      const from = target.dataset.from ? document.querySelector<HTMLSelectElement>(target.dataset.from) : null;
      void write("add", { store, productId, qty: from ? Number(from.value) : 1 });
    } else if (op === "increment") {
      void write("add", { store, productId, qty: 1 });
    } else if (op === "decrement") {
      void write("remove", { store, productId, qty: 1 });
    } else if (op === "remove") {
      void write("remove", { store, productId });
    } else if (op === "back") {
      const sameSite = document.referrer.startsWith(`${location.origin}/`);
      if (sameSite && history.length > 1) history.back();
      else location.href = target.dataset.fallback || "/";
    } else if (op === "clear-search") {
      const input = target.closest("form")?.querySelector("input");
      if (input) {
        input.value = "";
        input.focus();
      }
    } else if (op === "mode") {
      document.querySelectorAll("[data-op='mode']").forEach((button) => button.setAttribute("aria-pressed", String(button === target)));
    } else if (op === "save") {
      const saved = target.getAttribute("aria-pressed") === "true";
      target.setAttribute("aria-pressed", String(!saved));
      const label = target.querySelector("span");
      if (label) label.textContent = saved ? "Save" : "Saved";
    }
  });
}

function css(c: Classes, variant: Variant): string {
  const drift = variant === "drift";
  return `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:#343538;background:#fff;font-size:15px}
a{color:inherit}
button{font:inherit;cursor:pointer}
.${c.sr}{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.${c.header}{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid #e8e9eb;padding:12px 24px}
.${c.headerRow}{display:flex;align-items:center;gap:16px}
.${c.headerRow}+.${c.headerRow}{margin-top:10px}
.${c.menu}{border:0;background:none;padding:6px;color:#343538}
.${c.logo}{display:flex;align-items:center;gap:4px;text-decoration:none;color:#003d29;font-weight:800;font-size:28px;letter-spacing:-.5px}
.${c.search}{flex:1;display:flex;align-items:center;gap:8px;height:48px;max-width:${drift ? "100%" : "560px"};border:1px solid #c7c8cd;border-radius:24px;padding:0 16px;background:#fff}
.${c.searchIcon}{border:0;background:none;padding:0;color:#343538;display:flex}
.${c.searchInput}{flex:1;border:0;outline:0;font-size:17px;background:transparent;color:#343538}
.${c.searchClear}{border:0;background:none;padding:0;color:#343538;display:flex}
.${c.modes}{display:flex;border:1px solid #c7c8cd;border-radius:24px;padding:3px}
.${c.mode}{border:0;background:none;border-radius:20px;padding:8px 18px;color:#9a9ca1;font-size:16px}
.${c.mode}[aria-pressed="true"]{background:#fff;color:#343538;box-shadow:inset 0 0 0 1.5px #343538}
.${c.eta}{display:flex;align-items:center;gap:6px;border:0;background:none;color:#108910;font-size:16px;white-space:nowrap}
.${c.login}{white-space:nowrap;text-decoration:none;font-weight:600;padding:10px 12px}
.${c.cart}{display:flex;align-items:center;gap:8px;height:48px;padding:0 20px;border:0;border-radius:24px;background:#108910;color:#fff;font-size:15px;white-space:nowrap;margin-left:auto}
.${c.cartFee}{max-width:200px;overflow:hidden;text-overflow:ellipsis}
.${c.cartCount}{font-size:20px;font-weight:700}
.${c.layout}{display:flex;gap:24px;padding:24px}
.${c.sidebar}{width:240px;flex:none;display:flex;flex-direction:column;gap:12px}
.${c.storeBadge}{display:flex;align-items:center;gap:12px;font-weight:700;font-size:18px}
.${c.storeDot}{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:800;border:1px solid #e8e9eb}
.${c.sideLinks}{display:flex;flex-direction:column;gap:8px}
.${c.sideLinks} a{text-decoration:none;padding:6px 0}
.${c.main}{flex:1;min-width:0}
.${c.home}{padding:24px}
.${c.title}{font-size:28px;margin:0 0 6px}
.${c.lede}{color:#72767e;margin:0 0 20px}
.${c.stores}{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.${c.storeCard}{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid #e8e9eb;border-radius:12px;text-decoration:none}
.${c.grid}{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(${drift ? "220px" : "200px"},1fr));gap:24px}
.${c.card}{position:relative;display:flex;flex-direction:column;gap:4px}
.${c.cardShell}{display:flex;flex-direction:column;gap:6px;height:100%;padding:12px;border:1px solid #e8e9eb;border-radius:12px}
.${c.cardMedia}{position:relative}
.${c.cardImageLink}{display:block}
.${c.cardImage}{width:100%;aspect-ratio:1;display:block;border-radius:8px}
.${c.cardActions}{${drift ? "margin-top:auto;" : "position:absolute;top:8px;right:8px;"}display:flex;justify-content:flex-end}
.${c.cardInfo}{text-decoration:none;display:flex;flex-direction:column;gap:2px}
.${c.price}{font-weight:700;font-size:20px}
.${c.priceShown} sup{font-size:12px;margin-left:1px}
.${c.name}{font-size:16px;font-weight:400;margin:0;line-height:1.35}
.${c.size}{color:#72767e;font-size:14px}
.${c.stock}{display:flex;align-items:center;gap:4px;color:#108910;font-size:14px}
.${c.add}{display:flex;align-items:center;gap:6px;height:40px;padding:0 16px;border:0;border-radius:20px;background:#108910;color:#fff;font-weight:600;font-size:16px;box-shadow:0 1px 4px rgba(0,0,0,.2)}
.${c.stepper}{display:flex;align-items:center;gap:6px;height:40px;padding:0 6px;border-radius:20px;background:#108910;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.2)}
.${c.step}{border:0;background:none;color:#fff;display:flex;padding:4px}
.${c.stepQty}{font-weight:600;min-width:36px;text-align:center}
.${c.pdp}{background:#f6f7f8;min-height:calc(100vh - 73px);padding:16px 24px}
.${c.panel}{background:#fff;border-radius:16px;padding:24px 36px;max-width:1650px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,.12)}
.${c.back}{display:inline-flex;align-items:center;gap:8px;border:0;background:none;font-size:18px;font-weight:600;padding:4px 0;color:#343538}
.${c.pdpGrid}{display:grid;grid-template-columns:${drift ? "minmax(260px,1fr) minmax(280px,420px) minmax(360px,520px)" : "64px minmax(320px,480px) 1fr minmax(280px,480px)"};gap:32px;margin-top:24px;align-items:start}
.${c.gallery}{${drift ? "display:flex;flex-direction:row-reverse;gap:16px" : "display:contents"}}
.${c.thumbs}{display:flex;flex-direction:column;gap:12px}
.${c.thumb}{width:52px;height:52px;border:1px solid #e8e9eb;border-radius:8px;padding:2px;background:#fff}
.${c.thumb}[aria-pressed="true"]{border:2px solid #343538}
.${c.thumb} img{width:100%;height:100%}
.${c.hero}{width:100%;max-width:420px;aspect-ratio:1;display:block}
.${c.info} h1{font-size:26px;line-height:1.25;margin:0 0 12px}
.${c.brandLink}{font-size:17px;font-weight:600}
.${c.attrs}{padding-left:0;list-style:none;margin:28px 0 0}
.${c.attrs} li::before{content:"\\2022\\00a0"}
.${c.buy}{border:1px solid #c7c8cd;border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:14px}
.${c.buyPrice}{font-size:24px;font-weight:700}
.${c.qtyLabel}{font-size:16px;color:#5f6369}
.${c.qtySelect}{height:56px;border:0;border-radius:8px;background:#f6f7f8;font-size:17px;padding:0 16px;text-align:center}
.${c.addToCart}{height:56px;border:0;border-radius:28px;background:#108910;color:#fff;font-size:20px;font-weight:700}
.${c.inCart}{margin:0;color:#108910;font-weight:600;min-height:1em}
.${c.save}{display:flex;align-items:center;gap:8px;border:0;background:none;font-size:17px;padding:8px 0;color:#343538}
.${c.related}{margin-top:40px}
.${c.related} h2{font-size:24px}
.${c.cartPanel}{position:fixed;top:0;right:0;bottom:0;width:420px;z-index:10;background:#fff;box-shadow:-4px 0 24px rgba(0,0,0,.18);display:flex;flex-direction:column}
.${c.cartPanel}[hidden]{display:none}
.${c.cartHead}{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e8e9eb}
.${c.cartHead} h2{margin:0;font-size:22px}
.${c.cartClose}{border:0;background:none;display:flex;padding:6px}
.${c.cartBody}{overflow:auto;padding:12px 20px;flex:1}
.${c.cartStore} ul{list-style:none;padding:0}
.${c.cartLine}{display:grid;grid-template-columns:1fr auto;gap:6px;padding:12px 0;border-bottom:1px solid #f0f0f2}
.${c.cartLine} .${c.cardActions}{position:static;grid-column:1/-1}
.${c.cartPrice}{font-weight:600}
.${c.checkout}{display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding:14px 20px;border-radius:28px;background:#108910;color:#fff;text-decoration:none;font-weight:700}
.${c.empty}{text-align:center;color:#72767e;padding:40px 0}
.${c.trap}{max-width:520px;margin:48px auto;padding:24px;border:1px solid #e8e9eb;border-radius:12px;display:flex;flex-direction:column;gap:14px}
.${c.trapButton}{height:48px;border:0;border-radius:24px;background:#108910;color:#fff;font-weight:700;font-size:16px}
.${c.field}{display:flex;flex-direction:column;gap:6px}
.${c.field} input{height:44px;border:1px solid #c7c8cd;border-radius:8px;padding:0 12px;font-size:16px}
.${c.results}{list-style:none;padding:0;display:flex;flex-direction:column;gap:10px}
`;
}

function productArt(item: Product): string {
  const { bg, band, text } = item.art;
  const brand = item.brand.split(" ")[0]?.toUpperCase() || "";
  const plain = item.name.replace(/,.*$/, "");
  const label = (plain.startsWith(item.brand) ? plain.slice(item.brand.length) : plain).trim().toUpperCase();
  const lines = label.match(/.{1,14}(?:\s|$)/g)?.map((line) => line.trim()).slice(0, 3) || [label];
  const berries = item.tags.includes("berry") || /berr/i.test(item.name)
    ? [[60, 150], [88, 162], [118, 150], [146, 162], [74, 176], [132, 178]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="13" fill="#3b4f9a" stroke="#22306b" stroke-width="2"/>`).join("")
    : "";
  const words = lines.map((line, index) => {
    const size = Math.min(17, Math.floor(118 / (line.length * 0.7)));
    return `<text x="100" y="${102 + index * 20}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${size}" font-weight="800" fill="${text}">${esc(line)}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#fff"/>`
    + `<rect x="28" y="12" width="144" height="180" rx="14" fill="${bg}" stroke="#d5d7db"/>`
    + `<rect x="28" y="40" width="144" height="32" fill="${band}"/>`
    + `<text x="100" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="800" fill="#fff">${esc(brand)}</text>`
    + `<rect x="36" y="80" width="128" height="${lines.length * 20 + 12}" rx="6" fill="${band}" opacity=".85"/>${words}${berries}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function priceHtml(c: Classes, price: number): string {
  const [dollars, cents] = price.toFixed(2).split(".");
  return `<div class="${c.price}"><span class="${c.sr}">Current price: ${money(price)}</span><span class="${c.priceShown}" aria-hidden="true">$${dollars}<sup>${cents}</sup></span></div>`;
}

export interface PageContext {
  variant: Variant;
  carts: Carts;
}

function qtyIn(ctx: PageContext, store: Store, id: string): number {
  return ctx.carts[store.slug].find((line) => line.productId === id)?.qty || 0;
}

function cardHtml(ctx: PageContext, store: Store, item: Product): string {
  const c = classNames(ctx.variant);
  const href = esc(productPath(store, item));
  const image = `<a class="${c.cardImageLink}" href="${href}" tabindex="-1"><img class="${c.cardImage}" alt="${esc(item.name)}" src="${productArt(item)}"></a>`;
  const actions = `<div class="${c.cardActions}" data-actions="${esc(item.id)}" data-store="${store.slug}">${actionsHtml(c, store.slug, item, qtyIn(ctx, store, item.id))}</div>`;
  const stock = `<div class="${c.stock}">${icon("stock")}<span>${esc(item.stock)}</span></div>`;
  const testId = TEST_IDS[ctx.variant].card;
  if (ctx.variant === "drift") {
    return `<li><div class="${c.cardShell}" data-testid="${testId}">${image}`
      + `<a class="${c.cardInfo}" href="${href}"><h3 class="${c.name}">${esc(item.name)}</h3><div class="${c.size}">${esc(item.size)}</div>${priceHtml(c, item.price)}</a>`
      + `${stock}${actions}</div></li>`;
  }
  return `<li class="${c.card}" data-testid="${testId}"><div class="${c.cardMedia}">${image}${actions}</div>`
    + `<a class="${c.cardInfo}" href="${href}">${priceHtml(c, item.price)}<h3 class="${c.name}">${esc(item.name)}</h3><div class="${c.size}">${esc(item.size)}</div></a>`
    + `${stock}</li>`;
}

function gridHtml(ctx: PageContext, store: Store, items: Product[], label: string): string {
  const c = classNames(ctx.variant);
  return `<ul class="${c.grid}" aria-label="${esc(label)}">${items.map((item) => cardHtml(ctx, store, item)).join("")}</ul>`;
}

function cartCount(ctx: PageContext, store: Store | undefined): number {
  return Object.entries(ctx.carts)
    .filter(([slug]) => !store || slug === store.slug)
    .reduce((sum, [, lines]) => sum + lines.reduce((n, line) => n + line.qty, 0), 0);
}

interface Shell {
  title: string;
  body: string;
  store?: Store;
  query?: string;
}

function header(ctx: PageContext, shell: Shell): string {
  const c = classNames(ctx.variant);
  const ids = TEST_IDS[ctx.variant];
  const store = shell.store;
  const action = store ? `/store/${store.slug}/s` : "/search";
  const label = store ? `Search ${store.name}` : "Search products, stores, and recipes";
  const query = shell.query || "";
  const clear = query ? `<button type="button" class="${c.searchClear}" aria-label="Clear search" data-op="clear-search">${icon("close")}</button>` : "";
  const search = `<form class="${c.search}" role="search" action="${action}" method="get">`
    + `<button type="submit" class="${c.searchIcon}" aria-label="Search">${icon("search")}</button>`
    + `<input class="${c.searchInput}" type="search" name="k" value="${esc(query)}" aria-label="${esc(label)}" placeholder="${esc(label)}..." autocomplete="off" data-testid="${ids.search}">${clear}</form>`;
  const menu = `<button type="button" class="${c.menu}" aria-label="Main menu">${icon("menu")}</button>`;
  const logo = `<a class="${c.logo}" href="/" aria-label="Instacart home"><svg aria-hidden="true" width="26" height="30" viewBox="0 0 26 30"><path d="M13 9c-5 0-9 4-9 9c0 6 5 11 9 11s9-5 9-11c0-5-4-9-9-9z" fill="#ff7009"/><path d="M13 10C11 5 8 2 4 1c1 4 4 7 9 9zm0 0c2-5 5-8 9-9c-1 4-4 7-9 9z" fill="#0aad0a"/></svg><span>instacart</span></a>`;
  const modes = `<div class="${c.modes}" role="group" aria-label="Delivery or pickup"><button type="button" class="${c.mode}" aria-pressed="true" data-op="mode">Delivery</button><button type="button" class="${c.mode}" aria-pressed="false" data-op="mode">Pickup</button></div>`;
  const eta = `<button type="button" class="${c.eta}">${icon("clock")}<span>Tomorrow, 1pm</span>${icon("info")}</button>`;
  const login = `<a class="${c.login}" href="/login">Log in</a>`;
  const count = cartCount(ctx, store);
  const cart = `<button type="button" class="${c.cart}" aria-label="View Cart. Items in cart: ${count}" aria-haspopup="dialog" data-op="open-cart" data-cart-button data-testid="${ids.cart}">${cartButtonHtml(c, count)}</button>`;
  if (ctx.variant === "drift") {
    return `<header class="${c.header}"><div class="${c.headerRow}">${logo}${menu}${modes}${eta}${cart}${login}</div><div class="${c.headerRow}">${search}</div></header>`;
  }
  return `<header class="${c.header}"><div class="${c.headerRow}">${menu}${logo}${search}${modes}${eta}${login}${cart}</div></header>`;
}

function cartPanel(ctx: PageContext, store: Store | undefined): string {
  const c = classNames(ctx.variant);
  return `<div class="${c.cartPanel}" role="dialog" aria-modal="true" aria-label="Cart" data-cart-dialog hidden>`
    + `<div class="${c.cartHead}"><h2>Cart</h2><button type="button" class="${c.cartClose}" aria-label="Close" data-op="close-cart">${icon("close")}</button></div>`
    + `<div class="${c.cartBody}" data-cart-body>${cartBodyHtml(c, STORES.map(({ slug, name }) => ({ slug, name })), ctx.carts, store?.slug || "")}</div></div>`;
}

function shellHtml(ctx: PageContext, shell: Shell): string {
  const c = classNames(ctx.variant);
  const names: Record<string, string> = {};
  for (const store of STORES) for (const item of store.products) names[item.id] = item.name;
  const data = JSON.stringify({
    c,
    store: shell.store?.slug || "",
    stores: STORES.map(({ slug, name }) => ({ slug, name })),
    carts: ctx.carts,
    names,
  }).replace(/</g, "\\u003c");
  const favicon = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='9' r='6' fill='#ff7009'/><path d='M8 3c-1-2-3-3-5-3c1 2 3 3 5 3zm0 0c1-2 3-3 5-3c-1 2-3 3-5 3z' fill='#0aad0a'/></svg>")}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(shell.title)}</title><link rel="icon" href="${favicon}"><style>${css(c, ctx.variant)}</style></head>`
    + `<body class="${c.page}">${header(ctx, shell)}${shell.body}${cartPanel(ctx, shell.store)}`
    + `<script type="application/json" id="fixture-data">${data}</script>`
    + `<script>${SHARED}\n(${String(client)})();</script></body></html>`;
}

function sidebar(ctx: PageContext, store: Store): string {
  const c = classNames(ctx.variant);
  const badge = `<div class="${c.storeBadge}"><span class="${c.storeDot}" style="background:${store.color}" aria-hidden="true">${esc(store.name[0])}</span><span>${esc(store.name)}</span></div>`;
  const facts = `<div>${esc(store.blurb)}</div><div>${esc(store.eta)}</div>`;
  const links = [
    `<a href="/store/${store.slug}/storefront">Shop</a>`,
    `<a href="/checkout?store=${store.slug}">Checkout</a>`,
    `<a href="/instacart-plus">Try Instacart+ free</a>`,
    `<a href="/account/addresses">Change address</a>`,
  ];
  const ordered = ctx.variant === "drift" ? [links[3], links[0], links[2], links[1]] : links;
  return `<aside class="${c.sidebar}" aria-label="${esc(store.name)} store">${badge}${facts}<nav class="${c.sideLinks}" aria-label="Store links">${ordered.join("")}</nav></aside>`;
}

function storeLayout(ctx: PageContext, store: Store, main: string): string {
  const c = classNames(ctx.variant);
  const content = `<main class="${c.main}">${main}</main>`;
  if (ctx.variant === "drift") return `<div class="${c.layout}">${content}${sidebar(ctx, store)}</div>`;
  return `<div class="${c.layout}">${sidebar(ctx, store)}${content}</div>`;
}

export function homePage(ctx: PageContext): string {
  const c = classNames(ctx.variant);
  const order = ctx.variant === "drift" ? ["sprouts", "costco", "safeway"] : ["costco", "safeway", "sprouts"];
  const cards = order.map((slug) => STORES.find((store) => store.slug === slug)).filter((store): store is Store => !!store).map((store) => (
    `<li><a class="${c.storeCard}" href="/store/${store.slug}/storefront" data-testid="${TEST_IDS[ctx.variant].store}">`
    + `<span class="${c.storeDot}" style="background:${store.color}" aria-hidden="true">${esc(store.name[0])}</span>`
    + `<span><strong>${esc(store.name)}</strong><br><span class="${c.size}">${esc(store.eta)} · ${esc(store.blurb)}</span></span></a></li>`
  )).join("");
  const body = `<main class="${c.home}"><h1 class="${c.title}">Stores to help you save</h1>`
    + `<p class="${c.lede}">Delivery in as fast as 1 hour</p><ul class="${c.stores}" aria-label="Stores">${cards}</ul></main>`;
  return shellHtml(ctx, { title: "Instacart | Grocery Delivery or Pickup from Local Stores Near You", body });
}

export function globalSearchPage(ctx: PageContext, query: string, hits: { store: Store; count: number }[]): string {
  const c = classNames(ctx.variant);
  const rows = hits.map(({ store, count }) => `<li><a class="${c.storeCard}" href="/store/${store.slug}/s?k=${encodeURIComponent(query)}">`
    + `<span class="${c.storeDot}" style="background:${store.color}" aria-hidden="true">${esc(store.name[0])}</span>`
    + `<span><strong>${esc(store.name)}</strong><br><span class="${c.size}">${count} results</span></span></a></li>`).join("");
  const body = `<main class="${c.home}"><h1 class="${c.title}">Results for “${esc(query)}”</h1>`
    + (rows ? `<ul class="${c.results}" aria-label="Stores with results">${rows}</ul>` : `<p class="${c.lede}">No results</p>`) + `</main>`;
  return shellHtml(ctx, { title: `${query} | Instacart`, body, query });
}

export function storefrontPage(ctx: PageContext, store: Store): string {
  const c = classNames(ctx.variant);
  const featured = store.featured.map((id) => store.products.find((item) => item.id === id)).filter((item): item is Product => !!item);
  const main = `<h1 class="${c.title}">${esc(store.name)}</h1><p class="${c.lede}">${esc(store.eta)} · ${esc(store.blurb)}</p>`
    + `<h2>Popular items</h2>${gridHtml(ctx, store, featured, "Popular items")}`;
  return shellHtml(ctx, { title: `${store.name} Delivery or Pickup Near Me | Instacart`, body: storeLayout(ctx, store, main), store });
}

export function searchPage(ctx: PageContext, store: Store, query: string, items: Product[]): string {
  const c = classNames(ctx.variant);
  const list = items.length
    ? gridHtml(ctx, store, items, `Results for ${query}`)
    : `<p class="${c.lede}">No results for “${esc(query)}” at ${esc(store.name)}</p>`;
  const main = `<h1 class="${c.title}">Results for “${esc(query)}”</h1><p class="${c.lede}">${items.length} items at ${esc(store.name)}</p>${list}`;
  return shellHtml(ctx, { title: `${query} | ${store.name} | Instacart`, body: storeLayout(ctx, store, main), store, query });
}

export function productPage(ctx: PageContext, store: Store, item: Product): string {
  const c = classNames(ctx.variant);
  const ids = TEST_IDS[ctx.variant];
  const art = productArt(item);
  const selectId = ctx.variant === "drift" ? "pdp-quantity-select" : "quantity";
  const options = Array.from({ length: 10 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join("");
  const qty = qtyIn(ctx, store, item.id);
  const gallery = `<div class="${c.gallery}"><div class="${c.thumbs}">`
    + `<button type="button" class="${c.thumb}" aria-pressed="true" aria-label="Image 1"><img alt="" src="${art}"></button>`
    + `<button type="button" class="${c.thumb}" aria-pressed="false" aria-label="Image 2"><img alt="" src="${art}"></button></div>`
    + `<img class="${c.hero}" alt="${esc(item.name)}" src="${art}"></div>`;
  const brandQuery = encodeURIComponent(item.brand.toLowerCase());
  const info = `<div class="${c.info}"><h1>${esc(item.name)}</h1>`
    + `<a class="${c.brandLink}" href="/store/${store.slug}/s?k=${brandQuery}">Shop all ${esc(item.brand.toLowerCase())}</a>`
    + (item.attributes.length ? `<ul class="${c.attrs}">${item.attributes.map((attr) => `<li>${esc(attr)}</li>`).join("")}</ul>` : "") + `</div>`;
  const buy = `<div class="${c.buy}"><div class="${c.buyPrice}">${money(item.price)}</div>`
    + `<label class="${c.qtyLabel}" for="${selectId}">Quantity</label><select class="${c.qtySelect}" id="${selectId}" name="quantity">${options}</select>`
    + `<button type="button" class="${c.addToCart}" data-op="add" data-from="#${selectId}" data-store="${store.slug}" data-product="${esc(item.id)}" data-testid="${ids.addToCart}">Add to cart</button>`
    + `<p class="${c.inCart}" role="status" data-in-cart="${esc(item.id)}" data-store="${store.slug}">${qty ? `${qty} in cart` : ""}</p>`
    + `<button type="button" class="${c.save}" aria-pressed="false" data-op="save">${icon("bookmark")}<span>Save</span></button></div>`;
  const others = store.products.filter((other) => other.id !== item.id).slice(-4);
  const related = others.length ? `<section class="${c.related}" aria-label="Items to add next"><h2>Items to add next</h2>${gridHtml(ctx, store, others, "Items to add next")}</section>` : "";
  const back = `<button type="button" class="${c.back}" data-op="back" data-fallback="/store/${store.slug}/storefront">${icon("back")}<span>Back</span></button>`;
  const grid = ctx.variant === "drift"
    ? `<div class="${c.pdpGrid}">${info}${buy}${gallery}</div>`
    : `<div class="${c.pdpGrid}">${gallery}${info}${buy}</div>`;
  const panel = ctx.variant === "drift" ? `${back}${related}${grid}` : `${back}${grid}${related}`;
  const body = `<main class="${c.pdp}"><div class="${c.panel}">${panel}</div></main>`;
  return shellHtml(ctx, { title: `${store.name} ${item.name} Delivery or Pickup Near Me - Instacart`, body, store });
}

export type TrapKind = "checkout" | "login" | "addresses" | "account" | "trial";

export function trapPage(ctx: PageContext, kind: TrapKind): string {
  const c = classNames(ctx.variant);
  const pages: Record<TrapKind, { title: string; body: string }> = {
    checkout: { title: "Checkout", body: `<h1>Checkout</h1><p>Review your order</p><button type="button" class="${c.trapButton}">Place order</button>` },
    login: {
      title: "Log in",
      body: `<h1>Log in</h1><label class="${c.field}">Email<input type="email" name="email" autocomplete="username"></label>`
        + `<label class="${c.field}">Password<input type="password" name="password" autocomplete="current-password"></label><button type="button" class="${c.trapButton}">Log in</button>`,
    },
    addresses: { title: "Addresses", body: `<h1>Your addresses</h1><button type="button" class="${c.trapButton}">Add address</button>` },
    account: { title: "Account settings", body: `<h1>Account settings</h1><p>Manage your account</p>` },
    trial: { title: "Instacart+", body: `<h1>Try Instacart+ free</h1><p>$0 delivery fees on orders over $35</p><button type="button" class="${c.trapButton}">Start free trial</button>` },
  };
  const page = pages[kind];
  return shellHtml(ctx, { title: `${page.title} | Instacart`, body: `<main class="${c.trap}">${page.body}</main>` });
}

export function notFoundPage(ctx: PageContext): string {
  const c = classNames(ctx.variant);
  return shellHtml(ctx, { title: "Page not found | Instacart", body: `<main class="${c.trap}"><h1>Page not found</h1><a href="/">Go to Instacart home</a></main>` });
}
