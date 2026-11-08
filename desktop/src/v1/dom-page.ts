// Runs inside the page. No Node imports. Playwright serializes this function.

export interface DomDump {
  handle: string;
  surface: "dom";
  role: string;
  name?: string;
  testId?: string;
  id?: string;
  nameAttr?: string;
  placeholder?: string;
  tag?: string;
  inputType?: string;
  autocomplete?: string;
  label?: string;
  text?: string;
  cssPath?: string;
  xpath?: string;
  href?: string;
  path: { role: string; name?: string }[];
  value?: string;
  bbox?: { x: number; y: number; w: number; h: number };
  checked?: boolean;
  enabled?: boolean;
  overlay?: boolean;
  /** visibility, display, or aria-hidden. A 0×0 box is reported on bbox, not here. */
  hidden?: boolean;
  /** Inside a dialog. A form modal is not an overlay sitting on top of its own fields. */
  inDialog?: boolean;
}

export interface PageDump {
  url: string;
  title: string;
  nodes: DomDump[];
  texts: string[];
  values: { handle: string; value: string }[];
  viewport?: { width: number; height: number };
}

export function dumpPage(): PageDump {
  const cssEscape = (value: string) =>
    window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const norm = (value: string) => value.replace(/\s+/g, " ").trim();
  document.querySelectorAll("[data-bao-i]").forEach((el) => el.removeAttribute("data-bao-i"));

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
      if (el.type === "file" || el.type === "text" || el.type === "password" || el.type === "email") return "textbox";
      if (el.type === "submit" || el.type === "button") return "button";
    }
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") return "heading";
    return tag;
  };

  const parentOf = (node: Element): Element | null => {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  const byId = (id: string, from: Node): Element | null => {
    const root = from.getRootNode();
    if (root instanceof Document || root instanceof ShadowRoot) {
      const found = root.getElementById(id);
      if (found) return found;
    }
    return document.getElementById(id);
  };

  const labelText = (source: Node | null, control: Element | null): string => {
    if (!source || control?.contains(source)) return "";
    if (source.nodeType === Node.TEXT_NODE) return source.textContent || "";
    return Array.from(source.childNodes, (child) => labelText(child, control)).join("");
  };

  const labelFor = (el: Element): string => {
    const control = el.tagName === "LABEL" ? null : el;
    const aria = norm(el.getAttribute("aria-label") || "");
    if (aria) return aria;
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled.split(/\s+/).map((id) => labelText(byId(id, el), control)).join(" ");
      if (norm(text)) return norm(text);
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (label) return norm(labelText(label, control));
    }
    let wrap: Element | null = el;
    while (wrap && wrap.tagName !== "LABEL") wrap = parentOf(wrap);
    if (wrap && wrap.tagName === "LABEL") return norm(labelText(wrap, control));
    return norm(el.getAttribute("title") || "");
  };

  const xpathOf = (el: Element): string => {
    const name = el.getAttribute("name");
    if (el.id && !/\d{4,}/.test(el.id) && !/[0-9a-f]{8,}/i.test(el.id)) {
      return `//*[@id="${el.id.replace(/"/g, "")}"]`;
    }
    if (name && !name.includes('"')) return `//${el.tagName.toLowerCase()}[@name="${name}"]`;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1) {
      let ix = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) ix += 1;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${ix}]`);
      if (node === document.body) break;
      node = node.parentElement;
    }
    return `/${parts.join("/")}`;
  };

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body) {
      if (node.id && !/\d{4,}/.test(node.id)) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      let nth = 1;
      let sib: Element | null = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) nth++;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${nth})`);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const interesting = (el: Element): boolean => {
    const tag = el.tagName;
    return /^(A|BUTTON|INPUT|TEXTAREA|SELECT|LABEL|H1|H2|H3|H4|SUMMARY)$/.test(tag)
      || el.hasAttribute("role")
      || el.matches('[contenteditable]:not([contenteditable="false"])')
      || el.hasAttribute("data-testid")
      || el.hasAttribute("data-qa")
      || el.hasAttribute("data-test")
      || el.hasAttribute("data-cy")
      || el.hasAttribute("data-bao-drop");
  };

  const nodes: DomDump[] = [];
  const values: { handle: string; value: string }[] = [];
  const texts: string[] = [];
  let n = 0;
  const shownText = (el: Element): string => {
    if (el instanceof HTMLSelectElement) {
      const option = el.selectedOptions[0];
      return norm(option?.label || option?.text || "").slice(0, 80);
    }
    return norm((el as HTMLElement).innerText || el.textContent || "").slice(0, 80);
  };
  const consider = (el: Element): void => {
    if (!(el instanceof HTMLElement)) return;
    if (el.shadowRoot) el.shadowRoot.querySelectorAll("*").forEach((child) => consider(child));
    if (el.hidden || el.closest("[hidden]")) return;
    const leaf = el.childElementCount === 0 ? shownText(el) : "";
    if (!interesting(el)) {
      if (leaf && leaf.length < 80) texts.push(leaf);
      return;
    }
    const handle = String(n++);
    el.setAttribute("data-bao-i", handle);
    const text = shownText(el);
    if (text && text.length < 80) texts.push(text);
    // A file input's chosen name is not innerText. The upload check looks for it.
    if (el instanceof HTMLInputElement && el.type === "file") {
      const chosen = el.files?.[0]?.name || "";
      if (chosen && chosen.length < 180) texts.push(chosen);
    }
    const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
    const value = input ? input.value
      : el.isContentEditable ? el.innerText : undefined;
    if (value !== undefined && input?.type !== "file") {
      values.push({ handle, value });
    }
    const path: { role: string; name?: string }[] = [];
    let parent: Element | null = parentOf(el);
    while (parent && parent !== document.body && path.length < 6) {
      path.unshift({ role: roleOf(parent), name: norm(parent.getAttribute("aria-label") || "").slice(0, 40) || undefined });
      parent = parentOf(parent);
    }
    const accessible = labelFor(el)
      || (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button") ? el.value : "");
    nodes.push({
      handle,
      surface: "dom",
      role: roleOf(el),
      name: norm(accessible).slice(0, 80) || undefined,
      testId: el.getAttribute("data-testid") || el.getAttribute("data-qa") || el.getAttribute("data-test") || el.getAttribute("data-cy") || undefined,
      href: el.tagName === "A" ? (el.getAttribute("href") || undefined) : undefined,
      id: el.id || undefined,
      nameAttr: el.getAttribute("name") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      tag: el.tagName.toLowerCase(),
      inputType: el.getAttribute("type") || undefined,
      autocomplete: el.getAttribute("autocomplete") || undefined,
      label: labelFor(el) || undefined,
      text: text || undefined,
      cssPath: cssPath(el),
      xpath: xpathOf(el),
      path,
      value,
      bbox: (() => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      })(),
      checked: input instanceof HTMLInputElement && (input.type === "radio" || input.type === "checkbox") ? input.checked : undefined,
      enabled: !el.hasAttribute("disabled"),
      overlay: el.getAttribute("role") === "dialog" || el.hasAttribute("data-bao-overlay") || el.getAttribute("data-testid") === "overlay-close" || undefined,
      hidden: (() => {
        const style = getComputedStyle(el);
        return style.display === "none" || style.visibility === "hidden" || el.getAttribute("aria-hidden") === "true";
      })(),
      inDialog: !!el.closest("[role='dialog'], [role='alertdialog']"),
    });
  };
  document.querySelectorAll("body *").forEach((el) => consider(el));
  return { url: location.href, title: document.title, nodes, texts, values, viewport: { width: window.innerWidth, height: window.innerHeight } };
}

/** Status lines a teach check can name. Runs in the page. Skips typed values and file echoes. */
export function visibleStatusLines(): string[] {
  const norm = (value: string) => (value || "").replace(/\s+/g, " ").trim();
  const typed = new Set([...document.querySelectorAll("input, textarea")]
    .map((el) => norm((el as HTMLInputElement).value))
    .filter(Boolean));
  return [...document.querySelectorAll("[data-testid]")]
    .map((el) => norm(el.textContent || ""))
    .filter((line) => line && !typed.has(line) && !/^waiting/i.test(line) && !/^Dropped file:/i.test(line) && !/^Received file:/i.test(line));
}
