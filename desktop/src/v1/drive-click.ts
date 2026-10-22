// Capture drive clicks. Playwright's locator.click aims at the element center
// and retries while another element receives the pointer. react-big-calendar
// paints the Selected bar over the middle of .rbc-day-bg, so that retry never
// finishes. A point the cell itself receives completes the click.

import type { Page } from "playwright";

type DrivePoint =
  | { kind: "center" }
  | { kind: "point"; x: number; y: number }
  | { kind: "force" };

export async function clickInDrive(page: Page, selector: string, timeout?: number): Promise<void> {
  const loc = page.locator(selector).first();
  await loc.evaluate((el) => {
    if (!(el instanceof Element)) return;
    const rect = el.getBoundingClientRect();
    const inView = rect.width > 1 && rect.height > 1
      && rect.top >= 0 && rect.left >= 0
      && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
    // Scrolling a page closes an open listbox. Leave an on-screen option where it is.
    if (!inView) el.scrollIntoView({ block: "center", inline: "nearest" });
  }).catch(() => undefined);
  const point = await loc.evaluate(receivablePoint).catch((): DrivePoint => ({ kind: "force" }));
  const opts: { timeout?: number; position?: { x: number; y: number }; force?: boolean } = {};
  if (timeout) opts.timeout = timeout;
  if (point.kind === "point") opts.position = { x: point.x, y: point.y };
  if (point.kind === "force") opts.force = true;
  await loc.click(Object.keys(opts).length ? opts : undefined);
}

/** Runs in the page. Position is relative to the padding edge, which is what locator.click expects. */
function receivablePoint(el: Element): DrivePoint {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return { kind: "force" };
  const style = getComputedStyle(el);
  const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
  const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
  const borderRight = Number.parseFloat(style.borderRightWidth) || 0;
  const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
  const padWidth = Math.max(1, rect.width - borderLeft - borderRight);
  const padHeight = Math.max(1, rect.height - borderTop - borderBottom);
  const receives = (x: number, y: number) => {
    const top = document.elementFromPoint(x, y);
    return !!top && (top === el || el.contains(top));
  };
  const inView = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  if (!inView) return { kind: "center" };
  if (receives(rect.left + rect.width / 2, rect.top + rect.height / 2)) return { kind: "center" };
  for (let row = 7; row >= 1; row--) {
    for (let col = 1; col <= 7; col++) {
      const x = rect.left + (rect.width * col) / 8;
      const y = rect.top + (rect.height * row) / 8;
      if (!receives(x, y)) continue;
      const px = Math.min(padWidth - 1, Math.max(1, x - rect.left - borderLeft));
      const py = Math.min(padHeight - 1, Math.max(1, y - rect.top - borderTop));
      return { kind: "point", x: px, y: py };
    }
  }
  return { kind: "force" };
}
