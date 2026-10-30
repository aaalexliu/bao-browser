import { INSTACART_DENY } from "./presets";

/** Guards for the one Instacart add-and-remove. The page function runs in the tab. */

export const STAPLE = "bananas";

/** clickForbidden also runs in the tab, where the import does not exist. READER_HELPERS sends this value there. */
const INSTACART_DENY_SOURCE = INSTACART_DENY;

export function clickForbidden(label: string): boolean {
  const text = label.replace(/\s+/g, " ").trim();
  return new RegExp(INSTACART_DENY_SOURCE, "i").test(text);
}

export function stapleNameOk(name: string): boolean {
  const text = name.replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > 80) return false;
  if (!/\bbananas?\b/i.test(text)) return false;
  if (/bread|chip|pudding|muffin|candy|yogurt|smoothie|cookie|cake|ice cream|cream pie|split|pepper|plantain|extract|flavor/i.test(text)) return false;
  return true;
}

/** A visible dialog the run may ignore, or a wall it must stop on. Empty is not a wall. */
export function classifyDialog(text: string): "" | "captcha" | "login" | "trial" | "store" | "address" | "cart" | "other" {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (/captcha|not a robot|verify you are human|verify you are not a bot/i.test(clean)) return "captcha";
  if (/password|log in|sign in|one-time code|verification code/i.test(clean)) return "login";
  if (/free trial|instacart\s*\+|try plus|start your trial/i.test(clean)) return "trial";
  if (/choose a store|select a store|which store|pick a store/i.test(clean)) return "store";
  if (/enter your address|add your address|confirm your address|delivery address|what's your address|where should we deliver/i.test(clean)) return "address";
  if (/your cart|cart is empty|subtotal|distinct items in cart|estimated total/i.test(clean)) return "cart";
  return "other";
}

export function searchLabelOk(label: string): boolean {
  const text = label.replace(/\s+/g, " ").trim();
  if (!text || text.length > 80 || clickForbidden(text)) return false;
  if (/address|email|zip|postal|password|phone|card/i.test(text)) return false;
  return /search/i.test(text);
}

export function addProductName(label: string): string {
  const text = label.replace(/\s+/g, " ").trim();
  const named = text.match(/^add\s+1\s+(?:ct|item|pkg|ea|each)\s+(.+)$/i);
  const name = named?.[1]?.slice(0, 80) || "";
  return stapleNameOk(name) ? name : "";
}

export function addLabelOk(label: string): boolean {
  const text = label.replace(/\s+/g, " ").trim();
  if (!text || text.length > 120 || clickForbidden(text) || /\$|delivery fee|checkout/i.test(text)) return false;
  if (/^(add|add to cart|add item)$/i.test(text)) return true;
  return addProductName(text).length > 0;
}

/** Prefer the string that actually carries the cart count. */
export function cartControlLabel(aria: string, text: string): string {
  const clean = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 80);
  const primary = clean(aria);
  const visible = clean(text);
  if (/\d/.test(primary) && /cart/i.test(primary)) return primary;
  if (/cart/i.test(visible)) return visible;
  return primary || visible;
}

/** Header cart. Empty carts say "View Cart". A cart with items says "Add $X to get $0 delivery fee N". */
export function cartLabelOk(label: string): boolean {
  const text = label.replace(/\s+/g, " ").trim();
  if (!text || text.length > 80 || clickForbidden(text) || /add to cart|checkout|distinct items in cart/i.test(text)) return false;
  if (/^(cart|view cart|open cart|your cart|shopping cart)\b/i.test(text)) return true;
  if (/^view\b/i.test(text) && /\bitems?\b/i.test(text) && /\bcart\b/i.test(text)) return true;
  if (/items in cart/i.test(text) && /\bcart\b/i.test(text)) return true;
  if (/\bitems?\b/i.test(text) && /\bin your\b/i.test(text) && /\b\d+\b/.test(text) && !/\$/.test(text)) return true;
  return /^add \$[\d.]+ to get \$[\d.]+ delivery fee\s+\d+\s*$/i.test(text);
}

