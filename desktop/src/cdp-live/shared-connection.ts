// Chrome asks the owner to allow every new debugging connection to his running Chrome: in its approval mode each WebSocket
// upgrade to /devtools/browser opens an "Allow remote debugging?" sheet (DevToolsHttpHandler::OnWebSocketRequest in
// content/browser/devtools/devtools_http_handler.cc). Bao makes one connection. The native agent, workflow capture, and
// replay connect to this local endpoint instead, so a session asks once.

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import type { DevToolsEndpoint } from "./endpoint";
import { serverFrame, ServerFrameDecoder, type CdpMessage, type CdpSocket } from "./socket";

const MAX_FRAME = 256 * 1024 * 1024;

export interface SharedConnection {
  endpoint: DevToolsEndpoint;
  close(): void;
}

/**
 * Joins one client to Bao's connection. The client gets its own browser session (Target.attachToBrowserTarget), so the
 * targets it discovers, the sessions it attaches, and their events stay its own. Its browser-level messages travel on that
 * session; messages of the sessions it attaches pass through unchanged.
 */
async function join(cdp: CdpSocket, client: Duplex, head: Buffer, key: string): Promise<void> {
  let browser: string;
  try {
    ({ sessionId: browser } = await cdp.send<{ sessionId: string }>("Target.attachToBrowserTarget", {}, undefined, 10_000));
  } catch {
    client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    return;
  }
  const sessions = new Set<string>();
  const own = (sessionId: unknown) => {
    if (typeof sessionId !== "string" || sessions.has(sessionId)) return;
    sessions.add(sessionId);
    cdp.route(sessionId, deliver);
  };
  const deliver = (text: string, message: CdpMessage) => {
    if (message.method === "Target.attachedToTarget") own(message.params?.sessionId);
    else own(message.result?.sessionId);
    let out = text;
    if (message.sessionId === browser) {
      const { sessionId: _browser, ...rest } = message;
      out = JSON.stringify(rest);
    }
    if (client.writable) client.write(serverFrame(1, Buffer.from(out)));
    const detached = message.method === "Target.detachedFromTarget" ? message.params?.sessionId : undefined;
    if (typeof detached === "string" && detached !== browser) {
      sessions.delete(detached);
      cdp.route(detached, undefined);
    }
  };
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const sessionId of sessions) cdp.route(sessionId, undefined);
    if (cdp.isOpen) void cdp.send("Target.detachFromTarget", { sessionId: browser }, undefined, 5000).catch(() => undefined);
  };
  const end = () => { client.destroy(); release(); };
  own(browser);
  if (client.destroyed) { release(); return; }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  client.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const frames = new ServerFrameDecoder(MAX_FRAME);
  const take = (chunk: Buffer) => {
    try {
      for (const frame of frames.push(chunk)) {
        if (frame.opcode === 1 && frame.text !== undefined) {
          const message = JSON.parse(frame.text) as CdpMessage;
          cdp.write(message.sessionId === undefined ? JSON.stringify({ ...message, sessionId: browser }) : frame.text);
        } else if (frame.opcode === 8) {
          // Answer the close, as the WebSocket closing handshake asks, before letting the client go.
          client.end(serverFrame(8, frame.payload ?? Buffer.alloc(0)));
          release();
        } else if (frame.opcode === 9) client.write(serverFrame(10, frame.payload ?? Buffer.alloc(0)));
      }
    } catch { end(); }
  };
  client.on("data", take).once("close", release).on("error", end);
  if (head.length) take(head);
}

/** A local endpoint whose clients share `cdp`, Bao's one connection to the owner's Chrome. It closes with that connection. */
export async function shareConnection(cdp: CdpSocket): Promise<SharedConnection> {
  const browserPath = `/devtools/browser/${randomUUID()}`;
  const clients = new Set<Duplex>();
  // Plain HTTP gets nothing, as Chrome's own endpoint answers in approval mode.
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, client: Duplex, head: Buffer) => {
    const key = request.headers["sec-websocket-key"];
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== browserPath || typeof key !== "string" || !cdp.isOpen) {
      client.destroy();
      return;
    }
    clients.add(client);
    client.on("error", () => client.destroy()).once("close", () => clients.delete(client));
    void join(cdp, client, head, key);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Bao could not open its local endpoint for Chrome");
  }
  const close = () => {
    server.close();
    server.closeAllConnections();
    for (const client of clients) client.destroy();
  };
  void cdp.disconnected.then(close);
  return { endpoint: { port: address.port, browserPath }, close };
}
