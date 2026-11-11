import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openWorkflowBrowser } from "../../src/engines/workflow-browser";
import { closeRetainedChrome, launchOwnedChrome, pidsForDataDir, pinTestBrowser } from "../../src/launch";
import { chromeProfiles } from "../support/chrome-profiles";

pinTestBrowser();

test("a disconnect followed by context.close runs one shutdown", { timeout: 20_000 }, async (t) => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-playwright-close-"));
  const context = await launchOwnedChrome({ userDataDir, headless: true });
  const browser = context.browser();
  assert.ok(browser);
  const logs: string[] = [];
  const error = console.error;
  t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    error.apply(console, args);
  });
  const kill = ChildProcess.prototype.kill;
  let sigterms = 0;
  let holdKill = true;
  t.mock.method(ChildProcess.prototype, "kill", function (this: ChildProcess, signal?: NodeJS.Signals | number) {
    if (holdKill && signal === "SIGTERM") {
      sigterms += 1;
      return true;
    }
    return kill.call(this, signal);
  });
  try {
    await browser.close();
    const started = Date.now() + 2000;
    while (sigterms < 1 && Date.now() < started) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sigterms, 1, "disconnect must start one shutdown");
    const closing = context.close();
    assert.equal(context.close(), closing, "disconnect and close share one completion");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sigterms, 1, "context.close after disconnect must not start a second shutdown");
    holdKill = false;
    await closing;
    assert.equal(logs.filter((line) => line.includes("bao shutdown")).length, 1);
    assert.deepEqual(pidsForDataDir(userDataDir), []);
  } finally {
    holdKill = false;
    await context.close().catch(() => undefined);
    if (pidsForDataDir(userDataDir).length) await closeRetainedChrome(userDataDir);
    assert.deepEqual(pidsForDataDir(userDataDir), [], "test must leave no owned Chrome processes");
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("a Playwright disconnect after keep-open leaves the retained Chrome up", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-playwright-retain-"));
  const sourceRoot = await chromeProfiles(path.join(root, "source"));
  const session = await openWorkflowBrowser({ browser: "bao", home: root, site: "about:blank", sourceRoot });
  assert.equal(session.kind, "owned");
  try {
    await session.keepOpen?.();
    const browser = session.context.browser();
    assert.ok(browser);
    const disconnected = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));
    await browser.close();
    await disconnected;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(pidsForDataDir(session.profile).length > 0, "keep-open must survive a Playwright disconnect");
    await session.close();
    assert.deepEqual(pidsForDataDir(session.profile), []);
  } finally {
    await session.close().catch(() => undefined);
    if (session.kind === "owned" && pidsForDataDir(session.profile).length) await closeRetainedChrome(session.profile);
    assert.equal(session.kind === "owned" ? pidsForDataDir(session.profile).length : 0, 0, "test must leave no owned Chrome processes");
    await rm(root, { recursive: true, force: true });
  }
});
