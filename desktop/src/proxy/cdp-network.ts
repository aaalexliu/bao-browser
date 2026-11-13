// Capture-time HAR over raw CDP Network.*, for the tabs an agent_browser session owns.
// The Playwright listener in ./network.ts remains the spike. This class is the port.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { CdpSocket } from "../cdp-live/socket";

export interface HarNameValue {
  name: string;
  value: string;
}

export interface HarCookie {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  send: number;
  wait: number;
  receive: number;
  ssl: number;
}

export interface FilePartRecord {
  name: string;
  fileName: string;
  sha256: string;
  path?: string;
  contentType?: string;
}

export interface DevtoolsHarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarNameValue[];
    queryString: HarNameValue[];
    cookies: HarCookie[];
    headersSize: number;
    bodySize: number;
    postData?: {
      mimeType: string;
      text?: string;
      params?: { name: string; value?: string; fileName?: string; contentType?: string }[];
    };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarNameValue[];
    cookies: HarCookie[];
    content: { size: number; mimeType: string; text?: string; encoding?: "base64" };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: HarTimings;
  serverIPAddress?: string;
  connection?: string;
  _stepId?: string;
  _initiator?: unknown;
  _error?: string;
  _blocked?: string;
  _requestBody?: string;
  _responseBody?: string;
  _fileParts?: FilePartRecord[];
  _webSocketMessages?: { type: "send" | "receive"; time: number; opcode: number; data: string }[];
  _eventSourceMessages?: { time: number; eventName: string; eventId: string; data: string }[];
}

export interface DevtoolsHarLog {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    entries: DevtoolsHarEntry[];
  };
}

const EMPTY_TIMINGS: HarTimings = { blocked: -1, dns: -1, connect: -1, send: 0, wait: 0, receive: 0, ssl: -1 };
const BODY_LIMIT = 5_000_000;
const FLUSH_MS = 200;

interface Inflight {
  stepId: string;
  sessionId: string;
  started: number;
  wall: number;
  entry: DevtoolsHarEntry;
  responseAt?: number;
  done: boolean;
  body?: Promise<void>;
}

/** Paths named by a command, such as an upload argument. Not URLs and not flags. */
export function filePaths(args: readonly string[]): string[] {
  return args.filter((arg) => arg.length > 0 && !arg.startsWith("-") && !arg.includes("://") && (arg.includes("/") || arg.includes("\\")));
}

export function keepResponseBody(mime: string): boolean {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "application/json" || base.endsWith("+json")) return true;
  if (base === "text/html" || base === "application/xhtml+xml") return true;
  if (base.startsWith("text/")) return true;
  return base === "application/javascript" || base === "application/xml";
}

export function assertDevtoolsHar(value: unknown): void {
  const log = (value as { log?: unknown } | null)?.log as {
    version?: unknown; creator?: { name?: unknown; version?: unknown }; entries?: unknown;
  } | undefined;
  if (!log || log.version !== "1.2" || typeof log.creator?.name !== "string" || typeof log.creator.version !== "string" || !Array.isArray(log.entries)) {
    throw new Error("HAR log is missing version, creator, or entries");
  }
  for (const entry of log.entries as DevtoolsHarEntry[]) {
    if (typeof entry.startedDateTime !== "string" || typeof entry.time !== "number" || !entry.request || !entry.response || !entry.timings || !entry.cache) {
      throw new Error("HAR entry is missing a required field");
    }
    for (const key of ["method", "url", "httpVersion"] as const) {
      if (typeof entry.request[key] !== "string") throw new Error(`HAR request.${key} is missing`);
    }
    if (!Array.isArray(entry.request.headers) || !Array.isArray(entry.request.queryString) || !Array.isArray(entry.request.cookies)) {
      throw new Error("HAR request headers, queryString, or cookies is missing");
    }
    if (typeof entry.request.headersSize !== "number" || typeof entry.request.bodySize !== "number") throw new Error("HAR request sizes are missing");
    if (typeof entry.response.status !== "number" || typeof entry.response.statusText !== "string" || typeof entry.response.httpVersion !== "string") {
      throw new Error("HAR response status is missing");
    }
    if (!Array.isArray(entry.response.headers) || !Array.isArray(entry.response.cookies)) throw new Error("HAR response headers or cookies is missing");
    if (typeof entry.response.content?.size !== "number" || typeof entry.response.content.mimeType !== "string") throw new Error("HAR response content is missing");
    if (typeof entry.response.redirectURL !== "string" || typeof entry.response.headersSize !== "number" || typeof entry.response.bodySize !== "number") {
      throw new Error("HAR response redirect or sizes are missing");
    }
    for (const key of ["send", "wait", "receive"] as const) {
      if (typeof entry.timings[key] !== "number") throw new Error(`HAR timings.${key} is missing`);
    }
  }
}

