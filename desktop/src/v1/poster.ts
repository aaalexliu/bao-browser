// The workflow card shows one full-page picture. An element crop is never the poster.

import { isFullPageShot } from "./redacted-png";

export const CARD_POSTER = "poster.png";

const PAGE_ACT = new Set([
  "click", "dblclick", "type", "input", "key", "keypress", "upload", "drop",
  "check", "select", "change", "submit", "download", "fill", "confirm", "login",
]);

/** A recorded act on a page. Navigation alone does not take the poster. */
export function isPageAct(op: string | undefined): boolean {
  return !!op && PAGE_ACT.has(op);
}

/**
 * The card poster is `poster.png` when that file is a full page.
 * Element crops and the stripe fixture are ignored, even if they are the only shots.
 */
export function selectCardPoster(files: { name: string; bytes: Buffer }[]): string | undefined {
  const named = files.find((file) => file.name === CARD_POSTER);
  if (!named || !isFullPageShot(named.bytes)) return undefined;
  return named.name;
}
