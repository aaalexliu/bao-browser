// A persistent profile used to reopen its last tab. That navigation raced the
// first replay and left the window on the old URL. The second launch must
// start blank, then land on the URL this run asked for, and stay there.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launchOwnedChrome, navigateOwned } from "../../src/launch";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandLine(userDataDir: string): string {
  if (process.platform !== "linux") return "";
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`).toString("utf8").replaceAll("\0", " ");
      if (cmd.includes(userDataDir) && /chrome|chromium/i.test(cmd) && !cmd.includes("--type=")) return cmd;
    } catch { /* The process exited or is not readable. */ }
  }
  return "";
}

test("the first replay after a fresh launch is not interrupted by a restored tab", { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bao-startup-nav-"));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><p id="path">${req.url}</p><p id="cookie">${req.headers.cookie || ""}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const first = await launchOwnedChrome({ userDataDir: dir, headless: true });
    try {
      const page = first.pages()[0] || await first.newPage();
      assert.equal(page.url(), "about:blank");
      await navigateOwned(page, `${origin}/old`);
      await page.evaluate(() => { document.cookie = "session=kept; path=/"; });
      assert.equal(new URL(page.url()).pathname, "/old");
    } finally {
      await first.close();
    }
    const second = await launchOwnedChrome({ userDataDir: dir, headless: true });
    try {
      const page = second.pages()[0] || await second.newPage();
      assert.equal(page.url(), "about:blank");
      assert.equal(second.pages().filter((item) => !item.isClosed()).length, 1);
      const argv = commandLine(dir);
      if (process.platform === "linux") {
        assert.equal(argv.includes("--restore-last-session"), false);
        assert.equal(argv.includes("--user-data-dir"), true);
      }
      await navigateOwned(page, `${origin}/intended`);
      await delay(600);
      assert.equal(new URL(page.url()).pathname, "/intended");
      assert.match(await page.locator("#cookie").innerText(), /session=kept/);
    } finally {
      await second.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
