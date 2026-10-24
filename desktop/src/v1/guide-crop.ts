// Guide crops are rewritten so a typed value and a password mask stay inside the card.
// The workflow page keeps the original shot.

import { deflateSync, inflateSync } from "node:zlib";

const ORANGE = [0xd4, 0x53, 0x2b] as const;

export type GuideCropKind = "plain" | "type" | "secret";

/** Outline the control. The value box is one opaque color, then dots for a secret. */
export function prepareGuideCrop(png: Buffer, kind: GuideCropKind): Buffer {
  const decoded = decodePng(png);
  if (!decoded) return png;
  const { width, height, rgba } = decoded;
  if (kind === "type" || kind === "secret") fillValueBox(rgba, width, height, kind === "secret");
  closeOutline(rgba, width, height);
  if (orangeCount(rgba, width, height) < 80) drawOutline(rgba, width, height);
  return encodePng(width, height, rgba);
}

/**
 * Replace the whole input interior with the field color.
 * A per-pixel dark overlay leaves the antialiased edge of the recorded value.
 */
function fillValueBox(rgba: Uint8Array, width: number, height: number, secret: boolean): void {
  const bg = cornerColor(rgba, width);
  const core = lowestRun(rgba, width, height, (i) => differs(rgba, i, bg));
  if (!core) return;
  let top = core.top;
  let bottom = core.bottom;
  for (let y = core.top - 1; y >= Math.max(0, core.top - 4); y--) {
    if (!fringeRow(rgba, width, y, bg)) break;
    top = y;
  }
  for (let y = core.bottom + 1; y <= Math.min(height - 1, core.bottom + 4); y++) {
    if (!fringeRow(rgba, width, y, bg)) break;
    bottom = y;
  }
  let left = width;
  let right = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = 0; x < width; x++) {
      if (!differs(rgba, (y * width + x) * 4, bg)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (right - left < 8 || bottom - top < 4) return;
  const color = fieldColor(rgba, width, left, top, right, bottom);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const i = (y * width + x) * 4;
      if (isOrange(rgba, i)) continue;
      paint(rgba, i, color);
    }
  }
  if (secret) drawDots(rgba, width, height, left, top, right, bottom);
}

function lowestRun(
  rgba: Uint8Array,
  width: number,
  height: number,
  hit: (i: number) => boolean,
): { top: number; bottom: number } | undefined {
  let best: { top: number; bottom: number } | undefined;
  let start = -1;
  const finish = (end: number) => {
    if (start < 0 || end - start < 4) return;
    best = { top: start, bottom: end - 1 };
  };
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) if (hit((y * width + x) * 4)) count += 1;
    const on = count > width * 0.45;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      finish(y);
      start = -1;
    }
  }
  if (start >= 0) finish(height);
  return best;
}

function fringeRow(rgba: Uint8Array, width: number, y: number, bg: [number, number, number, number]): boolean {
  let diff = 0;
  let dark = 0;
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (!differs(rgba, i, bg)) continue;
    diff += 1;
    if (lumaAt(rgba, i) < 80) dark += 1;
  }
  if (dark > 0 && diff < width * 0.4) return false;
  return diff > 8;
}

function fieldColor(
  rgba: Uint8Array,
  width: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): [number, number, number, number] {
  const counts = new Map<string, { n: number; color: [number, number, number, number] }>();
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const i = (y * width + x) * 4;
      if (isOrange(rgba, i) || lumaAt(rgba, i) < 200) continue;
      const color: [number, number, number, number] = [rgba[i], rgba[i + 1], rgba[i + 2], 255];
      const key = color.slice(0, 3).join(",");
      const row = counts.get(key);
      if (row) row.n += 1;
      else counts.set(key, { n: 1, color });
    }
  }
  let best: { n: number; color: [number, number, number, number] } | undefined;
  for (const row of counts.values()) if (!best || row.n > best.n) best = row;
  return best?.color || [255, 255, 255, 255];
}

