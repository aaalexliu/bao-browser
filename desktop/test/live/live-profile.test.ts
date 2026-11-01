// The pinned test Chromium on a temp profile stands in for the daily Chrome.
// It is headed because a headless Chrome does not take a second process's
// command line. BaoOSHelper is a fake. This never opens the installed Chrome.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { connectCdp } from "../../src/cdp-live/socket";
import { pinTestBrowser } from "../../src/launch";
import { TEST_MEDIA_ARGS } from "../../src/test-browser.js";
import { assertNotDailyChrome } from "../../src/profile";
import { fakeChromeHelper } from "../fake-helper";

async function waitForPort(file: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(file) && /^\d+\n\/devtools\/browser\//.test(readFileSync(file, "utf8"))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("DevToolsActivePort was not written");
}

test("the daily target opens its window in the Default profile when another profile was used last", { skip: process.env.BAO_LIVE_TESTS !== "1", timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-live-profile-"));
  const userData = path.join(root, "chrome");
  assertNotDailyChrome(userData);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Shop</title><button type='button'>Add to cart</button>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server port missing");
  const origin = `http://127.0.0.1:${address.port}`;
  let chrome: ChildProcess | undefined;
  const host = createLiveHost({
    home: root,
    lockFile: path.join(root, "lock"),
    target: { kind: "daily", portFile: path.join(userData, "DevToolsActivePort"), profile: "Default" },
    helper: () => fakeChromeHelper().helper,
  });
  try {
    chrome = spawn(pinTestBrowser(), [
      `--user-data-dir=${userData}`,
      "--remote-debugging-port=0",
      ...TEST_MEDIA_ARGS,
      "--profile-directory=Profile 1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--use-mock-keychain",
      "--password-store=basic",
      "about:blank",
    ], { stdio: "ignore" });
    const portFile = path.join(userData, "DevToolsActivePort");
    await waitForPort(portFile);
    const endpoint = await readDevToolsActivePort(portFile);
    const side = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 10_000 });
    type Listed = { targetInfos?: { targetId?: string; type?: string; url?: string; browserContextId?: string }[] };
    const pages = async () => ((await side.send<Listed>("Target.getTargets")).targetInfos || []).filter((info) => info.type === "page");
    const first = (await pages())[0];
    assert.ok(first?.browserContextId);
    mkdirSync(path.join(userData, "Default"));

    const started = await host.call({ op: "live_session_start", intent: "Shop", url: `${origin}/shop` }) as { outcome?: { kind?: string } };
    assert.equal(started.outcome?.kind, "applied", JSON.stringify(started.outcome));
    const driven = (await pages()).filter((info) => (info.url || "").startsWith(origin));
    assert.equal(driven.length, 1);
    assert.notEqual(driven[0]?.browserContextId, first.browserContextId);
    const contexts = await side.send<{ defaultBrowserContextId?: string }>("Target.getBrowserContexts");
    assert.equal(contexts.defaultBrowserContextId, driven[0]?.browserContextId);
    side.close();
  } finally {
    await host.close().catch(() => undefined);
    if (chrome?.pid) {
      try { process.kill(chrome.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    spawnSync("pkill", ["-9", "-f", `user-data-dir=${userData}`]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
