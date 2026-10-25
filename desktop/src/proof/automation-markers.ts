// Bao's capture/replay browser, checked against a local page.
// No navigator patching. No challenge widgets. A throwaway profile.
//
//   npm run proof:automation-markers

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchOwnedChrome, needsLinuxNoSandbox } from "../launch";

const ARTIFACTS = process.env.BAO_MARKER_OUT || "/opt/cursor/artifacts/automation-markers";

function cmdline(pid: number): string {
  return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();
}

function browserArgv(userDataDir: string): string {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = cmdline(Number(name));
      if (!cmd.includes(userDataDir) || !/chrome|chromium/i.test(cmd) || cmd.includes("--type=")) continue;
      return cmd;
    } catch { /* process exited */ }
  }
  return "";
}

async function readSignals(page: import("playwright").Page): Promise<{ webdriver: boolean | undefined; ua: string; ready: boolean }> {
  let last = "unread";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(() => ({
        webdriver: navigator.webdriver,
        ua: navigator.userAgent,
        ready: (window as unknown as { __baoReady?: boolean }).__baoReady === true,
      }));
    } catch (err) {
      last = err instanceof Error ? err.message.split("\n")[0] : String(err);
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
    }
  }
  throw new Error(`${last} at ${page.url()}`);
}

function grab(file: string): Promise<void> {
  return new Promise((resolve) => {
    if (!process.env.DISPLAY) return resolve();
    const child = spawn("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "x11grab", "-video_size", "1440x900",
      "-i", process.env.DISPLAY, "-frames:v", "1", file,
    ], { stdio: "ignore" });
    child.on("exit", () => resolve());
  });
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  const home = await mkdtemp(path.join(tmpdir(), "bao-markers-"));
  const profile = path.join(home, "chrome-profile");
  const headed = process.platform === "darwin" || Boolean(process.env.DISPLAY);
  const server = createServer((req, res) => {
    const set = req.url?.startsWith("/set");
    if (set) res.setHeader("set-cookie", "bao_marker=kept; Path=/; Max-Age=86400");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>${set ? "set" : "read"}</title><p id="which">${set ? "set" : "read"}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "ok" : "FAIL"} ${name}: ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };
  try {
    const first = await launchOwnedChrome({ userDataDir: profile, headless: !headed });
    try {
      await first.exposeBinding("__baoProbe", async () => "probe");
      await first.addInitScript(() => {
        (window as unknown as { __baoReady?: boolean }).__baoReady = true;
      });
      const page = first.pages()[0] || await first.newPage();
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) console.log(`nav ${page.url()}`);
      });
      await page.goto(`http://127.0.0.1:${port}/set`, { waitUntil: "load", timeout: 20000 });
      await page.waitForSelector("#which", { timeout: 10000 });
      const signals = await readSignals(page);
      const argv = browserArgv(profile);
      writeArgv(argv);
      await grab(path.join(ARTIFACTS, "replay-window.png"));
      check("webdriver", signals.webdriver === false || signals.webdriver === undefined, String(signals.webdriver));
      check("ua", !/HeadlessChrome/i.test(signals.ua), signals.ua);
      check("init script", signals.ready, String(signals.ready));
      check("no enable-automation", !argv.includes("--enable-automation"), "argv");
      check("no AutomationControlled", !argv.includes("AutomationControlled"), "argv");
      const sandboxBanned = process.platform === "darwin" || !needsLinuxNoSandbox();
      check("no-sandbox", sandboxBanned ? !argv.includes("--no-sandbox") : true, sandboxBanned ? "absent" : "linux CI may set it");
      check("argv present", argv.includes("--user-data-dir"), argv.slice(0, 180));
    } finally {
      await first.close();
    }
    const second = await launchOwnedChrome({ userDataDir: profile, headless: !headed });
    try {
      const page = second.pages()[0] || await second.newPage();
      await page.goto(`http://127.0.0.1:${port}/read`, { waitUntil: "load", timeout: 20000 });
      await page.waitForSelector("#which", { timeout: 10000 });
      const cookie = await page.evaluate(() => document.cookie);
      check("cookie survived", cookie.includes("bao_marker=kept"), cookie || "(empty)");
    } finally {
      await second.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("proof:automation-markers passed");
}

function writeArgv(argv: string): void {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(path.join(ARTIFACTS, "argv.txt"), argv + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
