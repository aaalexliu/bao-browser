import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { keepBehind, openBackgroundCdp } from "../../src/engines/background-cdp";
import { launchOwnedChromeEndpoint, pinTestBrowser } from "../../src/launch";

pinTestBrowser();

test("agent commands that would bring Bao's Chrome forward are answered in place or opened in the background", () => {
  assert.deepEqual(keepBehind({ id: 1, method: "Page.bringToFront", sessionId: "S" }), { reply: {} });
  assert.deepEqual(keepBehind({ id: 2, method: "Target.activateTarget", params: { targetId: "T" } }), { reply: {} });
  assert.deepEqual(keepBehind({ id: 3, method: "Target.createTarget", params: { url: "https://example.test/" } }),
    { forward: { id: 3, method: "Target.createTarget", params: { url: "https://example.test/", background: true } } });
  const navigate = { id: 4, method: "Page.navigate", params: { url: "https://example.test/" }, sessionId: "S" };
  assert.deepEqual(keepBehind(navigate), { forward: navigate });
});

test("a refused Chrome debugging connection is retried before the agent gets a gateway error", async () => {
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

test("the agent's endpoint keeps Chrome behind, gives each page focus, and hides Bao's own replies", { timeout: 60_000 }, async () => {
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
