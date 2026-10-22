// Runs inside the fixture page. Playwright serializes this function, so it
// closes over nothing from Node.

export interface PageRequest {
  op: "view" | "at" | "active" | "id" | "scroll" | "file" | "auth";
  x?: number;
  y?: number;
  id?: string;
  dx?: number;
  dy?: number;
}

export function pageApi(request: PageRequest): unknown {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim();

  const roleOf = (el: Element): string => {
    const aria = el.getAttribute("role");
    if (aria) return aria;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "textarea" || tag === "select") return "textbox";
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox") return "checkbox";
      if (el.type === "radio") return "radio";
      if (el.type === "submit" || el.type === "button") return "button";
      return "textbox";
    }
    if (tag === "a") return "link";
    return tag;
  };

  const identityOf = (el: Element) => {
    const input = el instanceof HTMLInputElement ? el : null;
    return {
      surface: "dom" as const,
      role: roleOf(el),
      id: el.id || undefined,
      testId: el.getAttribute("data-testid") || undefined,
      name: el.getAttribute("aria-label") || undefined,
      text: norm(el.textContent || "").slice(0, 80) || undefined,
      nameAttr: el.getAttribute("name") || undefined,
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute("aria-label") || undefined,
      path: [] as { role: string; name?: string }[],
      inputType: input?.type || "",
    };
  };

  const clickGate = (el: Element): "login" | "confirm" | undefined => {
    const marked = el.closest("[data-bao-gate]");
    const gate = marked?.getAttribute("data-bao-gate");
    if (gate === "login" || gate === "confirm") return gate;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return undefined;
    const label = norm(el.getAttribute("aria-label") || el.textContent || "");
    if (/^confirm\b/i.test(label)) return "confirm";
    if (/^(log in|sign in)$/i.test(label)) return "login";
    return undefined;
  };

  const typeGate = (el: Element): "login" | "confirm" | undefined => {
    if (el instanceof HTMLInputElement && el.type === "password") return "login";
    const gate = el.getAttribute("data-bao-gate");
    if (gate === "login" || gate === "confirm") return gate;
    return undefined;
  };

  const boxOf = (el: Element) => {
    const raw = el.getBoundingClientRect();
    let x1 = raw.x;
    let y1 = raw.y;
    let x2 = raw.x + raw.width;
    let y2 = raw.y + raw.height;
    let parent = el.parentElement;
    while (parent && parent !== document.documentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX)) {
        const clip = parent.getBoundingClientRect();
        x1 = Math.max(x1, clip.x);
        y1 = Math.max(y1, clip.y);
        x2 = Math.min(x2, clip.x + clip.width);
        y2 = Math.min(y2, clip.y + clip.height);
      }
      parent = parent.parentElement;
    }
    x1 = Math.max(x1, 0);
    y1 = Math.max(y1, 0);
    x2 = Math.min(x2, window.innerWidth);
    y2 = Math.min(y2, window.innerHeight);
    return {
      x: raw.x,
      y: raw.y,
      w: raw.width,
      h: raw.height,
      vx: x1,
      vy: y1,
      vw: Math.max(0, x2 - x1),
      vh: Math.max(0, y2 - y1),
    };
  };

  const pack = (el: Element, gate: "login" | "confirm" | undefined) => ({
    identity: identityOf(el),
    gate,
    box: boxOf(el),
  });

  if (request.op === "view") {
    const text = (id: string) => norm(document.getElementById(id)?.textContent || "");
    const nodes: unknown[] = [];
    document.querySelectorAll("[id]").forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      if (!el.id || el.tagName === "BODY" || el.tagName === "HTML") return;
      const box = boxOf(el);
      nodes.push({
        id: el.id,
        role: roleOf(el),
        name: el.getAttribute("aria-label") || "",
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        vx: box.vx,
        vy: box.vy,
        vw: box.vw,
        vh: box.vh,
      });
    });
    return {
      url: location.href,
      status: text("status"),
      flash: text("flash"),
      files: text("files"),
      picked: text("picked"),
      nodes,
    };
  }

  if (request.op === "scroll") {
    let el = document.elementFromPoint(request.x || 0, request.y || 0) as HTMLElement | null;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) {
        el.scrollBy(request.dx || 0, request.dy || 0);
        return { scrolled: el.id || el.tagName };
      }
      el = el.parentElement;
    }
    window.scrollBy(request.dx || 0, request.dy || 0);
    return { scrolled: "window" };
  }

  if (request.op === "id" && request.id) {
    const el = document.getElementById(request.id);
    if (!el) return null;
    return pack(el, clickGate(el));
  }

  if (request.op === "file") {
    const el = document.querySelector("input[type=file]");
    if (!el) return null;
    return pack(el, undefined);
  }

  if (request.op === "auth") {
    const marked = document.querySelector("[data-bao-gate='login']");
    if (marked) return pack(marked, "login");
    const buttons = Array.from(document.querySelectorAll("button, [role='button'], input[type='submit']"));
    const found = buttons.find((el) => /^(log in|sign in)$/i.test(norm(el.getAttribute("aria-label") || el.textContent || "")));
    if (!found) return null;
    return pack(found, "login");
  }

  if (request.op === "active") {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    return pack(el, typeGate(el));
  }

  const raw = document.elementFromPoint(request.x || 0, request.y || 0);
  let el: Element | null = raw;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.id) break;
    el = el.parentElement;
  }
  if (!el || !("id" in el) || !el.id) return null;
  return pack(el, clickGate(el));
}
