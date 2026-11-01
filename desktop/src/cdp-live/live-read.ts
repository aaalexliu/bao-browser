import type { ExtractSpec, ListRead } from "../v1/data-steps";

export const LIVE_READ_LIMIT = 4000;

/** The live tool records the same extract contract the replay engine already reads. */
export function liveReadSpec(name: string, selector = "body"): ExtractSpec {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error("name must be an output name of 1 to 64 letters, digits, or underscores, starting with a letter");
  if (!selector.trim() || selector.length > 500) throw new Error("selector must contain 1 to 500 characters");
  return {
    mode: "element",
    as: name,
    locators: [{ kind: "css", value: selector }],
    columns: [{ name: "text", type: "text", read: "text", locators: [{ kind: "css", value: ":scope" }] }],
  };
}

/** Live replay supports only visible text, never attributes, field values, lists, or pagination. */
export function liveReadSelector(spec: ExtractSpec): string {
  const selector = spec.locators[0];
  const column = spec.columns[0];
  if (spec.mode !== "element" || spec.pagination || spec.locators.length !== 1 || selector?.kind !== "css" || !selector.value
    || spec.columns.length !== 1 || column?.name !== "text" || column.type !== "text" || column.read !== "text" || column.dropped
    || column.locators.length !== 1 || column.locators[0]?.kind !== "css" || column.locators[0].value !== ":scope") {
    throw new Error("live replay supports only live_read text extracts");
  }
  return liveReadSpec(spec.as, selector.value).locators[0]!.value!;
}

export interface RegionRead {
  text: string;
  truncated: boolean;
}

export function liveReadRows(read: RegionRead): ListRead {
  return { rows: [{ text: read.text }], nextVisible: false };
}

/** Page function. Only redacted, bounded visible text leaves Chrome. */
export function readLiveRegion(ask: { selector: string; limit: number }): RegionRead {
  let matches: NodeListOf<Element>;
  try { matches = document.querySelectorAll(ask.selector); }
  catch { throw new Error("invalid read selector"); }
  if (matches.length !== 1) throw new Error(matches.length ? "read selector is ambiguous" : "read region not found");
  const root = matches[0]!;
  const excluded = "input, textarea, select, script, style, noscript, template, [hidden], [aria-hidden=true], [contenteditable]:not([contenteditable=false])";
  const credential = /password|passcode|\bssn\b|social.?security|card.?number|\bcvv\b|\bcvc\b|security.?code|verification.?code|one.?time.?code|\botp\b|\bpin\b|\btoken\b|api.?key|client.?secret|authorization|account.?number|routing.?number/i;
  function visible(el: Element): boolean {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.matches(excluded)) return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      const hint = [node.id, node.getAttribute("name"), node.getAttribute("autocomplete"), node.getAttribute("aria-label")].filter(Boolean).join(" ");
      if (credential.test(hint)) return false;
    }
    return true;
  }
  if (!visible(root)) throw new Error("read region is hidden or sensitive");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks: string[] = [];
  let size = 0;
  let visited = 0;
  let truncated = false;
  while (walker.nextNode()) {
    if (++visited > 20000 || size >= 64000) { truncated = true; break; }
    const node = walker.currentNode;
    if (!node.parentElement || !visible(node.parentElement)) continue;
    const text = (node.textContent || "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").trim();
    if (!text) continue;
    chunks.push(text.slice(0, 64000 - size));
    size += text.length;
    if (size > 64000) truncated = true;
  }
  const credentialLabel = /\b(?:pin|password|passcode|ssn|social security number|account number|routing number|token|authorization)\b/;
  const bareLabel = new RegExp(`^${credentialLabel.source}[ \\t]*(?:[:#]|is\\b)?[ \\t]*$`, "i");
  const ownField = /^[A-Za-z][A-Za-z ]{0,39}:/;
  const inlineValue = new RegExp(`(${credentialLabel.source}[ \\t]*(?:(?:[:#]|is\\b)[ \\t]*)?)([^\\n;]*?)(?=\\. |;|\\n|$)`, "gi");
  const text = chunks.map((chunk, index) => {
    let safe = chunk.replace(/(?<![A-Za-z0-9_-])(?:(?:sk-|ghp_|gho_|xoxb-|xoxp-|AKIA)[A-Za-z0-9_-]+|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?![A-Za-z0-9_-])/g, "[redacted]");
    if (index > 0 && bareLabel.test(chunks[index - 1]!) && !ownField.test(chunk)) safe = "[redacted]";
    else safe = safe.replace(inlineValue, (match, prefix: string, value: string) => value ? `${prefix}[redacted]` : match);
    return safe
      .replace(/\b\d(?:[ -]?\d){12,}\b/g, (number) => {
        const digits = number.replace(/[ -]/g, "");
        if (digits.length > 19) return number;
        let sum = 0;
        for (let index = digits.length - 1; index >= 0; index -= 1) {
          let digit = Number(digits[index]);
          if ((digits.length - 1 - index) % 2) { digit *= 2; if (digit > 9) digit -= 9; }
          sum += digit;
        }
        return sum % 10 === 0 ? "[redacted]" : number;
      })
      .replace(/\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, "[redacted]");
  }).join("\n").trim();
  if (!text) throw new Error("read region has no readable text");
  const limit = Math.min(4000, Math.max(1, ask.limit));
  truncated ||= text.length > limit;
  const marker = "\n[truncated]";
  return { text: truncated ? text.slice(0, Math.max(0, limit - marker.length)) + marker : text, truncated };
}
