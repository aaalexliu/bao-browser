import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { inflateSync } from "node:zlib";
import { keepBehind, openBackgroundCdp } from "../../src/engines/background-cdp";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";
import { scaledMs } from "../runtime";

pinTestBrowser();

test("agent commands that would bring Bao's Chrome forward are answered in place or opened in the background", () => {
  assert.deepEqual(keepBehind({ id: 1, method: "Page.bringToFront", sessionId: "S" }), { reply: {} });
  assert.deepEqual(keepBehind({ id: 2, method: "Target.activateTarget", params: { targetId: "T" } }), { reply: {} });
  assert.deepEqual(keepBehind({ id: 3, method: "Target.createTarget", params: { url: "https://example.test/" } }),
    { forward: { id: 3, method: "Target.createTarget", params: { url: "https://example.test/", background: true } } });
  const navigate = { id: 4, method: "Page.navigate", params: { url: "https://example.test/" }, sessionId: "S" };
  assert.deepEqual(keepBehind(navigate), { forward: navigate });
});

test("a refused Chrome debugging connection is retried before the agent gets a gateway error", { timeout: scaledMs(5_000) }, async () => {
  const chrome = net.createServer();
  let attempts = 0;
  chrome.on("connection", (socket) => {
    attempts += 1;
    if (attempts === 1) {
      socket.destroy();
      return;
    }
    socket.once("data", () => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
  });
  await new Promise<void>((resolve) => chrome.listen(0, "127.0.0.1", resolve));
  const port = (chrome.address() as net.AddressInfo).port;
  const background = await openBackgroundCdp({ port, browserPath: "/devtools/browser/retry" });
  const socket = new WebSocket(`ws://127.0.0.1:${background.endpoint.port}${background.endpoint.browserPath}`);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("agent connection failed")), { once: true });
    });
    assert.equal(attempts, 2);
  } finally {
    socket.close();
    background.close();
    await new Promise<void>((resolve) => chrome.close(() => resolve()));
  }
});

