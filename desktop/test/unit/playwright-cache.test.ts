import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { swapTestHome } from "../../src/playwright-cache.js";
import { laneChildEnv } from "../runtime";

function realCache(): string {
  const home = userInfo().homedir;
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ms-playwright");
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "ms-playwright");
}

function fakeChromium(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "bao-pw-pin-")), "Google Chrome for Testing");
  writeFileSync(file, "");
  chmodSync(file, 0o755);
  return file;
}

test("a home swap pins the real Playwright cache and keeps an explicit path", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "bao-pw-home-"));
  try {
    const swapped = swapTestHome({ HOME: userInfo().homedir }, temp);
    assert.equal(swapped.HOME, temp);
    assert.equal(swapped.PLAYWRIGHT_BROWSERS_PATH, realCache());
    assert.equal(swapped.PLAYWRIGHT_BROWSERS_PATH?.startsWith(temp), false);

    const kept = swapTestHome({ HOME: userInfo().homedir, PLAYWRIGHT_BROWSERS_PATH: "/custom/browsers" }, temp);
    assert.equal(kept.PLAYWRIGHT_BROWSERS_PATH, "/custom/browsers");
    assert.equal(kept.HOME, temp);

    const local = swapTestHome({ PLAYWRIGHT_BROWSERS_PATH: "0" }, temp);
    assert.equal(local.PLAYWRIGHT_BROWSERS_PATH, "0");

    const blank = swapTestHome({ HOME: temp, PLAYWRIGHT_BROWSERS_PATH: "" });
    assert.equal(blank.HOME, temp);
    assert.equal(blank.PLAYWRIGHT_BROWSERS_PATH, realCache());
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("laneChildEnv pins the real cache even when HOME is already a temp dir", () => {
  const pin = fakeChromium();
  const temp = mkdtempSync(path.join(tmpdir(), "bao-pw-lane-"));
  try {
    const env = laneChildEnv("hermetic", { HOME: temp }, () => pin);
    assert.equal(env.HOME, temp);
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, realCache());
    assert.equal(env.BAO_TEST_BROWSER, pin);

    const kept = laneChildEnv("hermetic", { HOME: temp, PLAYWRIGHT_BROWSERS_PATH: "/custom/browsers" }, () => pin);
    assert.equal(kept.PLAYWRIGHT_BROWSERS_PATH, "/custom/browsers");
    assert.equal(kept.HOME, temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(path.dirname(pin), { recursive: true, force: true });
  }
});

test("a temp HOME with an empty cache still launches a headless test browser", { timeout: 60_000 }, () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-pw-launch-"));
  const browserModule = path.resolve("desktop/dist/desktop/src/test-browser.js");
  const script = `
    const { testChromium } = require(${JSON.stringify(browserModule)});
    (async () => {
      const browser = await testChromium.launch();
      const page = await browser.newPage();
      const value = await page.evaluate(() => 1 + 1);
      const session = await browser.newBrowserCDPSession();
      const info = await session.send("SystemInfo.getProcessInfo");
      const main = info.processInfo.find((entry) => entry.type === "browser");
      if (!main) throw new Error("browser process missing");
      const { execFileSync } = require("node:child_process");
      const command = execFileSync("ps", ["-p", String(main.id), "-o", "command="], { encoding: "utf8" });
      await browser.close();
      if (value !== 2) throw new Error("page did not run");
      if (!/--headless/.test(command) && !/headless[-_]shell/.test(command)) throw new Error("browser was not headless: " + command);
      if (command.includes(${JSON.stringify(home)})) throw new Error("browser resolved under the temp home");
      process.stdout.write("headless\\n");
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (existsSync(realCache())) delete env.PLAYWRIGHT_BROWSERS_PATH;
  else if (!env.PLAYWRIGHT_BROWSERS_PATH || env.PLAYWRIGHT_BROWSERS_PATH === "0") {
    throw new Error("Playwright browsers are missing");
  }
  delete env.BAO_TEST_BROWSER;
  delete env.BAO_HEADED;
  delete env.BAO_LANE;
  delete env.BAO_LIVE_TESTS;
  const guard = path.resolve("desktop/test/connection-guard.cjs");
  env.NODE_OPTIONS = `--require ${JSON.stringify(guard)}`;
  try {
    const result = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 45_000 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /^headless\n$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
