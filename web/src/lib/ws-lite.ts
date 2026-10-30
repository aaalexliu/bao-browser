// A small WebSocket for text frames. The desktop dials out with this client.
// Node's global WebSocket cannot set an Authorization header on this runtime.

import { createHash, randomBytes } from "node:crypto";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_BYTES = 1_000_000;

export function maxFrameBytes(): number {
  return MAX_BYTES;
}

export interface SocketHandlers {
  message: (text: string) => void;
  close: () => void;
}

type Pending = { chunks: Buffer[] };

export class LiteSocket {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private dead = false;
  private notified = false;
  private queued: string[] = [];
  private pending: Pending | null = null;
  private discard = 0;
  private messageFn: (text: string) => void = (text) => {
    this.queued.push(text);
  };
  readonly handlers: SocketHandlers;

  constructor(private readonly socket: Duplex, private readonly mask: boolean) {
    const self = this;
    this.handlers = {
      close() {},
      get message() {
        return self.messageFn;
      },
      set message(fn: (text: string) => void) {
        self.messageFn = fn;
        const pending = self.queued;
        self.queued = [];
        for (const text of pending) fn(text);
      },
    };
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("close", () => this.closed());
    socket.on("error", () => this.closed());
  }

  send(text: string): void {
    if (this.dead) return;
    this.socket.write(encodeFrame(1, Buffer.from(text), this.mask));
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    try { this.socket.write(encodeFrame(8, Buffer.alloc(0), this.mask)); } catch { /* already gone */ }
    this.socket.end();
    this.finish();
  }

  private closed(): void {
    this.dead = true;
    this.finish();
  }

  private finish(): void {
    if (this.notified) return;
    this.notified = true;
    this.handlers.close();
  }

  feed(chunk: Buffer): void {
    let rest = chunk;
    if (this.discard > 0) {
      if (rest.length <= this.discard) {
        this.discard -= rest.length;
        return;
      }
      rest = rest.subarray(this.discard);
      this.discard = 0;
    }
    this.buf = this.buf.length === 0 ? rest : Buffer.concat([this.buf, rest]);
    while (this.buf.length >= 2 && this.discard === 0) {
      const header = peekFrame(this.buf);
      if (!header) return;
      if (header.oversize) {
        // A frame over the cap is skipped. Its payload is not kept in memory.
        this.pending = null;
        if (this.buf.length < header.total) {
          this.discard = header.total - this.buf.length;
          this.buf = Buffer.alloc(0);
          return;
        }
        this.buf = this.buf.subarray(header.total);
        continue;
      }
      if (this.buf.length < header.total) return;
      const frame = takeFrame(this.buf, header);
      this.buf = frame.rest;
      if (frame.opcode === 8) {
        this.close();
        return;
      }
      if (frame.opcode === 9) {
        if (!this.dead) this.socket.write(encodeFrame(10, frame.payload, this.mask));
        continue;
      }
      if (frame.opcode === 10) continue;
      if (frame.opcode !== 1 && frame.opcode !== 0) continue;
      const pushed = pushFrame(frame.fin, frame.opcode, frame.payload, this.pending);
      this.pending = pushed.pending;
      if (pushed.oversize || !pushed.message) continue;
      this.handlers.message(pushed.message.toString("utf8"));
    }
  }
}

export function pushFrame(
  fin: boolean,
  opcode: number,
  payload: Buffer,
  pending: Pending | null,
): { pending: Pending | null; message: Buffer | null; oversize: boolean } {
  if (payload.length > MAX_BYTES) return { pending: null, message: null, oversize: true };
  if (opcode === 1 && fin) return { pending: null, message: payload, oversize: false };
  if (opcode === 1) return { pending: { chunks: [payload] }, message: null, oversize: false };
  if (opcode !== 0 || !pending) return { pending: null, message: null, oversize: false };
  const size = pending.chunks.reduce((sum, part) => sum + part.length, 0) + payload.length;
  if (size > MAX_BYTES) return { pending: null, message: null, oversize: true };
  const chunks = [...pending.chunks, payload];
  if (!fin) return { pending: { chunks }, message: null, oversize: false };
  return { pending: null, message: Buffer.concat(chunks), oversize: false };
}

