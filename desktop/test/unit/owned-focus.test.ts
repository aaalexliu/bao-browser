import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as sockets from "../../src/cdp-live/socket";
import { ACCOUNT_CHROME_MAC, focusOwnedHandoff, forgetDisclaimedChrome, launchOwnedChromeEndpoint, lockOwnedProfile, pidsForDataDir, presentOwnedProfile, releaseKeptWindow, rememberDisclaimedChrome, testLaneBrowser, type OwnedChromeFocus } from "../../src/launch";
import { ownerPrompts, type WorkflowBrowser } from "../../src/engines/workflow-browser";

const processes = require("node:child_process") as typeof import("node:child_process");

function recorder(): { focus: OwnedChromeFocus; order: string[] } {
  const order: string[] = [];
  return {
    order,
    focus: {
      async present() { order.push("present"); },
      async lock() { order.push("lock"); },
    },
  };
}

function owned(profile: string): WorkflowBrowser {
  return {
    kind: "owned",
    choice: "owned",
    profile,
    persistent: false,
    context: {},
    page: {},
    close: async () => {},
  } as WorkflowBrowser;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("an owner handoff calls the prompt first, then focus work, in call order", async () => {
  const profile = "/tmp/bao-owned-focus-order";
  rememberDisclaimedChrome(profile, 4501, true);
  try {
    const order: string[] = [];
    let finishPresent!: () => void;
    const presentGate = new Promise<void>((resolve) => { finishPresent = resolve; });
    const focus: OwnedChromeFocus = {
      async present() {
        order.push("present-start");
        await presentGate;
        order.push("present-end");
      },
      async lock() { order.push("lock"); },
    };
    const prompts = ownerPrompts(owned(profile), {
      showConfirm() { order.push("confirm"); },
      clearConfirm() { order.push("clear"); },
    }, focus);
    await prompts!.showConfirm!("Apply");
    await prompts!.clearConfirm!("run");
    assert.deepEqual(order, ["confirm", "clear"]);
    await flush();
    assert.deepEqual(order, ["confirm", "clear", "present-start"]);
    finishPresent();
    await flush();
    assert.deepEqual(order, ["confirm", "clear", "present-start", "present-end", "lock"]);
  } finally {
    forgetDisclaimedChrome(profile);
  }
});

test("a throwing prompt does not reject, and the handoff still runs", async (t) => {
  const profile = "/tmp/bao-owned-focus-throw";
  rememberDisclaimedChrome(profile, 4502, true);
  const rejections: unknown[] = [];
  const onReject = (error: unknown) => { rejections.push(error); };
  process.on("unhandledRejection", onReject);
  t.after(() => {
    process.off("unhandledRejection", onReject);
    forgetDisclaimedChrome(profile);
  });
  const { focus, order } = recorder();
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  const prompts = ownerPrompts(owned(profile), {
    showConfirm() { throw new Error("prompt failed"); },
    async showLoginWait() { throw new Error("prompt rejected"); },
  }, focus);
  assert.doesNotThrow(() => prompts!.showConfirm!("Apply"));
  assert.doesNotThrow(() => prompts!.showLoginWait!("Sign in"));
  await flush();
  assert.deepEqual(order, ["present", "present"]);
  assert.deepEqual(rejections, []);
  assert.ok(logged.some((line) => line.includes("prompt=showConfirm") && line.includes("prompt failed")));
  assert.ok(logged.some((line) => line.includes("prompt=showLoginWait") && line.includes("prompt rejected")));
});

test("a running Chrome handoff does not present or lock the owned Chrome", async () => {
  const { focus, order } = recorder();
  let shown = false;
  const browser = {
    kind: "current",
    choice: "current",
    context: {},
    page: {},
    close: async () => {},
    show: async () => { shown = true; },
    settle: async () => {},
    bringToFront: async () => {},
    keepOpen: async () => {},
  } as WorkflowBrowser;
  const prompts = ownerPrompts(browser, {
    async showAsk() { order.push("ask"); },
    async clearLoginWait() { order.push("clear"); },
  }, focus);
  await prompts!.showAsk!({} as never);
  await prompts!.clearLoginWait!("run");
  assert.equal(shown, true);
  assert.deepEqual(order, ["ask", "clear"]);
});

test("a handoff locks again only a Chrome Bao launched behind", async () => {
  const behind = "/tmp/bao-owned-focus-behind";
  const foreground = "/tmp/bao-owned-focus-foreground";
  rememberDisclaimedChrome(behind, 4503, true);
  rememberDisclaimedChrome(foreground, 4504, false);
  try {
    const behindFocus = recorder();
    await focusOwnedHandoff(behind, true, behindFocus.focus);
    await focusOwnedHandoff(behind, false, behindFocus.focus);
    assert.deepEqual(behindFocus.order, ["present", "lock"]);
    const foregroundFocus = recorder();
    await focusOwnedHandoff(foreground, true, foregroundFocus.focus);
    await focusOwnedHandoff(foreground, false, foregroundFocus.focus);
    assert.deepEqual(foregroundFocus.order, ["present"]);
  } finally {
    forgetDisclaimedChrome(behind);
    forgetDisclaimedChrome(foreground);
  }
});

test("a handoff does not touch a Chrome bao-spawn did not start", async () => {
  const profile = "/tmp/bao-playwright-chrome";
  const { focus, order } = recorder();
  await focusOwnedHandoff(profile, true, focus);
  await focusOwnedHandoff(profile, false, focus);
  await presentOwnedProfile(profile);
  await lockOwnedProfile(profile);
  assert.deepEqual(order, []);
});

function writeFakeSpawner(dir: string): string {
  const file = path.join(dir, "fake-spawn");
  writeFileSync(file, [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const portArg = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));",
    "const announced = portArg ? portArg.slice('--remote-debugging-port='.length) : '';",
    "const child = spawn(process.execPath, ['-e', \"process.stderr.write('DevTools listening on ws://127.0.0.1:' + process.env.BAO_FAKE_PORT + '/devtools/browser/abc' + String.fromCharCode(10)); setInterval(() => {}, 1000);\"], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, BAO_FAKE_PORT: announced } });",
    "fs.writeFileSync(__filename + '.pid', String(child.pid));",
    "process.stdout.write(String(child.pid) + String.fromCharCode(10));",
    "child.on('exit', (code) => process.exit(code ?? 0));",
    "",
  ].join("\n"), { mode: 0o755 });
  return file;
}

