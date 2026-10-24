// Chrome for Testing ignores AXPosition. CDP Browser.setWindowBounds is the
// move that has to land before a replay failure counts.

import type { Page } from "playwright";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const POSITION_SLOP = 15;
const SIZE_SLOP = 20;

export function boundsApplied(after: WindowBounds | null, want: WindowBounds): boolean {
  if (!after) return false;
  return Math.abs(after.x - want.x) <= POSITION_SLOP
    && Math.abs(after.y - want.y) <= POSITION_SLOP
    && Math.abs(after.width - want.width) <= SIZE_SLOP
    && Math.abs(after.height - want.height) <= SIZE_SLOP;
}

interface CdpBounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export async function readOwnedWindow(page: Page): Promise<WindowBounds | null> {
  const client = await page.context().newCDPSession(page);
  try {
    const target = await client.send("Browser.getWindowForTarget") as { windowId: number };
    const got = await client.send("Browser.getWindowBounds", { windowId: target.windowId }) as { bounds?: CdpBounds };
    return fromCdp(got.bounds);
  } finally {
    await client.detach().catch(() => undefined);
  }
}

export async function moveOwnedWindow(page: Page, want: WindowBounds): Promise<{ applied: boolean; before: WindowBounds | null; after: WindowBounds | null }> {
  const client = await page.context().newCDPSession(page);
  try {
    const target = await client.send("Browser.getWindowForTarget") as { windowId: number };
    const beforeRaw = await client.send("Browser.getWindowBounds", { windowId: target.windowId }) as { bounds?: CdpBounds };
    await client.send("Browser.setWindowBounds", {
      windowId: target.windowId,
      bounds: {
        left: Math.round(want.x),
        top: Math.round(want.y),
        width: Math.round(want.width),
        height: Math.round(want.height),
        windowState: "normal",
      },
    });
    const afterRaw = await client.send("Browser.getWindowBounds", { windowId: target.windowId }) as { bounds?: CdpBounds };
    const before = fromCdp(beforeRaw.bounds);
    const after = fromCdp(afterRaw.bounds);
    return { applied: boundsApplied(after, want), before, after };
  } finally {
    await client.detach().catch(() => undefined);
  }
}

function fromCdp(bounds: CdpBounds | undefined): WindowBounds | null {
  if (!bounds || bounds.left == null || bounds.top == null || bounds.width == null || bounds.height == null) return null;
  return { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
}
