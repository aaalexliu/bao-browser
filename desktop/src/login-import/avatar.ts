// A Chrome default picture is often one flat color. Show initials on that color
// instead of stretching the pixel into a circle. A real photo stays an image.

import { inflateSync } from "node:zlib";

export interface AvatarView {
  avatarDataUrl: string | null;
  avatarColor: string | null;
}

const MAX_CHANNEL_SPREAD = 18;

export function presentAvatar(buf: Buffer): AvatarView {
  const mime = imageMime(buf);
  if (!mime) return { avatarDataUrl: null, avatarColor: null };
  if (mime === "image/png") {
    const color = flatPngColor(buf);
    if (color) return { avatarDataUrl: null, avatarColor: color };
  }
  return { avatarDataUrl: `data:${mime};base64,${buf.toString("base64")}`, avatarColor: null };
}

export function imageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** The visible color when every pixel is the same, composited on white. */
export function flatPngColor(buf: Buffer): string | null {
  const pixels = pngPixels(buf);
  if (!pixels) return null;
  const { rgba } = pixels;
  let n = 0;
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] ?? 0;
    if (alpha < 16) continue;
    const r = overWhite(rgba[i] ?? 0, alpha);
    const g = overWhite(rgba[i + 1] ?? 0, alpha);
    const b = overWhite(rgba[i + 2] ?? 0, alpha);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minG = Math.min(minG, g);
    maxG = Math.max(maxG, g);
    minB = Math.min(minB, b);
    maxB = Math.max(maxB, b);
    sumR += r;
    sumG += g;
    sumB += b;
    n += 1;
  }
  if (!n) return null;
  if (maxR - minR > MAX_CHANNEL_SPREAD || maxG - minG > MAX_CHANNEL_SPREAD || maxB - minB > MAX_CHANNEL_SPREAD) return null;
  return hex(Math.round(sumR / n), Math.round(sumG / n), Math.round(sumB / n));
}

function overWhite(channel: number, alpha: number): number {
  return Math.round((channel * alpha + 255 * (255 - alpha)) / 255);
}

function hex(r: number, g: number, b: number): string {
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

function byte(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
}

function pngPixels(buf: Buffer): { rgba: Uint8Array } | null {
  if (imageMime(buf) !== "image/png" || buf.length < 8) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buf.length) return null;
    const data = buf.subarray(start, end);
    if (type === "IHDR") {
      if (data.length < 13) return null;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") transparency = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (!width || !height || width > 4096 || height > 4096 || depth !== 8 || interlace !== 0 || !idat.length) return null;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 || colorType === 3 ? 1 : 0;
  if (!channels) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = channels;
  const rowLength = stride * width;
  if (raw.length < height * (rowLength + 1)) return null;
  const scan = unfilter(raw, height, rowLength, stride);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const src = i * stride;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (colorType === 6) {
      r = scan[src] ?? 0;
      g = scan[src + 1] ?? 0;
      b = scan[src + 2] ?? 0;
      a = scan[src + 3] ?? 255;
    } else if (colorType === 2) {
      r = scan[src] ?? 0;
      g = scan[src + 1] ?? 0;
      b = scan[src + 2] ?? 0;
    } else if (colorType === 0) {
      r = g = b = scan[src] ?? 0;
    } else if (colorType === 4) {
      r = g = b = scan[src] ?? 0;
      a = scan[src + 1] ?? 255;
    } else if (palette) {
      const index = scan[src] ?? 0;
      r = palette[index * 3] ?? 0;
      g = palette[index * 3 + 1] ?? 0;
      b = palette[index * 3 + 2] ?? 0;
      if (transparency && index < transparency.length) a = transparency[index] ?? 255;
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return { rgba };
}

function unfilter(raw: Buffer, height: number, rowLength: number, stride: number): Buffer {
  const out = Buffer.alloc(height * rowLength);
  let previous = Buffer.alloc(rowLength);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset] ?? 0;
    offset += 1;
    const row = Buffer.alloc(rowLength);
    for (let x = 0; x < rowLength; x += 1) {
      const value = raw[offset] ?? 0;
      offset += 1;
      const left = x >= stride ? (row[x - stride] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= stride ? (previous[x - stride] ?? 0) : 0;
      if (filter === 1) row[x] = (value + left) & 255;
      else if (filter === 2) row[x] = (value + up) & 255;
      else if (filter === 3) row[x] = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[x] = (value + paeth(left, up, upLeft)) & 255;
      else row[x] = value;
    }
    row.copy(out, y * rowLength);
    previous = row;
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonal = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left;
  if (upDistance <= diagonal) return up;
  return upLeft;
}
