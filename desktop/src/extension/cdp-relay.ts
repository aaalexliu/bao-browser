// CDP for Bao's tabs in the owner's own Chrome, driven by the extension through chrome.debugger.
// A client connects to ws://127.0.0.1:<app port>/devtools/browser/<lease>. A lease is one run: it sees only the tabs
// its clients created and the popups those tabs opened. The owner's tabs are not in any lease.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { ServerFrameDecoder } from "../cdp-live/socket";
import type { RelayEvent } from "../../../shared/agent-tabs";
import type { ExtensionLink } from "./link";

const LEASE_PATH = /^\/devtools\/browser\/([0-9a-zA-Z-]{8,64})$/;

export const EXTENSION_NOT_LINKED = "Running Chrome needs the Bao extension in Chrome, linked to the Bao app. Open Chrome, then check that the Bao icon says linked to Bao.";
export const EXTENSION_TOO_OLD = "Reload the Bao extension at chrome://extensions. Running Chrome needs its tab-group permission.";

interface Tab { tabId: number; targetId: string; url: string; title: string; lease: Lease; children: Set<string> }
interface Lease { id: string; clients: Set<Client>; tabs: Map<number, Tab> }
interface Client { socket: Duplex; lease: Lease; discover: boolean; autoAttach: boolean; sessions: Map<string, Tab> }
interface Message { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }

/** A server frame is never masked. */
function serverFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  if (length < 65536) return Buffer.concat([Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]), payload]);
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function sessionId(): string {
  return randomBytes(16).toString("hex").toUpperCase();
}

