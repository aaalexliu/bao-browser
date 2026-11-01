import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { launchAccountChrome, launchOwnedChrome, needsLinuxNoSandbox, pinTestBrowser } from "../../src/launch";
import { launchTestBrowser, launchTestContext, TEST_MEDIA_ARGS } from "../../src/test-browser.js";

const headless = process.env.BAO_MEDIA_HEADED !== "1";
const root = mkdtempSync(path.join(tmpdir(), "bao-test-media-"));
const server = createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<!doctype html><title>Test media isolation</title><h1>Test media isolation</h1>");
});
let origin: string;

before(async () => {
  pinTestBrowser();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
});

async function assertMediaFlags(browser: Browser): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  try {
    // Unlike Browser.getBrowserCommandLine, this does not need --enable-automation.
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const main = processInfo.find((entry) => entry.type === "browser");
    assert.ok(main);
    const command = execFileSync("ps", ["-p", String(main.id), "-o", "command="], { encoding: "utf8" });
    for (const flag of TEST_MEDIA_ARGS) assert.ok(command.split(/\s+/).includes(flag), `missing ${flag}`);
    assert.equal(command.includes("--use-fake-ui-for-media-stream"), false);
    console.log(`media launch ${new Date().toISOString()} ${JSON.stringify(processInfo)} flags=${TEST_MEDIA_ARGS.join(" ")}`);
  } finally {
    await session.detach();
  }
}

async function assertDeniedRequests(page: Page): Promise<void> {
  console.log(`media requests start ${new Date().toISOString()} ${page.url()}`);
  const result = await page.evaluate(async () => {
    const permissions = await Promise.all(["camera", "microphone"].map(async (name) => {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      return { name, state: status.state };
    }));
    const outcomes = [];
    for (const constraints of [{ audio: true }, { video: true }, { audio: true, video: true }]) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        for (const track of stream.getTracks()) track.stop();
        outcomes.push("unexpected stream");
      } catch (error) {
        outcomes.push((error as DOMException).name);
      }
    }
    const devices = (await navigator.mediaDevices.enumerateDevices()).map((device) => ({ kind: device.kind, label: device.label }));
    return { permissions, outcomes, devices };
  });
  assert.deepEqual(result.outcomes, ["NotAllowedError", "NotAllowedError", "NotAllowedError"]);
  assert.ok(result.devices.every((device) => device.label === ""));
  console.log(`media denied ${new Date().toISOString()} ${page.url()} ${JSON.stringify(result)}`);
}

async function assertContextMedia(context: BrowserContext): Promise<void> {
  const browser = context.browser();
  assert.ok(browser);
  await assertMediaFlags(browser);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin);
  await assertDeniedRequests(page);
  const other = await context.newPage();
  await other.goto(origin.replace("127.0.0.1", "localhost"));
  await assertDeniedRequests(other);
}

test("idle throwaway Chrome baseline does not use page media APIs", { timeout: 60_000 }, async () => {
  const browser = await launchTestBrowser({ headless });
  try {
    await assertMediaFlags(browser);
    console.log(`idle media baseline start ${new Date().toISOString()}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log(`idle media baseline end ${new Date().toISOString()}`);
  } finally { await browser.close(); }
});

test("throwaway Playwright browser rejects media in implicit and explicit contexts", { timeout: 60_000 }, async () => {
  const browser = await launchTestBrowser({ headless, args: ["--lang=en-US"] });
  try {
    await assertMediaFlags(browser);
    const page = await browser.newPage();
    await page.goto(origin);
    await assertDeniedRequests(page);
    const context = await browser.newContext();
    await assertContextMedia(context);
    await context.close();
  } finally { await browser.close(); }
});

for (const kind of ["extension", "owned", "video", "account"] as const) {
  test(`${kind} test browser rejects camera and microphone`, { timeout: 60_000 }, async () => {
    const profile = path.join(root, kind);
    const context = kind === "extension" ? await launchTestContext(profile, { headless })
      : kind === "account" ? await launchAccountChrome({ userDataDir: profile, headless })
      : await launchOwnedChrome({ userDataDir: profile, headless, videoDir: kind === "video" ? path.join(root, "clips") : undefined });
    try { await assertContextMedia(context); }
    finally { await context.close(); }
  });
}

test("manually spawned fixture Chrome rejects media", { timeout: 60_000 }, async () => {
  const profile = path.join(root, "spawned");
  const child = spawn(pinTestBrowser(), [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--use-mock-keychain", "--password-store=basic", ...TEST_MEDIA_ARGS,
    ...(needsLinuxNoSandbox() ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    ...(headless ? ["--headless=new"] : []), "about:blank",
  ], { stdio: "ignore" });
  try {
    const file = path.join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15_000;
    let port = "";
    while (Date.now() < deadline) {
      try { port = readFileSync(file, "utf8").split("\n")[0]; } catch { /* Chrome has not written the port yet. */ }
      if (/^\d+$/.test(port)) break;
      if (child.exitCode != null || child.signalCode != null) throw new Error("test Chrome exited before its port file");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(port, /^\d+$/);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try { await assertContextMedia(browser.contexts()[0]); }
    finally { await browser.close(); }
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.exitCode != null || child.signalCode != null ? resolve() : child.once("exit", () => resolve()));
  }
});

test("public CreepJS and sannysoft media probes still load with denial", { skip: process.env.BAO_MEDIA_PUBLIC !== "1", timeout: 150_000 }, async () => {
  const browser = await launchTestBrowser({ headless });
  try {
    await assertMediaFlags(browser);
    const page = await browser.newPage();
    for (const [url, wait, title] of [
      ["https://abrahamjuliot.github.io/creepjs/", 40_000, /CreepJS/],
      ["https://bot.sannysoft.com/", 12_000, /Antibot/],
    ] as const) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(wait);
      assert.match(await page.title(), title);
      const text = await page.locator("body").innerText();
      assert.match(text, /permissions/i);
      assert.match(text, /devices|media/i);
      console.log(`public media probe ${new Date().toISOString()} ${page.url()} title=${await page.title()} text=${text.slice(0, 500)}`);
      await assertDeniedRequests(page);
    }
  } finally { await browser.close(); }
});
