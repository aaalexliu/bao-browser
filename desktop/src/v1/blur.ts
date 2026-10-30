// Blur sensitive fields before a screenshot is taken, then clear the filter.
// The page function is self-contained so Playwright can serialize it.

export interface BlurPage {
  evaluate(fn: () => unknown): Promise<unknown>;
  screenshot(opts?: object): Promise<Buffer>;
}

/** Keep the pattern in sync with src/mask.ts. It runs inside the page. */
export function blurSensitiveFields(): number {
  const ac = new Set([
    "current-password", "new-password", "cc-number", "cc-csc", "cc-exp",
    "cc-exp-month", "cc-exp-year", "one-time-code",
  ]);
  const re = /pass(word|code)|\bssn\b|social.?security|credit.?card|card.?number|\bcc-?num|\bcvv\b|\bcvc\b|security.?code|\botp\b|one.?time.?code|routing.?number|\bpin\b/i;
  let count = 0;
  for (const el of document.querySelectorAll("input, textarea")) {
    const input = el as HTMLInputElement;
    const type = (input.type || "").toLowerCase();
    const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase().trim();
    const hay = [input.getAttribute("name"), input.id, autocomplete, input.getAttribute("aria-label"), input.getAttribute("placeholder")].filter(Boolean).join(" ");
    const sensitive = type === "password" || ac.has(autocomplete) || re.test(hay);
    if (!sensitive) continue;
    input.setAttribute("data-bao-blur", "1");
    input.style.setProperty("filter", "blur(14px)", "important");
    count += 1;
  }
  return count;
}

export function clearSensitiveBlur(): void {
  for (const el of document.querySelectorAll("[data-bao-blur]")) {
    const input = el as HTMLElement;
    input.style.removeProperty("filter");
    input.removeAttribute("data-bao-blur");
  }
}

export async function shotWithBlur(page: BlurPage, opts?: object): Promise<Buffer> {
  await page.evaluate(blurSensitiveFields);
  try {
    return await page.screenshot(opts);
  } finally {
    await page.evaluate(clearSensitiveBlur).catch(() => undefined);
  }
}
