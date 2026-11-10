import assert from "node:assert/strict";
import childProcess, { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import * as sockets from "../../src/cdp-live/socket";
import { closeRetainedChrome, launchOwnedChromeEndpoint, pidsForDataDir, pinTestBrowser } from "../../src/launch";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { laneChildEnv } from "../runtime";

pinTestBrowser();

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
  test(`endpoint preserves a persistent cookie after process-group ${signal}`, { timeout: 30_000, skip: process.platform === "win32" }, async () => {
    const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === "darwin"
      ? path.join(homedir(), "Library", "Caches", "ms-playwright")
      : path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "ms-playwright"));
    const root = await mkdtemp(path.join(tmpdir(), "bao-group-cookie-"));
    const userDataDir = path.join(root, "profile");
    const env = laneChildEnv("hermetic", { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCache });
    env.HOME = root;
    env.BAO_HOME = path.join(root, "bao");
    const script = `
      const { launchOwnedChromeEndpoint } = require(${JSON.stringify(path.resolve("desktop/dist/desktop/src/launch.js"))});
      (async () => {
        const chrome = await launchOwnedChromeEndpoint({ userDataDir: ${JSON.stringify(userDataDir)}, headless: true, detached: true });
        let closing;
        for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
          process.on(signal, () => closing ??= chrome.close().then(() => process.exit(0), () => process.exit(1)));
        }
        process.send("ready");
      })().catch(() => process.exit(1));
    `;
    const worker = spawn(process.execPath, ["-e", script], { env, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(worker, "exit");
    let cdp: sockets.CdpSocket | undefined;
    let reopened: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
    try {
      await Promise.race([once(worker, "message"), exited.then(() => { throw new Error("launch worker exited before ready"); })]);
      const endpoint = await readDevToolsActivePort(path.join(userDataDir, "DevToolsActivePort"));
      cdp = await sockets.connectCdp(endpoint.port, endpoint.browserPath);
      await cdp.send("Storage.setCookies", { cookies: [{
        name: "group_shutdown_probe", value: "synthetic", domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600,
      }] });
      process.kill(-worker.pid!, signal);
      const [code, exitSignal] = await exited as [number | null, NodeJS.Signals | null];
      assert.equal(code, 0, "group shutdown must complete gracefully");
      assert.equal(exitSignal, null);
      assert.deepEqual(pidsForDataDir(userDataDir), []);
      cdp.close();
      reopened = await launchOwnedChromeEndpoint({ userDataDir, headless: true });
      const next = await readDevToolsActivePort(reopened.portFile);
      cdp = await sockets.connectCdp(next.port, next.browserPath);
      const result = await cdp.send("Storage.getCookies") as { cookies: Array<{ name: string; value: string }> };
      assert.ok(result.cookies.some((cookie) => cookie.name === "group_shutdown_probe" && cookie.value === "synthetic"), "persistent cookie must survive a group signal and relaunch");
    } finally {
      if (cdp?.isOpen) await cdp.send("Browser.close", {}, undefined, 3000).catch(() => undefined);
      cdp?.close();
      await reopened?.close();
      if (worker.exitCode == null && worker.signalCode == null) {
        worker.kill("SIGKILL");
        await exited;
      }
      const deadline = Date.now() + 5000;
      while (pidsForDataDir(userDataDir).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(pidsForDataDir(userDataDir), [], "test must leave no owned Chrome processes");
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("startup keeps its original error when graceful cleanup times out", { timeout: 15_000 }, async (t) => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-startup-error-"));
  const startupError = new Error("discovery rejected during startup");
  const connect = sockets.connectCdp;
  const kill = process.kill.bind(process);
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const killMock = t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      signals.push(signal);
      return true;
    }
    return kill(pid, signal);
  });
  const childKillMock = t.mock.method(ChildProcess.prototype, "kill", (signal?: NodeJS.Signals | number) => {
    signals.push(signal);
    return true;
  });
  t.mock.method(sockets, "connectCdp", async (...args: Parameters<typeof connect>) => {
    const cdp = await connect(...args);
    const send = cdp.send.bind(cdp);
    t.mock.method(cdp, "send", (method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number) => {
      if (method === "Target.setDiscoverTargets") return Promise.reject(startupError);
      if (method === "Browser.close") return Promise.reject(new Error("shutdown request failed"));
      return send(method, params, sessionId, timeoutMs);
    });
    return cdp;
  });
  try {
    await assert.rejects(launchOwnedChromeEndpoint({ userDataDir, headless: true }), (error) => error === startupError);
    assert.ok(signals.includes("SIGTERM"));
    assert.ok(signals.includes("SIGKILL"), "cleanup must escalate when graceful shutdown stalls");
    assert.ok(pidsForDataDir(userDataDir).length > 0, "the mocked signals must leave Chrome alive");
  } finally {
    killMock.mock.restore();
    childKillMock.mock.restore();
    await closeRetainedChrome(userDataDir);
    assert.deepEqual(pidsForDataDir(userDataDir), []);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("retained reclaim lets Chrome save a cookie before sending signals", { timeout: 20_000 }, async (t) => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-reclaim-cookie-"));
  const connect = sockets.connectCdp;
  const kill = process.kill.bind(process);
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === "SIGTERM" || signal === "SIGKILL") signals.push(signal);
    return kill(pid, signal);
  });
  let delayClose = false;
  let requestedClose: Promise<unknown> | undefined;
  t.mock.method(sockets, "connectCdp", async (...args: Parameters<typeof connect>) => {
    const cdp = await connect(...args);
    const send = cdp.send.bind(cdp);
    t.mock.method(cdp, "send", (method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number) => {
      if (delayClose && method === "Browser.close") {
        // A close acknowledgement does not mean the browser has flushed its profile.
        const close = cdp.close.bind(cdp);
        requestedClose = new Promise((resolve) => setTimeout(resolve, 200)).then(() => send(method, params, sessionId, timeoutMs)).catch(() => undefined).finally(close);
        t.mock.method(cdp, "close", () => undefined);
        return Promise.resolve({});
      }
      return send(method, params, sessionId, timeoutMs);
    });
    return cdp;
  });
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let inspector: sockets.CdpSocket | undefined;
  try {
    chrome = await launchOwnedChromeEndpoint({ userDataDir, headless: true });
    let endpoint = await readDevToolsActivePort(chrome.portFile);
    inspector = await connect(endpoint.port, endpoint.browserPath);
    await inspector.send("Storage.setCookies", { cookies: [{ name: "reclaim_probe", value: "saved", domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600 }] });
    inspector.close();
    await chrome.keepOpen();
    delayClose = true;
    await closeRetainedChrome(userDataDir);
    await requestedClose;
    assert.deepEqual(signals, [], "accepted graceful close must finish before signal escalation");
    delayClose = false;
    chrome = await launchOwnedChromeEndpoint({ userDataDir, headless: true });
    endpoint = await readDevToolsActivePort(chrome.portFile);
    inspector = await connect(endpoint.port, endpoint.browserPath);
    const { cookies } = await inspector.send<{ cookies: { name: string; value: string }[] }>("Storage.getCookies");
    assert.ok(cookies.some((cookie) => cookie.name === "reclaim_probe" && cookie.value === "saved"), "the persistent cookie contract survives reclaim and relaunch");
  } finally {
    delayClose = false;
    await requestedClose;
    inspector?.close();
    await chrome?.close();
    await closeRetainedChrome(userDataDir);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("a late close cannot kill the replacement of a retained browser", { timeout: 20_000 }, async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-late-close-"));
  let original: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let replacement: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let cdp: sockets.CdpSocket | undefined;
  try {
    original = await launchOwnedChromeEndpoint({ userDataDir, headless: true });
    await original.keepOpen();
    await closeRetainedChrome(userDataDir);
    replacement = await launchOwnedChromeEndpoint({ userDataDir, headless: true });
    await original.close();
    const endpoint = await readDevToolsActivePort(replacement.portFile);
    cdp = await sockets.connectCdp(endpoint.port, endpoint.browserPath);
    const { targetInfos } = await cdp.send<{ targetInfos: { type: string }[] }>("Target.getTargets");
    assert.ok(targetInfos.some((target) => target.type === "page"), "a replacement remains usable after the original owner's delayed cleanup");
  } finally {
    cdp?.close();
    await original?.close();
    await replacement?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

for (const mode of ["close", "retained-close", "failed-close", "disconnect", "process-exit", "startup-failure"] as const) {
  test(`endpoint-only launch releases its owned Chrome after ${mode}`, { timeout: 20_000 }, async (t) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-endpoint-"));
    const connect = sockets.connectCdp;
    const spawn = childProcess.spawn;
    let ownedChild: ChildProcess | undefined;
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      if (args[1].includes(`--user-data-dir=${userDataDir}`)) ownedChild = child;
      return child;
    });
    let cdp: sockets.CdpSocket | undefined;
    const methods: string[] = [];
    t.mock.method(chromium, "connectOverCDP", () => { throw new Error("must not initialize Playwright"); });
    t.mock.method(sockets, "connectCdp", async (...args: Parameters<typeof connect>) => {
      cdp = await connect(...args);
      const send = cdp.send.bind(cdp);
      t.mock.method(cdp, "send", (method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number) => {
        methods.push(method);
        if (mode === "startup-failure" && method === "Target.setDiscoverTargets") return Promise.reject(new Error("discovery failed"));
        if (mode === "failed-close" && method === "Browser.close") return Promise.reject(new Error("close failed"));
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
          assert.ok(ownedChild);
          ownedChild.kill("SIGTERM");
        } else {
          if (mode === "retained-close") {
            await chrome.keepOpen();
            assert.equal(cdp.isOpen, false);
            assert.ok(pidsForDataDir(userDataDir).length > 0);
          }
          const started = Date.now();
          const closing = chrome.close();
          assert.equal(chrome.close(), closing);
          await closing;
          if (mode === "retained-close" || mode === "failed-close") {
            assert.ok(Date.now() - started < 3000, "close without a sent Browser.close must fit within the last four seconds of MCP shutdown");
          }
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
