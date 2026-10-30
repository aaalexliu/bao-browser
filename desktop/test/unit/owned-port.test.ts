// Parallel test files used to pick the same Chrome debugging port before
// either Chrome had bound it. One launch then attached to the other's Chrome,
// and closing either one closed both. Overlapping launches must each drive the
// Chrome on their own profile.

import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright";
import { launchOwnedChrome } from "../../src/launch";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
