// Runs inside the page. Playwright serializes installDataPage, so every
// helper lives inside it. No Node imports.
//
// List detection follows the scrapers bao is measured against:
// Bardeen (click one row, find siblings, propose columns), Axiom and
// Browserflow (a list plus a Next control), Playwright (role, text, test
// id, css, and xpath, tried in that order).

export function installDataPage(): void {
  const RATINGS = ["One", "Two", "Three", "Four", "Five"];

  const norm = (value: string | null | undefined): string => (value || "").replace(/\s+/g, " ").trim();

  const cssEscape = (value: string): string => {
    const css = window.CSS;
    if (css && typeof css.escape === "function") return css.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  const cssAttr = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, "\\'");

  const stableClasses = (el: Element): string[] => [...el.classList].filter((name) => {
    if (RATINGS.includes(name)) return false;
    if (/^(active|current|selected|hover|focus)$/i.test(name)) return false;
    if (/\d{4,}/.test(name)) return false;
    return true;
  });

  const piece = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const classes = stableClasses(el).slice(0, 2);
    return classes.length ? `${tag}.${classes.join(".")}` : tag;
  };

  const roleOf = (el: Element): string => {
    const aria = el.getAttribute("role");
    if (aria) return aria;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "listbox";
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox") return "checkbox";
      if (el.type === "radio") return "radio";
      if (el.type === "submit" || el.type === "button") return "button";
      return "textbox";
    }
    return tag;
  };

  const identName = (raw: string, index: number): string => {
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (/^[a-z][a-z0-9_]*$/.test(cleaned)) return cleaned;
    return `col_${index + 1}`;
  };

  type Locator = { kind: string; value?: string; role?: string; name?: string };

  const query = (root: ParentNode, locator: Locator): Element[] => {
    try {
      if (locator.kind === "css" && locator.value) return [...root.querySelectorAll(locator.value)];
      if (locator.kind === "testid" && locator.value) {
        return [...root.querySelectorAll(`[data-testid="${cssAttr(locator.value)}"]`)];
      }
      if (locator.kind === "xpath" && locator.value) {
        const doc = root instanceof Document ? root : (root as Element).ownerDocument || document;
        const snap = doc.evaluate(locator.value, root instanceof Document ? doc : root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const found: Element[] = [];
        for (let i = 0; i < snap.snapshotLength; i++) {
          const node = snap.snapshotItem(i);
          if (node instanceof Element) found.push(node);
        }
        return found;
      }
      if (locator.kind === "role" && locator.role) {
        const scope = root instanceof Document ? root.body : root;
        return [...(scope?.querySelectorAll("*") || [])].filter((el) => {
          if (roleOf(el) !== locator.role && el.tagName.toLowerCase() !== locator.role) return false;
          if (!locator.name) return true;
          const label = el.getAttribute("aria-label") || "";
          return norm(label) === locator.name || norm(el.textContent) === locator.name;
        });
      }
      if (locator.kind === "text" && locator.value) {
        const scope = root instanceof Document ? root.body : root;
        return [...(scope?.querySelectorAll("*") || [])].filter((el) => norm(el.textContent) === locator.value);
      }
    } catch {
      return [];
    }
    return [];
  };

  const queryAll = (root: ParentNode, locators: Locator[]): Element[] => {
    for (const locator of locators) {
      const found = query(root, locator);
      if (found.length) return found;
    }
    return [];
  };

  const relativeSelector = (row: Element, el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== row) {
      parts.unshift(piece(node));
      const selector = parts.join(" > ");
      try {
        if (row.querySelectorAll(selector).length === 1) return selector;
      } catch {
        return selector;
      }
      node = node.parentElement;
    }
    return parts.join(" > ") || piece(el);
  };

  const rowSelector = (row: Element): { css: string; xpath: string } => {
    const tag = row.tagName.toLowerCase();
    const classes = stableClasses(row);
    const parent = row.parentElement;
    const parentClass = parent ? stableClasses(parent)[0] : undefined;
    let css = classes.length ? `${tag}.${classes.slice(0, 2).join(".")}` : tag;
    if (parent && parentClass) css = `${parent.tagName.toLowerCase()}.${parentClass} > ${css}`;
    else if (parent?.id && !/\d{4,}/.test(parent.id)) css = `#${cssEscape(parent.id)} > ${tag}`;
    const xpathClass = classes[0] || parentClass;
    const xpath = xpathClass
      ? `//${parent && parentClass ? `${parent.tagName.toLowerCase()}[contains(@class,"${parentClass}")]/` : ""}${tag}[contains(@class,"${classes[0] || parentClass}")]`
      : `//${tag}`;
    return { css, xpath };
  };

  const readMode = (el: Element): string => {
    if ([...el.classList].some((name) => RATINGS.includes(name) || /star/i.test(name))) return "rating";
    if (el.getAttribute("title")) return "title";
    if (el instanceof HTMLImageElement) return "src";
    return "text";
  };

  const suggestName = (el: Element, index: number, used: Set<string>): string => {
    let base = "col";
    if (el.getAttribute("title")) base = "title";
    else if ([...el.classList].some((name) => /star/i.test(name))) base = "rating";
    else if (stableClasses(el).length) base = identName(stableClasses(el)[stableClasses(el).length - 1] || "", index);
    else if (el.tagName === "A") base = "link";
    else base = identName(el.tagName.toLowerCase(), index);
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    return name;
  };

  const readEl = (el: Element | null, mode: string): string => {
    if (!el) return "";
    if (mode === "rating") {
      const hit = [...el.classList].find((name) => RATINGS.includes(name));
      return hit || norm(el.textContent);
    }
    if (mode === "title") return el.getAttribute("title") || norm(el.textContent);
    if (mode === "href") return el instanceof HTMLAnchorElement ? el.href : (el.getAttribute("href") || "");
    if (mode === "src") return el instanceof HTMLImageElement ? (el.currentSrc || el.src) : (el.getAttribute("src") || "");
    if (mode === "value" && "value" in el) return norm(String((el as HTMLInputElement).value || ""));
    return norm(el.textContent);
  };

  const interesting = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.closest("script, style, noscript, svg")) return false;
    const tag = el.tagName;
    if (/^(A|IMG|H1|H2|H3|H4|P|TD|TH|BUTTON|INPUT|TEXTAREA|SELECT|TIME)$/.test(tag)) return true;
    if (el.classList.length && norm(el.textContent).length > 0 && el.children.length <= 2) return true;
    return false;
  };

  const proposeElement = (start: Element): Record<string, unknown> => {
    const viewH = window.innerHeight || 800;
    let node: Element | null = start instanceof HTMLElement ? start : start.parentElement;
    let best: { row: Element; css: string; xpath: string; count: number } | undefined;
    let depth = 0;
    while (node && node !== document.body && depth < 10) {
      const built = rowSelector(node);
      let count = 0;
      try { count = document.querySelectorAll(built.css).length; } catch { count = 0; }
      const rect = node.getBoundingClientRect();
      const generic = !stableClasses(node).length && /^(a|span|div|p|li|ul|ol)$/i.test(node.tagName);
      if (!generic && count >= 2 && count <= 80 && rect.height > 12 && rect.height < viewH * 0.85) {
        best = { row: node, css: built.css, xpath: built.xpath, count };
      }
      node = node.parentElement;
      depth += 1;
    }
    if (!best) {
      const text = norm(start.textContent).slice(0, 80);
      const built = rowSelector(start);
      return {
        mode: "element",
        count: 1,
        locators: [
          { kind: "css", value: built.css },
          { kind: "xpath", value: built.xpath },
        ],
        columns: [{
          id: "value",
          name: "value",
          read: "text",
          type: "text",
          locators: [{ kind: "css", value: ":scope" }],
          samples: text ? [text] : [],
        }],
      };
    }
    const rows = query(document, { kind: "css", value: best.css }).slice(0, 6);
    const sample = rows.length ? rows : [best.row];
    const groups = new Map<string, { el: Element; selector: string }>();
    for (const row of sample) {
      for (const el of row.querySelectorAll("*")) {
        if (!interesting(el)) continue;
        const selector = relativeSelector(row, el);
        if (!selector || groups.has(selector)) continue;
        let unique = false;
        try { unique = row.querySelectorAll(selector).length === 1; } catch { unique = false; }
        if (!unique) continue;
        groups.set(selector, { el, selector });
      }
    }
    const used = new Set<string>();
    const columns = [...groups.values()].map(({ el, selector }, index) => {
      const read = readMode(el);
      const name = suggestName(el, index, used);
      const samples: string[] = [];
      for (const row of sample.slice(0, 4)) {
        let inner: Element | null = null;
        try { inner = row.querySelector(selector); } catch { inner = null; }
        const value = readEl(inner, read);
        if (value) samples.push(value.slice(0, 80));
      }
      const type = read === "href" || read === "src" ? "url" : "text";
      return {
        id: name,
        name,
        read,
        type,
        locators: [{ kind: "css", value: selector }],
        samples,
      };
    }).filter((column) => column.samples.length > 0).slice(0, 8);

    const locators: Locator[] = [
      { kind: "css", value: best.css },
      { kind: "xpath", value: best.xpath },
    ];
    return {
      mode: "list",
      count: best.count,
      locators,
      columns,
      next: findNext(),
    };
  };

  const findNext = (): Locator[] | undefined => {
    const typed = document.querySelector("li.next a, a.next, a[rel='next']");
    const byText = [...document.querySelectorAll("a")].find((el) => /^(next|›|»)$/i.test(norm(el.textContent)));
    const el = typed || byText;
    if (!(el instanceof Element)) return undefined;
    const locators: Locator[] = [];
    if (el.closest("li.next")) locators.push({ kind: "css", value: "li.next a" });
    if (el.classList.contains("next")) locators.push({ kind: "css", value: "a.next" });
    const rel = el.getAttribute("rel");
    if (rel === "next") locators.push({ kind: "css", value: "a[rel='next']" });
    const label = norm(el.textContent) || "next";
    locators.push({ kind: "role", role: "link", name: label });
    locators.push({ kind: "text", value: label });
    return locators;
  };

  const host = window as unknown as Record<string, unknown>;

  host.__baoPropose = (arg: { selector?: string; x?: number; y?: number }) => {
    let el: Element | null = null;
    if (arg && arg.selector) {
      try { el = document.querySelector(arg.selector); } catch { el = null; }
    } else if (arg && typeof arg.x === "number" && typeof arg.y === "number") {
      el = document.elementFromPoint(arg.x, arg.y);
    }
    if (!el) return { error: "no element" };
    return proposeElement(el);
  };

  host.__baoReadList = (spec: {
    locators?: Locator[];
    columns?: { name: string; read?: string; locators?: Locator[]; dropped?: boolean }[];
    pagination?: { next?: Locator[] };
  }) => {
    const rows = queryAll(document, spec.locators || []);
    const records: Record<string, string>[] = [];
    for (const row of rows) {
      const record: Record<string, string> = {};
      for (const column of spec.columns || []) {
        if (column.dropped) continue;
        const inner = queryAll(row, column.locators || [])[0] || null;
        record[column.name] = readEl(inner, column.read || "text");
      }
      if (Object.values(record).some((value) => value)) records.push(record);
    }
    const next = spec.pagination?.next;
    const nextVisible = next ? queryAll(document, next).some((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) : false;
    return { rows: records, nextVisible };
  };

  host.__baoMark = (locators: Locator[]) => {
    document.querySelectorAll("[data-bao-pick]").forEach((el) => el.removeAttribute("data-bao-pick"));
    const found = queryAll(document, locators);
    const el = found.find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!el) return false;
    el.setAttribute("data-bao-pick", "1");
    el.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  };

  let pickHandler: ((event: Event) => void) | null = null;
  host.__baoArm = () => {
    if (pickHandler) document.removeEventListener("click", pickHandler, true);
    host.__baoPicking = true;
    pickHandler = (event: Event) => {
      host.__baoPicking = false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (pickHandler) document.removeEventListener("click", pickHandler, true);
      pickHandler = null;
      const raw = event.target;
      const el = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null;
      const proposal = el ? proposeElement(el) : { error: "no element" };
      host.__baoLastProposal = proposal;
      const deliver = host.__baoDeliver;
      if (typeof deliver === "function") void (deliver as (value: unknown) => unknown)(proposal);
    };
    document.addEventListener("click", pickHandler, true);
  };
}
