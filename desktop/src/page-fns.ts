// Page-side helpers. Passed to Playwright addInitScript / evaluate, so they must
// close over nothing from Node. This is a spike ranker: testid, id, visible text,
// css. It is not the extension's getSelectors (no anchors, no shadow path).

export interface RankedSelector {
  type: "testid" | "aria" | "text" | "id" | "css" | "shadowpath" | "ax";
  value: string;
  score: number;
}

export interface Described {
  selectors: RankedSelector[];
  reach: "light";
  unique: boolean;
  text: string;
}

export function installPageHelpers(): void {
  const w = window as unknown as {
    __baoDescribe?: (el: Element) => Described;
    __baoResolve?: (selectors: RankedSelector[]) => string | null;
    __baoLastTrusted?: boolean;
  };

  const esc = (s: string) =>
    window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  function labelOf(el: Element): string {
    if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button")) {
      return norm(el.value || "");
    }
    return norm(el.textContent || "");
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        parts.unshift(`#${esc(node.id)}`);
        break;
      }
      let nth = 1;
      let sib: Element | null = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) nth++;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${nth})`);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function matchesOf(s: RankedSelector): Element[] {
    if (s.type === "text") {
      return Array.from(document.querySelectorAll("a,button,h1,h2,h3,input[type=submit]")).filter(
        (el) => labelOf(el) === s.value
      );
    }
    if (s.type === "testid" || s.type === "id" || s.type === "css") {
      try {
        return Array.from(document.querySelectorAll(s.value));
      } catch {
        return [];
      }
    }
    return [];
  }

  w.__baoDescribe = (el: Element): Described => {
    const sels: RankedSelector[] = [];
    const tid = el.getAttribute("data-testid");
    if (tid) sels.push({ type: "testid", value: `[data-testid="${esc(tid)}"]`, score: 1 });
    if (el.id && !/^(ember|react|mui|css-)/i.test(el.id)) {
      sels.push({ type: "id", value: `#${esc(el.id)}`, score: 0.85 });
    }
    const text = labelOf(el);
    const textTag = /^(A|BUTTON|H1|H2|H3)$/.test(el.tagName) ||
      (el instanceof HTMLInputElement && el.type === "submit");
    if (text && text.length <= 80 && textTag) sels.push({ type: "text", value: text, score: 0.7 });
    if (el instanceof HTMLInputElement && el.type && el.type !== "text") {
      const attr = `input[type="${el.type}"]`;
      if (document.querySelectorAll(attr).length === 1) sels.push({ type: "css", value: attr, score: 0.55 });
    }
    sels.push({ type: "css", value: cssPath(el), score: 0.3 });
    sels.sort((a, b) => b.score - a.score);
    const top = sels[0];
    const n = top ? matchesOf(top).length : 0;
    return { selectors: sels, reach: "light", unique: n === 1, text };
  };

  w.__baoResolve = (selectors: RankedSelector[]): string | null => {
    document.querySelectorAll("[data-bao-hit]").forEach((el) => el.removeAttribute("data-bao-hit"));
    const ranked = [...selectors].sort((a, b) => b.score - a.score);
    for (const s of ranked) {
      const found = matchesOf(s);
      if (found.length === 1 && found[0] instanceof HTMLElement) {
        found[0].setAttribute("data-bao-hit", "1");
        return s.type;
      }
    }
    return null;
  };

  document.addEventListener(
    "click",
    (e) => {
      w.__baoLastTrusted = e.isTrusted;
    },
    true
  );
}
