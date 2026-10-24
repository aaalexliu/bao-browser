// Chrome native messaging: uint32 little-endian length, then UTF-8 JSON. Cap is 1MB.

export const MAX_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new Error("native message exceeds 1MB");
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) throw new Error("native message exceeds 1MB");
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body.toString("utf8")));
    }
    return out;
  }
}