function headersOf(raw: unknown): HarNameValue[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => {
      const row = item as { name?: unknown; value?: unknown };
      return typeof row.name === "string" && typeof row.value === "string" ? [{ name: row.name, value: row.value }] : [];
    });
  }
  if (typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([name, value]) => {
    if (typeof value === "string") return [{ name, value }];
    if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" ? [{ name, value: item }] : []);
    return [];
  });
}

function headerValue(headers: HarNameValue[], name: string): string {
  return headers.find((header) => header.name.toLowerCase() === name)?.value ?? "";
}

function queryOf(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function httpVersion(protocol: unknown): string {
  if (typeof protocol !== "string" || !protocol) return "HTTP/1.1";
  if (protocol === "h2") return "HTTP/2.0";
  if (protocol === "h3") return "HTTP/3.0";
  if (protocol.toLowerCase().startsWith("http/")) return protocol.toUpperCase();
  return protocol;
}

function cookiesFromHeader(header: string): HarCookie[] {
  if (!header) return [];
  return header.split(";").flatMap((part) => {
    const split = part.indexOf("=");
    if (split <= 0) return [];
    const name = part.slice(0, split).trim();
    const value = part.slice(split + 1).trim();
    return name ? [{ name, value }] : [];
  });
}

function cookiesFromSetCookie(headers: HarNameValue[]): HarCookie[] {
  return headers.filter((header) => header.name.toLowerCase() === "set-cookie").map((header) => {
    const [pair, ...attrs] = header.value.split(";");
    const split = pair?.indexOf("=") ?? -1;
    const cookie: HarCookie = {
      name: split > 0 ? pair!.slice(0, split).trim() : "",
      value: split > 0 ? pair!.slice(split + 1).trim() : "",
    };
    for (const attr of attrs) {
      const [rawName, rawValue] = attr.split("=");
      const name = rawName?.trim().toLowerCase();
      const value = rawValue?.trim();
      if (name === "path" && value) cookie.path = value;
      else if (name === "domain" && value) cookie.domain = value;
      else if (name === "expires" && value) cookie.expires = value;
      else if (name === "httponly") cookie.httpOnly = true;
      else if (name === "secure") cookie.secure = true;
    }
    return cookie;
  }).filter((cookie) => cookie.name);
}

function cookiesFromAssociated(raw: unknown): HarCookie[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const cookie = (item as { cookie?: Record<string, unknown> }).cookie;
    if (!cookie || typeof cookie.name !== "string") return [];
    const next: HarCookie = { name: cookie.name, value: typeof cookie.value === "string" ? cookie.value : "" };
    if (typeof cookie.path === "string") next.path = cookie.path;
    if (typeof cookie.domain === "string") next.domain = cookie.domain;
    if (typeof cookie.expires === "number" && cookie.expires > 0) next.expires = new Date(cookie.expires * 1000).toISOString();
    if (cookie.httpOnly === true) next.httpOnly = true;
    if (cookie.secure === true) next.secure = true;
    return [next];
  });
}

