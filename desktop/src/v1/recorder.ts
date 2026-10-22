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
    const monthIndex = (name) => {
      const names = ["january","february","march","april","may","june","july","august","september","october","november","december"];
      const n = names.indexOf(String(name || "").toLowerCase());
      return n < 0 ? 0 : n + 1;
    };
    const isoDate = (y, m, d) => String(y) + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    const pickerMark = (el) => {
      if (!el || !el.closest) return null;
      const popup = el.closest(".react-datepicker");
      if (popup) {
        const label = el.getAttribute && el.getAttribute("aria-label");
        const match = label && String(label).match(/(\\d{1,2})\\s+([A-Za-z]+)\\s+(\\d{4})/);
        const month = match ? monthIndex(match[2]) : 0;
        if (!match || !month) return { picker: true };
        return { picker: true, value: isoDate(Number(match[3]), month, Number(match[1])) };
      }
      const cal = el.closest(".rbc-calendar");
      if (cal) {
        const nav = norm(el.innerText || "").toLowerCase();
        if (nav === "today" || nav === "back" || nav === "next") return { picker: true };
        const cell = el.closest(".rbc-date-cell");
        if (!cell) return { picker: true };
        const heading = cal.querySelector(".rbc-toolbar-label");
        const label = heading && heading.textContent && heading.textContent.trim().match(/^([A-Za-z]+)\\s+(\\d{4})$/);
        const month = label ? monthIndex(label[1]) : 0;
        const day = Number(norm(cell.innerText || ""));
        if (!label || !month || !day) return { picker: true };
        return { picker: true, value: isoDate(Number(label[2]), month, day) };
      }
      const fixture = el.closest("[data-bao-picker]");
      if (fixture) {
        const date = el.getAttribute && el.getAttribute("data-date");
        if (el.getAttribute && el.getAttribute("data-nav")) return { picker: true };
        return date ? { picker: true, value: date } : { picker: true };
      }
      return null;
    };
    const calendarRange = (cal) => {
      const events = cal.querySelectorAll(".rbc-event");
      if (!events.length) return null;
      const heading = cal.querySelector(".rbc-toolbar-label");
      const label = heading && heading.textContent && heading.textContent.trim().match(/^([A-Za-z]+)\\s+(\\d{4})$/);
      const month = label ? monthIndex(label[1]) : 0;
      if (!label || !month) return null;
      const days = [];
      cal.querySelectorAll(".rbc-month-row").forEach((row) => {
        const cells = Array.from(row.querySelectorAll(".rbc-date-cell")).map((el) => ({
          day: Number(norm(el.innerText || "")),
          off: el.classList.contains("rbc-off-range"),
        }));
        const segments = Array.from(row.querySelectorAll(".rbc-row-segment"));
        if (!segments.some((seg) => seg.querySelector(".rbc-event"))) return;
        let cursor = 0;
        segments.forEach((seg) => {
          const basis = Number.parseFloat(seg.style.flexBasis || "0");
          const span = Math.round((basis / 100) * 7) || 0;
          const hit = !!seg.querySelector(".rbc-event");
          for (let i = 0; i < span; i++) {
            const cell = cells[cursor + i];
            if (hit && cell && !cell.off) days.push(cell.day);
          }
          cursor += span;
        });
      });
      if (!days.length) return null;
      const year = Number(label[2]);
      return { start: isoDate(year, month, days[0]), end: isoDate(year, month, days[days.length - 1]) };
    };
    document.addEventListener("click", (event) => {
      if (window.__baoPicking) return;
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
        const picked = pickerMark(el);
        if (picked) Object.assign(payload, picked);
        send(payload);
      }, 0);
    }, true);
    document.addEventListener("mouseup", (event) => {
      const cal = document.querySelector(".rbc-calendar");
      if (!cal || !event.target || !cal.contains(event.target)) return;
      setTimeout(() => {
        const range = calendarRange(cal);
        if (!range) return;
        send({ kind: "act", op: "click", picker: true, value: range.start, endValue: range.end, identity: ident(cal) });
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
      const dateLike = el.type === "date" || /\\b(date|check-?in|check-?out|dob|birthday|arrival|departure)\\b/i.test([el.id, el.getAttribute("name"), el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" "));
      if (dateLike) {
        send({ kind: "act", op: "type", identity: ident(el), value: el.value, dateField: true, inputType: el.type || "text" });
        return;
      }
      send({ kind: "act", op: "type", identity: ident(el), value: el.value });
    }, true);
    const elementOf = (raw) => !raw ? null : raw.nodeType === 1 ? raw : raw.parentElement;
    const dropTarget = (raw) => {
      const el = elementOf(raw);
      return el && el.closest ? el.closest("input[type=file], [data-bao-drop]") : null;
    };
    // An OS file drag can deliver the drop to the document with client coordinates
    // that miss the zone. The last dragover that was actually over a file input
    // or drop zone is the zone the pointer released on.
    let dropHover = null;
    document.addEventListener("dragover", (event) => {
      if (!event.dataTransfer) return;
      // Cancel the browser's default, which is to navigate to the file.
      // The drop event is what gets recorded, and only on a file input or drop zone.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      const pointed = document.elementFromPoint(event.clientX, event.clientY);
      const zone = dropTarget(event.target) || dropTarget(pointed);
      dropHover = zone ? { zone, x: event.clientX, y: event.clientY } : null;
    }, true);
    document.addEventListener("drop", (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) event.preventDefault();
      const pointed = document.elementFromPoint(event.clientX, event.clientY);
      const direct = dropTarget(event.target) || dropTarget(pointed);
      const zone = direct || (dropHover && dropHover.zone);
      const host = zone || (pointed && pointed.closest ? pointed.closest("[data-testid], button, a, input") : null);
      const base = file && file.name ? file.name.split(/[/\\\\]/).pop() : "";
      if (!zone || !host || !base) return;
      if (zone.matches && zone.matches("input[type=file]")) window.__baoSkipNextFile = true;
      send({ kind: "act", op: "drop", identity: ident(host), fileName: base });
    }, true);
  })();`;
}
