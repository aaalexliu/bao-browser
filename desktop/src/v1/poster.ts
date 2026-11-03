// The workflow card shows one full-page picture. An element crop is never the poster.

import { isFullPageShot } from "./redacted-png";
import { readGuidePng } from "./guide-crop";

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

export function isClearPageShot(png: Buffer): boolean {
  if (!isFullPageShot(png)) return false;
  let image: ReturnType<typeof readGuidePng>;
  try { image = readGuidePng(png); } catch { return false; }
  if (!image) return false;
  const { width, height, rgba } = image;
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255;
    if (alpha === 1) continue;
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(255 + (rgba[i + c] - 255) * alpha);
  }
  // Scrollbars and the veil's bottom caption do not make page content readable.
  const left = Math.ceil(width / 10);
  const top = Math.ceil(height / 10);
  const right = width - left - 1;
  const bottom = height - top - 1;
  const required = Math.ceil((right - left) * (bottom - top) / 1000);
  let sharp = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(rgba[i + c] - rgba[i + 4 + c]) < 16 && Math.abs(rgba[i + c] - rgba[i + width * 4 + c]) < 16) continue;
        if (++sharp >= required) return true;
        break;
      }
    }
  }
  return false;
}
