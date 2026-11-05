import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import * as sockets from "../../src/cdp-live/socket";
import { launchOwnedChromeEndpoint, pidsForDataDir, pinTestBrowser } from "../../src/launch";

pinTestBrowser();

for (const mode of ["close", "disconnect", "process-exit", "startup-failure"] as const) {
  test(`endpoint-only launch releases its owned Chrome after ${mode}`, { timeout: 20_000 }, async (t) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-endpoint-"));
    const connect = sockets.connectCdp;
    let cdp: sockets.CdpSocket | undefined;
    const methods: string[] = [];
    t.mock.method(chromium, "connectOverCDP", () => { throw new Error("must not initialize Playwright"); });
    t.mock.method(sockets, "connectCdp", async (...args: Parameters<typeof connect>) => {
      cdp = await connect(...args);
      const send = cdp.send.bind(cdp);
      t.mock.method(cdp, "send", (method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number) => {
        methods.push(method);
        if (mode === "startup-failure" && method === "Target.setDiscoverTargets") return Promise.reject(new Error("discovery failed"));
        return send(method, params, sessionId, timeoutMs);
      });
      return cdp;
    });
    let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
    try {
      const launching = launchOwnedChromeEndpoint({ userDataDir, headless: true });
      if (mode === "startup-failure") {
        await assert.rejects(launching, /discovery failed/);
      } else {
        chrome = await launching;
        assert.ok(cdp);
        assert.deepEqual(methods, ["Target.setDiscoverTargets"]);
        assert.ok(pidsForDataDir(userDataDir).length > 0);
        if (mode === "disconnect") cdp.close();
        else if (mode === "process-exit") {
          for (const pid of pidsForDataDir(userDataDir)) {
            try { process.kill(pid, "SIGTERM"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
        } else {
          const closing = chrome.close();
          assert.equal(chrome.close(), closing);
          await closing;
        }
        await chrome.closed;
        await chrome.close();
      }
      assert.deepEqual(pidsForDataDir(userDataDir), []);
      assert.equal(cdp?.isOpen, false);
      assert.ok(methods.every(method => method === "Target.setDiscoverTargets" || method === "Browser.close"));
    } finally {
      await chrome?.close();
      cdp?.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
}
