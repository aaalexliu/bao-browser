// Parallel test files used to pick the same Chrome debugging port before
// either Chrome had bound it. One launch then attached to the other's Chrome,
// and closing either one closed both. Overlapping launches must each drive the
// Chrome on their own profile.

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright";
import { launchOwnedChrome } from "../../src/launch";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function profileDir(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  try {
    await page.goto("chrome://version");
    return path.dirname((await page.locator("#profile_path").innerText()).trim());
  } finally {
    await page.close();
  }
}

test("owned launches that overlap each drive their own Chrome", { timeout: 90_000 }, async () => {
  const dirs = await Promise.all([0, 1, 2].map(() => mkdtemp(path.join(tmpdir(), "bao-owned-port-"))));
  // Each launch starts before the Chrome before it has opened its port.
  const settled = await Promise.allSettled(dirs.map(async (dir, index) => {
    await delay(index * 30);
    return launchOwnedChrome({ userDataDir: dir, headless: true });
  }));
  const contexts = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  try {
    for (const result of settled) if (result.status === "rejected") throw result.reason;
    for (const [index, context] of contexts.entries()) {
      assert.equal(await profileDir(context), realpathSync(dirs[index]));
    }
    await contexts[0].close();
    for (const context of contexts.slice(1)) {
      const page = await context.newPage();
      assert.equal(await page.evaluate(() => 1 + 1), 2);
      await page.close();
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  }
});

test("a browser that binds port 9222 is refused and stopped", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-owned-9222-"));
  const userDataDir = path.join(root, "profile");
  const exe = path.join(root, "fake-chrome.sh");
  const pidFile = path.join(root, "fake.pid");
  await writeFile(exe, [
    "#!/bin/sh",
    "for arg in \"$@\"; do",
    "  case \"$arg\" in --user-data-dir=*) dir=\"${arg#--user-data-dir=}\" ;; esac",
    "done",
    `echo $$ > "${pidFile}"`,
    "printf '9222\\n/devtools/browser/fake-id\\n' > \"$dir/DevToolsActivePort\"",
    "exec sleep 60",
    "",
  ].join("\n"));
  await chmod(exe, 0o755);
  try {
    await assert.rejects(launchOwnedChrome({ userDataDir, executablePath: exe, headless: true }), /remote-debugging-port 9222/);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(pid > 0);
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await delay(50);
    assert.equal(alive(pid), false);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