function killPid(pid: number): void {
  if (!Number.isInteger(pid) || pid < 2) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

test("a kept window stays free after keepOpen and a queued lock cannot land after the allow", { skip: process.platform !== "darwin", timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-kept-handoff-"));
  const profile = path.join(dir, "profile");
  const fake = writeFakeSpawner(dir);
  const order: string[] = [];
  let releaseLock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseLock = resolve; });
  const command = [
    ACCOUNT_CHROME_MAC,
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=9333",
    ...(testLaneBrowser() ? ["--use-mock-keychain"] : []),
  ].join(" ");
  const ps = t.mock.method(processes, "execFileSync", () => command);
  const execFile = t.mock.method(processes, "execFile", ((file: string, args?: readonly string[], options?: unknown, callback?: unknown) => {
    const done = typeof options === "function" ? options : callback;
    if (file === "lsappinfo" && typeof done === "function") {
      if (args?.[0] === "setinfo" && args.includes("kLSAllowedToBecomeFrontmostKey=true")) order.push("allow");
      (done as (error: null, stdout: string, stderr: string) => void)(null, "", "");
      return undefined;
    }
    return undefined;
  }) as unknown as typeof processes.execFile);
  let open = true;
  t.mock.method(sockets, "connectCdp", async () => ({
    get isOpen() { return open; },
    disconnected: new Promise<void>(() => {}),
    on() {},
    close() { open = false; },
    send() { return Promise.resolve({}); },
  }) as unknown as Awaited<ReturnType<typeof sockets.connectCdp>>);
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  try {
    chrome = await launchOwnedChromeEndpoint({
      userDataDir: profile,
      executablePath: ACCOUNT_CHROME_MAC,
      background: "none",
      start: {
        env: {},
        spawner: fake,
        lockBehind: () => true,
        present: () => { throw new Error("a background launch must not ask to come forward"); },
      },
    });
    const focus: OwnedChromeFocus = {
      async present() { order.push("present"); },
      async lock() {
        order.push("lock");
        await gate;
      },
    };
    await ownerPrompts(owned(profile), { clearConfirm() {} }, focus)!.clearConfirm!("run-1");
    await flush();
    assert.deepEqual(order, ["lock"]);
    const kept = chrome.keepOpen();
    await flush();
    assert.deepEqual(order, ["lock"]);
    releaseLock?.();
    releaseLock = undefined;
    await kept;
    assert.deepEqual(order, ["lock", "allow"]);
    const later = recorder();
    await ownerPrompts(owned(profile), { clearConfirm() {} }, later.focus)!.clearConfirm!("run-2");
    await flush();
    assert.deepEqual(later.order, []);
  } finally {
    releaseLock?.();
    await flush();
    ps.mock.restore();
    execFile.mock.restore();
    forgetDisclaimedChrome(profile);
    for (const pid of pidsForDataDir(profile)) killPid(pid);
    const pidFile = `${fake}.pid`;
    if (existsSync(pidFile)) killPid(Number(readFileSync(pidFile, "utf8")));
    await chrome?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("letting a kept window go allows that pid and does not present it", async () => {
  const { order } = recorder();
  const allowed: number[] = [];
  await releaseKeptWindow({ kind: "gui", pid: 5150, userDataDir: "/tmp/bao-kept" }, async (pid) => {
    allowed.push(pid);
    order.push("allow");
    return true;
  });
  assert.deepEqual(allowed, [5150]);
  assert.deepEqual(order, ["allow"]);
});