/** The count is the items phrase or the last number on the fee label, never the dollar amount. */
export function cartCountFromLabel(label: string, badge: string | null): number | null {
  const text = label.replace(/\s+/g, " ").trim();
  if (!text || text.length > 80) return null;
  const inCart = text.match(/items in cart:?\s*(\d+)/i);
  if (inCart?.[1]) return Number(inCart[1]);
  const items = text.match(/\b(\d+)\b(?:\s+\S+){0,3}\s+items?\b/i);
  if (items?.[1] && (/\b(?:cart|bag|basket)s?\b/i.test(text) || /\bin your\b/i.test(text))) return Number(items[1]);
  const fee = text.match(/^add \$[\d.]+ to get \$[\d.]+ delivery fee\s+(\d+)\s*$/i);
  if (fee?.[1]) return Number(fee[1]);
  const trailing = text.match(/^(?:view cart|open cart|your cart|shopping cart|cart)\b\D*(\d+)\s*$/i);
  if (trailing?.[1]) return Number(trailing[1]);
  if (badge && /^\d+$/.test(badge) && /^(cart|view cart|open cart|your cart|shopping cart)\b/i.test(text)) return Number(badge);
  if (/^(view cart|cart)\.?$/i.test(text)) return 0;
  return null;
}

export function removeLabelOk(label: string, how: string, quantity: number | null): boolean {
  const text = label.replace(/\s+/g, " ").trim();
  if (!text || text.length > 120 || clickForbidden(text)) return false;
  if (quantity == null || !Number.isInteger(quantity) || quantity < 1) return false;
  if (how === "decrease") return /^(decrease|decrement)\b/i.test(text) || /^(−|-|minus)$/i.test(text);
  if (how === "remove" && quantity === 1) return /^remove\b/i.test(text) && !/\ball\b/i.test(text);
  return false;
}

/** The add changed the count by one, and the later count matches the start. */
export function cartRestored(before: number, afterAdd: number, afterRemove: number): boolean {
  return Number.isInteger(before) && before >= 0
    && afterAdd === before + 1
    && afterRemove === before;
}

export interface InstacartSnap {
  blocked: string | null;
  cartCount: number | null;
  cartAmbiguous: boolean;
  search: boolean;
  searchLabel: string;
  cartLabel: string;
  addLabel: string;
  product: string;
  price: number | null;
  removeHow: string;
  removeLabel: string;
  removeQuantity: number | null;
  dialog: boolean;
  hints: string[];
}

/**
 * Runs inside the Instacart page. Returns flags and the one staple control.
 * It does not return dialog text, addresses, or other cart lines.
 * Guard calls are injected beside this function; it cannot import them.
 */
