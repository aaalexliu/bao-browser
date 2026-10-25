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
  const parentOf = (node: Element): Element | null => {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const keyOf = (el: Element) => {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body) {
      let nth = 1;
      let sib: Element | null = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) nth += 1;
      parts.unshift(`${node.tagName}:${nth}`);
      node = parentOf(node);
    }
    return parts.join("/");
  };
  const out: Record<string, string> = {};
  const visit = (el: Element) => {
    if (!(el instanceof HTMLElement) || skip.test(el.tagName)) return;
    if (el.shadowRoot) el.shadowRoot.querySelectorAll("*").forEach((child) => visit(child));
    if (el.childElementCount) return;
    if (el.hidden || el.closest("[hidden]")) return;
    // Password covers exist only for the screenshot. They are not a page effect.
    if (el.closest("[data-bao-mask], [data-bao-blur]")) return;
    const text = norm(el.innerText || el.textContent || "");
    if (!text) return;
    out[keyOf(el)] = text;
  };
  document.querySelectorAll("body *").forEach((el) => visit(el));
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
    const noteDialog = (type, message, decision, value) => {
      const text = String(message == null ? "" : message).replace(/\\s+/g, " ").trim().slice(0, 180) || "dialog";
      const typed = value == null ? undefined : String(value).replace(/\\s+/g, " ").trim().slice(0, 180);
      pending = { type, message: text, decision, value: typed || undefined };
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
      noteDialog("prompt", message, typed == null ? "dismiss" : "accept", typed);
      return typed;
    };
    const cssPathOf = (el) => {
      const parts = [];
      let node = el;
      while (node && node !== document.body) {
        if (node.id && !/\\d{4,}/.test(node.id)) {
          const esc = window.CSS && CSS.escape ? CSS.escape(node.id) : String(node.id).replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
          parts.unshift("#" + esc);
          break;
        }
        let nth = 1;
        let sib = node;
        while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) nth++;
        parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + nth + ")");
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    const testIdOf = (el) => el.getAttribute("data-testid") || el.getAttribute("data-qa") || el.getAttribute("data-test") || el.getAttribute("data-cy") || undefined;
    const fieldClosed = (el) => {
      if (!el || el.disabled || el.hidden) return true;
      if (el.closest && (el.closest("[hidden]") || el.closest("[aria-hidden='true']"))) return true;
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
      const style = window.getComputedStyle ? getComputedStyle(el) : null;
      if (style && (style.display === "none" || style.visibility === "hidden")) return true;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return !!(rect && rect.width < 1 && rect.height < 1);
    };
    const dateLike = (el) => {
      if (!el || !el.getAttribute) return false;
      const hay = [el.id, el.getAttribute("name"), el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" ");
      return /date|dob|birth|check-?in|check-?out|birthday|arrival|departure/i.test(hay);
    };
    const receivesPointer = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return !!top && (top === el || el.contains(top));
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
    const parentOf = (node) => {
      if (!node) return null;
      if (node.parentElement) return node.parentElement;
      const root = node.getRootNode && node.getRootNode();
      return root && root.host ? root.host : null;
    };
    const accName = (el) => {
      const aria = norm(el.getAttribute("aria-label") || "");
      if (aria) return aria;
      const labelled = el.getAttribute("aria-labelledby");
      if (labelled) {
        const text = labelled.split(/\\s+/).map((id) => {
          const node = el.getRootNode ? el.getRootNode().getElementById?.(id) : null;
          return norm((node || document.getElementById(id) || {}).textContent || "");
        }).filter(Boolean).join(" ");
        if (text) return text.slice(0, 80);
      }
      if (el.id) {
        const label = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
        const via = norm(label && label.textContent || "");
        if (via) return via.slice(0, 80);
      }
      let wrap = el;
      while (wrap && wrap.tagName !== "LABEL") wrap = parentOf(wrap);
      if (wrap && wrap.tagName === "LABEL") {
        const via = norm(wrap.textContent || "");
        if (via) return via.slice(0, 80);
      }
      const title = norm(el.getAttribute("title") || "");
      if (title) return title.slice(0, 80);
      return "";
    };
    const roleOf = (el) => {
      const aria = el.getAttribute("role");
      if (aria) return aria;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "listbox";
      if (tag === "textarea") return "textbox";
      if (el.type === "checkbox") return "checkbox";
      if (el.type === "radio") return "radio";
      if (el.type === "submit" || el.type === "button") return "button";
      if (tag === "input") return "textbox";
      return tag;
    };
    // composedPath walks shadow hosts. parentElement stops at the shadow root,
    // so the role path is what a later replay uses to tell a slotted control
    // from the host. The css path stays the short id path the scorer already matches.
    const pathOf = (el) => {
      const out = [];
      let node = parentOf(el);
      while (node && node !== document.body && node !== document.documentElement && out.length < 6) {
        const name = accName(node).slice(0, 40);
        out.unshift(name ? { role: roleOf(node), name: name } : { role: roleOf(node) });
        node = parentOf(node);
      }
      return out;
    };
    const ident = (el) => {
      const name = accName(el);
      const text = norm(el.innerText || el.textContent || "").slice(0, 80);
      const kind = String(el.type || "").toLowerCase();
      const buttonValue = el.tagName === "INPUT" && (kind === "button" || kind === "submit" || kind === "reset")
        ? norm(String(el.value || "")).slice(0, 80)
        : "";
      const shown = name || buttonValue;
      return {
        surface: "dom",
        role: roleOf(el),
        testId: testIdOf(el),
        id: el.id || undefined,
        nameAttr: el.getAttribute("name") || undefined,
        tag: el.tagName.toLowerCase(),
        cssPath: cssPathOf(el),
        href: el.tagName === "A" ? (el.getAttribute("href") || undefined) : undefined,
        name: shown || undefined,
        label: shown || undefined,
        text: text || buttonValue || undefined,
        path: pathOf(el),
      };
    };
    const eventEl = (event) => {
      const path = event.composedPath && event.composedPath();
      const first = path && path[0];
      if (first && first.nodeType === 1) return first;
      const raw = event.target;
      return raw && raw.nodeType === 1 ? raw : raw && raw.parentElement;
    };
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
        const day = el.closest(".react-datepicker__day") || el;
        const label = day.getAttribute && day.getAttribute("aria-label");
        const text = String(label || "");
        let match = text.match(/(\\d{1,2})\\s+([A-Za-z]+)\\s+(\\d{4})/);
        if (match) {
          const month = monthIndex(match[2]);
          if (month) return { picker: true, value: isoDate(Number(match[3]), month, Number(match[1])) };
        }
        match = text.match(/([A-Za-z]+)\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})/);
        if (match) {
          const month = monthIndex(match[1]);
          if (month) return { picker: true, value: isoDate(Number(match[3]), month, Number(match[2])) };
        }
        return { picker: true };
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
    let suppressClickUntil = 0;
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.repeat) return;
      const raw = eventEl(event);
      if (!raw || raw.tagName === "TEXTAREA" || raw.isContentEditable) return;
      // Enter in a text field activates the form's submit control with a click
      // whose detail is 0. That click is not a pointer choice. Record the key.
      suppressClickUntil = Date.now() + 700;
      const beforeUrl = location.href;
      const el = raw;
      setTimeout(() => {
        send({ kind: "act", op: "key", key: "Enter", identity: ident(el), beforeUrl, afterUrl: location.href });
      }, 0);
    }, true);
    document.addEventListener("click", (event) => {
      if (window.__baoPicking) return;
      // A fill focuses the field with a real click. That click is not a step.
      if (document.documentElement && document.documentElement.getAttribute("data-bao-ignore-click") === "1") {
        document.documentElement.removeAttribute("data-bao-ignore-click");
        return;
      }
      if (event.detail === 0 && Date.now() < suppressClickUntil) return;
      const raw = eventEl(event);
      if (raw && raw.closest && raw.closest("input[type=file]")) return;
      const marked = raw && pickerMark(raw);
      const clickableSel = "button,a,input,textarea,select,label,li,[role='option'],[role='button'],[role='link'],[data-testid],[data-qa],[data-test],[data-cy]";
      const clickableOf = (node) => {
        let cur = node;
        while (cur && cur.nodeType === 1) {
          if (cur.matches && cur.matches(clickableSel)) return cur;
          cur = parentOf(cur);
        }
        return null;
      };
      let el = marked ? raw : clickableOf(raw);
      // react-select paints the combobox as a div. The pointer lands on an inner
      // div, not the input, so the click would otherwise be dropped. The nearest
      // id that owns that input is the control (#state, #city).
      if (!el && raw && raw.closest) {
        const host = raw.closest("[id]");
        const combo = host && host.querySelector && host.querySelector("input[id^='react-select-']");
        if (host && combo) el = host;
      }
      if (!el) return;
      const kind = String(el.type || "").toLowerCase();
      if ((kind === "checkbox" || kind === "radio") && !receivesPointer(el)) return;
      const openerNow = document.querySelector("input.react-datepicker-ignore-onclickoutside, input[aria-expanded='true']");
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
          if (dialog.value) payload.dialogValue = dialog.value;
        }
        if (change) {
          payload.subtreeBefore = change.before;
          payload.subtreeAfter = change.after;
        }
        if (afterText) payload.afterText = afterText;
        const picked = pickerMark(el);
        if (picked && picked.value && openerNow) payload.identity = ident(openerNow);
        if (picked) Object.assign(payload, picked);
        else if (el.tagName === "INPUT" && dateLike(el)) payload.picker = true;
        send(payload);
      }, 0);
    }, true);
    document.addEventListener("mouseup", (event) => {
      const cal = document.querySelector(".rbc-calendar");
      if (!cal || !event.target || !cal.contains(event.target)) return;
      const nav = event.target.closest && event.target.closest("button");
      const navText = nav && norm(nav.innerText || "").toLowerCase();
      if (navText === "today" || navText === "back" || navText === "next") return;
      // The selection bar is painted after mouseup. Reading it immediately
      // still sees the previous range.
      setTimeout(() => {
        const range = calendarRange(cal);
        if (!range) return;
        send({ kind: "act", op: "click", picker: true, value: range.start, endValue: range.end, identity: ident(cal) });
      }, 250);
    }, true);
    // insertText fires input. change may also fire for the same value. Record one.
    const lastTyped = new WeakMap();
    document.addEventListener("input", (event) => {
      const el = eventEl(event);
      if (!el) return;
      if (el.type === "password") {
        notePassword(el);
        return;
      }
      // react-select clears the input when an option is chosen, so the change
      // event often sees an empty value. Keep the text that was typed. A
      // combobox like the subjects field has its own id, not a react-select id.
      const comboId = el.id || "";
      const combo = comboId.indexOf("react-select-") === 0
        || el.getAttribute("role") === "combobox"
        || el.getAttribute("aria-autocomplete") === "list";
      const kind = String(el.type || "").toLowerCase();
      if (el.tagName === "SELECT" || kind === "checkbox" || kind === "radio" || kind === "file" || kind === "button" || kind === "submit") return;
      if (!combo && (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
      const valueNow = el.value == null ? "" : String(el.value);
      if (!norm(valueNow)) return;
      if (lastTyped.get(el) === valueNow) return;
      lastTyped.set(el, valueNow);
      send({ kind: "act", op: "type", identity: ident(el), value: valueNow });
    }, true);
    // One change event is delivered to every shadow listener and to document.
    // Record it once. A later change on the same control is a new event.
    const seenChange = new WeakSet();
    const onChange = (event) => {
      if (!event || seenChange.has(event)) return;
      seenChange.add(event);
      const el = eventEl(event);
      if (!el) return;
      if (el.disabled) return;
      if (fieldClosed(el) && String(el.type || "").toLowerCase() !== "file") return;
      if (el.closest && el.closest(".react-datepicker, .rbc-calendar, [data-bao-picker]")) return;
      if (el.classList && String(el.className || "").indexOf("react-datepicker") !== -1) return;
      if ((el.readOnly || (el.hasAttribute && el.hasAttribute("readonly"))) && dateLike(el)) return;
      if (el.tagName === "SELECT") {
        const option = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
        const label = norm(option && (option.label || option.text) || "");
        const picked = label || el.value || "";
        const mark = "select:" + picked;
        if (lastTyped.get(el) === mark) return;
        lastTyped.set(el, mark);
        send({ kind: "act", op: "select", identity: ident(el), value: picked });
        return;
      }
      const kind = (el.type || "").toLowerCase();
      if (kind === "radio" || kind === "checkbox") {
        if (!receivesPointer(el)) return;
        send({ kind: "act", op: "check", identity: ident(el), checked: !!el.checked, value: el.value || "" });
        return;
      }
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
      // The input listener already kept the combobox text. change would append it again.
      if ((el.id || "").indexOf("react-select-") === 0 || el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list") return;
      const valueNow = el.value == null ? "" : String(el.value);
      if (!norm(valueNow)) return;
      if (lastTyped.get(el) === valueNow) return;
      lastTyped.set(el, valueNow);
      if (el.type === "date" || dateLike(el)) {
        send({ kind: "act", op: "type", identity: ident(el), value: valueNow, dateField: true, inputType: el.type || "text" });
        return;
      }
      send({ kind: "act", op: "type", identity: ident(el), value: valueNow });
    };
    document.addEventListener("change", onChange, true);
    // change does not cross a shadow root, so a select or typed field inside
    // one never reaches document. Listen on each root as it is created.
    const origAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = origAttach.call(this, init);
      root.addEventListener("change", onChange, true);
      return root;
    };
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
    // attachShadow is patched for roots created after this script. A root that
    // already exists (the extension injects into a live tab) would otherwise
    // swallow change events. Walk the ones that are already open.
    const wireShadows = (root) => {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll("*").forEach((el) => {
        if (!el.shadowRoot) return;
        const shadow = el.shadowRoot;
        if (shadow.__baoWired) return;
        shadow.__baoWired = true;
        shadow.addEventListener("change", onChange, true);
        wireShadows(shadow);
      });
    };
    wireShadows(document);
  })();`;
}
