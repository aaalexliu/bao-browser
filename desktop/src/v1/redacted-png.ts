// Redacted filmstrip frames. The bytes are a generated swatch, never a screenshot
// that was captured on the device.

import { deflateSync } from "node:zlib";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A crop around a control. The 96×54 stripe and a full-page picture are not one. */
export function isElementCrop(png: Buffer): boolean {
  if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") return false;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 96 && height === 54) return false;
  return width >= 2 && height >= 2 && width <= 720 && height <= 480;
}

/** A small PNG that does not contain the source image. `seed` only picks a color. */
export function redactedPng(seed: number): Buffer {
  const w = 96;
  const h = 54;
  const raw = Buffer.alloc((1 + w * 3) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      const stripe = Math.floor(x / 12) % 2;
      raw[i] = stripe ? 32 + (seed * 18) % 40 : 214;
      raw[i + 1] = stripe ? 28 : 198;
      raw[i + 2] = stripe ? 22 + (seed % 12) : 176;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
