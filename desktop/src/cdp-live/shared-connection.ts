// Chrome asks the owner to allow every new debugging connection to his running Chrome: in its approval mode each WebSocket
// upgrade to /devtools/browser opens an "Allow remote debugging?" sheet (DevToolsHttpHandler::OnWebSocketRequest in
// content/browser/devtools/devtools_http_handler.cc). Bao makes one connection per running Chrome. The native agent, workflow
// capture, replay, and every later session connect to this local endpoint instead, so a Chrome launch asks once.

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { keepBehind } from "../engines/background-cdp";
import type { DevToolsEndpoint } from "./endpoint";
import { CDP_PROGRESS_CEILING_MS, serverFrame, ServerFrameDecoder, type CdpMessage, type CdpSocket } from "./socket";

const MAX_FRAME = 256 * 1024 * 1024;

/** Query on the native daemon's `--cdp` URL. Only that client stays behind. A handoff client does not send it. */
export const DAEMON_BEHIND_QUERY = "background=1";

function daemonStaysBehind(resource: string | undefined): boolean {
  const [key, value] = DAEMON_BEHIND_QUERY.split("=");
  try {
    return new URL(resource ?? "/", "http://127.0.0.1").searchParams.get(key ?? "") === value;
  } catch {
    return false;
  }
}

export interface SharedConnection {
  endpoint: DevToolsEndpoint;
  close(): void;
}

/**
 * Joins one client to Bao's connection. The client gets its own browser session (Target.attachToBrowserTarget), so the
 * targets it discovers, the sessions it attaches, and their events stay its own. Its browser-level messages travel on that
 * session. When the client's URL has `background=1`, Page.bringToFront and Target.activateTarget are answered here and
 * Target.createTarget is forced into the background, so the native daemon's tab switch does not raise the owner's Chrome.
 * A client without that marker is forwarded unchanged, so a handoff's Target.activateTarget still brings the task tab forward.
 * Bao's own socket, the one passed into shareConnection, is not a client. Other messages pass through. Its commands travel
 * under ids of Bao's connection.
 */
async function join(cdp: CdpSocket, client: Duplex, head: Buffer, key: string, behind: boolean): Promise<void> {
  let browser: string;
  const ceiling = new AbortController();
  const timer = setTimeout(() => ceiling.abort(), CDP_PROGRESS_CEILING_MS);
  timer.unref();
  // A client that leaves sends FIN. That is "end" until this side finishes, so "close" alone holds the attach.
  const onLeave = () => ceiling.abort();
  client.on("close", onLeave);
  client.on("end", onLeave);
  client.on("error", onLeave);
  if (client.destroyed) onLeave();
  try {
    ({ sessionId: browser } = await cdp.sendUntilProgress<{ sessionId: string }>("Target.attachToBrowserTarget", {}, undefined, { signal: ceiling.signal }));
  } catch {
    if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    return;
  } finally {
    clearTimeout(timer);
    client.off("close", onLeave);
    client.off("end", onLeave);
    client.off("error", onLeave);
  }
  const sessions = new Set<string>();
  let released = false;
  const own = (sessionId: unknown) => {
    if (typeof sessionId !== "string" || sessions.has(sessionId)) return;
    sessions.add(sessionId);
    cdp.route(sessionId, deliver);
  };
  const deliver = (text: string, message: CdpMessage) => {
    if (released) return;
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
          if (typeof message.id === "number" && typeof message.method === "string") {
            const command = { id: message.id, method: message.method, params: message.params, sessionId: message.sessionId };
            const next = behind ? keepBehind(command) : { forward: command };
            if ("reply" in next) {
              const reply = { id: message.id, result: next.reply, ...message.sessionId ? { sessionId: message.sessionId } : {} };
              if (client.writable) client.write(serverFrame(1, Buffer.from(JSON.stringify(reply))));
              continue;
            }
            const forward = next.forward;
            cdp.write(forward.sessionId === undefined ? { ...forward, sessionId: browser } : forward, deliver);
            continue;
          }
          cdp.write(message.sessionId === undefined ? { ...message, sessionId: browser } : message, deliver);
        } else if (frame.opcode === 8) {
          // Answer the close, as the WebSocket closing handshake asks, before letting the client go.
          client.end(serverFrame(8, frame.payload ?? Buffer.alloc(0)));
          release();
        } else if (frame.opcode === 9) client.write(serverFrame(10, frame.payload ?? Buffer.alloc(0)));
      }
    } catch { end(); }
  };
  client.on("data", take).once("end", end).once("close", release).on("error", end);
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
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== browserPath || typeof key !== "string" || !cdp.isOpen) {
      client.destroy();
      return;
    }
    clients.add(client);
    client.on("error", () => client.destroy()).once("close", () => clients.delete(client));
    void join(cdp, client, head, key, daemonStaysBehind(request.url));
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
