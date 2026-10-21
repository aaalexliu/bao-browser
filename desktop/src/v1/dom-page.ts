// Runs inside the page. No Node imports. Playwright serializes this function.

export interface DomDump {
  handle: string;
  surface: "dom";
  role: string;
  name?: string;
  testId?: string;
  id?: string;
  nameAttr?: string;
  tag?: string;
  label?: string;
  text?: string;
  cssPath?: string;
  path: { role: string; name?: string }[];
  value?: string;
}

export interface PageDump {
  url: string;
  title: string;
  nodes: DomDump[];
  texts: string[];
  values: { handle: string; value: string }[];
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
      if (el.type === "file" || el.type === "text" || el.type === "password" || el.type === "email") return "textbox";
      if (el.type === "submit" || el.type === "button") return "button";
    }
    if (tag === "h1" || tag === "h2" || tag === "h3") return "heading";
    return tag;
  };

  const labelFor = (el: Element): string => {
    if (el.id) {
      const label = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (label) return norm(label.textContent || "");
    }
    const wrap = el.closest("label");
    if (wrap) return norm(wrap.textContent || "");
    return el.getAttribute("aria-label") || "";
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
    return /^(A|BUTTON|INPUT|TEXTAREA|SELECT|LABEL|H1|H2|H3|SUMMARY)$/.test(tag)
      || el.hasAttribute("role")
      || el.hasAttribute("data-testid")
      || el.hasAttribute("data-bao-drop");
  };

  const nodes: DomDump[] = [];
  const values: { handle: string; value: string }[] = [];
  const texts: string[] = [];
  let n = 0;
  document.querySelectorAll("body *").forEach((el) => {
    if (!(el instanceof HTMLElement) || !interesting(el)) return;
    const handle = String(n++);
    el.setAttribute("data-bao-i", handle);
    const text = norm(el.innerText || el.textContent || "").slice(0, 80);
    if (text && text.length < 80) texts.push(text);
    const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
    if (input && input.type !== "password" && input.type !== "file") {
      values.push({ handle, value: input.value });
    }
    const path: { role: string; name?: string }[] = [];
    let parent: Element | null = el.parentElement;
    while (parent && parent !== document.body && path.length < 6) {
      path.unshift({ role: roleOf(parent), name: norm(parent.getAttribute("aria-label") || "").slice(0, 40) || undefined });
      parent = parent.parentElement;
    }
    nodes.push({
      handle,
      surface: "dom",
      role: roleOf(el),
      name: el.getAttribute("aria-label") || undefined,
      testId: el.getAttribute("data-testid") || undefined,
      id: el.id || undefined,
      nameAttr: el.getAttribute("name") || undefined,
      tag: el.tagName.toLowerCase(),
      label: labelFor(el) || undefined,
      text: text || undefined,
      cssPath: cssPath(el),
      path,
      value: input && input.type !== "password" ? input.value : undefined,
    });
  });
  return { url: location.href, title: document.title, nodes, texts, values };
}
