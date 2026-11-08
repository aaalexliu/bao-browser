import { createServer } from "node:http";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import type { DevToolsEndpoint } from "./endpoint";
import { clientFrame, handshakeRequest, ServerFrameDecoder } from "./socket";

export interface TabRelay {
  /** Browser endpoint for Playwright's connectOverCDP. */
  url: string;
  close(): void;
}

/** Playwright's own WebSocket message limit. */
const MAX_MESSAGE = 256 * 1024 * 1024;

/**
 * Playwright's connectOverCDP auto-attaches every tab in the browser and waits until each one answers
 * Page.enable, so one owner tab that never answers stalls it. This relay passes Playwright's traffic
 * through to Chrome unchanged, except that the browser-wide Target.setAutoAttach becomes an attach to
 * `targetId` alone. Playwright then sees and touches only that tab.
 */
export async function relayTab(endpoint: DevToolsEndpoint, targetId: string): Promise<TabRelay> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  server.on("upgrade", (request, client: Socket, head: Buffer) => {
    const upstream = createConnection({ host: "127.0.0.1", port: endpoint.port });
    const end = () => { client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", end).on("close", () => { sockets.delete(socket); end(); });
    }
    // Chrome answers Playwright's own key, so its handshake reply passes through as is.
    upstream.write(handshakeRequest(endpoint.browserPath, `127.0.0.1:${endpoint.port}`, String(request.headers["sec-websocket-key"])));
    upstream.pipe(client);
    const decoder = new ServerFrameDecoder(MAX_MESSAGE);
    const forward = (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          upstream.write(clientFrame(frame.opcode, frame.opcode === 1 ? Buffer.from(attachOnly(frame.text!, targetId)) : frame.payload!));
        }
      } catch { end(); }
    };
    forward(head);
    client.on("data", forward);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}${endpoint.browserPath}`,
    close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

function attachOnly(text: string, targetId: string): string {
  const message = JSON.parse(text) as { id: number; method?: string; sessionId?: string };
  if (message.sessionId || message.method !== "Target.setAutoAttach") return text;
  return JSON.stringify({ id: message.id, method: "Target.attachToTarget", params: { targetId, flatten: true } });
}
