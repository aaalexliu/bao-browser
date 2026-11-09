// Which of a running Chrome's debugging targets are tabs. Chrome also lists its own surfaces as targets, such as the Gemini in
// Chrome panel (gemini.google.com/glic) and side panels.

import type { CdpSocket } from "./socket";

export interface ChromeTarget { targetId: string; type: string; url: string; openerId?: string }

/**
 * Whether a target is a page target in one of Chrome's windows. Chrome answers Browser.getWindowForTarget only for a page in a window's
 * tab strip, so the Gemini panel, side panels, webviews, and hidden pages fail it.
 */
export async function isChromeTab(cdp: CdpSocket, target: ChromeTarget): Promise<boolean> {
  if (target.type !== "page") return false;
  return cdp.send("Browser.getWindowForTarget", { targetId: target.targetId }, undefined, 2000).then(() => true, () => false);
}