function differs(rgba: Uint8Array, i: number, bg: [number, number, number, number]): boolean {
  if (isOrange(rgba, i)) return false;
  const delta = Math.abs(rgba[i] - bg[0]) + Math.abs(rgba[i + 1] - bg[1]) + Math.abs(rgba[i + 2] - bg[2]);
  return delta > 18;
}

function drawDots(
  rgba: Uint8Array,
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): void {
  const band = bottom - top;
  const span = right - left;
  if (band < 6 || span < 24) return;
  const cy = Math.round((top + bottom) / 2);
  const radius = Math.max(1, Math.min(3, Math.round(band * 0.12)));
  const count = 6;
  const gap = radius * 5;
  const total = (count - 1) * gap;
  let x0 = left + Math.round((span - total) / 2);
  const inset = left + radius + 2;
  if (x0 < inset) x0 = inset;
  for (let n = 0; n < count; n++) {
    const cx = x0 + n * gap;
    if (cx > right - radius - 2) break;
    fillCircle(rgba, width, height, cx, cy, radius, [110, 106, 100, 255]);
  }
}

function fillCircle(rgba: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, color: [number, number, number, number]): void {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue;
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
      paint(rgba, (y * width + x) * 4, color);
    }
  }
}

/** Finish a box whose mask covered one edge. A complete outline is left as it is. */
function closeOutline(rgba: Uint8Array, width: number, height: number): void {
  const left = rail(rgba, width, height, 0, Math.min(24, width), 1);
  const right = rail(rgba, width, height, width - 1, Math.max(0, width - 24), -1);
  if (!left || !right || right.x - left.x < 20) return;
  const color: [number, number, number, number] = [ORANGE[0], ORANGE[1], ORANGE[2], 255];
  seal(rgba, width, left.x, right.x, left.top, 1, color);
  seal(rgba, width, left.x, right.x, left.bottom, -1, color);
  sealColumn(rgba, width, left.x, left.top, left.bottom, 1, color);
  sealColumn(rgba, width, right.x, right.top, right.bottom, -1, color);
}

