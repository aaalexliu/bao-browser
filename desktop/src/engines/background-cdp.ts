// The native agent-browser reaches Bao's own agent Chrome through this endpoint, so Chrome stays behind the owner's apps.
// agent-browser brings a tab to the front on every tab switch and opens new tabs in front. On macOS either one lifts
// Chrome's window over the owner's other apps, and can make Chrome the front app with the owner's keyboard.
// On a Chrome copy, the same switch also selects the tab. Focus emulation does not unthrottle a tab that is not selected.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { DevToolsEndpoint } from "../cdp-live/endpoint";
import { clientFrame, handshakeRequest, serverFrame, ServerFrameDecoder } from "../cdp-live/socket";

const MAX_FRAME = 256 * 1024 * 1024;
/** Bao's own commands use ids far above any the agent's client reaches, so their replies can be dropped. */
const FIRST_OWN_ID = 1_000_000_000;

export interface CdpCommand { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }

/**
 * What Chrome gets for one agent command, or what Bao answers in its place. A tab switch keeps Chrome where it is. A new
 * tab opens in the background. Focus emulation keeps a background tab visible and painting.
 */
export function keepBehind(command: CdpCommand): { reply: Record<string, unknown> } | { forward: CdpCommand } {
  switch (command.method) {
    case "Page.bringToFront":
    case "Target.activateTarget":
      return { reply: {} };
    case "Target.createTarget":
      return { forward: { ...command, params: { ...command.params, background: true } } };
    default:
      return { forward: command };
  }
}

export interface BackgroundCdp {
  endpoint: DevToolsEndpoint;
  close(): void;
}

function upgrade(chrome: DevToolsEndpoint): Promise<{ socket: Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: chrome.port });
    let header = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      clearTimeout(timer);
      socket.off("data", onData).off("error", onError).off("close", onClose).setTimeout(0);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      finish();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error("Chrome did not answer the debugging connection"), { code: "ETIMEDOUT" })), 10_000);
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(Object.assign(new Error("Chrome closed the debugging connection"), { code: "ECONNRESET" }));
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const split = header.indexOf("\r\n\r\n");
      if (split < 0) return;
      if (!/^HTTP\/1\.[01] 101 /.test(header.subarray(0, split).toString("utf8"))) {
        fail(new Error("Chrome refused the debugging connection"));
        return;
      }
      if (settled) return;
      settled = true;
      finish();
      socket.pause();
      resolve({ socket, rest: header.subarray(split + 4) });
    };
    socket.on("data", onData).once("error", onError).once("close", onClose);
    socket.once("connect", () => socket.write(handshakeRequest(chrome.browserPath, `127.0.0.1:${chrome.port}`, randomBytes(16).toString("base64"))));
  });
}

