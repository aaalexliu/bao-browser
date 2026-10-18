import type { Page } from "playwright";

/** CDP click so the page sees isTrusted. Callers pass a point they just measured. */
export async function clickViewport(page: Page, x: number, y: number): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1,
    });
  } finally {
    await client.detach().catch(() => {});
  }
}