export interface CdpRelay {
  /** Takes an HTTP upgrade for a lease path. Returns false for any other path. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

export function createCdpRelay(link: ExtensionLink): CdpRelay {
  const leases = new Map<string, Lease>();
  const tabs = new Map<number, Tab>();
  let userAgent: string | undefined;

  const call = (op: string, params: Record<string, unknown> = {}, timeoutMs?: number) => new Promise<unknown>((resolve, reject) => {
    link.relay(op, params, (error, value) => error ? reject(error) : resolve(value), timeoutMs);
  });

  const send = (client: Client, message: Record<string, unknown>) => {
    if (!client.socket.destroyed) client.socket.write(serverFrame(1, Buffer.from(JSON.stringify(message))));
  };
  const event = (client: Client, method: string, params: unknown, session?: string) =>
    send(client, { method, params, ...(session ? { sessionId: session } : {}) });

  const info = (tab: Tab) => ({ targetId: tab.targetId, type: "page", title: tab.title, url: tab.url, attached: true, canAccessOpener: false,
    browserContextId: tab.lease.id });

  const attach = (client: Client, tab: Tab): string => {
    const id = sessionId();
    client.sessions.set(id, tab);
    event(client, "Target.attachedToTarget", { sessionId: id, targetInfo: info(tab), waitingForDebugger: false });
    return id;
  };

  const announce = (tab: Tab) => {
    for (const client of tab.lease.clients) {
      if (client.discover) event(client, "Target.targetCreated", { targetInfo: info(tab) });
      if (client.autoAttach) attach(client, tab);
    }
  };

  const addTab = (lease: Lease, opened: { tabId: number; targetId: string; url: string; title: string }): Tab => {
    const tab: Tab = { ...opened, lease, children: new Set() };
    lease.tabs.set(tab.tabId, tab);
    tabs.set(tab.tabId, tab);
    announce(tab);
    return tab;
  };

  const dropTab = (tab: Tab) => {
    if (tabs.get(tab.tabId) !== tab) return;
    tabs.delete(tab.tabId);
    tab.lease.tabs.delete(tab.tabId);
    for (const client of tab.lease.clients) {
      for (const [id, held] of client.sessions) {
        if (held !== tab) continue;
        client.sessions.delete(id);
        event(client, "Target.detachedFromTarget", { sessionId: id, targetId: tab.targetId });
      }
      if (client.discover) event(client, "Target.targetDestroyed", { targetId: tab.targetId });
    }
  };

  const endLease = (lease: Lease) => {
    for (const client of lease.clients) client.socket.destroy();
  };

  const refresh = async (lease: Lease) => {
    const fresh = await call("info", { tabIds: [...lease.tabs.keys()] }, 5000) as { tabId: number; url: string; title: string }[];
    for (const item of fresh) {
      const tab = lease.tabs.get(item.tabId);
      if (tab) Object.assign(tab, { url: item.url, title: item.title });
    }
  };

  const byTarget = (lease: Lease, targetId: unknown): Tab => {
    for (const tab of lease.tabs.values()) if (tab.targetId === targetId) return tab;
    throw new Error(`No target with given id found: ${String(targetId)}`);
  };

  async function browserCommand(client: Client, method: string, params: Record<string, unknown>): Promise<unknown> {
    const lease = client.lease;
    switch (method) {
      case "Browser.getVersion": {
        userAgent ??= (await call("version", {}, 5000) as { userAgent: string }).userAgent;
        const version = /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? "0";
        return { protocolVersion: "1.3", product: `Chrome/${version}`, revision: "", userAgent, jsVersion: "" };
      }
      // Downloads keep the owner's settings, and Bao never grants a site permission in his profile.
      case "Browser.setDownloadBehavior":
      case "Browser.grantPermissions":
        return {};
      case "Target.setDiscoverTargets":
        client.discover = params.discover === true;
        if (client.discover) for (const tab of lease.tabs.values()) event(client, "Target.targetCreated", { targetInfo: info(tab) });
        return {};
      case "Target.setAutoAttach":
        client.autoAttach = params.autoAttach === true;
        if (client.autoAttach) {
          for (const tab of lease.tabs.values()) if (![...client.sessions.values()].includes(tab)) attach(client, tab);
        }
        return {};
      case "Target.getTargets":
        await refresh(lease);
        return { targetInfos: [...lease.tabs.values()].map(info) };
      case "Target.getTargetInfo": {
        if (params.targetId === undefined) return { targetInfo: { targetId: lease.id, type: "browser", title: "", url: "", attached: true } };
        const tab = byTarget(lease, params.targetId);
        await refresh(lease);
        return { targetInfo: info(tab) };
      }
      case "Target.attachToTarget":
        return { sessionId: attach(client, byTarget(lease, params.targetId)) };
      case "Target.detachFromTarget": {
        const id = String(params.sessionId ?? "");
        const tab = client.sessions.get(id);
        if (!tab) throw new Error("No session with given id");
        client.sessions.delete(id);
        event(client, "Target.detachedFromTarget", { sessionId: id, targetId: tab.targetId });
        return {};
      }
      case "Target.createTarget": {
        const opened = await call("open", { url: typeof params.url === "string" ? params.url : "about:blank" }) as Tab;
        if (leases.get(lease.id) !== lease) {
          await call("close", { tabIds: [opened.tabId] });
          throw new Error("The Bao session ended");
        }
        return { targetId: addTab(lease, opened).targetId };
      }
      case "Target.closeTarget": {
        const tab = byTarget(lease, params.targetId);
        await call("close", { tabIds: [tab.tabId] });
        dropTab(tab);
        return { success: true };
      }
      // The owner keeps his active tab. Bao.showTab opens the group for a handoff, or brings a tab to the front when he asks.
      case "Target.activateTarget":
        byTarget(lease, params.targetId);
        return {};
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Bao.showTab":
        await call("show", { tabId: byTarget(lease, params.targetId).tabId, front: params.front === true });
        return {};
      case "Bao.settleTab":
        await call("settle", { tabId: byTarget(lease, params.targetId).tabId });
        return {};
      case "Bao.closeTabs": {
        const closing = [...lease.tabs.values()];
        await call("close", { tabIds: closing.map((tab) => tab.tabId) });
        for (const tab of closing) dropTab(tab);
        return {};
      }
      default:
        throw new Error(`Bao's Running Chrome does not support ${method}`);
    }
  }

  function routeOf(client: Client, id: string): { tab: Tab; child?: string } | undefined {
    const root = client.sessions.get(id);
    if (root) return { tab: root };
    for (const tab of client.sessions.values()) if (tab.children.has(id)) return { tab, child: id };
    return undefined;
  }

  function onMessage(client: Client, message: Message): void {
    const reply = (body: { result: unknown } | { error: { code: number; message: string } }) =>
      send(client, { id: message.id, ...body, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
    const fail = (error: unknown) => reply({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    const params = message.params ?? {};
    const browserLevel = !message.sessionId || message.method.startsWith("Browser.")
      || (message.method.startsWith("Target.") && !["Target.setAutoAttach", "Target.getTargetInfo", "Target.detachFromTarget"].includes(message.method));
    if (browserLevel) {
      browserCommand(client, message.method, params).then((result) => reply({ result }), fail);
      return;
    }
    const route = routeOf(client, message.sessionId!);
    if (!route) {
      fail(new Error(`Session with given id not found: ${message.sessionId}`));
      return;
    }
    if (message.method === "Page.bringToFront") {
      reply({ result: {} });
      return;
    }
    // A background tab needs focus emulation to paint and take input. A client cannot turn it off.
    const forwarded = message.method === "Emulation.setFocusEmulationEnabled" ? { enabled: true } : params;
    // The callback runs before any later frame, so the reply keeps its place among the tab's events. A page command
    // can wait a long time, as it can on Chrome's own port; the limit only frees a call the extension never answers.
    link.relay("send", { tabId: route.tab.tabId, ...(route.child ? { sessionId: route.child } : {}), method: message.method, params: forwarded },
      (error, value) => error ? fail(new Error(cdpMessage(error.message))) : reply({ result: value ?? {} }), 600_000);
  }

  link.onRelayEvent((relayEvent: RelayEvent) => {
    const tab = tabs.get(relayEvent.tabId);
    if (relayEvent.kind === "opened") {
      const opener = tabs.get(relayEvent.openerTabId);
      if (opener) addTab(opener.lease, relayEvent);
      else link.relay("release", { tabIds: [relayEvent.tabId] }, () => undefined);
      return;
    }
    if (!tab) return;
    if (relayEvent.kind === "cdp") {
      const params = (relayEvent.params ?? {}) as Record<string, unknown>;
      if (relayEvent.method === "Target.attachedToTarget" && typeof params.sessionId === "string") tab.children.add(params.sessionId);
      if (relayEvent.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") tab.children.delete(params.sessionId);
      for (const client of tab.lease.clients) {
        if (relayEvent.sessionId) {
          if ([...client.sessions.values()].includes(tab)) event(client, relayEvent.method, params, relayEvent.sessionId);
          continue;
        }
        for (const [id, held] of client.sessions) if (held === tab) event(client, relayEvent.method, params, id);
      }
    } else if (relayEvent.kind === "info") {
      Object.assign(tab, { url: relayEvent.url, title: relayEvent.title });
      for (const client of tab.lease.clients) if (client.discover) event(client, "Target.targetInfoChanged", { targetInfo: info(tab) });
    } else if (relayEvent.kind === "removed") {
      dropTab(tab);
    } else {
      // Cancel on Chrome's debugging bar stops this run. The extension already gave its tabs to the owner.
      for (const held of [...tab.lease.tabs.values()]) dropTab(held);
      endLease(tab.lease);
    }
  });

  link.onDrop(() => {
    for (const lease of [...leases.values()]) endLease(lease);
  });

  function connect(socket: Duplex, head: Buffer, lease: Lease): void {
    const client: Client = { socket, lease, discover: false, autoAttach: false, sessions: new Map() };
    lease.clients.add(client);
    const decoder = new ServerFrameDecoder();
    const take = (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (frame.opcode === 1 && frame.text) onMessage(client, JSON.parse(frame.text) as Message);
          else if (frame.opcode === 8) { socket.end(serverFrame(8, Buffer.alloc(0))); socket.destroy(); }
          else if (frame.opcode === 9) socket.write(serverFrame(10, frame.payload ?? Buffer.alloc(0)));
        }
      } catch {
        socket.destroy();
      }
    };
    socket.on("data", take);
    socket.on("error", () => socket.destroy());
    // The HTTP server keeps sockets half open, so a client that leaves sends only an end.
    socket.on("end", () => socket.destroy());
    socket.once("close", () => {
      lease.clients.delete(client);
      if (lease.clients.size) return;
      leases.delete(lease.id);
      // Nobody drives this run any more. Its open tabs become the owner's.
      const left = [...lease.tabs.values()];
      for (const tab of left) dropTab(tab);
      if (left.length) link.relay("release", { tabIds: left.map((tab) => tab.tabId) }, () => undefined);
    });
    if (head.length) take(head);
  }

  return {
    upgrade(req, socket, head) {
      const match = LEASE_PATH.exec(new URL(req.url || "/", "http://127.0.0.1").pathname);
      if (!match) return false;
      const key = req.headers["sec-websocket-key"];
      const refusal = typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket" ? "not a WebSocket upgrade"
        : !link.connected() ? EXTENSION_NOT_LINKED : !link.agentTabs() ? EXTENSION_TOO_OLD : undefined;
      if (refusal) {
        socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${refusal}`);
        return true;
      }
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const id = match[1]!;
      let lease = leases.get(id);
      if (!lease) leases.set(id, lease = { id, clients: new Set(), tabs: new Map() });
      connect(socket, head, lease);
      return true;
    },
    close() {
      for (const lease of [...leases.values()]) endLease(lease);
    },
  };
}

/** chrome.debugger rejects with the protocol error as JSON text. A CDP client wants its message. */
function cdpMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : text;
  } catch {
    return text;
  }
}
