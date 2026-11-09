import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as net from "node:net";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { CdpSocket, connectCdp } from "../../src/cdp-live/socket";
import { launchOwnedChromeEndpoint, pinTestBrowser, pidsForDataDir } from "../../src/launch";
import { trapPort } from "../support/trap-port";

pinTestBrowser();

test("owned Chrome publishes its own nonzero debugging endpoint, replacing a stale file", { timeout: 30_000 }, async (t) => {
  const sent: string[] = [];
  const send = CdpSocket.prototype.send;
  t.mock.method(CdpSocket.prototype, "send", function (this: CdpSocket, ...args: Parameters<typeof send>) {
    sent.push(args[0]);
    return send.apply(this, args);
  });
  const root = await mkdtemp(path.join(tmpdir(), "bao-startup-marker-"));
  const portFile = path.join(root, "DevToolsActivePort");
  const stalePort = await trapPort();
  await writeFile(portFile, `${stalePort}\n/devtools/browser/stale\n`);
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: root, headless: true });
  try {
    assert.equal(chrome.portFile, portFile);
    assert.deepEqual(sent, ["Target.setDiscoverTargets"], "Bao startup must not enable renderer domains or inject scripts");
    const endpoint = await readDevToolsActivePort(portFile);
    assert.notEqual(endpoint.port, stalePort);
    assert.notEqual(endpoint.browserPath, "/devtools/browser/stale");
    const pid = pidsForDataDir(root)[0]!;
    const { execFileSync } = await import("node:child_process");
    const argv = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    assert.ok(argv.includes(`--remote-debugging-port=${endpoint.port}`), argv);
    assert.ok(!argv.includes("--remote-debugging-port=0"), argv);
    assert.ok(!argv.includes("--enable-automation"), argv);
    assert.ok(!argv.includes("AutomationControlled"), argv);
    assert.equal((await readFile(portFile, "utf8")).trim(), `${endpoint.port}\n${endpoint.browserPath}`);
  } finally {
    await chrome.close();
    assert.deepEqual(pidsForDataDir(root), []);
    await rm(root, { recursive: true, force: true });
  }
});

test("a debugging-port bind race fails without connecting to the other listener", { timeout: 25_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-startup-port-race-"));
  let requests = 0;
  const listener = createServer((_request, response) => { requests++; response.end("not our Chrome"); });
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as net.AddressInfo;
  try {
    // Force allocation to lose the bind race. The other listener must never receive a CDP request.
    const sockets = require("node:net") as typeof net;
    t.mock.method(sockets, "createServer", () => ({
      once() { return this; },
      listen(_port: number, _host: string, ready: () => void) { ready(); },
      address() { return address; },
      close(done: () => void) { done(); },
    } as unknown as net.Server));
    await assert.rejects(launchOwnedChromeEndpoint({ userDataDir: root, headless: true }), /debugging port did not open|Chrome exited/);
    assert.equal(requests, 0);
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const deadline = Date.now() + 3000;
    while (pidsForDataDir(root).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(pidsForDataDir(root), []);
    await rm(root, { recursive: true, force: true });
  }
});

test("headed owned Chrome keeps navigator.webdriver false before and after a Runtime attach", {
  skip: process.env.BAO_LANE === "live" || process.env.BAO_LIVE_TESTS === "1"
    ? process.platform !== "darwin" && !process.env.DISPLAY
    : "a headed browser belongs in the live lane",
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-headed-marker-"));
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: root, headless: false });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  try {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
    const target = targetInfos.find(info => info.type === "page")!;
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const webdriver = async () => {
      const { result } = await cdp.send<{ result: { value: boolean } }>("Runtime.evaluate", {
        expression: "navigator.webdriver", returnByValue: true,
      }, sessionId);
      return result.value;
    };
    assert.equal(await webdriver(), false, "browser-level startup must not set the marker");
    await cdp.send("Runtime.enable", {}, sessionId);
    assert.equal(await webdriver(), false, "native page-domain startup must not set the marker");
  } finally {
    cdp.close();
    await chrome.close();
    await rm(root, { recursive: true, force: true });
  }
});
