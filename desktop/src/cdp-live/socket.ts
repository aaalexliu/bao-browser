import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

/** Local browser socket. The upgrade carries no Origin header. */

/** Chrome's own DevTools send buffer. Other clients' replies, such as a full-page screenshot, can share Bao's connection. */
const MAX_FRAME = 256 * 1024 * 1024;

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
  private chunks: Buffer[] = [];
  private length = 0;
  private fragments: Buffer[] = [];
  private fragOp = 0;

  constructor(private readonly maxFrame = MAX_FRAME) {}

  push(chunk: Buffer): DecodedFrame[] {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    const out: DecodedFrame[] = [];
    while (this.length >= 2) {
      const head = this.chunks[0]!.length >= 14 ? this.chunks[0]! : Buffer.concat(this.chunks, Math.min(14, this.length));
      const b0 = head[0]!;
      const b1 = head[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.length < 4) break;
        len = head.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.length < 10) break;
        const big = head.readBigUInt64BE(2);
        if (big > BigInt(this.maxFrame)) throw new Error("cdp frame too large");
        len = Number(big);
        offset = 10;
      }
      if (len > this.maxFrame) throw new Error("cdp frame too large");
      const maskLen = masked ? 4 : 0;
      if (this.length < offset + maskLen + len) break;
      const frame = this.take(offset + maskLen + len);
      const payload = frame.subarray(offset + maskLen);
      if (masked) {
        const mask = frame.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      }
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

  /** Removes the first `n` buffered bytes into one new buffer, copying each byte once. */
  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let pos = 0;
    while (pos < n) {
      const chunk = this.chunks[0]!;
      const count = Math.min(chunk.length, n - pos);
      chunk.copy(out, pos, 0, count);
      pos += count;
      if (count === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
    this.length -= n;
    return out;
  }

  private finish(opcode: number, payload: Buffer): DecodedFrame {
    if (opcode === 1) return { opcode, text: payload.toString("utf8"), payload };
    return { opcode, payload };
  }
}

/** A server frame is never masked. */
export function serverFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  if (length < 65536) return Buffer.concat([Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]), payload]);
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

