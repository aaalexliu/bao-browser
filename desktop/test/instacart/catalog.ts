// Stores and products for the Instacart fixture. Names, sizes and the target
// price follow the owner's Costco blueberries flow on instacart.com.

export type StoreSlug = "costco" | "safeway" | "sprouts";

export interface Product {
  id: string;
  slug: string;
  name: string;
  price: number;
  size: string;
  brand: string;
  attributes: string[];
  /** Extra search words, so "blueberries" also finds a berry blend. */
  tags: string[];
  stock: string;
  art: { bg: string; band: string; text: string };
}

export interface Store {
  slug: StoreSlug;
  name: string;
  eta: string;
  blurb: string;
  color: string;
  products: Product[];
  /** Products shown on the storefront. The target is never one of them, so a run must search. */
  featured: string[];
}

function product(id: string, name: string, price: number, size: string, brand: string, extra: Partial<Product> = {}): Product {
  const slug = extra.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id,
    slug,
    name,
    price,
    size,
    brand,
    attributes: [],
    tags: [],
    stock: "Many in stock",
    art: { bg: "#e9f2fb", band: "#2b4c9a", text: "#ffffff" },
    ...extra,
  };
}

/** The owner's item. Path and price match the real product page. */
export const TARGET = product("19232694", "Kirkland Signature Organic Blueberries, 3 lbs", 9.89, "3 lb", "Kirkland Signature", {
  slug: "kirkland-signature-organic-blueberries-3-lb-3-lb",
  attributes: ["Organic"],
  tags: ["berry", "frozen", "fruit"],
  art: { bg: "#1f8f3a", band: "#c8102e", text: "#ffffff" },
});

export const TARGET_PATH = `/products/${TARGET.id}-${TARGET.slug}?retailerSlug=costco`;

const costco: Product[] = [
  product("16954301", "Fresh Blueberries, 18 oz", 5.99, "18 oz", "Costco", { tags: ["berry", "fruit"], art: { bg: "#dfe8f7", band: "#3b5ba5", text: "#ffffff" } }),
  TARGET,
  product("17820455", "Organic Blueberries, 24 oz", 8.49, "24 oz", "Costco", { attributes: ["Organic"], tags: ["berry", "fruit"], art: { bg: "#e4f1e0", band: "#2f6f3e", text: "#ffffff" } }),
  product("19104470", "Kirkland Signature Three Berry Blend, 4 lbs", 13.49, "4 lb", "Kirkland Signature", { tags: ["blueberry", "berry", "frozen"], art: { bg: "#f3e3ea", band: "#c8102e", text: "#ffffff" } }),
  product("15506728", "Townsend Farms Organic Berry Supreme, 48 oz", 12.99, "48 oz", "Townsend Farms", { attributes: ["Organic"], tags: ["blueberry", "berry", "frozen"], art: { bg: "#fbe9e4", band: "#7a2e8c", text: "#ffffff" } }),
  product("18405512", "Kirkland Signature Blueberry Muffins, 6 ct", 10.99, "6 ct", "Kirkland Signature", { tags: ["bakery"], art: { bg: "#f7eedc", band: "#c8102e", text: "#ffffff" } }),
  product("19232702", "Kirkland Signature Organic Strawberries, 4 lbs", 11.79, "4 lb", "Kirkland Signature", { attributes: ["Organic"], tags: ["berry", "frozen", "fruit"], art: { bg: "#fbe3e3", band: "#c8102e", text: "#ffffff" } }),
  product("16620915", "Kirkland Signature Organic Hemp Hearts, 32 oz", 14.29, "32 oz", "Kirkland Signature", { attributes: ["Organic"], art: { bg: "#eef3df", band: "#c8102e", text: "#ffffff" } }),
  product("14310088", "Bananas, 3 lbs", 1.99, "3 lb", "Costco", { tags: ["fruit"], art: { bg: "#fbf3c8", band: "#8a6d00", text: "#ffffff" } }),
];

const safeway: Product[] = [
  product("20311845", "Signature Farms Blueberries, 18 oz", 7.99, "18 oz", "Signature Farms", { tags: ["berry", "fruit"], art: { bg: "#e3e9f7", band: "#d0021b", text: "#ffffff" } }),
  product("20311902", "O Organics Organic Blueberries, 6 oz", 4.99, "6 oz", "O Organics", { attributes: ["Organic"], tags: ["berry", "fruit"], art: { bg: "#e6f2e1", band: "#4c7d2a", text: "#ffffff" } }),
  product("20318877", "Bananas, 2 lbs", 1.38, "2 lb", "Safeway", { tags: ["fruit"], art: { bg: "#fbf3c8", band: "#8a6d00", text: "#ffffff" } }),
];

const sprouts: Product[] = [
  product("21400311", "Sprouts Organic Blueberries, 6 oz", 3.99, "6 oz", "Sprouts", { attributes: ["Organic"], tags: ["berry", "fruit"], art: { bg: "#e9f3df", band: "#5a8f29", text: "#ffffff" } }),
  product("21400412", "Organic Bananas, 2 lbs", 1.78, "2 lb", "Sprouts", { attributes: ["Organic"], tags: ["fruit"], art: { bg: "#fbf3c8", band: "#5a8f29", text: "#ffffff" } }),
];

export const STORES: readonly Store[] = [
  { slug: "costco", name: "Costco", eta: "Delivery by 1pm", blurb: "In-store prices", color: "#e31837", products: costco, featured: ["14310088", "16620915", "19232702", "18405512"] },
  { slug: "safeway", name: "Safeway", eta: "Delivery by 12pm", blurb: "Lots of deals", color: "#d0021b", products: safeway, featured: ["20311845", "20311902", "20318877"] },
  { slug: "sprouts", name: "Sprouts", eta: "Delivery by 11am", blurb: "Organic", color: "#5a8f29", products: sprouts, featured: ["21400311", "21400412"] },
];

export function storeBySlug(slug: string): Store | undefined {
  return STORES.find((store) => store.slug === slug);
}

export function productIn(store: Store, id: string): Product | undefined {
  return store.products.find((item) => item.id === id);
}

export function productPath(store: Store, item: Product): string {
  return `/products/${item.id}-${item.slug}?retailerSlug=${store.slug}`;
}

function stem(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith("ies") && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("es") && /(?:ch|sh|x|ss|o)es$/.test(lower)) return lower.slice(0, -2);
  if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length > 3) return lower.slice(0, -1);
  return lower;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}

/** Every query word must match a name word or a tag, singular or plural. The store's own name is ignored. */
export function search(store: Store, query: string): Product[] {
  const own = new Set(words(store.name));
  const wanted = words(query).filter((word) => !own.has(word));
  if (!wanted.length) return [];
  return store.products.filter((item) => {
    const have = new Set([...words(item.name), ...words(item.brand), ...item.attributes.flatMap(words), ...item.tags.flatMap(words)]);
    return wanted.every((word) => have.has(word));
  });
}
