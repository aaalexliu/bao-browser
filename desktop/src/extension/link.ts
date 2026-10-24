// Unix socket the native host dials. The token stays in a 0600 file the extension cannot read.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { FrameDecoder, encodeFrame } from "./frames";
import { installNativeHost } from "./install-host";
import type { Gesture, HelloMessage } from "./protocol";
import { EXTENSION_ID } from "./protocol";

export interface TrailHandler {
  (event: Record<string, unknown>, gesture?: Gesture): void;
}

export interface RecordHandler {
  (kind: "start" | "stop", url: string): void;
}

export interface ExtensionLink {
  socketPath: string;
  helloSerial: number;
  connected(): boolean;
  onTrail(handler: TrailHandler): void;
  onRecord(handler: RecordHandler): void;
  command(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  waitForHello(afterSerial: number, timeoutMs?: number): Promise<HelloMessage>;
  close(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export async function startExtensionLink(opts: {
  home: string;
  configHome?: string;
  hostScript: string;
  extraDirs?: string[];
  nodePath?: string;
}): Promise<ExtensionLink> {
  const dir = path.join(opts.home, "extension-host");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = path.join(dir, "bridge.sock");
  const tokenPath = path.join(dir, "token");
  let token = "";
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch {
    token = "";
  }
  if (!token) {
    token = randomBytes(32).toString("hex");
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  }
  chmodSync(tokenPath, 0o600);
  try {
    unlinkSync(socketPath);
  } catch {
    /* fresh socket */
  }
  installNativeHost({
    home: opts.configHome || opts.home,
    socketPath,
    tokenPath,
    hostScript: opts.hostScript,
    nodePath: opts.nodePath,
    extensionId: EXTENSION_ID,
    extraDirs: opts.extraDirs,
  });

  let server: Server;
  let active: Socket | null = null;
  let generation = 0;
  let hello: HelloMessage | null = null;
  let helloSerial = 0;
  const pending = new Map<string, Pending>();
  const helloWaiters: { after: number; resolve: (hello: HelloMessage) => void; timer: NodeJS.Timeout }[] = [];
  let trail: TrailHandler = () => {};
  let record: RecordHandler = () => {};
  let closed = false;

  const failPending = (message: string) => {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
      pending.delete(id);
    }
  };

  const noteHello = (message: HelloMessage) => {
    hello = message;
    helloSerial += 1;
    const serial = helloSerial;
    for (let i = helloWaiters.length - 1; i >= 0; i--) {
      const waiter = helloWaiters[i];
      if (!waiter || waiter.after >= serial) continue;
      clearTimeout(waiter.timer);
      helloWaiters.splice(i, 1);
      waiter.resolve(message);
    }
  };

  const onFrame = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const body = message as { type?: string; id?: string; ok?: boolean; value?: unknown; error?: string; event?: Record<string, unknown>; gesture?: Gesture; url?: string; resumed?: boolean; extensionId?: string; version?: string };
    if (body.type === "hello") {
      noteHello({
        type: "hello",
        extensionId: String(body.extensionId || ""),
        version: String(body.version || ""),
        resumed: body.resumed === true,
      });
      return;
    }
    if (body.type === "result" && body.id) {
      const item = pending.get(body.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(body.id);
      if (body.ok) item.resolve(body.value);
      else item.reject(new Error(body.error || "extension command failed"));
      return;
    }
    if (body.type === "trail" && body.event) {
      trail(body.event, body.gesture);
      return;
    }
    if (body.type === "record-start") {
      record("start", String(body.url || ""));
      return;
    }
    if (body.type === "record-stop") {
      record("stop", String(body.url || ""));
      return;
    }
  };

  await new Promise<void>((resolve, reject) => {
    server = createServer((socket) => {
      const decoder = new FrameDecoder();
      let authed = false;
      let mine = 0;
      const drop = () => {
        if (!authed || mine === 0 || mine !== generation) return;
        if (active === socket) active = null;
        hello = null;
        failPending("link dropped");
      };
      socket.on("error", () => socket.destroy());
      socket.on("close", drop);
      socket.on("data", (chunk) => {
        let frames: unknown[];
        try {
          frames = decoder.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const frame of frames) {
          if (!authed) {
            const body = frame as { type?: string; token?: string; extensionId?: string };
            if (body.type !== "auth" || body.token !== token || body.extensionId !== EXTENSION_ID) {
              socket.destroy();
              return;
            }
            authed = true;
            mine = ++generation;
            const previous = active;
            active = socket;
            if (previous && previous !== socket) {
              previous.destroy();
              failPending("link dropped");
            }
            socket.write(encodeFrame({ type: "auth-ok" }));
            continue;
          }
          if (active !== socket) return;
          onFrame(frame);
        }
      });
    });
    server.on("error", reject);
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        /* some platforms ignore chmod on sockets */
      }
      resolve();
    });
  });

  let commandSeq = 0;
  const link: ExtensionLink = {
    socketPath,
    get helloSerial() {
      return helloSerial;
    },
    connected: () => active !== null && !active.destroyed,
    onTrail(handler) {
      trail = handler;
    },
    onRecord(handler) {
      record = handler;
    },
    command(op, params = {}, timeoutMs = 30000) {
      if (!active || active.destroyed) return Promise.reject(new Error("extension is not connected"));
      const id = `c${Date.now().toString(36)}-${++commandSeq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`extension timed out on ${op}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          active?.write(encodeFrame({ type: "cmd", id, op, ...params }));
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    waitForHello(afterSerial, timeoutMs = 15000) {
      if (hello && helloSerial > afterSerial) return Promise.resolve(hello);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = helloWaiters.findIndex((item) => item.timer === timer);
          if (index >= 0) helloWaiters.splice(index, 1);
          reject(new Error("extension did not reconnect"));
        }, timeoutMs);
        helloWaiters.push({ after: afterSerial, resolve, timer });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      failPending("link closed");
      active?.destroy();
      active = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
    },
  };
  return link;
}

export function hostScriptPath(): string {
  return path.join(__dirname, "native-host.js");
}