export function clientFrame(opcode: number, payload: Buffer): Buffer {
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

export interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** Takes the messages of a session that another client owns, and the replies to that client's commands. */
export type CdpRoute = (text: string, message: CdpMessage) => void;

interface ClientCall {
  id: number;
  route: CdpRoute;
}

export class CdpSocket {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly calls = new Map<number, ClientCall>();
  private readonly listeners: { method: string; sessionId?: string; handler: Handler }[] = [];
  private readonly routes = new Map<string, CdpRoute>();
  private readonly lifeWaiters = new Set<() => void>();
  private closed = false;
  private resolveDisconnected!: () => void;
  readonly disconnected = new Promise<void>((resolve) => { this.resolveDisconnected = resolve; });

  constructor(private readonly socket: Socket) {
    socket.once("close", () => this.close());
    socket.once("error", () => this.close());
  }

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

  /**
   * Waits for the reply while the peer sends frames. Silence ends the wait.
   * A deadline counted from the start does not.
   */
  sendUntilProgress<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string, opts: { silenceMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`cdp closed before ${method}`));
    const silenceMs = opts.silenceMs ?? CDP_SILENCE_MS;
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ping: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        if (timer) clearTimeout(timer);
        if (ping) clearInterval(ping);
        this.lifeWaiters.delete(onLife);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        stop();
        this.pending.delete(id);
        reject(err);
      };
      const onAbort = () => fail(new Error(`cdp aborted ${method}`));
      const arm = () => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fail(new Error(`cdp timeout ${method}`)), silenceMs);
      };
      const onLife = () => arm();
      this.lifeWaiters.add(onLife);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) {
        fail(new Error(`cdp aborted ${method}`));
        return;
      }
      this.pending.set(id, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          stop();
          resolve(value as T);
        },
        reject: (err) => fail(err),
      });
      arm();
      this.socket.write(clientFrame(1, Buffer.from(JSON.stringify(message))));
      const every = Math.min(1_000, Math.max(50, Math.floor(silenceMs / 3)));
      ping = setInterval(() => { if (!settled) this.ping(); }, every);
      this.ping();
    });
  }

  /** Returns the call that removes this listener. */
  on(method: string, sessionId: string | undefined, handler: Handler): () => void {
    const listener = { method, sessionId, handler };
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }

  /** Sends the messages of `sessionId` to `route` instead of Bao. No route gives them back to Bao. */
  route(sessionId: string, route: CdpRoute | undefined): void {
    if (route) this.routes.set(sessionId, route);
    else this.routes.delete(sessionId);
  }

  /** Sends a command another client wrote under an id of this socket. Its reply comes back to `route` with the client's id. */
  write(message: CdpMessage, route: CdpRoute): void {
    if (this.closed) return;
    const id = this.nextId++;
    this.calls.set(id, { id: message.id as number, route });
    this.socket.write(clientFrame(1, Buffer.from(JSON.stringify({ ...message, id }))));
  }

  /** Any frame from the peer, including a pong, means the wait is still making progress. */
  noteLife(): void {
    for (const wake of this.lifeWaiters) wake();
  }

  private ping(): void {
    if (!this.closed) this.socket.write(clientFrame(9, Buffer.alloc(0)));
  }

  takeText(text: string): void {
    this.noteLife();
    let msg: CdpMessage;
    try {
      msg = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const call = this.calls.get(msg.id);
      if (call) {
        this.calls.delete(msg.id);
        const reply = { ...msg, id: call.id };
        call.route(JSON.stringify(reply), reply);
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(scrubCdp(msg.error.message || "cdp error")));
      else waiter.resolve(msg.result);
      return;
    }
    const route = msg.sessionId === undefined ? undefined : this.routes.get(msg.sessionId);
    if (route) {
      route(text, msg);
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
    this.noteLife();
    if (!this.closed) this.socket.write(clientFrame(10, Buffer.from(payload ?? new Uint8Array())));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error("cdp closed"));
    this.pending.clear();
    this.lifeWaiters.clear();
    this.calls.clear();
    this.socket.destroy();
    this.resolveDisconnected();
  }
}

/** How long a progress wait stays open after the last frame from the peer. */
export const CDP_SILENCE_MS = 120_000;

/** A capture, active-page read, or shared-endpoint join stops here even when the peer keeps answering pings. */
export const CDP_PROGRESS_CEILING_MS = 30_000;

export interface ConnectOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const REFUSED_CONNECTION = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EAI_AGAIN"]);

function refusedConnection(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && REFUSED_CONNECTION.has(code);
}

/**
 * Chrome can print its debugging line before the port accepts. A refused connection is retried
 * until two seconds have passed, and never past the caller's own timeout.
 */
export function connectCdp(port: number, browserPath: string, opts: ConnectOptions = {}): Promise<CdpSocket> {
  if (!browserPath.startsWith("/devtools/browser")) {
    return Promise.reject(new Error("refusing a non-browser debugging path"));
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const retryUntil = Math.min(deadline, Date.now() + 2000);
  return (async () => {
    let last: unknown;
    while (Date.now() <= deadline) {
      if (opts.signal?.aborted) throw new Error("cdp handshake aborted");
      try {
        return await connectCdpOnce(port, browserPath, Math.max(1, deadline - Date.now()), opts.signal);
      } catch (error) {
        last = error;
        if (!refusedConnection(error) || Date.now() >= retryUntil || opts.signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, retryUntil - Date.now()))));
      }
    }
    throw last instanceof Error ? last : new Error("cdp handshake timed out");
  })();
}

function connectCdpOnce(port: number, browserPath: string, timeoutMs: number, signal?: AbortSignal): Promise<CdpSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
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
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    socket.on("close", () => {
      if (!upgraded) fail(Object.assign(new Error("cdp connection closed"), { code: "ECONNRESET" }));
    });
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
            signal?.removeEventListener("abort", onAbort);
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
        else if (frame.opcode === 10) client.noteLife();
      }
    }

    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(handshakeRequest(browserPath, `127.0.0.1:${port}`, key));
    });
  });
}
