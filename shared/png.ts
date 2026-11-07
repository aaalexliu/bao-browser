export function isElementCrop(bytes: Buffer): boolean {
  let width = 0;
  let height = 0;
  if (isPng(bytes)) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return false;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) return false;
      if (offset + 2 > bytes.length) return false;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return false;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (length < 8) return false;
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  }
  if (width === 96 && height === 54) return false;
  return width >= 2 && height >= 2 && width <= 720 && height <= 480;
}

export function isPng(png: Buffer): boolean {
  if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") return false;
  return png.readUInt32BE(16) >= 2 && png.readUInt32BE(20) >= 2;
}