export function readInstacart(wantProduct: string): InstacartSnap {
  const want = (wantProduct || "").replace(/\s+/g, " ").trim().toLowerCase();
  const empty: InstacartSnap = {
    blocked: null,
    cartCount: null,
    cartAmbiguous: false,
    search: false,
    searchLabel: "",
    cartLabel: "",
    addLabel: "",
    product: "",
    price: null,
    removeHow: "",
    removeLabel: "",
    removeQuantity: null,
    dialog: false,
    hints: [],
  };
  const norm = (value: string | null | undefined): string => (value || "").replace(/\s+/g, " ").trim();
  const shown = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const labelOf = (el: Element): string => {
    const labelled = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => {
      const root = el.getRootNode();
      const node = root instanceof Document || root instanceof ShadowRoot ? root.getElementById(id) : null;
      return norm(node?.textContent);
    }).filter(Boolean).join(" ");
    const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
    const aria = norm(el.getAttribute("aria-label"));
    if (aria) return aria.slice(0, 180);
    if (input) return norm(labelled || input.placeholder || el.getAttribute("title")).slice(0, 180);
    const icon = el.querySelector("img[alt], svg[aria-label], [role='img'][aria-label]");
    const iconText = norm(icon?.getAttribute("alt") || icon?.getAttribute("aria-label"));
    const text = norm(labelled || el.getAttribute("title") || el.textContent).slice(0, 180);
    if (iconText && /cart|bag|basket/i.test(iconText) && (text === "" || /^\d+$/.test(text))) return iconText.slice(0, 180);
    return text || iconText.slice(0, 180);
  };
  const parentOf = (el: Element): Element | null => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const roots: ParentNode[] = [document];
  let shadows = 0;
  document.querySelectorAll("iframe").forEach((frame) => {
    if (!(frame instanceof HTMLIFrameElement)) return;
    try {
      if (frame.contentDocument) roots.push(frame.contentDocument);
    } catch {
      /* A cross-origin frame is not read. */
    }
  });
  const collect = (sel: string, countShadows = false): Element[] => {
    const out: Element[] = [];
    const walk = (root: ParentNode): void => {
      root.querySelectorAll("*").forEach((el) => {
        if (el.matches(sel)) out.push(el);
        if (el instanceof HTMLElement && el.shadowRoot) {
          if (countShadows) shadows += 1;
          walk(el.shadowRoot);
        }
      });
    };
    roots.forEach(walk);
    return out;
  };
  const hintOf = (label: string): string | null => {
    const text = norm(label).slice(0, 80);
    if (!text || /@|\bstreet\b|\bavenue\b|\broad\b|\bapt\b|\b\d{5}\b/i.test(text)) return null;
    if (/distinct items in cart/i.test(text)) return "store-cart";
    if (/^add \$[\d.]+ to get \$[\d.]+ delivery fee\s+\d+\s*$/i.test(text)) return "header-cart-with-fee";
    if (/^(view cart|open cart|your cart|shopping cart|cart)\b/i.test(text) || /items in cart/i.test(text)) return "view-cart";
    if (/^search\b/i.test(text)) return "search";
    if (/^add\s+1\s+(?:ct|item|pkg|ea|each)\b/i.test(text) || /^(add|add to cart|add item)$/i.test(text)) return "add";
    if (/^(decrement|decrease|increment|increase)\b/i.test(text)) return text.split(/\s+/).slice(0, 2).join(" ");
    if (/^remove\b/i.test(text)) return "remove";
    if (/^(log in|sign in|checkout|go to checkout)$/i.test(text)) return text.toLowerCase();
    return null;
  };

  collect("[data-bao-search], [data-bao-add], [data-bao-cart], [data-bao-remove]").forEach((el) => {
    el.removeAttribute("data-bao-search");
    el.removeAttribute("data-bao-add");
    el.removeAttribute("data-bao-cart");
    el.removeAttribute("data-bao-remove");
  });

  const snap: InstacartSnap = { ...empty };
  if (collect("input[type='password']").some(shown)) {
    snap.blocked = "password";
    snap.hints = ["controls:password"];
    return snap;
  }
  const heading = norm(document.querySelector("h1")?.textContent).slice(0, 180);
  if (/address|deliver to|where should we deliver|what's your address/i.test(heading)) {
    snap.blocked = "address";
    snap.hints = ["controls:address"];
    return snap;
  }
  if (/store/i.test(heading) && /choose|select|pick|which/i.test(heading)) {
    snap.blocked = "store";
    snap.hints = ["controls:store"];
    return snap;
  }
  const title = document.title || "";
  if (/captcha|not a robot|access denied|just a moment|pardon our interruption|verify you are human/i.test(title)) {
    snap.blocked = "captcha";
  }

  const dialogs = collect("[role='dialog'], [role='alertdialog']").filter(shown);
  snap.dialog = dialogs.length > 0;
  const dialogBits = (dialog: Element): string => {
    const bits: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        bits.push(node.textContent || "");
        return;
      }
      if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
      node.childNodes.forEach(walk);
    };
    walk(dialog);
    return norm(bits.join(" ")).slice(0, 800);
  };
  const dialogText = dialogs.map(dialogBits).join("\n");
  const dialogClass = classifyDialog(dialogText);
  if (!snap.blocked && dialogClass && dialogClass !== "cart" && dialogClass !== "other") snap.blocked = dialogClass;

  const body = norm(document.body?.innerText || "").slice(0, 4000);
  if (!snap.blocked && /verify you are human|verify you are not a bot|i'm not a robot|captcha/i.test(body)) snap.blocked = "captcha";

  const buttons = collect("button, a, [role='button'], input[type='submit'], input[type='button']", true).filter(shown);
  const fields = collect("input, textarea, [role='searchbox'], [role='textbox'], [role='combobox']").filter((el) => {
    if (!shown(el)) return false;
    if (el instanceof HTMLInputElement && /password|email|tel|hidden|file|checkbox|radio/i.test(el.type)) return false;
    const auto = el.getAttribute("autocomplete") || "";
    if (/street|address|postal|cc-|email|tel|username|password/i.test(auto)) return false;
    const label = labelOf(el);
    if (/address|email|zip|postal|password|phone|card/i.test(label)) return false;
    return searchLabelOk(label);
  });
  const covers = (dialog: Element, el: Element): boolean => {
    const a = dialog.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    if (a.width < 80 || a.height < 80) return false;
    const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return b.width > 0 && b.height > 0 && overlapX > b.width * 0.5 && overlapY > b.height * 0.5;
  };
  if (snap.dialog && !want && !snap.blocked && dialogClass === "other") {
    const openSearch = fields.some((el) => !dialogs.some((dialog) => covers(dialog, el)));
    const coveredSearch = fields.some((el) => dialogs.some((dialog) => covers(dialog, el)));
    if (coveredSearch && !openSearch) snap.blocked = "unexpected-dialog";
  }

  const hinted = new Set<string>();
  for (const el of [...buttons, ...fields]) {
    const hint = hintOf(labelOf(el));
    if (hint) hinted.add(hint);
  }
  const topWord = /^(cart|view|open|bag|basket|items|delivery|search|add|menu|account|shop)$/i;
  let tops = 0;
  for (const el of buttons) {
    if (tops >= 4 || el.getBoundingClientRect().top >= 180) continue;
    const word = labelOf(el).split(" ")[0]?.toLowerCase() || "";
    if (!topWord.test(word) || hinted.has(`top:${word}`)) continue;
    hinted.add(`top:${word}`);
    tops += 1;
  }
  if (snap.dialog) hinted.add(`dialog:${dialogClass || "empty"}`);
  snap.hints = [`controls:b${buttons.length}:i${fields.length}:s${shadows}:d${dialogs.length}`, ...hinted].slice(0, 8);
  if (snap.blocked) return snap;

  const badgeOf = (el: Element): string | null => {
    const badge = Array.from(el.querySelectorAll("span, div")).map((node) => norm(node.textContent)).find((text) => /^\d+$/.test(text));
    return badge || null;
  };
  const inHeader = (el: Element): boolean => {
    if (el.closest("header, nav, [role='banner']")) return true;
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.top < 180;
  };
  const cartCandidate = (el: Element): boolean => {
    const visible = "innerText" in el ? (el as HTMLElement).innerText || "" : "";
    const label = cartControlLabel(el.getAttribute("aria-label") || "", visible);
    return cartLabelOk(label) && cartCountFromLabel(label, badgeOf(el)) != null;
  };
  const carts = buttons.filter(cartCandidate);
  const headerBits = carts.length ? [] : collect("div, span").filter((el) => {
    const text = norm(el.textContent);
    if (!text || text.length > 80) return false;
    return shown(el) && inHeader(el) && cartCandidate(el);
  });
  const headerCarts = (carts.length ? carts : headerBits).filter(inHeader);
  const poolSource = carts.length ? carts : headerBits;
  const chosen = headerCarts.length ? headerCarts : poolSource;
  const pool = chosen.filter((el) => !chosen.some((other) => other !== el && el.contains(other)));
  snap.cartAmbiguous = pool.length > 1;
  const onlyCart = pool.length === 1 ? pool[0] : undefined;
  if (onlyCart) {
    const visible = "innerText" in onlyCart ? (onlyCart as HTMLElement).innerText || "" : "";
    const label = cartControlLabel(onlyCart.getAttribute("aria-label") || "", visible);
    snap.cartCount = cartCountFromLabel(label, badgeOf(onlyCart));
    snap.cartLabel = label.slice(0, 80);
    onlyCart.setAttribute("data-bao-cart", "1");
  }

  const headerFields = fields.filter((el) => el.getBoundingClientRect().top < 220);
  const search = headerFields[0] || fields[0];
  if (search) {
    snap.search = true;
    snap.searchLabel = labelOf(search).slice(0, 80);
    search.setAttribute("data-bao-search", "1");
  }

  if (!want) {
    let best: { el: Element; name: string; price: number | null } | null = null;
    for (const el of buttons) {
      const label = labelOf(el);
      if (!addLabelOk(label) || el.closest("[role='dialog'], [role='alertdialog']")) continue;
      const named = addProductName(label);
      let node: Element | null = el;
      let card: Element | null = null;
      let price: number | null = null;
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const text = norm(node.textContent);
        if (text.length > 600) break;
        const hasName = named ? text.toLowerCase().includes(named.toLowerCase()) : /\bbananas?\b/i.test(text);
        if (!hasName) {
          node = parentOf(node);
          continue;
        }
        card = node;
        const prices = [...text.matchAll(/\$(\d+\.\d{2})/g)].map((match) => Number(match[1])).filter((value) => value > 0 && value < 100);
        if (prices.length) {
          price = Math.min(...prices);
          break;
        }
        node = parentOf(node);
      }
      if (!card) continue;
      const headingName = norm(card.querySelector("h2, h3, h4, a")?.textContent).slice(0, 80);
      const name = stapleNameOk(named) ? named : headingName;
      if (!stapleNameOk(name)) continue;
      if (!best || (price != null && (best.price == null || price < best.price))) best = { el, name, price };
    }
    if (best) {
      snap.addLabel = labelOf(best.el).slice(0, 120);
      snap.product = best.name;
      snap.price = best.price;
      best.el.setAttribute("data-bao-add", "1");
    }
    return snap;
  }

  const rowQuantity = (row: Element): number | null => {
    const spin = row.querySelector("[role='spinbutton'], input[type='number']");
    if (spin instanceof HTMLInputElement && /^\d+$/.test(spin.value)) return Number(spin.value);
    if (spin && /^\d+$/.test(norm(spin.textContent))) return Number(norm(spin.textContent));
    const aria = Array.from(row.querySelectorAll("[aria-label]")).map((el) => el.getAttribute("aria-label") || "").join(" ");
    const named = aria.match(/quantity[^0-9]{0,16}(\d+)/i);
    if (named?.[1]) return Number(named[1]);
    const counts = Array.from(row.querySelectorAll("span, div, p")).map((el) => norm(el.textContent)).filter((text) => /^\d{1,2}\s*ct$/i.test(text));
    const nums = [...new Set(counts.map((text) => Number((text.match(/\d+/) || [])[0])))].filter((num) => num >= 1);
    return nums.length === 1 ? nums[0] ?? null : null;
  };
  const rows = collect("li, article, [role='listitem'], div").filter((el) => {
    if (!shown(el)) return false;
    const text = norm(el.textContent);
    if (!text || text.length > 1200 || !text.toLowerCase().includes(want)) return false;
    return Array.from(el.querySelectorAll("button, [role='button']")).some((button) => {
      const label = labelOf(button);
      return shown(button) && (/^(decrease|decrement)\b/i.test(label) || /^(−|-|minus)$/i.test(label) || /^remove\b/i.test(label));
    });
  });
  rows.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
  const row = rows[0];
  if (!row) return snap;
  const controls = Array.from(row.querySelectorAll("button, [role='button']")).filter(shown);
  const decrease = controls.find((el) => /^(decrease|decrement)\b/i.test(labelOf(el)) || /^(−|-|minus)$/i.test(labelOf(el)));
  const remove = controls.find((el) => /^remove\b/i.test(labelOf(el)) && !/\ball\b/i.test(labelOf(el)));
  let quantity = rowQuantity(row);
  if (quantity == null && remove && !decrease) {
    const label = labelOf(remove);
    if (/^remove$/i.test(label) || label.toLowerCase().includes(want)) quantity = 1;
  }
  if (quantity === 1 && remove && removeLabelOk(labelOf(remove), "remove", 1)) {
    snap.removeHow = "remove";
    snap.removeLabel = labelOf(remove).slice(0, 80);
    snap.removeQuantity = 1;
    remove.setAttribute("data-bao-remove", "1");
  } else if (decrease && removeLabelOk(labelOf(decrease), "decrease", quantity)) {
    snap.removeHow = "decrease";
    snap.removeLabel = labelOf(decrease).slice(0, 80);
    snap.removeQuantity = quantity;
    decrease.setAttribute("data-bao-remove", "1");
  } else {
    snap.removeQuantity = quantity;
  }
  return snap;
}

/** Everything readInstacart calls in the tab, in the shape evaluateFunction takes. */
export const READER_HELPERS: ReadonlyArray<{ name: string; toString(): string }> = [
  { name: "INSTACART_DENY_SOURCE", toString: () => JSON.stringify(INSTACART_DENY_SOURCE) },
  classifyDialog,
  clickForbidden,
  stapleNameOk,
  searchLabelOk,
  addProductName,
  addLabelOk,
  cartControlLabel,
  cartLabelOk,
  cartCountFromLabel,
  removeLabelOk,
];
