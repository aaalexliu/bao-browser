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
      const beforeUrl = location.href;
      const beforeLines = visible();
      setTimeout(() => {
        const typed = fieldValues();
        const added = visible().filter((line) => !beforeLines.includes(line) && !typed.has(line));
        const afterText = added.join(" ").slice(0, 180);
        const payload = { kind: "act", op: "click", identity: ident(el), beforeUrl, afterUrl: location.href };
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
