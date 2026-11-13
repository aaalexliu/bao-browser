import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { StepRecordStore } from "../../src/engines/step-record";
import { assertDevtoolsHar, CdpNetworkCapture, type DevtoolsHarEntry } from "../../src/proxy/cdp-network";
import { testChromium } from "../../src/test-browser";

test("CDP network capture records owned-tab traffic and skips every other tab", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-cdp-network-"));
  const userData = await mkdtemp(path.join(tmpdir(), "bao-cdp-chrome-"));
  const upload = path.join(root, "statement.pdf");
  await writeFile(upload, Buffer.from("pdf-bytes"));
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/json")) {
      const body = Buffer.from("{\"ok\":true,\"n\":1}");
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "session=fixture-response; Path=/; HttpOnly" });
      response.end(body);
      return;
    }
    if (url.startsWith("/redirect")) {
      response.writeHead(302, { location: "/json" });
      response.end();
      return;
    }
    if (url.startsWith("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write("event: ready\ndata: hello\n\n");
      return;
    }
    if (url.startsWith("/upload")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("stored");
      return;
    }
    if (url.startsWith("/ws")) {
      acceptSocket(request, response);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>fixture</title>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(testChromium.executablePath(), [
    "--headless=new", `--user-data-dir=${userData}`, "--remote-debugging-port=0", "--no-first-run",
    "--disable-gpu", "--disable-background-networking", "--disable-sync", "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore" });
  let cdp: CdpSocket | undefined;
  try {
    const endpoint = await readPort(userData);
    cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 5000 });
    const store = new StepRecordStore(root, "run-fixture");
    const capture = new CdpNetworkCapture(cdp, false, (bytes) => store.putBody(bytes));
    await capture.start();
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    await capture.own(targetId);
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 5000);
    capture.setStep("command-1");
    const started = Date.now();
    await cdp.send("Page.navigate", { url: `${base}/page` }, sessionId, 5000);
    await evaluate(cdp, sessionId, "document.readyState");
    await cdp.send("Network.setCookie", { name: "session", value: "fixture-request", url: base }, sessionId, 5000);
    await evaluate(cdp, sessionId, `fetch(${JSON.stringify(`${base}/json?code=482731`)}, { headers: { "x-api-key": "fixture-request-key" } }).then((response) => response.text())`);
    await evaluate(cdp, sessionId, `fetch(${JSON.stringify(`${base}/json`)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "October" }) }).then((response) => response.text())`);
    await evaluate(cdp, sessionId, `fetch(${JSON.stringify(`${base}/redirect`)}).then((response) => response.text())`);
    await evaluate(cdp, sessionId, `fetch("http://127.0.0.1:1/fail").catch(() => "failed")`);
    await cdp.send("Network.setBlockedURLs", { urls: ["*blocked*"] }, sessionId, 5000);
    await evaluate(cdp, sessionId, `fetch(${JSON.stringify(`${base}/blocked`)}).catch(() => "blocked")`);
    await evaluate(cdp, sessionId, `new Promise((resolve) => { const source = new EventSource(${JSON.stringify(`${base}/events`)}); source.addEventListener("ready", () => resolve("ready")); setTimeout(resolve, 1000); })`);
    await evaluate(cdp, sessionId, `new Promise((resolve) => { const socket = new WebSocket(${JSON.stringify(`${base.replace("http", "ws")}/ws`)}); socket.onmessage = () => resolve("message"); socket.onerror = () => resolve("error"); setTimeout(resolve, 1000); })`);
    capture.noteFiles([upload]);
    const file = await readFile(upload);
    await evaluate(cdp, sessionId, `(() => { const data = new FormData(); data.append("note", "October"); data.append("file", new File([Uint8Array.from(${JSON.stringify([...file])})], "statement.pdf", { type: "application/pdf" })); return fetch(${JSON.stringify(`${base}/upload`)}, { method: "POST", body: data }).then((response) => response.text()); })()`);
    const { targetId: other } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: `${base}/other` });
    assert.notEqual(other, targetId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const takeStarted = Date.now();
    const entries = await capture.take("command-1");
    const takeMs = Date.now() - takeStarted;
    const sealMs = Date.now() - started;
    await store.writeStep({
      schema: "bao.step-record/v1", id: "command-1", command: "open", args: [`${base}/page`], status: "passed",
      startedAt: started, endedAt: Date.now(), waits: [{ for: "open", ms: sealMs }], network: { entries },
    });
    await store.writeHar(capture.allEntries());
    await capture.stop();
    cdp.close();
    cdp = undefined;

    const urls = entries.map((item) => item.request.url);
    assert.equal(urls.some((url) => url.includes("/other")), false, "an unowned tab is not recorded");
    const json = entries.find((item) => item.request.url.includes("/json?code=482731"));
    assert.ok(json);
    assert.equal(json.response.status, 200);
    assert.ok(json.request.cookies.some((cookie) => cookie.name === "session" && cookie.value === "fixture-request"));
    assert.ok(json.response.cookies.some((cookie) => cookie.name === "session" && cookie.value === "fixture-response"));
    assert.ok(json.request.headers.some((header) => header.name.toLowerCase() === "x-api-key" && header.value === "fixture-request-key"));
    assert.equal(typeof json._initiator, "object");
    assert.ok(json._responseBody);
    const posted = entries.find((item) => item.request.method === "POST" && item.request.url.endsWith("/json"));
    assert.ok(posted?._requestBody);
    assert.equal(posted.request.postData?.text, undefined, "the step record keeps the hash, not a second copy of the body");
    const redirect = entries.find((item) => item.request.url.includes("/redirect"));
    assert.equal(redirect?.response.status, 302);
    assert.match(redirect?.response.redirectURL ?? "", /\/json$/);
    const failed = entries.find((item) => item.request.url.includes(":1/fail"));
    assert.ok(failed?._error);
    const blocked = entries.find((item) => item.request.url.includes("/blocked"));
    assert.ok(blocked?._blocked || blocked?._error);
    const socket = entries.find((item) => item.request.url.includes("/ws"));
    assert.ok(socket?._webSocketMessages?.some((message) => message.data.includes("hello")));
    const events = entries.find((item) => item.request.url.includes("/events"));
    assert.ok(events?._eventSourceMessages?.some((message) => message.data === "hello"));
    const uploaded = entries.find((item) => item.request.url.includes("/upload"));
    assert.equal(uploaded?._fileParts?.[0]?.path, upload);
    assert.equal(uploaded?._fileParts?.[0]?.sha256, createHash("sha256").update(file).digest("hex"));
    const bodies = await readdir(path.join(root, "runs", "run-fixture", "bodies"));
    assert.equal(bodies.includes(uploaded!._fileParts![0]!.sha256), false, "a file part is named, not copied");
    const jsonBodies = entries.filter((item) => item._responseBody && item.request.url.includes("/json"));
    assert.equal(new Set(jsonBodies.map((item) => item._responseBody)).size, 1, "identical JSON is stored once");

    const har = JSON.parse(await readFile(path.join(root, "runs", "run-fixture", "run.har"), "utf8")) as { log: { entries: DevtoolsHarEntry[] } };
    assertDevtoolsHar(har);
    const inlined = har.log.entries.find((item) => item.request.url.includes("/json?code=482731"));
    assert.equal(inlined?.response.content.text, "{\"ok\":true,\"n\":1}");
    const stepFile = path.join(root, "runs", "run-fixture", "steps");
    const bodyBytes = (await Promise.all(bodies.map((name) => stat(path.join(root, "runs", "run-fixture", "bodies", name))))).reduce((sum, item) => sum + item.size, 0);
    const stepBytes = (await stat(path.join(stepFile, "command-1.json.gz"))).size;
    console.log(JSON.stringify({ takeMs, sealMs, stepBytes, bodyBytes, harBytes: (await stat(path.join(root, "runs", "run-fixture", "run.har"))).size, entries: entries.length }));
  } finally {
    cdp?.close();
    chrome.kill();
    await once(chrome, "exit").catch(() => undefined);
    server.close();
    await rm(userData, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function readPort(userData: string) {
  const file = path.join(userData, "DevToolsActivePort");
  const deadline = Date.now() + 5000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { return parseDevToolsActivePort(await readFile(file, "utf8")); }
    catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw last instanceof Error ? last : new Error("Chrome did not write DevToolsActivePort");
}

async function evaluate(cdp: CdpSocket, sessionId: string, expression: string): Promise<void> {
  const result = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string } }>(
    "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, 5000,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "page evaluate failed");
}

function acceptSocket(request: IncomingMessage, response: ServerResponse): void {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    response.writeHead(400);
    response.end();
    return;
  }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  const socket = request.socket;
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  const payload = Buffer.from("hello");
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
}
