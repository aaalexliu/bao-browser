// stdio MCP server. Screenshot, click, type, key, and read_tree go through
// the macOS executor. Only Calculator and TextEdit are accepted.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSensitiveValue } from "../../../src/mask";
import { AuditTrail, type AuditSource } from "./audit";
import { MacOsExecutor } from "./macos-exec";
import { MacOsHelper, type AxNode } from "./os-macos";
import { HELPER, launchIfDown } from "./spike-macos-host";

const APPS = {
  calculator: { bundle: "com.apple.calculator", process: "Calculator", launch: "Calculator" },
  textedit: { bundle: "com.apple.TextEdit", process: "TextEdit", launch: "TextEdit" },
} as const;

type AppName = keyof typeof APPS;

const source: AuditSource = {
  agent: "live-model",
  vendor: process.env.BAO_VENDOR || "unknown",
  adapter: process.env.BAO_MODEL || "unknown",
};

const trail = new AuditTrail();
const helper = new MacOsHelper(HELPER);
const work = process.env.BAO_WORK || "/tmp/bao-mcp-work";
const trailPath = process.env.BAO_TRAIL || "";
const ownedPath = process.env.BAO_OWNED || "";
const shotDir = process.env.BAO_SHOTS || "";
let shots = 0;
let buffer = Buffer.alloc(0);
let lineFraming = true;
const owned: Record<string, number> = {};
const lastImage: Partial<Record<AppName, { w: number; h: number }>> = {};

const tools = [
  tool("screenshot", "Window-cropped screenshot of Calculator or TextEdit. Click coordinates are pixels in this image.", { app: appProp() }, ["app"]),
  tool("click", "Click a pixel in the latest screenshot. 0,0 is the top-left of that window image. The server maps the pixel onto the window and resolves an accessibility element.", {
    app: appProp(), x: { type: "number" }, y: { type: "number" },
  }, ["app", "x", "y"]),
  tool("type", "Type text into the focused text control of the target app.", {
    app: appProp(), text: { type: "string" },
  }, ["app", "text"]),
  tool("key", "Send one key combo to the target app, such as return or cmd+a.", {
    app: appProp(), combo: { type: "string" },
  }, ["app", "combo"]),
  tool("read_tree", "Accessibility summary of the target window.", { app: appProp() }, ["app"]),
];

function appProp() {
  return { type: "string", enum: ["calculator", "textedit"] };
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

function send(msg: unknown): void {
  const body = Buffer.from(JSON.stringify(msg));
  if (lineFraming) {
    process.stdout.write(body);
    process.stdout.write("\n");
    return;
  }
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
  const trace = process.env.BAO_TRACE;
  if (!trace) return;
  void import("node:fs").then((fs) => fs.appendFileSync(trace, `${line}\n`));
}

async function saveTrail(): Promise<void> {
  if (!trailPath) return;
  await writeFile(trailPath, JSON.stringify({
    source: { agent: source.agent, vendor: source.vendor, model: source.adapter },
    events: trail.events,
  }, null, 2));
  if (ownedPath) await writeFile(ownedPath, JSON.stringify(owned));
}

function appOf(name: unknown): AppName {
  if (name === "calculator" || name === "textedit") return name;
  throw new Error("app must be calculator or textedit");
}

async function ensure(name: AppName): Promise<string> {
  if (owned[name]) return APPS[name].bundle;
  const pid = await launchIfDown(APPS[name].launch, APPS[name].process);
  if (pid == null) throw new Error(`${name} is already running; refusing to touch it`);
  owned[name] = pid;
  await new Promise((r) => setTimeout(r, 700));
  return APPS[name].bundle;
}

function untitledTitle(title: string): boolean {
  return title === "Untitled" || title.startsWith("Untitled");
}

async function guardTextEdit(app: AppName, bundle: string): Promise<"open" | "untitled"> {
  if (app !== "textedit") return "untitled";
  let titles: string[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nodes = (await helper.nodes(bundle)).nodes ?? [];
    titles = nodes.filter((n) => n.role === "AXWindow").map((n) => (n.name || n.title || "").trim());
    if (titles.some((title) => title.length > 0)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!titles.some((title) => title.length > 0)) {
    throw new Error("TextEdit window title was not ready; refusing to capture it");
  }
  for (const title of titles) {
    if (title === "" || title === "Open" || untitledTitle(title)) continue;
    const pid = owned.textedit;
    if (pid) {
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve) => execFile("/bin/kill", [String(pid)], () => resolve()));
    }
    throw new Error("restored document; aborting without reading it");
  }
  const open = titles.includes("Open");
  const untitled = titles.some((title) => untitledTitle(title));
  return open && !untitled ? "open" : "untitled";
}