function timingsOf(raw: unknown, receive: number): HarTimings {
  const timing = raw as Record<string, unknown> | undefined;
  const num = (key: string) => typeof timing?.[key] === "number" ? timing[key] as number : -1;
  const dnsStart = num("dnsStart");
  const connectStart = num("connectStart");
  const sendStart = num("sendStart");
  const blocked = dnsStart >= 0 ? dnsStart : connectStart >= 0 ? connectStart : sendStart;
  const dnsEnd = num("dnsEnd");
  const connectEnd = num("connectEnd");
  const sendEnd = num("sendEnd");
  const headersEnd = num("receiveHeadersEnd");
  const sslStart = num("sslStart");
  const sslEnd = num("sslEnd");
  return {
    blocked: blocked >= 0 ? blocked : -1,
    dns: dnsStart >= 0 && dnsEnd >= 0 ? dnsEnd - dnsStart : -1,
    connect: connectStart >= 0 && connectEnd >= 0 ? connectEnd - connectStart : -1,
    send: sendStart >= 0 && sendEnd >= 0 ? sendEnd - sendStart : 0,
    wait: sendEnd >= 0 && headersEnd >= 0 ? headersEnd - sendEnd : 0,
    receive,
    ssl: sslStart >= 0 && sslEnd >= 0 ? sslEnd - sslStart : -1,
  };
}

function elapsed(timings: HarTimings, fallback: number): number {
  const sum = [timings.blocked, timings.dns, timings.connect, timings.send, timings.wait, timings.receive]
    .reduce((total, part) => total + (part > 0 ? part : 0), 0);
  return sum > 0 ? sum : Math.max(0, fallback);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashFile(file: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => resolve(undefined));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function boundaryOf(contentType: string): string | undefined {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2]?.trim();
}

function partHeaders(raw: string): { headers: HarNameValue[]; body: string } {
  const split = raw.indexOf("\r\n\r\n");
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split + 4) : "";
  const headers = head.split("\r\n").flatMap((line) => {
    const colon = line.indexOf(":");
    if (colon <= 0) return [];
    return [{ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() }];
  });
  return { headers, body };
}

/** File parts are named by path and SHA-256. Their bytes are not stored. */
export async function describeMultipart(body: string, contentType: string, files: readonly string[]): Promise<{
  mimeType: string;
  params: { name: string; value?: string; fileName?: string; contentType?: string }[];
  text?: string;
  fileParts: FilePartRecord[];
} | undefined> {
  if (!contentType.toLowerCase().includes("multipart/")) return undefined;
  const boundary = boundaryOf(contentType);
  if (!boundary) return undefined;
  const params: { name: string; value?: string; fileName?: string; contentType?: string }[] = [];
  const fileParts: FilePartRecord[] = [];
  const chunks = body.split(`--${boundary}`);
  for (const chunk of chunks) {
    const trimmed = chunk.replace(/^\r\n/, "").replace(/\r\n$/, "");
    if (!trimmed || trimmed === "--") continue;
    const part = partHeaders(trimmed.endsWith("--") ? trimmed.slice(0, -2).replace(/\r\n$/, "") : trimmed);
    const disposition = headerValue(part.headers, "content-disposition");
    const name = /(?:^|;)\s*name="([^"]*)"/.exec(disposition)?.[1] ?? /(?:^|;)\s*name=([^;]+)/.exec(disposition)?.[1]?.trim() ?? "";
    const fileName = /filename="([^"]*)"/.exec(disposition)?.[1] ?? /filename=([^;]+)/.exec(disposition)?.[1]?.trim();
    const content = headerValue(part.headers, "content-type") || undefined;
    if (fileName !== undefined) {
      const path = files.find((file) => file === fileName || file.split(/[/\\]/).pop() === fileName.split(/[/\\]/).pop());
      const sha256 = (path ? await hashFile(path) : undefined) ?? hashText(part.body);
      fileParts.push({ name, fileName, sha256, ...(path ? { path } : {}), ...(content ? { contentType: content } : {}) });
      params.push({ name, fileName: path ?? fileName, ...(content ? { contentType: content } : {}) });
      continue;
    }
    params.push({ name, value: part.body.replace(/\r\n$/, ""), ...(content ? { contentType: content } : {}) });
  }
  return { mimeType: contentType, params, fileParts };
}

function blankEntry(stepId: string, at: number, method: string, url: string): DevtoolsHarEntry {
  return {
    startedDateTime: new Date(at).toISOString(),
    time: 0,
    request: {
      method, url, httpVersion: "HTTP/1.1", headers: [], queryString: queryOf(url), cookies: [], headersSize: -1, bodySize: -1,
    },
    response: {
      status: 0, statusText: "", httpVersion: "HTTP/1.1", headers: [], cookies: [],
      content: { size: 0, mimeType: "" }, redirectURL: "", headersSize: -1, bodySize: -1,
    },
    cache: {},
    timings: { ...EMPTY_TIMINGS },
    _stepId: stepId,
  };
}

