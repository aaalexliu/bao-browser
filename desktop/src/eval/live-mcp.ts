// Live MCP. BAO_MCP_LIVE=1 navigates to BAO_FIXTURE_URL and performs each tool
// call. Every read and act is a trail line with a PNG snapshot.
// A password type, and a click on data-bao-gate, is recorded and not performed.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Identity } from "../v1/schema";
import { launchOwnedChrome } from "../launch";
import { pageApi, type PageRequest } from "./page";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

interface Hit {
  identity: Identity;
  gate?: "login" | "confirm";
  box: { x: number; y: number; w: number; h: number };
}

const tools = [
  { name: "screenshot", description: "Capture the fixture viewport.", inputSchema: { type: "object", properties: {} } },
  { name: "snapshot", description: "Read ids, roles, and boxes, and capture the viewport.", inputSchema: { type: "object", properties: {} } },
  {
    name: "click",
    description: "Click a viewport coordinate. ref is a DOM id, not an accessibility id.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        ref: { type: "string" },
      },
    },
  },
  { name: "type", description: "Type into the focused field.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "key", description: "Press a key.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "scroll", description: "Scroll at a viewport coordinate.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, dx: { type: "number" }, dy: { type: "number" } } } },
  { name: "upload", description: "Set a file input by DOM id. The trail stores the basename only.", inputSchema: { type: "object", properties: { id: { type: "string" }, path: { type: "string" } }, required: ["id", "path"] } },
];

