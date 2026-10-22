// Interpret cases for extract and for_each. Same trail, same workflow.
// A copied list becomes an extract. A copied table that is typed row by row
// becomes a for_each. An ordinary trail stays version 2.

import type { TrailEvent } from "../../v1/interpret";

const dom = {
  surface: "dom" as const,
  path: [] as { role: string }[],
};

export interface DataCase {
  id: string;
  name: string;
  events: TrailEvent[];
  expect: "extract" | "for_each" | "plain";
}

const listLocators = [
  { kind: "css" as const, value: "article.product_pod" },
  { kind: "xpath" as const, value: "//article[contains(@class,\"product_pod\")]" },
];

const columns = [
  { name: "title", type: "text" as const, read: "title" as const, locators: [{ kind: "css" as const, value: "h3 > a" }] },
  { name: "price", type: "text" as const, read: "text" as const, locators: [{ kind: "css" as const, value: "p.price_color" }] },
  { name: "rating", type: "text" as const, read: "rating" as const, locators: [{ kind: "css" as const, value: "p.star-rating" }] },
];

function act(id: string, op: string, extra: Partial<TrailEvent> = {}): TrailEvent {
  return { id, ts: 1, kind: "act", op, ...extra };
}

export const dataCases: DataCase[] = [
  {
    id: "copied-list",
    name: "A copied list becomes an extract",
    expect: "extract",
    events: [
      act("copy-1", "copy", {
        list: {
          as: "books",
          headers: ["title", "price", "rating"],
          rows: [
            { title: "Alpha", price: "£10.00", rating: "Three" },
            { title: "Beta", price: "£20.00", rating: "Five" },
          ],
          locators: listLocators,
          columns,
        },
      }),
    ],
  },
  {
    id: "typed-rows",
    name: "Copied rows typed into a form become for_each",
    expect: "for_each",
    events: [
      act("copy-2", "copy", {
        list: {
          as: "people",
          headers: ["name", "email"],
          rows: [
            { name: "Ada Lovelace", email: "ada@example.com" },
            { name: "Grace Hopper", email: "grace@example.com" },
          ],
        },
      }),
      act("t1", "type", { value: "Ada Lovelace", identity: { ...dom, role: "textbox", id: "userName" } }),
      act("t2", "type", { value: "ada@example.com", identity: { ...dom, role: "textbox", id: "userEmail" } }),
      act("c1", "click", { identity: { ...dom, role: "button", name: "Submit" } }),
      act("t3", "type", { value: "Grace Hopper", identity: { ...dom, role: "textbox", id: "userName" } }),
      act("t4", "type", { value: "grace@example.com", identity: { ...dom, role: "textbox", id: "userEmail" } }),
      act("c2", "click", { identity: { ...dom, role: "button", name: "Submit" } }),
    ],
  },
  {
    id: "plain-click",
    name: "An ordinary click stays version 2",
    expect: "plain",
    events: [
      act("c", "click", { identity: { ...dom, role: "button", name: "Save" } }),
      act("t", "type", { value: "hello", identity: { ...dom, role: "textbox", id: "note" } }),
    ],
  },
];