/**
 * Listens to Network.* on targets the caller owns. A target opened by an owned target is owned too.
 * Events from any other target are ignored.
 */
export class CdpNetworkCapture {
  private readonly owned = new Set<string>();
  private readonly sessions = new Map<string, string>();
  private readonly inflight = new Map<string, Inflight>();
  private readonly extra = new Map<string, { headers?: HarNameValue[]; cookies?: HarCookie[] }>();
  private readonly responseExtra = new Map<string, HarNameValue[]>();
  private readonly finished: DevtoolsHarEntry[] = [];
  private readonly byId = new Map<string, DevtoolsHarEntry>();
  private stepId = "";
  private files: string[] = [];
  private started = false;
  private stopped = false;
  private late: ((stepId: string) => void) | undefined;

  constructor(
    private readonly cdp: CdpSocket,
    private readonly closeSocket: boolean,
    private readonly storeBody: (bytes: Buffer) => Promise<string>,
  ) {}

  onLate(listener: (stepId: string) => void): void {
    this.late = listener;
  }

  setStep(stepId: string): void {
    this.stepId = stepId;
  }

  noteFiles(paths: readonly string[]): void {
    this.files = [...paths];
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.cdp.on("Target.targetCreated", undefined, (params) => {
      const info = params.targetInfo as { targetId?: unknown; type?: unknown; openerId?: unknown } | undefined;
      if (info?.type !== "page" || typeof info.targetId !== "string" || typeof info.openerId !== "string") return;
      if (!this.owned.has(info.openerId)) return;
      void this.own(info.targetId).catch(() => undefined);
    });
    await this.cdp.send("Target.setDiscoverTargets", { discover: true }, undefined, 5000);
  }

