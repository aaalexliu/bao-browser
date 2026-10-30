// Capture-time HAR. Each entry records the audit event that was open when the
// request started. Replay does not send these again. Cookies and auth headers
// are stripped before the file is written.

import type { BrowserContext, Request, Response } from "playwright";

const STRIP = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "set-cookie",
]);

interface HarHeader {
  name: string;
  value: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    queryString: { name: string; value: string }[];
    cookies: [];
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    cookies: [];
    content: { size: number; mimeType: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _auditEventId: string;
}

export interface HarLog {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

interface Started {
  auditEventId: string;
  at: number;
}

function headersOf(raw: Record<string, string>): HarHeader[] {
  const out: HarHeader[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (STRIP.has(name.toLowerCase())) continue;
    out.push({ name, value });
  }
  return out;
}

function queryOf(url: string): { name: string; value: string }[] {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export class NetworkCapture {
  readonly entries: HarEntry[] = [];
  private inflight = 0;
  private readonly started = new WeakMap<Request, Started>();

  constructor(private readonly currentId: () => string) {}

  attach(ctx: BrowserContext): void {
    ctx.on("request", (req) => {
      this.inflight++;
      this.started.set(req, { auditEventId: this.currentId(), at: Date.now() });
    });
    ctx.on("requestfinished", (req) => {
      void this.finish(req, false);
    });
    ctx.on("requestfailed", (req) => {
      void this.finish(req, true);
    });
  }

  async flush(): Promise<void> {
    const deadline = Date.now() + 3000;
    while (this.inflight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  har(): HarLog {
    return {
      log: {
        version: "1.2",
        creator: { name: "bao-proxy", version: "spike" },
        entries: this.entries,
      },
    };
  }

  private async finish(req: Request, failed: boolean): Promise<void> {
    const meta = this.started.get(req);
    if (!meta) return;
    this.started.delete(req);
    try {
      let res: Response | null = null;
      try {
        res = await req.response();
      } catch { /* failed before a response */ }
      const responseHeaders = res ? headersOf(await res.allHeaders().catch(() => res!.headers())) : [];
      const mime = responseHeaders.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
      const sizeHeader = responseHeaders.find((h) => h.name.toLowerCase() === "content-length")?.value;
      const size = sizeHeader ? Number(sizeHeader) : -1;
      const elapsed = Date.now() - meta.at;
      this.entries.push({
      startedDateTime: new Date(meta.at).toISOString(),
      time: elapsed,
      request: {
        method: req.method(),
        url: req.url(),
        httpVersion: "HTTP/1.1",
        headers: headersOf(await req.allHeaders().catch(() => req.headers())),
        queryString: queryOf(req.url()),
        cookies: [],
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status: failed || !res ? 0 : res.status(),
        statusText: failed || !res ? "" : res.statusText(),
        httpVersion: "HTTP/1.1",
        headers: responseHeaders,
        cookies: [],
        content: { size: Number.isFinite(size) ? size : -1, mimeType: mime.split(";")[0] ?? "" },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: elapsed, receive: 0 },
      _auditEventId: meta.auditEventId,
    });
    } finally {
      this.inflight = Math.max(0, this.inflight - 1);
    }
  }
}