export async function liveMcpMain(): Promise<void> {
  const home = process.env.BAO_HOME || path.join(process.cwd(), ".bao-mcp");
  const url = process.env.BAO_FIXTURE_URL;
  if (!url) throw new Error("BAO_FIXTURE_URL is required when BAO_MCP_LIVE=1");
  mkdirSync(path.join(home, "shots"), { recursive: true });
  const trailPath = path.join(home, "trail.jsonl");
  const profile = await mkdtemp(path.join(tmpdir(), "bao-mcp-"));
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: process.env.BAO_HEADED !== "1",
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  let seq = 0;

  const ask = (request: PageRequest) => page.evaluate(pageApi, request);

  async function shot(): Promise<{ sha256: string; path: string; w: number; h: number; png: Buffer }> {
    const png = await page.screenshot({ type: "png" });
    const sha256 = createHash("sha256").update(png).digest("hex");
    const file = path.join(home, "shots", `${sha256.slice(0, 16)}.png`);
    writeFileSync(file, png);
    return { sha256, path: file, w: png.readUInt32BE(16), h: png.readUInt32BE(20), png };
  }

  async function statusText(): Promise<{ status?: string; url: string }> {
    const view = await ask({ op: "view" }) as { status?: string; url: string };
    return { status: view.status || undefined, url: page.url() };
  }

  function record(event: Record<string, unknown>): void {
    appendFileSync(trailPath, JSON.stringify({ id: `e${seq++}`, ...event }) + "\n");
  }

  async function perform(name: string, args: Record<string, unknown>): Promise<{ text: string; image?: Buffer; isError?: boolean }> {
    const started = Date.now();
    const beforeUrl = page.url();
    let text = "OK";
    let isError = false;
    let identity: Identity | undefined;
    let gate: "login" | "confirm" | undefined;
    let value: string | undefined;
    let sensitive = false;
    let performed = true;
    let fileName: string | undefined;
    let provenance: { x: number; y: number; space: "viewport" } | undefined;
    const kind = name === "screenshot" || name === "snapshot" ? "read" : "act";
    try {
      if (name === "screenshot" || name === "snapshot") {
        text = name === "screenshot" ? "screenshot" : JSON.stringify(await ask({ op: "view" }));
      } else if (name === "click") {
        const ref = typeof args.ref === "string" ? args.ref : "";
        let point = { x: Number(args.x), y: Number(args.y) };
        if (ref) {
          const hit = await ask({ op: "id", id: ref }) as Hit | null;
          if (!hit) throw new Error(`no element ${ref}`);
          point = { x: hit.box.x + hit.box.w / 2, y: hit.box.y + hit.box.h / 2 };
        }
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("click needs x and y, or a ref");
        const hit = await ask({ op: "at", x: point.x, y: point.y }) as Hit | null;
        identity = hit?.identity;
        gate = hit?.gate;
        provenance = { x: point.x, y: point.y, space: "viewport" };
        if (gate) {
          performed = false;
          text = `STOP ${gate}`;
        } else {
          await page.mouse.click(point.x, point.y);
          await page.waitForTimeout(40);
        }
      } else if (name === "type") {
        const typed = String(args.text ?? "");
        const hit = await ask({ op: "active" }) as Hit | null;
        identity = hit?.identity;
        gate = hit?.gate;
        if (!hit?.identity?.id) throw new Error("type has no focused field");
        if (gate === "login" || hit.identity.id === "password" || hit.identity.nameAttr === "password") {
          performed = false;
          sensitive = true;
          gate = "login";
          text = "STOP login";
        } else {
          value = typed;
          await page.locator("#" + hit.identity.id).fill(typed);
          await page.waitForTimeout(20);
        }
      } else if (name === "key") {
        const key = String(args.key || "Enter");
        await page.keyboard.press(key);
        await page.waitForTimeout(20);
        value = key;
      } else if (name === "scroll") {
        const x = Number(args.x) || 0;
        const y = Number(args.y) || 0;
        const dx = Number(args.dx) || 0;
        const dy = Number(args.dy) || 0;
        provenance = { x, y, space: "viewport" };
        await ask({ op: "scroll", x, y, dx, dy });
        await page.waitForTimeout(20);
      } else if (name === "upload") {
        const id = String(args.id || "");
        const filePath = String(args.path || "");
        const hit = await ask({ op: "id", id }) as Hit | null;
        if (!hit) throw new Error(`no element ${id}`);
        identity = hit.identity;
        fileName = path.basename(filePath);
        await page.locator("#" + id).setInputFiles(filePath);
        await page.waitForTimeout(20);
      } else {
        throw new Error(`unknown tool ${name}`);
      }
    } catch (err) {
      isError = true;
      performed = false;
      text = err instanceof Error ? err.message : String(err);
    }
    const after = await statusText().catch(() => ({ status: undefined, url: page.url() }));
    const image = await shot();
    const recordedArgs: Record<string, unknown> = { ...args };
    if (sensitive) delete recordedArgs.text;
    if (name === "upload") delete recordedArgs.path;
    record({
      ts: Date.now(),
      kind,
      op: name === "key" ? "key" : name,
      args: recordedArgs,
      latencyMs: Date.now() - started,
      source: { agent: "mcp", vendor: "bao", adapter: "stdio" },
      snapshot: { sha256: image.sha256, path: image.path, w: image.w, h: image.h },
      identity,
      value: sensitive ? undefined : value,
      key: name === "key" ? String(args.key || "Enter") : undefined,
      sensitive: sensitive || undefined,
      gate,
      performed,
      fileName,
      provenance,
      beforeUrl,
      afterUrl: after.url,
      afterText: after.status,
    });
    return { text, image: kind === "read" ? image.png : undefined, isError };
  }

  const input = process.stdin;
  let buf = Buffer.alloc(0);
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await context.close().catch(() => undefined);
    process.exit(0);
  };
  input.on("end", () => void shutdown());
  input.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buf.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buf.length < start + length) return;
      const body = buf.slice(start, start + length).toString("utf8");
      buf = buf.slice(start + length);
      void handle(body);
    }
  });

  async function handle(body: string): Promise<void> {
    const msg = JSON.parse(body) as Rpc;
    if (msg.method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "bao", version: "0.1.0" },
        },
      });
    }
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "tools/list") {
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    }
    if (msg.method === "tools/call") {
      const name = msg.params?.name || "";
      const args = msg.params?.arguments || {};
      const result = await perform(name, args);
      const content: Record<string, unknown>[] = [{ type: "text", text: result.text }];
      if (result.image) {
        content.push({ type: "image", data: result.image.toString("base64"), mimeType: "image/png" });
      }
      return send({ jsonrpc: "2.0", id: msg.id, result: { content, isError: !!result.isError } });
    }
    if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  }

  await new Promise(() => {});
}

function send(msg: unknown): void {
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
