// Field-by-field comparison. Causes are explanations, not a licence to spoof.

import { createHash } from "node:crypto";

export interface SignalField {
  name: string;
  human: string;
  extension: string;
  playwright: string;
}

export interface SignalDiff {
  name: string;
  human: string;
  extension: string;
  playwright: string;
  cause: string;
  fix: string;
}

interface CauseRule {
  test: RegExp;
  when: "any" | "playwright" | "extension";
  cause: string;
  fix: string;
}

const RULES: CauseRule[] = [
  {
    test: /^tls\./,
    when: "playwright",
    cause: "JA3 and JA4 come from the browser's TLS stack. The extension and the human share one Chrome. Playwright launches a different Chromium, so its ClientHello differs. Copying the human handshake would be spoofing.",
    fix: "Keep the extension on the same Chrome binary. Do not rewrite the ClientHello.",
  },
  {
    test: /^navigator\.webdriver$/,
    when: "playwright",
    cause: "Playwright's Chrome is started with --enable-automation, which sets navigator.webdriver. The extension does not patch navigator.",
    fix: "Leave navigator alone. The Playwright column is that driver's flag, not something the extension should copy.",
  },
  {
    test: /^event\.isTrusted$/,
    when: "extension",
    cause: "A click dispatched from a content script is untrusted. chrome.debugger can produce trusted input, and Chrome then shows the debugging infobar, which is its own tell. Replay stays off the debugger except for a file input.",
    fix: "No in-page fix that keeps the event trusted without the debugger bar or spoofing isTrusted.",
  },
  {
    test: /^timing\./,
    when: "any",
    cause: "The extension plays the recording's dwell, key gaps, and pointer samples, and does not add a second random source. A gap that remains against the human session is scheduler and socket delay. Playwright keeps its own click clock and does not play this recording.",
    fix: "Play the recorded times in the page. Do not add jitter. Do not copy Playwright's clock.",
  },
  {
    test: /^cookie\.incap_ses/,
    when: "any",
    cause: "Imperva rotates incap_ses when it answers. The value that matters is the Cookie header on the next request, which is the jar the browser actually stored.",
    fix: "Stay in the same profile so the jar carries over. Do not copy the cookie by hand.",
  },
  {
    test: /^cookie\.visid_incap/,
    when: "playwright",
    cause: "visid_incap is the visitor id Imperva stored in this profile. Playwright uses a fresh Chromium profile, so the site issues a new one. An extension replay in the human profile should send the same id.",
    fix: "Replay in the same user-data-dir. Do not set the cookie from script.",
  },
  {
    test: /^cookie\.carryover\./,
    when: "any",
    cause: "Carryover is whether the next request's Cookie header still contains the name the human response stored.",
    fix: "Use the same profile. A missing name means the jar did not keep it, which the extension must not paper over.",
  },
  {
    test: /^clientHint\./,
    when: "playwright",
    cause: "Client hints are the browser's own. The extension does not set them. Playwright's Chromium advertises a different build.",
    fix: "Do not patch userAgentData or Sec-CH headers.",
  },
  {
    test: /^header\./,
    when: "any",
    cause: "The extension does not write request headers. A difference is the browser, the profile, or a header the site echoed.",
    fix: "Do not rewrite headers.",
  },
  {
    test: /^indicator\./,
    when: "any",
    cause: "The toolbar badge is the visible record and replay indicator. It sits in browser chrome, outside the page. An in-page strip is added only when a step needs you.",
    fix: "Keep the badge. Hiding it would hide that Bao is driving.",
  },
  {
    test: /^debugger\./,
    when: "any",
    cause: "Attaching chrome.debugger paints Chrome's debugging infobar and can shrink the viewport. The page's navigator.webdriver stays false. File inputs are the only replay path that attaches, and they detach immediately.",
    fix: "Prefer element.click and InputEvent. Use the debugger only for DOM.setFileInputFiles.",
  },
];

function ruleFor(name: string, human: string, extension: string, playwright: string): CauseRule | undefined {
  for (const rule of RULES) {
    if (!rule.test.test(name)) continue;
    if (rule.when === "any") return rule;
    if (rule.when === "playwright" && playwright !== human && extension === human) return rule;
    if (rule.when === "playwright" && playwright !== extension) return rule;
    if (rule.when === "extension" && extension !== human) return rule;
  }
  return undefined;
}

/** Rows are the fields that are not identical across the three drivers. */
export function diffSignals(fields: readonly SignalField[]): SignalDiff[] {
  const out: SignalDiff[] = [];
  for (const field of fields) {
    if (field.human === field.extension && field.extension === field.playwright) continue;
    const rule = ruleFor(field.name, field.human, field.extension, field.playwright);
    out.push({
      name: field.name,
      human: field.human,
      extension: field.extension,
      playwright: field.playwright,
      cause: rule?.cause
        || "The three sessions disagree here. The extension does not rewrite this field on purpose.",
      fix: rule?.fix
        || "Compare the raw HAR and netlog for this name before changing the driver.",
    });
  }
  return out;
}

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Cookie values leave the machine only as a short hash. Names stay readable. */
export function hashCookieHeader(header: string): string {
  if (!header) return "";
  return header.split(/;\s*/).filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    if (eq < 0) return part;
    const name = part.slice(0, eq).trim();
    return `${name}=${hashValue(part.slice(eq + 1))}`;
  }).sort().join("; ");
}