function executor(bundle: string): MacOsExecutor {
  return new MacOsExecutor(trail, helper, bundle, work);
}

function origin(raw: unknown) {
  return { source, raw };
}

async function windowShot(bundle: string): Promise<Buffer> {
  const file = path.join(work, `cap-${Date.now()}.png`);
  await helper.shot(bundle, file);
  const image = await readFile(file);
  await rm(file, { force: true });
  await saveShot(image);
  return image;
}

async function saveShot(png: Buffer): Promise<void> {
  shots += 1;
  if (!shotDir) return;
  await writeFile(path.join(shotDir, `model-${String(shots).padStart(2, "0")}.png`), png);
}

function pngSize(png: Buffer): { w: number; h: number } {
  if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") return { w: 0, h: 0 };
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

function remember(app: AppName, png: Buffer): { w: number; h: number } {
  const size = pngSize(png);
  if (size.w > 0 && size.h > 0) lastImage[app] = size;
  return size;
}

function mainWindow(hit: { windows?: { layer: number; x: number; y: number; w: number; h: number }[] }) {
  const list = (hit.windows ?? []).filter((w) => w.layer === 0 && w.w > 2 && w.h > 2);
  list.sort((a, b) => b.w * b.h - a.w * a.h);
  return list[0];
}

function imageFrame(
  frame: { x: number; y: number; w: number; h: number },
  win: { x: number; y: number; w: number; h: number },
  img: { w: number; h: number },
): string {
  const rx = ((frame.x - win.x) / win.w) * img.w;
  const ry = ((frame.y - win.y) / win.h) * img.h;
  const rw = (frame.w / win.w) * img.w;
  const rh = (frame.h / win.h) * img.h;
  return `${Math.round(rx)},${Math.round(ry)} ${Math.round(rw)}x${Math.round(rh)}`;
}

function summary(
  nodes: AxNode[],
  win: { x: number; y: number; w: number; h: number } | undefined,
  img: { w: number; h: number } | undefined,
): string {
  const lines = nodes.filter((n) => n.useful || n.role === "AXStaticText" || n.role === "AXScrollArea" || n.role === "AXTextArea").slice(0, 40).map((n) => {
    const value = n.value && isSensitiveValue(n.value) ? "[masked]" : (n.value || "").slice(0, 80);
    const frame = n.frame && win && img && img.w > 0 ? imageFrame(n.frame, win, img) : "no-frame";
    return `${n.role} ${JSON.stringify(n.name)} value=${JSON.stringify(value)} ${frame}`;
  });
  const head = img ? `image ${img.w}x${img.h} pixels. frames are screenshot pixels, origin top-left.` : "no screenshot yet.";
  return [head, ...lines].join("\n");
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; png?: Buffer; error?: boolean }> {
  if (name === "screenshot") {
    const app = appOf(args.app);
    const bundle = await ensure(app);
    await guardTextEdit(app, bundle);
    const seen = await executor(bundle).observe(origin({ tool: name, app: args.app }));
    const size = remember(app, seen.png);
    await saveShot(seen.png);
    return { text: `screenshot ${args.app} ${size.w}x${size.h} pixels. click x and y are pixels in this image, origin top-left.`, png: seen.png };
  }
  if (name === "read_tree") {
    const app = appOf(args.app);
    const bundle = await ensure(app);
    const panel = await guardTextEdit(app, bundle);
    const ex = executor(bundle);
    const seen = await ex.observe(origin({ tool: name, app: args.app }));
    const size = remember(app, seen.png);
    await saveShot(seen.png);
    if (panel === "open") {
      return { text: "Open panel. Click the New Document button. Frames of other rows are omitted.", png: seen.png };
    }
    const nodes = (await helper.nodes(bundle)).nodes ?? [];
    const win = mainWindow(await helper.windows(bundle));
    return { text: summary(nodes, win, size) || "(no accessibility nodes)", png: seen.png };
  }
  if (name === "click") {
    const app = appOf(args.app);
    const bundle = await ensure(app);
    await guardTextEdit(app, bundle);
    const x = Number(args.x);
    const y = Number(args.y);
    const img = lastImage[app];
    const win = mainWindow(await helper.windows(bundle));
    if (!img || !win || !(x >= 0 && y >= 0 && x < img.w && y < img.h)) {
      trail.append({
        kind: "act", op: "osClick", source, raw: { tool: name, app: args.app, x, y },
        unresolved: { reason: img ? "click is outside the screenshot" : "screenshot required before click" },
        provenance: { x, y, space: "screen" },
      });
      const why = img ? `outside the ${img.w}x${img.h} screenshot` : "call screenshot first";
      return { text: `refused: ${why}. click x and y are pixels in the window image.`, error: true };
    }
    const sx = win.x + (x / img.w) * win.w;
    const sy = win.y + (y / img.h) * win.h;
    const acted = await executor(bundle).act({ op: "click", x: sx, y: sy, button: "left" }, origin({ tool: name, app: args.app, x, y, sx, sy }));
    const image = await windowShot(bundle);
    remember(app, image);
    return { text: acted.unresolved ? `unresolved: ${acted.reason}` : "pressed", png: image, error: acted.unresolved };
  }
  if (name === "type") {
    const app = appOf(args.app);
    const bundle = await ensure(app);
    await guardTextEdit(app, bundle);
    const text = String(args.text ?? "");
    const acted = await executor(bundle).act({ op: "type", text }, origin({ tool: name, app: args.app, text: isSensitiveValue(text) ? "[masked]" : text }));
    const image = await windowShot(bundle);
    remember(app, image);
    return { text: acted.unresolved ? `unresolved: ${acted.reason}` : "typed", png: image, error: acted.unresolved };
  }
  if (name === "key") {
    const app = appOf(args.app);
    const bundle = await ensure(app);
    await guardTextEdit(app, bundle);
    const combo = String(args.combo ?? "");
    const acted = await executor(bundle).act({ op: "keypress", keys: combo.split("+").map((s) => s.trim()).filter(Boolean) }, origin({ tool: name, app: args.app, combo }));
    const image = await windowShot(bundle);
    remember(app, image);
    return { text: acted.unresolved ? `unresolved: ${acted.reason}` : `key ${combo}`, png: image, error: acted.unresolved };
  }
  return { text: `unknown tool ${name}`, error: true };
}

function contentOf(result: { text: string; png?: Buffer }): unknown[] {
  const out: unknown[] = [{ type: "text", text: result.text }];
  if (result.png && result.png.length > 0) {
    out.push({ type: "image", data: result.png.toString("base64"), mimeType: "image/png" });
  }
  return out;
}

async function handle(msg: { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } }): Promise<void> {
  const method = msg.method || "";
  log(`method ${method} id=${msg.id == null ? "-" : String(msg.id)}`);
  if (msg.id == null) return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bao", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(String(msg.params?.name), msg.params?.arguments ?? {});
      await saveTrail();
      send({ jsonrpc: "2.0", id: msg.id, result: { content: contentOf(result), isError: result.error || undefined } });
    } catch (err) {
      await saveTrail();
      const text = err instanceof Error ? err.message : String(err);
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: true } });
    }
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${method}` } });
}

function drain(): void {
  while (buffer.length > 0) {
    const text = buffer.toString("utf8");
    if (text.startsWith("{") || text.startsWith("\n") || text.startsWith("\r")) {
      const nl = buffer.indexOf(0x0a);
      if (nl < 0) return;
      const line = buffer.subarray(0, nl).toString("utf8").trim();
      buffer = buffer.subarray(nl + 1);
      if (!line) continue;
      void handle(JSON.parse(line) as { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } }).catch((err) => log(String(err)));
      continue;
    }
    lineFraming = false;
    const sep = text.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(text.slice(0, sep));
    if (!match) {
      log("mcp framing missing Content-Length");
      buffer = Buffer.alloc(0);
      return;
    }
    const len = Number(match[1]);
    const start = Buffer.byteLength(text.slice(0, sep + 4));
    if (buffer.length < start + len) return;
    const body = buffer.subarray(start, start + len).toString("utf8");
    buffer = buffer.subarray(start + len);
    void handle(JSON.parse(body) as { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } }).catch((err) => log(String(err)));
  }
}

async function main(): Promise<void> {
  await mkdir(work, { recursive: true });
  if (shotDir) await mkdir(shotDir, { recursive: true });
  if (ownedPath) {
    try { Object.assign(owned, JSON.parse(await readFile(ownedPath, "utf8")) as Record<string, number>); } catch { /* new run */ }
  }
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  log("bao mcp ready");
}

main().catch((err) => {
  log(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
