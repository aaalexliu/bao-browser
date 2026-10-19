// The executor owns focus. Adapters never pass a target for type or keypress.
// Resolution uses document.activeElement, and the CDP accessibility tree's
// focused node is recorded beside it.

import type { Page } from "playwright";
import type { FieldHint } from "../../../src/mask";
import type { Described } from "../page-fns";

export interface AxFocus {
  role: string;
  name: string;
}

export interface TrackedFocus {
  scope: "element" | "page";
  editable: boolean;
  tag: string;
  described: Described | null;
  hint: FieldHint | null;
  ax: AxFocus | null;
}

interface AXNode {
  ignored?: boolean;
  focused?: boolean;
  role?: { value?: string };
  name?: { value?: string };
}

export async function readFocus(page: Page): Promise<TrackedFocus> {
  const dom = await page.evaluate(() => {
    const el = document.activeElement;
    const pageScoped = !el || el === document.body || el === document.documentElement;
    if (pageScoped) return { scope: "page" as const, tag: el ? el.tagName.toLowerCase() : "none" };
    const input = el instanceof HTMLInputElement ? el : null;
    const area = el instanceof HTMLTextAreaElement ? el : null;
    const editable = !!area || !!(el as HTMLElement).isContentEditable ||
      (!!input && !["checkbox", "radio", "button", "submit", "file", "range", "image"].includes(input.type));
    const w = window as unknown as { __baoDescribe?: (node: Element) => Described };
    return {
      scope: "element" as const,
      tag: el.tagName.toLowerCase(),
      editable,
      described: w.__baoDescribe ? w.__baoDescribe(el) : null,
      hint: {
        type: input?.type || "",
        autocomplete: el.getAttribute("autocomplete") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        placeholder: el.getAttribute("placeholder") || "",
        value: "",
      },
    };
  });
  const ax = await axFocus(page);
  if (dom.scope === "page") {
    return { scope: "page", editable: false, tag: dom.tag, described: null, hint: null, ax };
  }
  return {
    scope: "element",
    editable: dom.editable,
    tag: dom.tag,
    described: dom.described,
    hint: dom.hint,
    ax,
  };
}

/** Keys that are a page action when nothing editable is focused. */
export const PAGE_KEYS = new Set(["Escape", "Tab"]);

export function normalizeKey(key: string): string {
  const k = key.trim();
  if (k === "Esc") return "Escape";
  if (k === "Return") return "Enter";
  return k;
}

async function axFocus(page: Page): Promise<AxFocus | null> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Accessibility.enable").catch(() => {});
    const evaluated = await client.send("Runtime.evaluate", {
      expression: "document.activeElement",
    }) as { result?: { objectId?: string } };
    const objectId = evaluated.result?.objectId;
    if (!objectId) return null;
    const described = await client.send("DOM.describeNode", { objectId }) as {
      node?: { backendNodeId?: number };
    };
    const backendNodeId = described.node?.backendNodeId;
    if (backendNodeId === undefined) return null;
    const partial = await client.send("Accessibility.getPartialAXTree", { backendNodeId }) as {
      nodes?: AXNode[];
    };
    const node = (partial.nodes ?? []).find((n) => n.role?.value && !n.ignored) ?? partial.nodes?.[0];
    if (!node) return null;
    return {
      role: node.role?.value || "",
      name: (node.name?.value || "").slice(0, 80),
    };
  } catch {
    return null;
  } finally {
    await client.detach().catch(() => {});
  }
}