  async own(targetId: string): Promise<void> {
    if (!targetId || this.owned.has(targetId) || this.stopped) return;
    this.owned.add(targetId);
    const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 5000);
    this.sessions.set(sessionId, targetId);
    this.listen(sessionId);
    await this.cdp.send("Network.enable", { maxPostDataSize: 1_000_000, maxResourceBufferSize: BODY_LIMIT }, sessionId, 5000);
  }

  entries(stepId: string): DevtoolsHarEntry[] {
    return this.snapshot().filter((entry) => entry._stepId === stepId);
  }

  allEntries(): DevtoolsHarEntry[] {
    return this.snapshot();
  }

  private snapshot(): DevtoolsHarEntry[] {
    const live = [...this.inflight.values()].filter((item) => !item.done).map((item) => {
      const clone = structuredClone(item.entry);
      clone._error = clone._error ?? "unfinished";
      clone.time = Math.max(0, Date.now() - item.wall);
      return clone;
    });
    return [...this.finished, ...live].map((entry) => structuredClone(entry));
  }

  async take(stepId: string): Promise<DevtoolsHarEntry[]> {
    const deadline = Date.now() + FLUSH_MS;
    while (Date.now() < deadline && [...this.inflight.values()].some((item) => item.stepId === stepId && !item.done)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await Promise.all([...this.inflight.values()].filter((item) => item.stepId === stepId && item.body).map((item) => item.body));
    return this.entries(stepId);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const [id, item] of this.inflight) {
      if (!item.done) {
        item.entry._error = item.entry._error ?? "unfinished";
        this.finished.push(item.entry);
      }
      this.inflight.delete(id);
    }
    for (const sessionId of this.sessions.keys()) {
      await this.cdp.send("Network.disable", {}, sessionId, 1000).catch(() => undefined);
      await this.cdp.send("Target.detachFromTarget", { sessionId }, undefined, 1000).catch(() => undefined);
    }
    this.sessions.clear();
    if (this.closeSocket) this.cdp.close();
  }

  private listen(sessionId: string): void {
    const on = (method: string, handler: (params: Record<string, unknown>) => void) => {
      this.cdp.on(method, sessionId, (params) => {
        try { handler(params); }
        catch { /* a malformed event does not stop the command */ }
      });
    };
    on("Network.requestWillBeSent", (params) => void this.onRequest(sessionId, params));
    on("Network.requestWillBeSentExtraInfo", (params) => this.onRequestExtra(params));
    on("Network.responseReceived", (params) => this.onResponse(params));
    on("Network.responseReceivedExtraInfo", (params) => this.onResponseExtra(params));
    on("Network.loadingFinished", (params) => void this.onFinished(params));
    on("Network.loadingFailed", (params) => this.onFailed(params));
    on("Network.webSocketCreated", (params) => this.onSocket(sessionId, params));
    on("Network.webSocketFrameSent", (params) => this.onSocketFrame(params, "send"));
    on("Network.webSocketFrameReceived", (params) => this.onSocketFrame(params, "receive"));
    on("Network.eventSourceMessageReceived", (params) => this.onEventSource(params));
  }

  private held(requestId: unknown): Inflight | undefined {
    return typeof requestId === "string" ? this.inflight.get(requestId) : undefined;
  }

  private entryFor(requestId: unknown): DevtoolsHarEntry | undefined {
    return typeof requestId === "string" ? this.inflight.get(requestId)?.entry ?? this.byId.get(requestId) : undefined;
  }

  private async onRequest(sessionId: string, params: Record<string, unknown>): Promise<void> {
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    const request = params.request as { method?: unknown; url?: unknown; headers?: unknown; postData?: unknown } | undefined;
    const url = typeof request?.url === "string" ? request.url : "";
    const method = typeof request?.method === "string" ? request.method : "GET";
    const redirect = params.redirectResponse as { status?: unknown; statusText?: unknown; headers?: unknown; mimeType?: unknown; protocol?: unknown; remoteIPAddress?: unknown } | undefined;
    const previous = this.inflight.get(requestId);
    if (previous && redirect) {
      previous.entry.response.status = typeof redirect.status === "number" ? redirect.status : 302;
      previous.entry.response.statusText = typeof redirect.statusText === "string" ? redirect.statusText : "";
      previous.entry.response.headers = headersOf(redirect.headers);
      previous.entry.response.cookies = cookiesFromSetCookie(previous.entry.response.headers);
      previous.entry.response.httpVersion = httpVersion(redirect.protocol);
      previous.entry.response.content.mimeType = typeof redirect.mimeType === "string" ? redirect.mimeType : "";
      previous.entry.response.redirectURL = url;
      if (typeof redirect.remoteIPAddress === "string") previous.entry.serverIPAddress = redirect.remoteIPAddress;
      previous.entry.time = elapsed(previous.entry.timings, Date.now() - previous.wall);
      previous.done = true;
      this.finished.push(previous.entry);
      this.inflight.delete(requestId);
    }
    if (!this.stepId) return;
    const wall = typeof params.wallTime === "number" ? params.wallTime * 1000 : Date.now();
    const entry = blankEntry(this.stepId, wall, method, url);
    entry.request.headers = headersOf(request?.headers);
    entry._initiator = params.initiator;
    const extra = this.extra.get(requestId);
    if (extra?.headers) this.mergeHeaders(entry, extra.headers);
    if (extra?.cookies) entry.request.cookies = extra.cookies;
    if (!entry.request.cookies.length) entry.request.cookies = cookiesFromHeader(headerValue(entry.request.headers, "cookie"));
    this.byId.set(requestId, entry);
    this.inflight.set(requestId, { stepId: this.stepId, sessionId, started: typeof params.timestamp === "number" ? params.timestamp : 0, wall, entry, done: false });
    if (typeof request?.postData === "string") await this.postData(entry, request.postData);
    else if (method !== "GET" && method !== "HEAD") void this.loadPostData(requestId, sessionId, entry);
  }

  private onRequestExtra(params: Record<string, unknown>): void {
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    const headers = headersOf(params.headers);
    const cookies = cookiesFromAssociated(params.associatedCookies);
    const held = this.inflight.get(requestId);
    if (!held) {
      this.extra.set(requestId, { headers, cookies });
      return;
    }
    if (headers.length) this.mergeHeaders(held.entry, headers);
    if (cookies.length) held.entry.request.cookies = cookies;
    else if (!held.entry.request.cookies.length) held.entry.request.cookies = cookiesFromHeader(headerValue(held.entry.request.headers, "cookie"));
  }

  private mergeHeaders(entry: DevtoolsHarEntry, headers: HarNameValue[]): void {
    const names = new Set(headers.map((header) => header.name.toLowerCase()));
    entry.request.headers = [...entry.request.headers.filter((header) => !names.has(header.name.toLowerCase())), ...headers];
  }

  private async postData(entry: DevtoolsHarEntry, text: string): Promise<void> {
    const mime = headerValue(entry.request.headers, "content-type");
    const multipart = await describeMultipart(text, mime, this.files);
    if (multipart) {
      entry.request.postData = { mimeType: multipart.mimeType, params: multipart.params };
      entry._fileParts = multipart.fileParts;
      entry.request.bodySize = multipart.fileParts.length ? -1 : Buffer.byteLength(text);
      return;
    }
    entry.request.bodySize = Buffer.byteLength(text);
    if (!text.length) return;
    entry.request.postData = { mimeType: mime || "application/octet-stream" };
    if (text.length <= BODY_LIMIT) entry._requestBody = await this.storeBody(Buffer.from(text));
  }

  private async loadPostData(requestId: string, sessionId: string, entry: DevtoolsHarEntry): Promise<void> {
    try {
      const result = await this.cdp.send<{ postData?: string }>("Network.getRequestPostData", { requestId }, sessionId, 2000);
      if (typeof result.postData === "string") await this.postData(entry, result.postData);
    } catch { /* the body was evicted or was not text */ }
  }

  private onResponse(params: Record<string, unknown>): void {
    const held = this.held(params.requestId);
    if (!held) return;
    const response = params.response as Record<string, unknown> | undefined;
    held.entry.response.status = typeof response?.status === "number" ? response.status : 0;
    held.entry.response.statusText = typeof response?.statusText === "string" ? response.statusText : "";
    held.entry.response.httpVersion = httpVersion(response?.protocol);
    held.entry.response.headers = headersOf(response?.headers);
    const extraHeaders = typeof params.requestId === "string" ? this.responseExtra.get(params.requestId) : undefined;
    if (extraHeaders) this.mergeResponseHeaders(held.entry, extraHeaders);
    held.entry.response.cookies = cookiesFromSetCookie(held.entry.response.headers);
    held.entry.response.content.mimeType = typeof response?.mimeType === "string" ? response.mimeType.split(";")[0]?.trim() ?? "" : "";
    held.entry.response.content.size = typeof response?.encodedDataLength === "number" ? response.encodedDataLength : 0;
    held.entry.timings = timingsOf(response?.timing, 0);
    if (typeof response?.remoteIPAddress === "string") held.entry.serverIPAddress = response.remoteIPAddress;
    held.responseAt = typeof params.timestamp === "number" ? params.timestamp : undefined;
  }

  private onResponseExtra(params: Record<string, unknown>): void {
    const headers = headersOf(params.headers);
    if (typeof params.requestId === "string" && headers.length) this.responseExtra.set(params.requestId, headers);
    const entry = this.entryFor(params.requestId);
    if (!entry || !headers.length) return;
    this.mergeResponseHeaders(entry, headers);
    const cookies = cookiesFromSetCookie(entry.response.headers);
    if (cookies.length) entry.response.cookies = cookies;
    if (typeof params.statusCode === "number" && entry.response.status === 0) entry.response.status = params.statusCode;
    if (!this.held(params.requestId) && entry._stepId) this.late?.(entry._stepId);
  }

  private mergeResponseHeaders(entry: DevtoolsHarEntry, headers: HarNameValue[]): void {
    const names = new Set(headers.map((header) => header.name.toLowerCase()));
    entry.response.headers = [...entry.response.headers.filter((header) => !names.has(header.name.toLowerCase())), ...headers];
  }

  private async onFinished(params: Record<string, unknown>): Promise<void> {
    const requestId = params.requestId;
    const held = this.held(requestId);
    if (!held || typeof requestId !== "string") return;
    const receive = held.responseAt !== undefined && typeof params.timestamp === "number" ? Math.max(0, (params.timestamp - held.responseAt) * 1000) : 0;
    held.entry.timings = { ...held.entry.timings, receive };
    held.entry.time = elapsed(held.entry.timings, Date.now() - held.wall);
    if (typeof params.encodedDataLength === "number") {
      held.entry.response.bodySize = params.encodedDataLength;
      if (!held.entry.response.content.size) held.entry.response.content.size = params.encodedDataLength;
    }
    held.done = true;
    const mime = held.entry.response.content.mimeType;
    if (keepResponseBody(mime) && held.entry.response.content.size <= BODY_LIMIT && held.entry.response.status > 0) {
      held.body = this.responseBody(requestId, held.sessionId, held);
      await held.body;
    }
    this.finish(requestId, held);
  }

  private async responseBody(requestId: string, sessionId: string, held: Inflight): Promise<void> {
    try {
      const result = await this.cdp.send<{ body?: string; base64Encoded?: boolean }>("Network.getResponseBody", { requestId }, sessionId, 2000);
      if (typeof result.body !== "string") return;
      const bytes = result.base64Encoded ? Buffer.from(result.body, "base64") : Buffer.from(result.body);
      if (bytes.length > BODY_LIMIT) return;
      held.entry._responseBody = await this.storeBody(bytes);
      held.entry.response.content.size = bytes.length;
    } catch { /* the body was evicted */ }
  }

  private onFailed(params: Record<string, unknown>): void {
    const requestId = params.requestId;
    const held = this.held(requestId);
    if (!held || typeof requestId !== "string") return;
    held.entry.response.status = 0;
    held.entry.response.statusText = typeof params.errorText === "string" ? params.errorText : "";
    if (typeof params.errorText === "string") held.entry._error = params.errorText;
    if (typeof params.blockedReason === "string") held.entry._blocked = params.blockedReason;
    if (params.canceled === true && !held.entry._error) held.entry._error = "canceled";
    held.entry.time = Math.max(0, Date.now() - held.wall);
    held.done = true;
    this.finish(requestId, held);
  }

  private finish(requestId: string, held: Inflight): void {
    this.inflight.delete(requestId);
    this.finished.push(held.entry);
    this.extra.delete(requestId);
    this.late?.(held.stepId);
  }

  private onSocket(sessionId: string, params: Record<string, unknown>): void {
    const held = this.held(params.requestId);
    if (!held) {
      if (!this.stepId || typeof params.url !== "string" || typeof params.requestId !== "string") return;
      const entry = blankEntry(this.stepId, Date.now(), "GET", params.url);
      entry._initiator = params.initiator;
      entry._webSocketMessages = [];
      this.inflight.set(params.requestId, { stepId: this.stepId, sessionId, started: 0, wall: Date.now(), entry, done: false });
      return;
    }
    held.entry._webSocketMessages ??= [];
    if (params.initiator) held.entry._initiator = params.initiator;
  }

  private onSocketFrame(params: Record<string, unknown>, type: "send" | "receive"): void {
    const held = this.held(params.requestId);
    const frame = params.response as { opcode?: unknown; payloadData?: unknown } | undefined;
    if (!held || typeof frame?.payloadData !== "string") return;
    held.entry._webSocketMessages ??= [];
    held.entry._webSocketMessages.push({
      type,
      time: typeof params.timestamp === "number" ? params.timestamp : Date.now() / 1000,
      opcode: typeof frame.opcode === "number" ? frame.opcode : 1,
      data: frame.payloadData,
    });
    this.late?.(held.stepId);
  }

  private onEventSource(params: Record<string, unknown>): void {
    const held = this.held(params.requestId);
    if (!held || typeof params.data !== "string") return;
    held.entry._eventSourceMessages ??= [];
    held.entry._eventSourceMessages.push({
      time: typeof params.timestamp === "number" ? params.timestamp : Date.now() / 1000,
      eventName: typeof params.eventName === "string" ? params.eventName : "",
      eventId: typeof params.eventId === "string" ? params.eventId : "",
      data: params.data,
    });
    this.late?.(held.stepId);
  }
}
