// Chrome native messaging: uint32 little-endian length, then UTF-8 JSON.

/** Chrome refuses a message over 1MB from the host. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Chrome sends the host messages up to 64MiB. A page picture from the extension can pass 1MB. */
export const MAX_FROM_CHROME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(value: unknown, max = MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > max) throw new Error(`native message exceeds ${max} bytes`);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly max = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > this.max) throw new Error(`native message exceeds ${this.max} bytes`);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body.toString("utf8")));
    }
    return out;
  }
}