/** Joins one agent connection to its own Chrome connection. Each page also gets focus emulation, so it acts as if its window had focus. */
async function join(chrome: DevToolsEndpoint, client: Duplex, head: Buffer, key: string, sockets: Set<Duplex>, selectTab?: (targetId: string) => Promise<void>): Promise<void> {
  let opened: { socket: Socket; rest: Buffer } | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      opened = await upgrade(chrome);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const again = attempt < 2 && (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE");
      if (!again) {
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!opened) {
    client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    return;
  }
  const { socket: chromeSocket, rest } = opened;
  sockets.add(chromeSocket);
  const end = () => { client.destroy(); chromeSocket.destroy(); };
  chromeSocket.once("close", () => { sockets.delete(chromeSocket); client.destroy(); });
  client.once("close", () => chromeSocket.destroy());
  if (client.destroyed) { end(); return; }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  client.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

  const focused = new Set<string>();
  const own = new Set<number>();
  const sessions = new Map<string, string>();
  const attachIds = new Map<number, string>();
  let nextOwn = FIRST_OWN_ID;
  let selectFailed = false;
  const toChrome = (command: CdpCommand) => chromeSocket.write(clientFrame(1, Buffer.from(JSON.stringify(command))));
  const fromClient = new ServerFrameDecoder(MAX_FRAME);
  const fromChrome = new ServerFrameDecoder(MAX_FRAME);
  const ownReply = (text: string) => {
    try {
      const { id } = JSON.parse(text) as { id?: unknown };
      return typeof id === "number" && own.delete(id);
    } catch { return false; }
  };
  const rememberSession = (text: string) => {
    let message: { id?: number; method?: string; params?: { sessionId?: string; targetInfo?: { targetId?: string } }; result?: { sessionId?: string } };
    try { message = JSON.parse(text); } catch { return; }
    const attached = message.method === "Target.attachedToTarget" ? message.params : undefined;
    if (attached?.sessionId && attached.targetInfo?.targetId) sessions.set(attached.sessionId, attached.targetInfo.targetId);
    if (message.id !== undefined && message.result?.sessionId) {
      const targetId = attachIds.get(message.id);
      if (targetId) {
        sessions.set(message.result.sessionId, targetId);
        attachIds.delete(message.id);
      }
    }
  };
  const targetOf = (command: CdpCommand): string | undefined => {
    if (command.method === "Target.activateTarget" && typeof command.params?.targetId === "string") return command.params.targetId;
    if (command.method === "Page.bringToFront" && command.sessionId) return sessions.get(command.sessionId);
    return undefined;
  };

  const handleClient = async (chunk: Buffer) => {
    for (const frame of fromClient.push(chunk)) {
      if (frame.opcode === 1 && frame.text) {
        const command = JSON.parse(frame.text) as CdpCommand;
        if (command.sessionId && !focused.has(command.sessionId)) {
          focused.add(command.sessionId);
          own.add(nextOwn);
          toChrome({ id: nextOwn++, method: "Emulation.setFocusEmulationEnabled", params: { enabled: true }, sessionId: command.sessionId });
        }
        const next = keepBehind(command);
        if ("reply" in next) {
          const targetId = selectTab ? targetOf(command) : undefined;
          if (selectTab && targetId) {
            try { await selectTab(targetId); }
            catch (error) {
              if (!selectFailed) {
                selectFailed = true;
                console.error(`Bao could not select the agent's tab without raising Chrome: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
          if (!client.destroyed) client.write(serverFrame(1, Buffer.from(JSON.stringify({ id: command.id, result: next.reply, ...command.sessionId ? { sessionId: command.sessionId } : {} }))));
        } else {
          if (command.method === "Target.attachToTarget" && typeof command.params?.targetId === "string") attachIds.set(command.id, command.params.targetId);
          toChrome(next.forward);
        }
      } else if (frame.opcode === 2) chromeSocket.write(clientFrame(2, frame.payload!));
      else if (frame.opcode === 8) end();
      else if (frame.opcode === 9) client.write(serverFrame(10, frame.payload ?? Buffer.alloc(0)));
    }
  };
  let chain = Promise.resolve();
  const takeClient = (chunk: Buffer) => { chain = chain.then(() => handleClient(chunk)).catch(end); };
  const takeChrome = (chunk: Buffer) => {
    try {
      for (const frame of fromChrome.push(chunk)) {
        // Replies to Bao's own commands are short. Larger frames go straight through unread.
        if (frame.opcode === 1 && frame.payload!.length < 65_536) rememberSession(frame.text!);
        if (frame.opcode === 1 && own.size && frame.payload!.length < 512 && ownReply(frame.text!)) continue;
        if (frame.opcode === 1 || frame.opcode === 2) client.write(serverFrame(frame.opcode, frame.payload!));
        else if (frame.opcode === 8) end();
        else if (frame.opcode === 9) chromeSocket.write(clientFrame(10, frame.payload ?? Buffer.alloc(0)));
      }
    } catch { end(); }
  };
  client.on("data", takeClient).on("error", end).on("end", end);
  chromeSocket.on("data", takeChrome).on("error", end);
  if (head.length) takeClient(head);
  if (rest.length) takeChrome(rest);
  chromeSocket.resume();
}

/** A local endpoint in front of Bao's agent Chrome. Close it when the session ends. `selectTab` runs before Bao answers a raising command, and only the copy route sets it. */
export async function openBackgroundCdp(chrome: DevToolsEndpoint, selectTab?: (targetId: string) => Promise<void>): Promise<BackgroundCdp> {
  const browserPath = `/devtools/browser/${randomUUID()}`;
  const sockets = new Set<Duplex>();
  // Plain HTTP gets nothing. Chrome's /json routes would raise its windows or hand out its own port.
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, client: Duplex, head: Buffer) => {
    const key = request.headers["sec-websocket-key"];
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== browserPath || typeof key !== "string") {
      client.destroy();
      return;
    }
    sockets.add(client);
    client.on("error", () => client.destroy()).once("close", () => sockets.delete(client));
    void join(chrome, client, head, key, sockets, selectTab);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Bao could not open its agent Chrome endpoint");
  }
  return {
    endpoint: { port: address.port, browserPath },
    close() {
      server.close();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    },
  };
}
