// Page script for a capture session. A password field becomes a secret slot.
// This string runs in the page. It must not read the password value.

/** What a recorded field is allowed to keep. Password values are dropped. */
export function recordedField(field: { type?: string; value?: string }): { value?: string; sensitive?: boolean } {
  if ((field.type || "").toLowerCase() === "password") return { sensitive: true };
  return field.value === undefined ? {} : { value: field.value };
}

/** Leaf text keyed by a structural path, so a later read can see what appeared. */
export function leafTexts(): Record<string, string> {
  const norm = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 240);
  const skip = /^(SCRIPT|STYLE|NOSCRIPT|SVG)$/;
  const keyOf = (el: Element) => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body) {
      let nth = 1;
      let sib: Element | null = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) nth += 1;
      parts.unshift(`${node.tagName}:${nth}`);
      node = node.parentElement;
    }
    return parts.join("/");
  };
  const out: Record<string, string> = {};
  document.querySelectorAll("body *").forEach((el) => {
    if (!(el instanceof HTMLElement) || el.childElementCount || skip.test(el.tagName)) return;
    if (el.hidden || el.closest("[hidden]")) return;
    // Password covers exist only for the screenshot. They are not a page effect.
    if (el.closest("[data-bao-mask], [data-bao-blur]")) return;
    const text = norm(el.innerText || el.textContent || "");
    if (!text) return;
    out[keyOf(el)] = text;
  });
  return out;
}

/** The shortest leaf that gained text. An empty before means the text appeared. */
export function smallestChange(
  before: Record<string, string>,
  after: Record<string, string>,
): { before: string; after: string } | undefined {
  let best: { before: string; after: string; rank: number } | undefined;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const prev = before[key] || "";
    const next = after[key] || "";
    if (!next || next === prev) continue;
    const rank = (prev ? 1000 : 0) + next.length;
    if (!best || rank < best.rank) best = { before: prev, after: next, rank };
  }
  return best ? { before: best.before, after: best.after } : undefined;
}

export function recorderSource(): string {
  return `(() => {
    ${leafTexts.toString()}
    ${smallestChange.toString()}
    const norm = (v) => (v || "").replace(/\\s+/g, " ").trim();
    const send = (payload) => { if (window.__baoRecord) window.__baoRecord(payload); };
    let pending;
    const noteDialog = (type, message, decision) => {
      const text = String(message == null ? "" : message).replace(/\\s+/g, " ").trim().slice(0, 180) || "dialog";
      pending = { type, message: text, decision };
    };
    const nativeAlert = window.alert;
    window.alert = function(message) {
      nativeAlert.call(window, message);
      noteDialog("alert", message, "accept");
    };
    const nativeConfirm = window.confirm;
    window.confirm = function(message) {
      const ok = nativeConfirm.call(window, message);
      noteDialog("confirm", message, ok ? "accept" : "dismiss");
      return ok;
    };
    const nativePrompt = window.prompt;
    window.prompt = function(message, value) {
      const typed = nativePrompt.call(window, message, value);
      noteDialog("prompt", message, typed == null ? "dismiss" : "accept");
      return typed;
    };
    const fieldValues = () => new Set([...document.querySelectorAll("input, textarea")].map((el) => norm(el.value)).filter(Boolean));
    const visible = () => [...document.querySelectorAll("[data-testid]")].map((el) => norm(el.innerText || el.value || "")).filter(Boolean);
    const secretSent = new WeakSet();
    const notePassword = (el) => {
      if (secretSent.has(el)) return;
      secretSent.add(el);
      const identity = ident(el);
      identity.role = "password";
      send({ kind: "act", op: "type", identity, sensitive: true });
    };
    const ident = (el) => ({
      surface: "dom",
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      testId: el.getAttribute("data-testid") || undefined,
      id: el.id || undefined,
      nameAttr: el.getAttribute("name") || undefined,
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute("aria-label") || undefined,
      text: norm(el.innerText || el.textContent || "").slice(0, 80) || undefined,
      path: [],
    });
    document.addEventListener("click", (event) => {
      const raw = event.target;
      if (raw && raw.closest && raw.closest("input[type=file]")) return;
      const el = raw && raw.closest ? raw.closest("button,a,input,textarea,select,li,[data-testid]") : raw;
      if (!el) return;
      pending = undefined;
      const leaves = leafTexts();
      const beforeUrl = location.href;
      const beforeLines = visible();
      setTimeout(() => {
        const change = smallestChange(leaves, leafTexts());
        const dialog = pending;
        pending = undefined;
        const typed = fieldValues();
        const added = visible().filter((line) => !beforeLines.includes(line) && !typed.has(line));
        const afterText = added.join(" ").slice(0, 180);
        const payload = { kind: "act", op: "click", identity: ident(el), beforeUrl, afterUrl: location.href };
        if (dialog) {
          payload.dialog = dialog.message;
          payload.dialogType = dialog.type;
          payload.dialogDecision = dialog.decision;
        }
        if (change) {
          payload.subtreeBefore = change.before;
          payload.subtreeAfter = change.after;
        }
        if (afterText) payload.afterText = afterText;
        send(payload);
      }, 0);
    }, true);
    document.addEventListener("input", (event) => {
      const el = event.target;
      if (!el || el.type !== "password") return;
      notePassword(el);
    }, true);
    document.addEventListener("change", (event) => {
      const el = event.target;
      if (!el) return;
      if (el.type === "file") {
        if (window.__baoSkipNextFile) {
          window.__baoSkipNextFile = false;
          return;
        }
        const file = el.files && el.files[0];
        if (!file || !file.name || file.name.indexOf("/") !== -1 || file.name.indexOf("\\\\") !== -1) return;
        send({ kind: "act", op: "upload", identity: ident(el), fileName: file.name });
        return;
      }
      if (el.type === "password") {
        notePassword(el);
        return;
      }
      send({ kind: "act", op: "type", identity: ident(el), value: el.value });
    }, true);
    document.addEventListener("drop", (event) => {
      const el = event.target;
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file || !file.name || file.name.indexOf("/") !== -1 || file.name.indexOf("\\\\") !== -1) return;
      send({ kind: "act", op: "drop", identity: ident(el), fileName: file.name });
    }, true);
  })();`;
}
