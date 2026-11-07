import { inflateSync } from "node:zlib";

export function readGuidePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } | undefined {
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