export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): LiteSocket | null {
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") return null;
  const accept = createHash("sha1").update(String(key) + GUID).digest("base64");
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  const client = new LiteSocket(socket, false);
  if (head.length) client.feed(head);
  return client;
}

export function rejectUpgrade(socket: Duplex, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  const reason = status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Error";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`,
  );
  socket.destroy();
}

type RelayEndpoint =
  | { scheme: "http"; host: string; port: number; path: string }
  | { scheme: "https"; host: string; port: number; path: string };

function parseRelayUrl(url: string): RelayEndpoint {
  const parsed = new URL(url);
  const path = `${parsed.pathname}${parsed.search}`;
  if (parsed.protocol === "https:" || parsed.protocol === "wss:") {
    return { scheme: "https", host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 443, path };
  }
  if (parsed.protocol === "http:" || parsed.protocol === "ws:") {
    return { scheme: "http", host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 80, path };
  }
  throw new Error("unsupported relay url");
}

export function openWebSocket(url: string, headers: Record<string, string>): Promise<LiteSocket> {
  const endpoint = parseRelayUrl(url);
  const key = randomBytes(16).toString("base64");
  const hostHeader = (endpoint.scheme === "https" && endpoint.port === 443) || (endpoint.scheme === "http" && endpoint.port === 80)
    ? endpoint.host
    : `${endpoint.host}:${endpoint.port}`;
  return new Promise((resolve, reject) => {
    const socket: Duplex = endpoint.scheme === "https"
      ? connectTls({ host: endpoint.host, port: endpoint.port, servername: endpoint.host })
      : connectTcp({ host: endpoint.host, port: endpoint.port });
    let header = Buffer.alloc(0);
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    socket.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    const handshake = () => {
      const lines = [
        `GET ${endpoint.path} HTTP/1.1`,
        `Host: ${hostHeader}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    };
    if (endpoint.scheme === "https") socket.once("secureConnect", handshake);
    else socket.once("connect", handshake);
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      header = Buffer.concat([header, chunk]);
      const split = header.indexOf("\r\n\r\n");
      if (split < 0) return;
      const text = header.subarray(0, split).toString("utf8");
      const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(text)?.[1] || 0);
      const rest = header.subarray(split + 4);
      if (status !== 101) {
        const body = rest.subarray(0, 300).toString("utf8");
        fail(new Error(`websocket ${status} ${body}`.trim()));
        return;
      }
      socket.removeAllListeners("data");
      settled = true;
      const client = new LiteSocket(socket, true);
      if (rest.length) client.feed(rest);
      resolve(client);
    });
  });
}

export function bearerHeader(req: IncomingMessage): string {
  const value = req.headers.authorization || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const key = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ key[i % 4]!;
  return Buffer.concat([header, key, masked]);
}

type FrameHeader = {
  fin: boolean;
  opcode: number;
  masked: boolean;
  length: number;
  offset: number;
  total: number;
  oversize: boolean;
};

function peekFrame(buf: Buffer): FrameHeader | null {
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let length = buf[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    offset = 10;
    if (big > BigInt(MAX_BYTES)) {
      const declared = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
      return { fin, opcode, masked, length: declared, offset, total: offset + (masked ? 4 : 0) + declared, oversize: true };
    }
    length = Number(big);
  }
  const total = offset + (masked ? 4 : 0) + length;
  return { fin, opcode, masked, length, offset, total, oversize: length > MAX_BYTES };
}

function takeFrame(buf: Buffer, header: FrameHeader): { fin: boolean; opcode: number; payload: Buffer; rest: Buffer } {
  let offset = header.offset;
  const key = header.masked ? buf.subarray(offset, offset + 4) : null;
  if (header.masked) offset += 4;
  const payload = Buffer.from(buf.subarray(offset, offset + header.length));
  if (key) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4]!;
  }
  return { fin: header.fin, opcode: header.opcode, payload, rest: buf.subarray(offset + header.length) };
}
