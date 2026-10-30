import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

/** Local browser socket. The upgrade carries no Origin header. */

const MAX_FRAME = 32 * 1024 * 1024;

export function handshakeRequest(resource: string, host: string, key: string): string {
  return [
    `GET ${resource} HTTP/1.1`,
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

export function scrubCdp(text: string): string {
  return text.replace(/\/devtools\/browser\/[0-9a-fA-F-]+/g, "/devtools/browser/<id>");
}

interface DecodedFrame {
  opcode: number;
  text?: string;
  payload?: Buffer;
}

export class ServerFrameDecoder {
  private buf = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragOp = 0;

  push(chunk: Buffer): DecodedFrame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: DecodedFrame[] = [];
    while (this.buf.length >= 2) {
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) throw new Error("cdp frame too large");
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_FRAME) throw new Error("cdp frame too large");
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) break;
      let payload = Buffer.from(this.buf.subarray(offset + maskLen, offset + maskLen + len));
      if (masked) {
        const mask = this.buf.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      }
      this.buf = Buffer.from(this.buf.subarray(offset + maskLen + len));
      if (opcode === 0) {
        this.fragments.push(payload);
        if (fin) {
          out.push(this.finish(this.fragOp, Buffer.concat(this.fragments)));
          this.fragments = [];
        }
        continue;
      }
      if (opcode === 1 || opcode === 2) {
        if (!fin) {
          this.fragOp = opcode;
          this.fragments = [payload];
          continue;
        }
        out.push(this.finish(opcode, payload));
        continue;
      }
      if (opcode === 8 || opcode === 9 || opcode === 10) out.push(this.finish(opcode, payload));
    }
    return out;
  }

  private finish(opcode: number, payload: Buffer): DecodedFrame {
    if (opcode === 1) return { opcode, text: payload.toString("utf8"), payload };
    return { opcode, payload };
  }
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

type Handler = (params: Record<string, unknown>) => void;

export class CdpSocket {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: { method: string; sessionId?: string; handler: Handler }[] = [];
  private closed = false;

  constructor(private readonly socket: Socket) {}

  get isOpen(): boolean {
    return !this.closed;
  }

  send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`cdp closed before ${method}`));
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`cdp timeout ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.write(clientFrame(1, Buffer.from(JSON.stringify(message))));
    });
  }

  on(method: string, sessionId: string | undefined, handler: Handler): void {
    this.listeners.push({ method, sessionId, handler });
  }

  takeText(text: string): void {
    let msg: { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(scrubCdp(msg.error.message || "cdp error")));
      else waiter.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    for (const listener of this.listeners) {
      if (listener.method !== msg.method) continue;
      if (listener.sessionId && listener.sessionId !== msg.sessionId) continue;
      if (!listener.sessionId && msg.sessionId) continue;
      listener.handler(msg.params || {});
    }
  }

  pong(payload?: Uint8Array): void {
    if (!this.closed) this.socket.write(clientFrame(10, Buffer.from(payload ?? new Uint8Array())));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error("cdp closed"));
    this.pending.clear();
    this.socket.destroy();
  }
}

export interface ConnectOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function connectCdp(port: number, browserPath: string, opts: ConnectOptions = {}): Promise<CdpSocket> {
  if (!browserPath.startsWith("/devtools/browser")) {
    return Promise.reject(new Error("refusing a non-browser debugging path"));
  }
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const socket = createConnection({ host: "127.0.0.1", port });
    const decoder = new ServerFrameDecoder();
    const client = new CdpSocket(socket);
    let header = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => fail(new Error("cdp handshake timed out")), timeoutMs);
    const onAbort = () => fail(new Error("cdp handshake aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    socket.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    socket.on("data", (chunk) => {
      try {
        if (!upgraded) {
          header = Buffer.concat([header, chunk]);
          const split = header.indexOf("\r\n\r\n");
          if (split < 0) return;
          const head = header.subarray(0, split).toString("utf8");
          const rest = header.subarray(split + 4);
          const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] || 0);
          if (status !== 101) {
            const body = rest.subarray(0, 300).toString("utf8");
            fail(new Error(scrubCdp(`cdp handshake status ${status} ${body}`.trim())));
            return;
          }
          upgraded = true;
          header = Buffer.alloc(0);
          if (rest.length) feed(rest);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            opts.signal?.removeEventListener("abort", onAbort);
            resolve(client);
          }
          return;
        }
        feed(chunk);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    function feed(bytes: Buffer): void {
      for (const frame of decoder.push(bytes)) {
        if (frame.opcode === 1 && frame.text) client.takeText(frame.text);
        else if (frame.opcode === 8) client.close();
        else if (frame.opcode === 9) client.pong(frame.payload || Buffer.alloc(0));
      }
    }

    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(handshakeRequest(browserPath, `127.0.0.1:${port}`, key));
    });
  });
}
