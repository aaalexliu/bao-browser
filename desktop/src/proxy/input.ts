import type { Page } from "playwright";

export type MouseButton = "left" | "middle" | "right";

/** Alt=1, Control=2, Meta=4, Shift=8. Matches CDP Input.dispatchMouseEvent. */
export function modifierBits(names: readonly string[]): number {
  let bits = 0;
  for (const name of names) {
    const key = name.toLowerCase();
    if (key === "alt") bits |= 1;
    else if (key === "control" || key === "ctrl") bits |= 2;
    else if (key === "meta" || key === "super") bits |= 4;
    else if (key === "shift") bits |= 8;
  }
  return bits;
}

/** CDP click so the page sees isTrusted. Callers pass a point they just measured. */
export async function clickViewport(
  page: Page,
  x: number,
  y: number,
  opts?: { button?: MouseButton; count?: number; modifiers?: number },
): Promise<void> {
  const button = opts?.button ?? "left";
  const count = opts?.count ?? 1;
  const modifiers = opts?.modifiers ?? 0;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    for (let i = 1; i <= count; i++) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button, clickCount: i, modifiers,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button, clickCount: i, modifiers,
      });
    }
  } finally {
    await client.detach().catch(() => {});
  }
}

export async function moveViewport(page: Page, x: number, y: number): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  } finally {
    await client.detach().catch(() => {});
  }
}

export async function mouseButton(page: Page, x: number, y: number, phase: "down" | "up"): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchMouseEvent", {
      type: phase === "down" ? "mousePressed" : "mouseReleased",
      x, y, button: "left", clickCount: 1,
    });
  } finally {
    await client.detach().catch(() => {});
  }
}

export async function dragViewport(
  page: Page,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  modifiers = 0,
): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, modifiers });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1, modifiers,
    });
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1, modifiers });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1, modifiers,
    });
  } finally {
    await client.detach().catch(() => {});
  }
}
