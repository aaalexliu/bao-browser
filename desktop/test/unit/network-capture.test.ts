import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { NetworkCapture } from "../../src/proxy/network";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { testChromium } from "../../src/test-browser";

test("HAR keeps cookie and credential headers from a local browser request and response", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("set-cookie", "session=fixture-response; Path=/");
    res.setHeader("x-api-key", "fixture-response-key");
    res.end("captured");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await testChromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ extraHTTPHeaders: {
      authorization: "Bearer fixture-auth",
      "x-api-key": "fixture-request-key",
    } });
    const url = `http://127.0.0.1:${address.port}/?code=482731`;
    await context.addCookies([{ name: "session", value: "fixture-request", url }]);
    const capture = new NetworkCapture(() => "event-1");
    capture.attach(context);
    const page = await context.newPage();
    const driver = new BrowserDriver(page);
    await page.goto(url);
    await page.evaluate(() => console.log("password=fixture-secret"));
    assert.ok(driver.trace().network.some((request) => request.url === url));
    assert.ok(driver.trace().console.some((line) => line.text === "password=fixture-secret"));
    await capture.flush();
    const entry = capture.har().log.entries.find((entry) => entry.request.url === url);
    assert.ok(entry);
    assert.equal(entry._auditEventId, "event-1");
    const headers = (rows: { name: string; value: string }[]) => Object.fromEntries(rows.map(({ name, value }) => [name.toLowerCase(), value]));
    const request = headers(entry.request.headers);
    assert.equal(request.authorization, "Bearer fixture-auth");
    assert.equal(request["x-api-key"], "fixture-request-key");
    assert.equal(request.cookie, "session=fixture-request");
    const response = headers(entry.response.headers);
    assert.equal(response["set-cookie"], "session=fixture-response; Path=/");
    assert.equal(response["x-api-key"], "fixture-response-key");
    assert.deepEqual(entry.request.queryString, [{ name: "code", value: "482731" }]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