test("the agent's endpoint keeps Chrome behind, gives each page focus, and hides Bao's own replies", { timeout: scaledMs(60_000) }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-background-cdp-"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, background: "window" });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const background = await openBackgroundCdp(endpoint);
  const direct = await connectCdp(endpoint.port, endpoint.browserPath);
  const socket = new WebSocket(`ws://127.0.0.1:${background.endpoint.port}${background.endpoint.browserPath}`);
  const received: { id?: number; result?: Record<string, unknown>; error?: unknown }[] = [];
  const waiting = new Map<number, (message: { result?: Record<string, unknown>; error?: unknown }) => void>();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
    received.push(message);
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const next = ++id;
    waiting.set(next, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result!));
    socket.send(JSON.stringify({ id: next, method, params, ...sessionId ? { sessionId } : {} }));
  });
  try {
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const { targetInfos } = await send("Target.getTargets") as { targetInfos: { targetId: string; type: string }[] };
    const pages = targetInfos.filter((target) => target.type === "page");
    assert.equal(pages.length, 1, "a background launch opens Bao's one window");
    const first = pages[0]!.targetId;
    const { sessionId } = await send("Target.attachToTarget", { targetId: first, flatten: true }) as { sessionId: string };
    const { sessionId: own } = await direct.send<{ sessionId: string }>("Target.attachToTarget", { targetId: first, flatten: true });
    assert.deepEqual(await direct.send("Runtime.evaluate", { expression: "document.hasFocus()", returnByValue: true }, own),
      { result: { type: "boolean", value: false } }, "a background window's page has no focus of its own");
    assert.deepEqual(await send("Runtime.evaluate", { expression: "document.hasFocus()", returnByValue: true }, sessionId),
      { result: { type: "boolean", value: true } }, "the page acts as if its window had focus");
    assert.deepEqual(await send("Page.bringToFront", {}, sessionId), {});
    assert.deepEqual(await send("Target.activateTarget", { targetId: first }), {});
    const { targetId: second } = await send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
    const windowOf = async (targetId: string) => (await direct.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId })).windowId;
    assert.equal(await windowOf(second), await windowOf(first), "a new tab opens in the background of Bao's window");
    const { sessionId: next } = await send("Target.attachToTarget", { targetId: second, flatten: true }) as { sessionId: string };
    assert.deepEqual(await send("Runtime.evaluate", { expression: "[document.visibilityState, document.hasFocus()]", returnByValue: true }, next),
      { result: { type: "object", value: ["visible", true] } }, "focus emulation keeps the background tab visible and focused");
    for (const route of ["/json/list", "/json/version", `/json/activate/${first}`]) {
      assert.equal((await fetch(`http://127.0.0.1:${background.endpoint.port}${route}`)).status, 404, `${route} would raise a tab or hand out Chrome's own port`);
    }
    assert.ok(received.every((message) => message.id === undefined || message.id <= id), "Bao's own replies never reach the agent");
  } finally {
    socket.close();
    direct.close();
    background.close();
    await chrome.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Chrome's screenshot PNG. A blank or white stand-in would not be this red. */
function pngPixel(png: Buffer, x: number, y: number): [number, number, number] {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(bpp > 0 && x < width && y < height, `png ${width}x${height} color ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rows: Buffer[] = [];
  let pos = 0;
  for (let row = 0; row < height; row++) {
    const filter = raw[pos++]!;
    const scan = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    const up = rows[row - 1];
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? scan[i - bpp]! : 0;
      const above = up?.[i] ?? 0;
      const upperLeft = up && i >= bpp ? up[i - bpp]! : 0;
      if (filter === 1) scan[i] = (scan[i]! + left) & 255;
      else if (filter === 2) scan[i] = (scan[i]! + above) & 255;
      else if (filter === 3) scan[i] = (scan[i]! + Math.floor((left + above) / 2)) & 255;
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - above);
        const pc = Math.abs(p - upperLeft);
        scan[i] = (scan[i]! + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 255;
      } else if (filter !== 0) throw new Error(`png filter ${filter}`);
    }
    rows.push(scan);
  }
  const i = x * bpp;
  return [rows[y]![i]!, rows[y]![i + 1]!, rows[y]![i + 2]!];
}

test("a swallowed tab switch drives an unselected tab and does not forward the raising commands", { timeout: scaledMs(60_000) }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-background-tab-"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "chrome"), headless: true, background: "window" });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const background = await openBackgroundCdp(endpoint);
  const direct = await connectCdp(endpoint.port, endpoint.browserPath);
  const socket = new WebSocket(`ws://127.0.0.1:${background.endpoint.port}${background.endpoint.browserPath}`);
  const received: { id?: number; result?: Record<string, unknown> }[] = [];
  const waiting = new Map<number, (message: { result?: Record<string, unknown>; error?: unknown }) => void>();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
    received.push(message);
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const next = ++id;
    waiting.set(next, (message) => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result!));
    socket.send(JSON.stringify({ id: next, method, params, ...sessionId ? { sessionId } : {} }));
  });
  const read = async <T>(targetId: string, expression: string, timeout = 5_000): Promise<T> => {
    const { sessionId } = await direct.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const result = await direct.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId, timeout);
    await direct.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    return result.result.value;
  };
  const visibility = (targetId: string) => read<string>(targetId, "document.visibilityState");
  const ticks = (targetId: string) => read<number>(targetId, "new Promise(r=>{const a=n;setTimeout(()=>r(n-a),1000)})", 5_000);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("agent socket failed")), { once: true });
    });
    const page = "data:text/html," + encodeURIComponent(
      "<body style=\"margin:0;background:#c81414\"><button data-testid=go style=\"position:absolute;left:20px;top:20px;width:120px;height:40px\">Go</button><input data-testid=field style=\"position:absolute;left:20px;top:80px;width:200px;height:30px\"><script>let n=0;setInterval(()=>n++,16);document.querySelector('[data-testid=go]').addEventListener('click',()=>{document.querySelector('[data-testid=go]').textContent='Done'})</script>",
    );
    const { targetId: hidden } = await direct.send<{ targetId: string }>("Target.createTarget", { url: page, background: true });
    const ready = Date.now() + 5_000;
    let button = false;
    while (!button && Date.now() < ready) {
      try {
        const { sessionId } = await direct.send<{ sessionId: string }>("Target.attachToTarget", { targetId: hidden, flatten: true });
        const read = await direct.send<{ result: { value: boolean } }>("Runtime.evaluate", {
          expression: "!!document.querySelector('[data-testid=go]')", returnByValue: true,
        }, sessionId);
        button = read.result.value;
        await direct.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      } catch { /* the renderer is still starting */ }
      if (!button) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(button, true, "the restored tab painted its button");
    assert.equal(await visibility(hidden), "hidden", "the restored tab is not the selected tab");
    const { sessionId } = await send("Target.attachToTarget", { targetId: hidden, flatten: true }) as { sessionId: string };
    assert.equal(await visibility(hidden), "hidden", "attaching does not select the tab");
    const before = await ticks(hidden);
    assert.ok(before <= 25, `an unselected tab is throttled, got ${before} ticks`);
    assert.deepEqual(await send("Page.bringToFront", {}, sessionId), {});
    assert.equal(received.filter((message) => message.id === id).length, 1, "bringToFront is answered once, not forwarded");
    assert.deepEqual(await send("Target.activateTarget", { targetId: hidden }), {});
    assert.equal(received.filter((message) => message.id === id).length, 1, "activateTarget is answered once, not forwarded");
    const after = await ticks(hidden);
    assert.ok(after <= 25, `the switch did not select the tab, got ${after} ticks`);
    await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
    const box = await send("Runtime.evaluate", {
      expression: "(() => { const el = document.querySelector('[data-testid=go]'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()",
      returnByValue: true,
    }, sessionId) as { result: { value: { x: number; y: number; w: number } } };
    assert.ok(box.result.value.w > 0, "the button has a box");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.result.value.x, y: box.result.value.y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.result.value.x, y: box.result.value.y, button: "left", clickCount: 1 }, sessionId);
    const label = await send("Runtime.evaluate", { expression: "document.querySelector('[data-testid=go]').textContent", returnByValue: true }, sessionId) as { result: { value: string } };
    assert.equal(label.result.value, "Done", "a click lands in the unselected tab");
    const field = await send("Runtime.evaluate", {
      expression: "(() => { const el = document.querySelector('[data-testid=field]'); const r = el.getBoundingClientRect(); return { x: r.x + 8, y: r.y + r.height / 2 }; })()",
      returnByValue: true,
    }, sessionId) as { result: { value: { x: number; y: number } } };
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: field.result.value.x, y: field.result.value.y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: field.result.value.x, y: field.result.value.y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a", unmodifiedText: "a" }, sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a" }, sessionId);
    const typed = await send("Runtime.evaluate", { expression: "document.querySelector('[data-testid=field]').value", returnByValue: true }, sessionId) as { result: { value: string } };
    assert.equal(typed.result.value, "a", "typing lands in the unselected tab");
    const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId) as { data: string };
    const pixel = pngPixel(Buffer.from(shot.data, "base64"), 400, 300);
    assert.ok(pixel[0] > 160 && pixel[1] < 60 && pixel[2] < 60, `the screenshot shows the page, got ${pixel.join(",")}`);
    const still = await ticks(hidden);
    assert.ok(still <= 25, `click, typing, and the screenshot leave the tab unselected, got ${still} ticks`);
  } finally {
    socket.close();
    direct.close();
    background.close();
    await chrome.close();
    await rm(root, { recursive: true, force: true });
  }
});