function rail(rgba: Uint8Array, width: number, height: number, from: number, to: number, step: number): { x: number; top: number; bottom: number } | undefined {
  let bestX = -1;
  let best = 0;
  for (let x = from; step > 0 ? x < to : x > to; x += step) {
    let count = 0;
    for (let y = 0; y < height; y++) if (isOrange(rgba, (y * width + x) * 4)) count += 1;
    if (count > best) {
      best = count;
      bestX = x;
    }
  }
  if (best < 8 || bestX < 0) return;
  let top = height;
  let bottom = 0;
  for (let y = 0; y < height; y++) {
    if (!isOrange(rgba, (y * width + bestX) * 4)) continue;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return { x: bestX, top, bottom };
}

function sealColumn(
  rgba: Uint8Array,
  width: number,
  x: number,
  top: number,
  bottom: number,
  dir: number,
  color: [number, number, number, number],
): void {
  const span = bottom - top;
  if (span < 4) return;
  let orange = 0;
  for (let y = top; y <= bottom; y++) if (isOrange(rgba, (y * width + x) * 4)) orange += 1;
  if (orange >= span * 0.6) return;
  for (let t = 0; t < 2; t++) {
    const col = x + dir * t;
    if (col < 0 || col >= width) continue;
    for (let y = top; y <= bottom; y++) paint(rgba, (y * width + col) * 4, color);
  }
}

function seal(rgba: Uint8Array, width: number, left: number, right: number, y: number, dir: number, color: [number, number, number, number]): void {
  const span = right - left;
  let orange = 0;
  for (let x = left; x <= right; x++) if (isOrange(rgba, (y * width + x) * 4)) orange += 1;
  if (orange >= span * 0.6) return;
  for (let t = 0; t < 2; t++) {
    const row = y + dir * t;
    if (row < 0 || row >= rgba.length / (width * 4)) continue;
    for (let x = left; x <= right; x++) paint(rgba, (row * width + x) * 4, color);
  }
}

function drawOutline(rgba: Uint8Array, width: number, height: number): void {
  const bg = cornerLuma(rgba, width);
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const luma = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
      if (Math.abs(luma - bg) < 18 && !isOrange(rgba, i)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) {
    minX = 1;
    minY = 1;
    maxX = width - 2;
    maxY = height - 2;
  }
  minX = Math.max(1, minX);
  minY = Math.max(1, minY);
  maxX = Math.min(width - 2, maxX);
  maxY = Math.min(height - 2, maxY);
  const color: [number, number, number, number] = [ORANGE[0], ORANGE[1], ORANGE[2], 255];
  for (let t = 0; t < 2; t++) {
    for (let x = minX; x <= maxX; x++) {
      paint(rgba, ((minY + t) * width + x) * 4, color);
      paint(rgba, ((maxY - t) * width + x) * 4, color);
    }
    for (let y = minY; y <= maxY; y++) {
      paint(rgba, (y * width + (minX + t)) * 4, color);
      paint(rgba, (y * width + (maxX - t)) * 4, color);
    }
  }
}

function orangeCount(rgba: Uint8Array, width: number, height: number): number {
  let count = 0;
  for (let i = 0; i < width * height * 4; i += 4) if (isOrange(rgba, i)) count += 1;
  return count;
}

function isOrange(rgba: Uint8Array, i: number): boolean {
  const r = rgba[i];
  const g = rgba[i + 1];
  const b = rgba[i + 2];
  return r > 180 && r > g + 40 && b < 100;
}

function lumaAt(rgba: Uint8Array, i: number): number {
  return (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
}

function cornerColor(rgba: Uint8Array, width: number): [number, number, number, number] {
  const i = width * 4;
  return [rgba[i] ?? 245, rgba[i + 1] ?? 245, rgba[i + 2] ?? 247, 255];
}

function cornerLuma(rgba: Uint8Array, width: number): number {
  const [r, g, b] = cornerColor(rgba, width);
  return (r + g + b) / 3;
}

function paint(rgba: Uint8Array, i: number, color: readonly [number, number, number, number]): void {
  rgba[i] = color[0];
  rgba[i + 1] = color[1];
  rgba[i + 2] = color[2];
  rgba[i + 3] = color[3];
}

export function readGuidePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } | undefined {
  return decodePng(buf);
}

function decodePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } | undefined {
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const end = offset + 8 + len;
    if (end + 4 > buf.length) return undefined;
    const data = buf.subarray(offset + 8, end);
    offset = end + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) return undefined;
    } else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || width < 2 || height < 2 || !idat.length) return undefined;
  const bpp = colorType === 6 ? 4 : 3;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const stride = width * bpp;
  if (inflated.length < height * (stride + 1)) return undefined;
  const rgba = new Uint8Array(width * height * 4);
  let src = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const row = inflated.subarray(src, src + stride);
    src += stride;
    const recon = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? recon[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      const raw = row[i];
      if (filter === 0) recon[i] = raw;
      else if (filter === 1) recon[i] = (raw + left) & 255;
      else if (filter === 2) recon[i] = (raw + up) & 255;
      else if (filter === 3) recon[i] = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) recon[i] = (raw + paeth(left, up, ul)) & 255;
      else return undefined;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const p = x * bpp;
      rgba[o] = recon[p];
      rgba[o + 1] = recon[p + 1];
      rgba[o + 2] = recon[p + 2];
      rgba[o + 3] = bpp === 4 ? recon[p + 3] : 255;
    }
    prev = recon;
  }
  return { width, height, rgba };
}

function paeth(left: number, up: number, ul: number): number {
  const estimate = left + up - ul;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - ul);
  if (dl <= du && dl <= dul) return left;
  if (du <= dul) return up;
  return ul;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dest = row + 1 + x * 3;
      raw[dest] = rgba[src];
      raw[dest + 1] = rgba[src + 1];
      raw[dest + 2] = rgba[src + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
