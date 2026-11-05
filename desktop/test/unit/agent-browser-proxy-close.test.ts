import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as launch from "../../src/launch";

launch.pinTestBrowser();

test("window close and proxy cleanup await the owned shutdown before reopening", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-close-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('native success\\n');\n`, { mode: 0o700 });
  const ownedLaunch = launch.launchOwnedChrome;
  const contexts: BrowserContext[] = [];
  const copies: string[] = [];
  t.mock.method(launch, "launchOwnedChrome", async (options: Parameters<typeof ownedLaunch>[0]) => {
    const context = await ownedLaunch({ ...options, headless: true });
    contexts.push(context);
    copies.push(options.userDataDir);
    const page = context.pages()[0]!;
    await page.goto("chrome://version");
    assert.match(await page.locator("#command_line").innerText(), /(?:^|\s)--disable-extensions(?:\s|$)/);
    await page.goto("about:blank");
    return context;
  });
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  let shutdown: Promise<void> | undefined;
  try {
    await proxy.execute("open");
    const context = contexts[0]!;
    const page = context.pages()[0]!;
    t.mock.method(context, "pages", () => []);
    const ownedClose = context.close.bind(context);
    t.mock.method(context, "close", () => {
      const closing = ownedClose();
      shutdown ??= closing;
      return closing;
    });
    (page as unknown as EventEmitter).emit("close", page);
    assert.ok(shutdown);
    (context as unknown as EventEmitter).emit("close", context);
    await Promise.resolve();
    const reopened = await proxy.execute("open");
    assert.equal(reopened[0]!.stdout, "native success\n");
    assert.equal(contexts.length, 2);
    assert.notEqual(copies[0], copies[1]);
    await assert.rejects(access(copies[0]!), /ENOENT/);
    assert.equal(launch.pidsForDataDir(copies[0]!).length, 0);
    assert.equal(await contexts[1]!.pages()[0]!.evaluate(() => 2 + 2), 4);
  } finally {
    await shutdown;
    await proxy.close().catch(() => undefined);
    for (const context of contexts) await context.close().catch(() => undefined);
    for (const copy of copies) {
      assert.equal(launch.pidsForDataDir(copy).length, 0);
      await rm(path.dirname(copy), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});
