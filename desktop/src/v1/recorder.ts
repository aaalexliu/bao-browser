// Page script for a capture session. A password field becomes a secret slot.
// This string runs in the page. It must not read the password value.

/** What a recorded field is allowed to keep. Password values are dropped. */
export function recordedField(field: { type?: string; value?: string }): { value?: string; sensitive?: boolean } {
  if ((field.type || "").toLowerCase() === "password") return { sensitive: true };
  return field.value === undefined ? {} : { value: field.value };
}

export function recorderSource(): string {
  return `(() => {
    const norm = (v) => (v || "").replace(/\\s+/g, " ").trim();
    const send = (payload) => { if (window.__baoRecord) window.__baoRecord(payload); };
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
      const el = event.target && event.target.closest ? event.target.closest("button,a,input,textarea,select,li,[data-testid]") : event.target;
      if (!el) return;
      const before = location.href;
      setTimeout(() => send({ kind: "act", op: "click", identity: ident(el), beforeUrl: before, afterUrl: location.href }), 0);
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
        const file = el.files && el.files[0];
        send({ kind: "act", op: "upload", identity: ident(el), fileName: file && file.name });
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
      send({ kind: "act", op: "drop", identity: ident(el), fileName: file && file.name });
    }, true);
  })();`;
}
