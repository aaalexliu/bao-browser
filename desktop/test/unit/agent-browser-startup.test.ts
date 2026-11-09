import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as launches from "../../src/launch";
import { LIST_TARGETS } from "../support/fake-agent-browser";

launches.pinTestBrowser();

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;

test("a copy that restores many tabs opens a timer-heavy page in a new tab in front of them", { skip: !binary, timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-restored-start-"));
  const sourceRoot = path.join(root, "source");
  const loads: string[] = [];
  const held: import("node:http").ServerResponse[] = [];
  // The page requests its late bundle after a chain of timers, and an image that answers only once that bundle is requested
  // holds its load event. Chrome throttles timers in a hidden tab, so there the load misses the native deadline.
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    if (url.pathname === "/hold") { held.push(response); return; }
    if (url.pathname === "/loaded") { loads.push(url.searchParams.get("visibility")!); response.end(); return; }
    if (url.pathname === "/bundle.js") {
      for (const image of held.splice(0)) image.end();
      response.setHeader("Content-Type", "text/javascript");
      response.end("");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(url.pathname === "/app" ? `<!doctype html><title>App</title><script>
      addEventListener('load', () => fetch('/loaded?visibility=' + document.visibilityState));
      let left = 40;
      const step = () => { if (--left) { setTimeout(step, 0); return; } const bundle = document.createElement('script'); bundle.src = '/bundle.js'; document.head.append(bundle); };
      setTimeout(step, 0);
    </script><img src="/hold" alt="">` : `<!doctype html><title>Restored ${url.pathname}</title>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const source = await launches.launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
  await source.pages()[0]!.goto(`${base}/restored/0`);
  for (let index = 1; index < 12; index++) await (await source.newPage()).goto(`${base}/restored/${index}`);
  await source.close();
  const proxy = new AgentBrowserProxy({ sourceRoot, home: path.join(root, "home"), executable: binary });
  try {
    const result = await proxy.execute("open", [`${base}/app`], "copy");
    assert.equal(result[0]!.exitCode, 0, result[0]!.stdout + result[0]!.stderr);
    assert.deepEqual(loads, ["visible"]);
    for (let index = 0; index < 12; index++) assert.ok(result[1]!.stdout.includes(`${base}/restored/${index}`), `restored tab ${index} stays open`);
  } finally {
    proxy.disconnect();
    await proxy.close();
    for (const image of held) image.end();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("pass-through open lists every restored tab even when an unrelated renderer never answers", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-stalled-start-"));
  const sourceRoot = path.join(root, "source");
  let block = false;
  let blockedRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    const blocked = block && request.url === "/blocked";
    if (blocked) blockedRequests++;
    response.end(`<!doctype html><title>${request.url}</title><h1>Local restored tab</h1>${blocked ? "<script>while (true) {}</script>" : ""}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const source = await launches.launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
  await source.pages()[0]!.goto(`${base}/blocked`);
  await (await source.newPage()).goto(`${base}/ready`);
  await source.close();
  const before = await readFile(path.join(sourceRoot, "Default", "Preferences"), "utf8");
  block = true;
  const launch = launches.launchOwnedChromeEndpoint;
  let copyDir = "";
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => {
    copyDir = options.userDataDir;
    assert.equal(options.headless, false, "product pass-through stays visible");
    assert.equal(options.loadExtensions, false);
    assert.equal(options.preserveRestoredTabs, true);
    return launch({ ...options, headless: true });
  });
  t.mock.method(chromium, "connectOverCDP", () => { throw new Error("pass-through must not attach Playwright"); });
  // A native CLI stand-in reads only Chrome's browser-level target inventory.
  // The real Chrome process and its stuck renderer are not mocked.
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
${LIST_TARGETS}
const args = process.argv.slice(2);
const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
const command = args[args.indexOf('--idle-timeout') + 2];
if (command === 'tab') {
  listTargets(endpoint.href).then(targets => {
    console.log(JSON.stringify({ data: { tabs: targets.filter(t => t.type === 'page').map(t => ({ targetId: t.id, url: t.url, active: t.url.endsWith('/ready') })) } }));
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else { console.log('native ' + command); }
`, { mode: 0o700 });
  const proxy = new AgentBrowserProxy({ sourceRoot, home: path.join(root, "home"),
    executable: process.env.AGENT_BROWSER_PROXY_BINARY || executable });
  try {
    const result = await proxy.execute("open", [`${base}/ready`], "copy");
    assert.equal(result[0]!.exitCode, 0, result[0]!.stderr);
    assert.equal(result[1]!.exitCode, 0, result[1]!.stderr);
    assert.ok(result[1]!.stdout.includes(`${base}/blocked`), "open returns the unrelated restored tab too");
    assert.ok(result[1]!.stdout.includes(`${base}/ready`));
    const [listed] = await proxy.execute("tab", ["list", "--json"]);
    const parsed = JSON.parse(listed!.stdout) as { data: { tabs: { url: string; targetId: string }[] } };
    const tabs = parsed.data.tabs;
    assert.equal(tabs.length, 3, "both restored tabs stay beside the agent's new tab");
    for (const url of [`${base}/blocked`, `${base}/ready`]) assert.ok(tabs.some(tab => tab.url === url), url);
    const deadline = Date.now() + 5000;
    while (blockedRequests === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(blockedRequests > 0, "the restored blocked renderer must have started");
    const endpoint = await readDevToolsActivePort(path.join(copyDir, "DevToolsActivePort"));
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    try {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: tabs.find(tab => tab.url === `${base}/blocked`)!.targetId, flatten: true,
      });
      await assert.rejects(cdp.send("Runtime.evaluate", { expression: "1 + 1" }, sessionId, 300), /cdp timeout/);
      const { targetInfos } = await cdp.send<{ targetInfos: { type: string }[] }>("Target.getTargets");
      assert.equal(targetInfos.filter(target => target.type === "page").length, 3);
    } finally { cdp.close(); }
    assert.equal(await readFile(path.join(sourceRoot, "Default", "Preferences"), "utf8"), before);
  } finally {
    proxy.disconnect();
    await proxy.close();
    if (copyDir) {
      assert.deepEqual(launches.pidsForDataDir(copyDir), []);
      await assert.rejects(access(copyDir), /ENOENT/);
      await rm(path.dirname(copyDir), { recursive: true, force: true });
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
