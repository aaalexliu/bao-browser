// Extension driver proof. Throwaway Chrome profiles and public pages only.
//
//   npm run proof:extension
//   PROOF_PART=worker|signals|fingerprints|tasks|rates|debugger|all

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { Capture } from "../app/capture";
import { BrowserDriver } from "../v1/browser-driver";
import { captureStartUrl, outputCsv, specFromProposal, type PageProposal } from "../v1/data-steps";
import { unavailableHeal } from "../v1/heal";
import { explain, type TrailEvent } from "../v1/interpret";
import { keepSessionCookies, launchOwnedChrome } from "../launch";
import { classifyPage } from "../v1/page-class";
import { replay, type RunResult } from "../v1/replay";
import type { ReplayArgs, WorkflowV2 } from "../v1/schema";
import { argsFor, scoreP1, scoreP5, scoreP9, type PageView, type RunView } from "./realworld";
import { ExtensionDriver } from "../extension/driver";
import { gestureQueue, readGestures, writeGestures, emptyGesture } from "../extension/gestures";
import { hostScriptPath, startExtensionLink, type ExtensionLink } from "../extension/link";
import { hashCookieHeader, hashValue, diffSignals, type SignalField } from "../extension/signals";
import type { Gesture } from "../extension/protocol";

process.env.BAO_CHROME_NO_SANDBOX = process.env.BAO_CHROME_NO_SANDBOX || "1";
process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";
process.env.BAO_PROOF_PAGE = "1";
for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];

const ARTIFACTS = "/opt/cursor/artifacts/extension-proof";
const PART = (process.env.PROOF_PART || "all").toLowerCase();
const WAIT_MS = Number(process.env.PROOF_WAIT_MS || 12000);
const ROOT = path.join(tmpdir(), `bao-ext-proof-${Date.now().toString(36)}`);
const HOME = path.join(ROOT, "home");
const BAO = path.join(ROOT, "bao");
const PROFILE = path.join(ROOT, "profile");
const RATES_PROFILE = path.join(ROOT, "rates-profile");
const EXT_DIR = path.resolve("extension/dist");

const SITES = {
  tls: "https://tls.peet.ws/api/all",
  creep: "https://abrahamjuliot.github.io/creepjs/",
  // The published demo https://fingerprintjs.github.io/BotD/ returns GitHub Pages 404.
  // The proof loads the public BotD v2 build from openfpcdn.io and prints its verdict.
  botd: "http://127.0.0.1/botd",
  cloudflare: "https://nowsecure.nl/",
  imperva: "https://bluefish.impvdemo.com/abp/",
  impervaFallback: "https://www.imperva.com/",
  sannysoft: "https://bot.sannysoft.com/",
  books: "https://books.toscrape.com/",
  travel: "https://books.toscrape.com/catalogue/category/books/travel_2/index.html",
  shop: "https://shop.polymer-project.org/list/mens_tshirts",
  signup: "https://automationexercise.com/login",
};

const results: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  part: PART,
  sandbox: process.env.BAO_CHROME_NO_SANDBOX,
  profile: PROFILE,
};

function want(name: string): boolean {
  return PART === "all" || PART.split(",").includes(name);
}

function log(message: string): void {
  console.log(`[proof] ${message}`);
}

function save(): void {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(path.join(ARTIFACTS, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeBin(): string {
  // Branded Google Chrome ignores --load-extension. Chrome for Testing still loads
  // an unpacked extension, and the human session uses that same binary.
  const fromEnv = process.env.BAO_PROOF_CHROME;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const root = path.join(homedir(), ".cache/ms-playwright");
  if (existsSync(root)) {
    const hits = readdirSync(root)
      .map((name) => path.join(root, name, "chrome-linux64", "chrome"))
      .filter((file) => existsSync(file))
      .sort();
    const found = hits[hits.length - 1];
    if (found) return found;
  }
  for (const file of ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"]) {
    if (existsSync(file)) return file;
  }
  throw new Error("chrome was not found");
}

function run(cmd: string, args: string[]): string {
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  return `${out.stdout || ""}${out.stderr || ""}`.trim();
}

function xdo(args: string[]): void {
  const out = spawnSync("xdotool", args, { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`xdotool ${args.join(" ")}: ${out.stderr || out.stdout}`);
}

function windowGeometry(id: string): { id: string; x: number; y: number; w: number; h: number; name: string; klass: string } {
  const geo = run("xdotool", ["getwindowgeometry", "--shell", id]);
  const pick = (name: string) => Number(geo.match(new RegExp(`^${name}=(\\d+)`, "m"))?.[1] || 0);
  return {
    id,
    x: pick("X"),
    y: pick("Y"),
    w: pick("WIDTH"),
    h: pick("HEIGHT"),
    name: run("xdotool", ["getwindowname", id]),
    klass: run("xprop", ["-id", id, "WM_CLASS"]),
  };
}

function visibleWindows(): { id: string; x: number; y: number; w: number; h: number; name: string; klass: string }[] {
  const listed = run("xdotool", ["search", "--onlyvisible", "--name", ".+"]);
  return listed.split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(windowGeometry);
}

function chromeWindow(): { id: string; x: number; y: number; w: number; h: number; name?: string; klass?: string } | undefined {
  const wins = visibleWindows().filter((win) => /chrome|chromium/i.test(`${win.klass} ${win.name}`));
  wins.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  return wins[0];
}

async function focusChrome(): Promise<void> {
  const win = chromeWindow();
  if (!win) return;
  spawnSync("xdotool", ["windowactivate", "--sync", win.id]);
  await sleep(150);
}

function unlock(profile: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(path.join(profile, name), { force: true });
  }
  const prefs = path.join(profile, "Default", "Preferences");
  if (!existsSync(prefs)) return;
  try {
    const parsed = JSON.parse(readFileSync(prefs, "utf8")) as { profile?: Record<string, unknown> };
    parsed.profile = { ...(parsed.profile || {}), exit_type: "Normal", exited_cleanly: true };
    writeFileSync(prefs, JSON.stringify(parsed));
  } catch {
    /* a fresh profile has no preferences yet */
  }
}

interface PageRead {
  title?: string;
  url?: string;
  text?: string;
  webdriver?: boolean;
  userAgent?: string;
  language?: string;
  languages?: string;
  hardwareConcurrency?: number;
  platform?: string;
  innerHeight?: number;
  outerHeight?: number;
  iframes?: string[];
  markers?: string[];
  badge?: string;
  phase?: string;
}

interface HarHeader { name: string; value: string }
interface HarEntry {
  url: string;
  method: string;
  status?: number;
  requestHeaders: HarHeader[];
  responseHeaders: HarHeader[];
}

class ChromeRun {
  private proc: ChildProcess | undefined;
  constructor(private readonly link: ExtensionLink, private readonly profile: string) {}

  async launch(opts: { netlog?: string; debugPort?: number }): Promise<void> {
    await this.quit();
    mkdirSync(this.profile, { recursive: true });
    unlock(this.profile);
    keepSessionCookies(this.profile);
    const args = [
      `--user-data-dir=${this.profile}`,
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--window-size=1280,900",
      "--window-position=20,20",
      "about:blank",
    ];
    if (process.env.BAO_CHROME_NO_SANDBOX === "1") args.push("--no-sandbox", "--disable-dev-shm-usage");
    if (opts.netlog) args.push(`--log-net-log=${opts.netlog}`, "--net-log-capture-mode=IncludeSensitive");
    if (opts.debugPort) args.push(`--remote-debugging-port=${opts.debugPort}`, "--remote-debugging-address=127.0.0.1");
    const before = this.link.helloSerial;
    const logFile = createWriteStream(path.join(ARTIFACTS, "chrome.log"), { flags: "a" });
    const xauth = process.env.XAUTHORITY || path.join(homedir(), ".Xauthority");
    this.proc = spawn(chromeBin(), args, {
      env: {
        ...process.env,
        HOME,
        DISPLAY: process.env.DISPLAY || ":1",
        XAUTHORITY: xauth,
      },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.proc.stderr?.pipe(logFile);
    this.proc.unref();
    log(`chrome pid ${this.proc.pid} bin ${chromeBin()} profile ${path.basename(this.profile)} debug ${opts.debugPort || "off"}`);
    results.chromeBin = chromeBin();
    await this.link.waitForHello(before, 25000);
  }

  async quit(): Promise<void> {
    run("pkill", ["-f", `user-data-dir=${this.profile}`]);
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const left = run("pgrep", ["-af", `user-data-dir=${this.profile}`]);
      if (!left) break;
      await sleep(200);
    }
    run("pkill", ["-9", "-f", `user-data-dir=${this.profile}`]);
    this.proc = undefined;
    unlock(this.profile);
    await sleep(300);
  }
}

async function cmd(link: ExtensionLink, op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
  const value = await link.command(op, params, timeoutMs);
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function readPage(link: ExtensionLink): Promise<PageRead> {
  return cmd(link, "read", {}, 20000) as Promise<PageRead>;
}

async function waitUrl(link: ExtensionLink, host: string, ms = 20000): Promise<PageRead> {
  const start = Date.now();
  let last: PageRead = {};
  while (Date.now() - start < ms) {
    last = await cmd(link, "status", {}, 10000) as PageRead;
    if ((last.url || "").includes(host)) {
      await cmd(link, "follow", {}, 10000).catch(() => undefined);
      await sleep(400);
      return readPage(link);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${host} at ${last.url || "?"}`);
}

async function humanGoto(link: ExtensionLink, url: string): Promise<PageRead> {
  const host = new URL(url).host;
  await focusChrome();
  xdo(["key", "--clearmodifiers", "ctrl+l"]);
  await sleep(200);
  xdo(["key", "ctrl+a"]);
  xdo(["key", "BackSpace"]);
  xdo(["type", "--delay", "12", url]);
  xdo(["key", "Return"]);
  return waitUrl(link, host);
}

function saveJpeg(name: string, dataUrl: unknown): string | undefined {
  const raw = String(dataUrl || "");
  const comma = raw.indexOf(",");
  if (comma < 0) return undefined;
  const file = path.join(ARTIFACTS, name);
  writeFileSync(file, Buffer.from(raw.slice(comma + 1), "base64"));
  return file;
}

async function shot(link: ExtensionLink, name: string): Promise<string | undefined> {
  try {
    const body = await cmd(link, "shot-raw", {}, 15000);
    const saved = saveJpeg(name, body.jpeg);
    if (saved) return saved;
    if (body.error) log(`shot ${name}: ${body.error}`);
  } catch (err) {
    log(`shot ${name}: ${err instanceof Error ? err.message : err}`);
  }
  await focusChrome();
  return windowShot(name.replace(/\.jpg$/, "") + "-window.png");
}

function windowShot(name: string): string | undefined {
  const file = path.join(ARTIFACTS, name.endsWith(".png") ? name : `${name}.png`);
  const win = chromeWindow();
  if (!win) return undefined;
  const grabbed = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "x11grab",
    "-video_size", `${Math.max(1, win.w)}x${Math.max(1, win.h)}`,
    "-i", `${process.env.DISPLAY || ":1"}+${win.x},${win.y}`,
    "-frames:v", "1",
    file,
  ], { encoding: "utf8" });
  return grabbed.status === 0 && existsSync(file) ? file : undefined;
}

function fullShot(name: string): string | undefined {
  const file = path.join(ARTIFACTS, name.endsWith(".png") ? name : `${name}.png`);
  const grabbed = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "x11grab",
    "-video_size", "1920x1200",
    "-i", process.env.DISPLAY || ":1",
    "-frames:v", "1",
    file,
  ], { encoding: "utf8" });
  if (grabbed.status !== 0) {
    log(`fullShot ${name}: ${grabbed.stderr || grabbed.stdout}`);
    return undefined;
  }
  return file;
}

function findAllowButton(file: string): { x: number; y: number; w: number; h: number } | undefined {
  // Chrome paints Deny as a saturated blue pill and Allow as the pale pill on its right.
  // Clicking the saturated pill dismisses the prompt.
  const script = `
import subprocess, sys
from collections import defaultdict, deque
path, ws, hs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
raw = subprocess.check_output(["ffmpeg","-v","error","-i",path,"-f","rawvideo","-pix_fmt","rgb24","pipe:1"])
w, h = ws, hs
if len(raw) < w * h * 3:
    print("none")
    raise SystemExit
step, cell = 2, 8
grid = defaultdict(list)
for y in range(90, h - 80, step):
    row = y * w * 3
    for x in range(40, w - 40, step):
        i = row + x * 3
        r, g, b = raw[i], raw[i+1], raw[i+2]
        kind = None
        if b > 150 and r < 80 and (b - r) > 90:
            kind = "deny"
        elif 170 <= r <= 245 and g >= 200 and b >= 235 and (b - r) >= 20:
            kind = "allow"
        if kind:
            grid[(x // cell, y // cell)].append((x, y, kind))

def clusters(kind):
    seen = set()
    out = []
    for start in list(grid):
        if start in seen or not any(p[2] == kind for p in grid[start]):
            continue
        q = deque([start])
        seen.add(start)
        pts = []
        while q:
            c = q.popleft()
            pts.extend(p for p in grid[c] if p[2] == kind)
            cx, cy = c
            for nx in (cx - 1, cx, cx + 1):
                for ny in (cy - 1, cy, cy + 1):
                    nxt = (nx, ny)
                    if nxt in grid and nxt not in seen and any(p[2] == kind for p in grid[nxt]):
                        seen.add(nxt)
                        q.append(nxt)
        if len(pts) < 80:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
        bw, bh = maxx - minx, maxy - miny
        if 40 <= bw <= 160 and 20 <= bh <= 64:
            out.append((minx, miny, maxx, maxy, len(pts)))
    return out

denies = clusters("deny")
allows = clusters("allow")
denies.sort(key=lambda box: box[4], reverse=True)
if not denies:
    print("none")
    raise SystemExit
deny = denies[0]
dx = (deny[0] + deny[2]) // 2
dy = (deny[1] + deny[3]) // 2
picked = None
for box in allows:
    cx = (box[0] + box[2]) // 2
    cy = (box[1] + box[3]) // 2
    if cx > deny[2] - 8 and abs(cy - dy) < 30:
        if picked is None or box[4] > picked[4]:
            picked = (cx, cy, box[2] - box[0], box[3] - box[1], box[4])
if picked is None:
    print("none")
else:
    print(f"{picked[0]} {picked[1]} {picked[2]} {picked[3]}")
`;
  const out = spawnSync("python3", ["-c", script, file, "1920", "1200"], { encoding: "utf8" });
  const line = (out.stdout || "").trim().split("\n").pop() || "";
  if (out.status !== 0 || line === "none" || !line) {
    log(`allow scan: ${line || out.stderr || "none"}`);
    return undefined;
  }
  const [x, y, w, h] = line.split(/\s+/).map(Number);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return undefined;
  return { x, y, w, h };
}

async function grant(link: ExtensionLink, chrome: ChromeRun, origins: string[]): Promise<void> {
  const port = 9333 + Math.floor(Math.random() * 40);
  await chrome.launch({ debugPort: port });
  await sleep(800);
  const listed = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json()) as { url?: string }[];
  const extensionTargets = listed.filter((item) => (item.url || "").includes("jcjcpblcjaakcmbgljdjkfgmmdfdbnfj")).map((item) => item.url || "");
  results.extensionTargets = extensionTargets;
  log(`extension targets ${extensionTargets.length}`);
  const allow = `chrome-extension://jcjcpblcjaakcmbgljdjkfgmmdfdbnfj/allow.html?origins=${encodeURIComponent(origins.join(","))}`;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const context = browser.contexts()[0];
    const page = context?.pages()[0] || await context?.newPage();
    if (!page) throw new Error("cdp had no page");
    await page.goto(allow, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("#allow", { timeout: 10000 });
    const granted = await acceptBubble(page);
    results.grant = { granted, origins: origins.length, port };
    save();
    if (!granted) {
      fullShot("grant-failed-full.png");
      throw new Error("Chrome did not grant the site list");
    }
  } finally {
    await browser.close().catch(() => undefined);
    await chrome.quit();
  }
}

async function grantState(page: Page): Promise<{ granted: string; asking: string; error: string; note: string }> {
  return page.evaluate(() => ({
    granted: document.body?.dataset.granted || "",
    asking: document.body?.dataset.asking || "",
    error: document.body?.dataset.error || "",
    note: document.getElementById("note")?.textContent || "",
  })).catch(() => ({ granted: "", asking: "", error: "evaluate failed", note: "" }));
}

async function clickAllowSites(page: Page): Promise<void> {
  await focusChrome();
  const point = await page.evaluate(() => {
    const el = document.getElementById("allow");
    const rect = el?.getBoundingClientRect();
    return {
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      left: rect?.left ?? 0,
      top: rect?.top ?? 0,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
    };
  });
  const win = chromeWindow();
  const x = Math.round(point.screenX + point.left + point.width / 2);
  const y = Math.round(point.screenY + Math.max(0, point.outerHeight - point.innerHeight) + point.top + point.height / 2);
  results.allowClick = { ...point, x, y, window: win || null };
  log(`allow click ${x},${y} window ${win ? `${win.x},${win.y} ${win.w}x${win.h} ${win.klass}` : "missing"}`);
  xdo(["mousemove", String(x), String(y)]);
  await sleep(200);
  fullShot("grant-cursor.png");
  xdo(["click", "1"]);
}

async function acceptBubble(page: Page): Promise<boolean> {
  await clickAllowSites(page);
  await sleep(700);
  let state = await grantState(page);
  log(`after click ${JSON.stringify(state)} windows ${visibleWindows().map((win) => `${win.name}|${win.w}x${win.h}`).join(";")}`);
  fullShot("grant-dialog.png");
  if (state.granted === "true") return true;
  if (state.granted === "false") return false;

  const dialog = fullShot("grant-dialog.png");
  const allow = dialog ? findAllowButton(dialog) : undefined;
  if (allow) {
    log(`dialog allow at ${allow.x},${allow.y} ${allow.w}x${allow.h}`);
    results.dialogAllow = allow;
    await focusChrome();
    xdo(["mousemove", String(allow.x), String(allow.y)]);
    await sleep(100);
    xdo(["click", "1"]);
    await sleep(600);
    state = await grantState(page);
    log(`after dialog click ${JSON.stringify(state)}`);
    if (state.granted === "true") return true;
    if (state.granted === "false") return false;
  }

  // XTEST, not --window. Chrome drops XSendEvent, which is what --window uses.
  await focusChrome();
  xdo(["key", "Return"]);
  await sleep(500);
  state = await grantState(page);
  log(`after return ${JSON.stringify(state)}`);
  if (state.granted === "true") return true;
  if (state.granted === "false") return false;

  const start = Date.now();
  while (Date.now() - start < 8000) {
    state = await grantState(page);
    if (state.granted === "true") return true;
    if (state.granted === "false") return false;
    await sleep(300);
  }
  return false;
}

function patternsFor(origins: string[]): string[] {
  return origins;
}

interface Obs {
  type?: string;
  t?: number;
  trusted?: boolean;
  x?: number;
  y?: number;
  key?: string;
}

function gestureFrom(events: Obs[]): Gesture {
  const clicks = events.filter((event) => event.type === "click" && event.t != null);
  const click = clicks[clicks.length - 1];
  if (!click || click.t == null) return emptyGesture();
  const prior = events.filter((event) => event.t != null && event.t <= click.t!);
  const moves = prior.filter((event) => event.type === "pointermove" && event.x != null && event.y != null);
  const start = prior[0]?.t ?? click.t;
  const keys = prior.filter((event) => event.type === "keydown" && event.t != null);
  const keyGaps: number[] = [];
  for (let i = 1; i < keys.length; i++) keyGaps.push(Math.max(0, Math.round((keys[i]!.t || 0) - (keys[i - 1]!.t || 0))));
  return {
    dwellMs: Math.max(0, Math.round(click.t - start)),
    pointer: moves.slice(-40).map((event) => ({
      dt: Math.max(0, Math.round((event.t || 0) - start)),
      x: Math.round(event.x || 0),
      y: Math.round(event.y || 0),
    })),
    keyGaps,
  };
}

function trustedOf(events: Obs[]): string {
  const clicks = events.filter((event) => event.type === "click");
  const last = clicks[clicks.length - 1];
  if (!last) return "missing";
  return last.trusted === true ? "true" : "false";
}

async function flushEvents(link: ExtensionLink): Promise<Obs[]> {
  const body = await cmd(link, "flush-events", {}, 10000);
  return Array.isArray(body.events) ? body.events as Obs[] : [];
}

async function flushHar(link: ExtensionLink): Promise<HarEntry[]> {
  const body = await cmd(link, "flush-har", {}, 10000);
  const entries = Array.isArray(body.entries) ? body.entries as HarEntry[] : [];
  return entries.map((entry) => ({
    url: entry.url,
    method: entry.method,
    status: entry.status,
    requestHeaders: (entry.requestHeaders || []).map((header) => (
      /cookie/i.test(header.name) ? { name: header.name, value: hashCookieHeader(header.value) } : { name: header.name, value: header.value }
    )),
    responseHeaders: (entry.responseHeaders || []).map((header) => (
      /set-cookie/i.test(header.name)
        ? { name: header.name, value: `${header.value.split("=")[0]}=${hashValue(header.value)}` }
        : { name: header.name, value: header.value }
    )),
  }));
}

function documentHeaders(entries: HarEntry[], pageUrl: string): Record<string, string> {
  let match: HarEntry | undefined;
  try {
    const wanted = new URL(pageUrl);
    match = [...entries].reverse().find((entry) => {
      try {
        const url = new URL(entry.url);
        return url.host === wanted.host && url.pathname === wanted.pathname;
      } catch {
        return false;
      }
    });
  } catch {
    match = undefined;
  }
  if (!match) match = [...entries].reverse().find((entry) => entry.method === "GET");
  const out: Record<string, string> = {};
  for (const header of match?.requestHeaders || []) out[header.name.toLowerCase()] = header.value;
  return out;
}

function tlsFields(text: string): Record<string, string> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { "tls.raw": "unread" };
  try {
    const json = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const out: Record<string, string> = {};
    const take = (name: string, value: unknown) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[name] = String(value);
    };
    for (const [key, value] of Object.entries(json)) {
      if (typeof value === "object" && value) continue;
      take(`tls.${key}`, value);
    }
    for (const group of ["tls", "http2"]) {
      const block = json[group];
      if (!block || typeof block !== "object") continue;
      for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
        if (typeof value === "string" || typeof value === "number") out[`tls.${group}.${key}`] = String(value).slice(0, 300);
      }
    }
    return out;
  } catch {
    return { "tls.parse": "failed" };
  }
}

function cookieJar(list: { name?: string; value?: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cookie of list) {
    if (!cookie.name) continue;
    out[cookie.name] = hashValue(cookie.value || "");
  }
  return out;
}

async function humanClick(link: ExtensionLink, selector: string): Promise<{ gesture: Gesture; trusted: string }> {
  await cmd(link, "follow", {}, 10000).catch(() => undefined);
  let box: Record<string, unknown> = {};
  let last = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      box = await cmd(link, "box", { selector }, 10000);
      if (box.x) break;
      last = JSON.stringify(box);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await sleep(400);
    }
  }
  if (!box.x) {
    try {
      box = await cmd(link, "dom-box", { selector }, 10000);
      last = `${last} dom-box ${JSON.stringify(box)}`;
    } catch (err) {
      last = `${last} dom-box ${err instanceof Error ? err.message : err}`;
    }
  }
  const x = Number(box.x || 0);
  const y = Number(box.y || 0);
  if (!x || !y) throw new Error(`no box for ${selector}: ${last}`);
  await focusChrome();
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const px = Math.round(x - 140 + (140 * i) / steps);
    const py = Math.round(y - 50 + (50 * i) / steps);
    xdo(["mousemove", String(px), String(py)]);
    await sleep(40);
  }
  xdo(["click", "1"]);
  await sleep(500);
  const events = await flushEvents(link);
  return { gesture: gestureFrom(events), trusted: trustedOf(events) };
}

interface SignalBag {
  tls: Record<string, string>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  carry: Record<string, string>;
  trusted: string;
  gesture: Gesture;
  badge: string;
  webdriver: string;
  language: string;
  platform: string;
  harFile: string;
}

function fieldsOf(bag: SignalBag): Record<string, string> {
  const out: Record<string, string> = { ...bag.tls };
  out["navigator.webdriver"] = bag.webdriver;
  out["navigator.language"] = bag.language;
  out["navigator.platform"] = bag.platform;
  out["event.isTrusted"] = bag.trusted;
  out["timing.dwellMs"] = String(bag.gesture.dwellMs || 0);
  out["timing.pointerSamples"] = String(bag.gesture.pointer.length);
  out["timing.pointerSpanMs"] = String(bag.gesture.pointer.at(-1)?.dt ?? 0);
  out["timing.keyGaps"] = bag.gesture.keyGaps.join(",");
  out["indicator.badge"] = bag.badge;
  out["debugger.attached"] = "false";
  const interesting = ["user-agent", "accept", "accept-language", "accept-encoding", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "upgrade-insecure-requests", "cookie"];
  for (const name of interesting) {
    if (bag.headers[name] != null) out[`header.${name}`] = bag.headers[name];
  }
  for (const [name, value] of Object.entries(bag.headers)) {
    if (name.startsWith("sec-ch-ua")) out[`clientHint.${name}`] = value;
  }
  for (const name of ["visid_incap", "incap_ses"]) {
    const hit = Object.entries(bag.cookies).find(([key]) => key.startsWith(name));
    out[`cookie.${name}`] = hit ? hit[1] : "absent";
    out[`cookie.carryover.${name}`] = bag.carry[name] || "no";
  }
  return out;
}

async function redactNetlog(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) return;
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(src, { encoding: "utf8" });
    const output = createWriteStream(dest);
    const lines = createInterface({ input });
    lines.on("line", (line) => {
      const redacted = /cookie|authorization/i.test(line)
        ? line.replace(/=([^;\s"]{6,})/g, (_all, value: string) => `=${hashValue(value)}`)
        : line;
      output.write(`${redacted}\n`);
    });
    lines.on("close", () => output.end());
    output.on("finish", () => resolve());
    output.on("error", reject);
    input.on("error", reject);
  });
}

async function captureHuman(link: ExtensionLink, patterns: string[]): Promise<SignalBag> {
  await cmd(link, "disarm");
  await cmd(link, "observe", { patterns });
  await cmd(link, "watch", { all: true });
  const tlsPage = await humanGoto(link, SITES.tls);
  const tls = tlsFields(`${tlsPage.text || ""}`);
  const tlsHar = await flushHar(link);
  await humanGoto(link, SITES.books);
  await sleep(800);
  const clicked = await humanClick(link, "a[href*='travel']");
  const gesture = clicked.gesture;
  await sleep(800);
  const travel = await readPage(link);
  const booksHar = await flushHar(link);
  const impervaUrl = results.impervaUrl as string || SITES.imperva;
  await humanGoto(link, impervaUrl);
  await sleep(2500);
  const firstCookies = cookieJar(((await cmd(link, "cookies", { url: impervaUrl })).cookies || []) as { name?: string; value?: string }[]);
  await flushHar(link);
  await focusChrome();
  xdo(["key", "F5"]);
  await sleep(2500);
  const secondHar = await flushHar(link);
  const headers = documentHeaders(secondHar, impervaUrl);
  const carryHeader = headers.cookie || documentHeaders(booksHar, travel.url || SITES.books).cookie || "";
  const carryNames = carryHeader.split(/;\s*/).map((part) => part.split("=")[0] || "");
  const carry: Record<string, string> = {};
  for (const name of ["visid_incap", "incap_ses"]) carry[name] = carryNames.some((item) => item.startsWith(name)) ? "yes" : "no";
  const status = await cmd(link, "status") as PageRead;
  const page = await readPage(link);
  const har = [...tlsHar, ...booksHar, ...secondHar];
  const harFile = path.join(ARTIFACTS, "human.har.json");
  writeFileSync(harFile, JSON.stringify(har, null, 2));
  const after = cookieJar(((await cmd(link, "cookies", { url: impervaUrl })).cookies || []) as { name?: string; value?: string }[]);
  return {
    tls,
    headers: { ...documentHeaders(tlsHar, SITES.tls), ...documentHeaders(booksHar, travel.url || SITES.books) },
    cookies: { ...firstCookies, ...after },
    carry,
    trusted: clicked.trusted,
    gesture,
    badge: String(status.badge || ""),
    webdriver: page.webdriver === true ? "true" : "false",
    language: String(page.language || ""),
    platform: String(page.platform || ""),
    harFile,
  };
}

async function captureExtension(link: ExtensionLink, gesture: Gesture, impervaUrl: string): Promise<SignalBag> {
  await cmd(link, "disarm");
  await cmd(link, "watch", { all: true });
  await cmd(link, "open", { url: SITES.tls, inject: true, dialogs: false, fresh: true }, 45000);
  const tlsPage = await readPage(link);
  const tlsHar = await flushHar(link);
  await cmd(link, "goto", { url: SITES.books, gesture: emptyGesture() }, 45000);
  await sleep(800);
  await cmd(link, "drive-click", { selector: "a[href*='travel']", gesture }, 20000);
  await sleep(800);
  const travel = await readPage(link);
  const events = await flushEvents(link);
  const booksHar = await flushHar(link);
  await cmd(link, "goto", { url: impervaUrl, gesture: emptyGesture() }, 45000);
  await sleep(2500);
  await flushHar(link);
  await cmd(link, "goto", { url: impervaUrl, gesture: emptyGesture() }, 45000);
  await sleep(2500);
  const secondHar = await flushHar(link);
  const headers = documentHeaders(secondHar, impervaUrl);
  const carryNames = (headers.cookie || "").split(/;\s*/).map((part) => part.split("=")[0] || "");
  const carry: Record<string, string> = {};
  for (const name of ["visid_incap", "incap_ses"]) carry[name] = carryNames.some((item) => item.startsWith(name)) ? "yes" : "no";
  const cookies = cookieJar(((await cmd(link, "cookies", { url: impervaUrl })).cookies || []) as { name?: string; value?: string }[]);
  const status = await cmd(link, "status") as PageRead;
  const harFile = path.join(ARTIFACTS, "extension.har.json");
  writeFileSync(harFile, JSON.stringify([...tlsHar, ...booksHar, ...secondHar], null, 2));
  const replayGesture = gestureFrom(events);
  return {
    tls: tlsFields(tlsPage.text || ""),
    headers: { ...documentHeaders(tlsHar, SITES.tls), ...documentHeaders(booksHar, travel.url || SITES.books) },
    cookies,
    carry,
    trusted: trustedOf(events),
    gesture: replayGesture.pointer.length || replayGesture.dwellMs ? replayGesture : gesture,
    badge: String(status.badge || ""),
    webdriver: tlsPage.webdriver === true ? "true" : "false",
    language: String(tlsPage.language || ""),
    platform: String(tlsPage.platform || ""),
    harFile,
  };
}

async function capturePlaywright(): Promise<SignalBag> {
  const dir = path.join(ROOT, "pw-signals");
  const netlog = path.join(ARTIFACTS, "playwright.netlog.json");
  const ctx = await launchOwnedChrome({
    userDataDir: dir,
    headless: process.env.BAO_HEADED === "1" ? false : true,
    args: [`--log-net-log=${netlog}`, "--net-log-capture-mode=IncludeSensitive"],
  });
  const har: HarEntry[] = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on("request", (request) => {
      const headers = request.headers();
      har.push({
        url: request.url(),
        method: request.method(),
        requestHeaders: Object.entries(headers).map(([name, value]) => ({
          name,
          value: /cookie/i.test(name) ? hashCookieHeader(value) : value,
        })),
        responseHeaders: [],
      });
    });
    page.on("response", (response) => {
      const entry = [...har].reverse().find((item) => item.url === response.url() && item.status == null);
      if (!entry) return;
      entry.status = response.status();
      const headers = response.headers();
      entry.responseHeaders = Object.entries(headers).map(([name, value]) => ({
        name,
        value: /set-cookie/i.test(name) ? `${value.split("=")[0]}=${hashValue(value)}` : value,
      }));
    });
    await page.goto(SITES.tls, { waitUntil: "domcontentloaded", timeout: 30000 });
    const tlsText = await page.locator("body").innerText().catch(() => "");
    const nav = await page.evaluate(() => ({
      webdriver: navigator.webdriver === true,
      language: navigator.language,
      platform: navigator.platform,
    }));
    await page.goto(SITES.books, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.evaluate(() => {
      const host = window as unknown as { __obs?: { type: string; t: number; trusted: boolean }[] };
      host.__obs = [];
      const start = performance.now();
      for (const type of ["pointermove", "click"]) {
        document.addEventListener(type, (event) => {
          const pe = event as PointerEvent;
          host.__obs?.push({ type, t: Math.round(performance.now() - start), trusted: pe.isTrusted });
        }, true);
      }
    });
    const before = Date.now();
    await page.click("a[href*='travel']", { timeout: 15000 });
    const dwell = Date.now() - before;
    const obs = await page.evaluate(() => (window as unknown as { __obs?: Obs[] }).__obs || []);
    const impervaUrl = String(results.impervaUrl || SITES.imperva);
    await page.goto(impervaUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
    await sleep(2000);
    await page.goto(impervaUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
    await sleep(1500);
    const cookies = await ctx.cookies(impervaUrl);
    const jar = cookieJar(cookies);
    const headerBag = documentHeaders(har, impervaUrl);
    const carryNames = (headerBag.cookie || "").split(/;\s*/).map((part) => part.split("=")[0] || "");
    const carry: Record<string, string> = {};
    for (const name of ["visid_incap", "incap_ses"]) carry[name] = carryNames.some((item) => item.startsWith(name)) ? "yes" : "no";
    const harFile = path.join(ARTIFACTS, "playwright.har.json");
    writeFileSync(harFile, JSON.stringify(har, null, 2));
    const gesture = gestureFrom(obs);
    if (!gesture.dwellMs) gesture.dwellMs = dwell;
    return {
      tls: tlsFields(tlsText),
      headers: { ...documentHeaders(har, SITES.tls), ...documentHeaders(har, SITES.books) },
      cookies: jar,
      carry,
      trusted: trustedOf(obs),
      gesture,
      badge: "",
      webdriver: nav.webdriver ? "true" : "false",
      language: nav.language,
      platform: nav.platform,
      harFile,
    };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

function align(human: Record<string, string>, extension: Record<string, string>, playwright: Record<string, string>): SignalField[] {
  const names = new Set([...Object.keys(human), ...Object.keys(extension), ...Object.keys(playwright)]);
  return [...names].sort().map((name) => ({
    name,
    human: human[name] ?? "",
    extension: extension[name] ?? "",
    playwright: playwright[name] ?? "",
  }));
}

async function runSignals(link: ExtensionLink, chrome: ChromeRun, patterns: string[]): Promise<void> {
  log("signals: human");
  const humanLog = path.join(ARTIFACTS, "human.netlog.json");
  await chrome.launch({ netlog: humanLog });
  let impervaUrl = SITES.imperva;
  await cmd(link, "disarm");
  await humanGoto(link, impervaUrl).catch(() => undefined);
  const probe = await readPage(link).catch(() => ({} as PageRead));
  if (/ERR_|can.t be reached|chrome-error/i.test(`${probe.url} ${probe.title} ${probe.text}`)) impervaUrl = SITES.impervaFallback;
  results.impervaUrl = impervaUrl;
  const human = await captureHuman(link, patterns);
  await chrome.quit();
  await redactNetlog(humanLog, path.join(ARTIFACTS, "human.netlog.redacted.json"));
  rmSync(humanLog, { force: true });
  log("signals: extension");
  const extLog = path.join(ARTIFACTS, "extension.netlog.json");
  await chrome.launch({ netlog: extLog });
  const extension = await captureExtension(link, human.gesture, impervaUrl);
  await chrome.quit();
  await redactNetlog(extLog, path.join(ARTIFACTS, "extension.netlog.redacted.json"));
  rmSync(extLog, { force: true });
  log("signals: playwright");
  const playwright = await capturePlaywright();
  const pwLog = path.join(ARTIFACTS, "playwright.netlog.json");
  await redactNetlog(pwLog, path.join(ARTIFACTS, "playwright.netlog.redacted.json"));
  rmSync(pwLog, { force: true });
  const fields = align(fieldsOf(human), fieldsOf(extension), fieldsOf(playwright));
  const diff = diffSignals(fields);
  results.signals = {
    compared: fields.length,
    identical: fields.length - diff.length,
    diff,
    humanTrusted: human.trusted,
    extensionTrusted: extension.trusted,
    playwrightTrusted: playwright.trusted,
    impervaUrl,
  };
  writeFileSync(path.join(ARTIFACTS, "signal-diff.json"), `${JSON.stringify(results.signals, null, 2)}\n`);
  save();
}

function verdictSnippet(text: string): string {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const picked = lines.filter((line) => /webdriver|headless|bot|stealth|lie|trust|chrome|missing|present|passed|failed|human|automation/i.test(line));
  return picked.slice(0, 30).join("\n").slice(0, 1500);
}

async function fingerprintOne(link: ExtensionLink, who: string, open: (url: string) => Promise<void>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const pages: [string, string, number][] = [
    ["creepjs", SITES.creep, 40000],
    ["botd", SITES.botd, 12000],
    ["sannysoft", SITES.sannysoft, 12000],
  ];
  for (const [name, url, wait] of pages) {
    await cmd(link, "disarm").catch(() => undefined);
    await open(url);
    await sleep(wait);
    const page = await readPage(link);
    const file = await shot(link, `${who}-${name}.jpg`);
    out[name] = {
      url: page.url,
      title: page.title,
      webdriver: page.webdriver === true,
      snippet: verdictSnippet(page.text || ""),
      screenshot: file,
    };
    log(`${who} ${name} webdriver=${page.webdriver === true}`);
  }
  return out;
}

async function runFingerprints(link: ExtensionLink, chrome: ChromeRun): Promise<void> {
  log("fingerprints");
  await chrome.launch({});
  const human = await fingerprintOne(link, "human", (url) => humanGoto(link, url).then(() => undefined));
  await cmd(link, "disarm");
  const extension = await fingerprintOne(link, "extension", async (url) => {
    await cmd(link, "open", { url, inject: false, fresh: true, dialogs: false }, 45000);
  });
  results.fingerprints = { human, extension };
  save();
}

function loadError(page: PageRead): boolean {
  return /chrome-error:|ERR_|can.t be reached|dns_probe|name not resolved/i.test(`${page.url} ${page.title} ${page.text}`);
}

function challenged(page: PageRead): { challenged: boolean; reason: string; snippet: string } {
  const snippet = `${page.title || ""} | ${page.url || ""} | ${(page.text || "").replace(/\s+/g, " ").slice(0, 220)}`;
  if (loadError(page)) return { challenged: false, reason: "load error", snippet };
  const decision = classifyPage({
    url: page.url,
    title: page.title,
    texts: [page.text || ""],
    markers: page.markers || [],
    iframeSrcs: page.iframes || [],
    targetPresent: false,
  });
  const hay = `${page.title || ""} ${page.text || ""} ${(page.markers || []).join(" ")}`;
  const extra = hay.match(/just a moment|checking your browser|pardon our interruption|incapsula incident|attention required|verify you are human|cf-browser-verification|enable javascript and cookies|powered by imperva|sorry, you have been blocked/i);
  if (decision.class === "bot_wall") return { challenged: true, reason: `${decision.vendor || "bot"} ${decision.reason}`, snippet };
  if (extra) return { challenged: true, reason: extra[0], snippet };
  return { challenged: false, reason: "passed", snippet };
}

async function runRates(link: ExtensionLink, chrome: ChromeRun): Promise<void> {
  log("rates");
  const sites = [
    ["cloudflare", SITES.cloudflare],
    ["imperva", String(results.impervaUrl || SITES.imperva)],
  ] as const;
  const table: Record<string, unknown> = {};
  await chrome.launch({});
  for (const [name, url] of sites) {
    const human: { challenged: boolean; reason: string }[] = [];
    const extension: { challenged: boolean; reason: string }[] = [];
    for (let i = 1; i <= 10; i++) {
      const order = i % 2 === 1 ? ["human", "extension"] : ["extension", "human"];
      for (const who of order) {
        let page: PageRead = {};
        try {
          if (who === "human") {
            await cmd(link, "disarm");
            await focusChrome();
            xdo(["key", "ctrl+t"]);
            await sleep(250);
            page = await humanGoto(link, url);
          } else {
            await cmd(link, "open", { url, inject: false, fresh: true, dialogs: false }, 45000);
            page = await readPage(link);
          }
          await sleep(WAIT_MS);
          page = await readPage(link);
        } catch (err) {
          page = { title: "load error", text: err instanceof Error ? err.message : String(err), url };
        }
        const row = challenged(page);
        if (who === "human") human.push(row);
        else extension.push(row);
        if (i === 1) {
          await shot(link, `rate-${name}-${who}.jpg`);
          writeFileSync(path.join(ARTIFACTS, `rate-${name}-${who}.txt`), `${row.snippet}\n`);
        }
        log(`${name} ${who} ${i} ${row.reason}`);
      }
      results.rates = table;
      save();
    }
    table[name] = {
      human: `${human.filter((row) => row.challenged).length}/10`,
      extension: `${extension.filter((row) => row.challenged).length}/10`,
      humanReasons: human.map((row) => row.reason),
      extensionReasons: extension.map((row) => row.reason),
    };
  }
  await chrome.quit();
  for (const [name, url] of sites) {
    const rows: { challenged: boolean; reason: string }[] = [];
    const dir = path.join(ROOT, `pw-rate-${name}`);
    const ctx = await launchOwnedChrome({ userDataDir: dir, headless: process.env.BAO_HEADED === "1" ? false : true });
    try {
      for (let i = 1; i <= 10; i++) {
        const page = await ctx.newPage();
        let read: PageRead = {};
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
          await sleep(WAIT_MS);
          read = await page.evaluate(() => ({
            title: document.title,
            url: location.href,
            text: (document.body?.innerText || "").slice(0, 4000),
            webdriver: navigator.webdriver === true,
          }));
        } catch (err) {
          read = { title: "load error", text: err instanceof Error ? err.message : String(err) };
        }
        rows.push(challenged(read));
        if (i === 1) {
          await page.screenshot({ path: path.join(ARTIFACTS, `rate-${name}-playwright.png`), type: "png" }).catch(() => undefined);
        }
        await page.close().catch(() => undefined);
        log(`${name} playwright ${i} ${rows.at(-1)?.reason}`);
      }
    } finally {
      await ctx.close().catch(() => undefined);
    }
    const block = table[name] as Record<string, unknown>;
    block.playwright = `${rows.filter((row) => row.challenged).length}/10`;
    block.playwrightReasons = rows.map((row) => row.reason);
    results.rates = table;
    save();
  }
}

const P1_A: Record<string, string> = {
  "Bao Record": "Bao Alpha",
  "bao-record@example.com": "bao-alpha@example.com",
  "Hello from the proof record.": "Hello from replay alpha.",
  Canada: "United States",
  "1990": "1992",
};
const P1_B: Record<string, string> = {
  "Bao Record": "Bao Beta",
  "bao-record@example.com": "bao-beta@example.com",
  "Hello from the proof record.": "Hello from replay beta.",
  Canada: "India",
  "1990": "1988",
};
const P9_A: Record<string, string> = { Bao: "Ada", "1 Market": "2 Market", "San Francisco": "New York", "94105": "10001" };
const P9_B: Record<string, string> = { Bao: "Grace", "1 Market": "3 Market", "San Francisco": "Boston", "94105": "02139" };

function p1Args(workflow: WorkflowV2, run: 1 | 2, file: string): ReplayArgs {
  const defaults = { ...(run === 1 ? P1_A : P1_B) };
  const recorded = workflow.inputs.map((input) => input.default).find((value) => !!value && value.includes("@"));
  if (recorded) defaults[recorded] = recorded.replace("bao-record-", run === 1 ? "bao-alpha-" : "bao-beta-");
  return argsFor(workflow, {
    secret: run === 1 ? "BaoProof-replay-a-9" : "BaoProof-replay-b-9",
    file: { name: path.basename(file), path: file },
    byDefault: defaults,
    byName: run === 1 ? { days: "12", months: "3", years: "1992" } : { days: "21", months: "11", years: "1988" },
  }) as ReplayArgs;
}

async function settle(): Promise<void> {
  await sleep(450);
}

async function drive(link: ExtensionLink, params: Record<string, unknown>): Promise<void> {
  const op = String(params.op || "drive-click");
  await cmd(link, op, params, 30000);
  await settle();
}

async function waitText(link: ExtensionLink, needle: string, ms = 20000): Promise<Record<string, unknown>> {
  const start = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - start < ms) {
    last = await cmd(link, "text", {}, 15000);
    const hay = `${last.title || ""} ${last.text || ""} ${last.url || ""}`;
    if (hay.toLowerCase().includes(needle.toLowerCase())) return last;
    await sleep(300);
  }
  throw new Error(`timed out waiting for "${needle}" at ${String(last.url || "?")} — ${String(last.text || "").slice(0, 180)}`);
}

function viewOf(body: Record<string, unknown>): PageView {
  return { url: String(body.url || ""), title: String(body.title || ""), text: String(body.text || "") };
}

function runView(result: RunResult, proofs: { action?: string; name?: string; via?: string }[]): RunView {
  return {
    runId: result.runId,
    status: result.status,
    modelCalls: result.modelCalls,
    pausedKind: result.pausedKind,
    heals: result.heals,
    fileProof: proofs,
    steps: result.steps.map((step) => ({
      id: step.id,
      status: step.status,
      reason: step.reason,
      phase: step.phase,
      snapshot: step.snapshot ? { ax: typeof step.snapshot.ax === "string" ? step.snapshot.ax : undefined, dom: step.snapshot.dom } : undefined,
    })),
    ask: result.ask,
    outputs: (result.outputs || []).flatMap((item) => item.type === "table" ? [{ name: item.name, type: item.type, rows: item.rows }] : []),
  };
}

async function replayExtension(link: ExtensionLink, workflow: WorkflowV2, args: ReplayArgs, dialogs: boolean): Promise<{ result: RunResult; page: PageView; proofs: { name?: string }[] }> {
  const driver = new ExtensionDriver(link, readGestures(BAO, workflow.id), undefined, undefined, dialogs);
  if (workflow.startUrl.startsWith("http")) await driver.open(workflow.startUrl);
  const result = await replay(workflow, args, driver, {
    heal: unavailableHeal(),
    holdForPerson: false,
    now: () => Date.now(),
    runId: `ext-${workflow.id}-${Date.now().toString(36)}`,
  });
  const page = viewOf(await cmd(link, "text", {}, 15000));
  await driver.end();
  return { result, page, proofs: driver.proofs };
}

async function replayPlaywright(workflow: WorkflowV2, args: ReplayArgs): Promise<{ result: RunResult; page: PageView; proofs: { name?: string }[] }> {
  const dir = path.join(ROOT, `pw-task-${workflow.id}-${Date.now().toString(36)}`);
  const ctx: BrowserContext = await launchOwnedChrome({
    userDataDir: dir,
    headless: process.env.BAO_HEADED === "1" ? false : true,
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    const driver = new BrowserDriver(page);
    if (workflow.startUrl.startsWith("http")) await page.goto(workflow.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    const result = await replay(workflow, args, driver, {
      heal: unavailableHeal(),
      holdForPerson: false,
      now: () => Date.now(),
    });
    const text = await page.evaluate(() => {
      const parts: string[] = [];
      const visit = (node: Node) => {
        if (!(node instanceof Element)) return;
        if (node.shadowRoot) visit(node.shadowRoot);
        if ((node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && node.type !== "password" && node.value) parts.push(node.value);
      };
      if (document.body) visit(document.body);
      const strip = document.getElementById("bao-control-strip")?.innerText || "";
      return `${strip}\n${document.body?.innerText || ""}\n${parts.join("\n")}`.slice(0, 20000);
    });
    return { result, page: { url: page.url(), title: await page.title(), text }, proofs: driver.proofs };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function recordWorkflow(link: ExtensionLink, id: string, startUrl: string, run: (capture: Capture) => Promise<void>): Promise<WorkflowV2> {
  const capture = new Capture();
  const gestures = new Map<string, Gesture>();
  link.onTrail((event, gesture) => {
    if (!capture.push(event as Omit<TrailEvent, "id" | "ts">)) return;
    const stored = capture.events[capture.events.length - 1];
    if (stored && gesture) gestures.set(stored.id, gesture);
  });
  capture.start();
  await cmd(link, "arm-record", { url: startUrl, dialogs: true });
  await cmd(link, "open", { url: startUrl, dialogs: true, inject: true }, 45000);
  await run(capture);
  await sleep(800);
  capture.recording = false;
  const events = capture.events;
  const built = explain(events, { id, name: id, startUrl: captureStartUrl(events, startUrl) });
  built.workflow.driver = "extension";
  writeGestures(BAO, built.workflow.id, gestureQueue(built.workflow.steps, built.groups, gestures));
  writeFileSync(path.join(ARTIFACTS, `${id}.workflow.json`), `${JSON.stringify(built.workflow, null, 2)}\n`);
  await cmd(link, "disarm").catch(() => undefined);
  return built.workflow;
}

async function runTasks(link: ExtensionLink, chrome: ChromeRun): Promise<void> {
  log("tasks");
  await chrome.launch({});
  const taskResults: Record<string, unknown> = {};
  const recordFile = path.join(ARTIFACTS, "p1-record.txt");
  const replayA = path.join(ARTIFACTS, "p1-replay-a.txt");
  const replayB = path.join(ARTIFACTS, "p1-replay-b.txt");
  writeFileSync(recordFile, "proof record p1\n");
  writeFileSync(replayA, "proof replay a p1\n");
  writeFileSync(replayB, "proof replay b p1\n");
  try {
    const email = `bao-record-${Date.now().toString(36)}@example.com`;
    const workflow = await recordWorkflow(link, "ext-p1", SITES.signup, async () => {
      await waitText(link, "New User Signup");
      await drive(link, { op: "drive-fill", selector: "input[data-qa=signup-name]", text: "Bao Record" });
      await drive(link, { op: "drive-fill", selector: "input[data-qa=signup-email]", text: email });
      await drive(link, { op: "drive-click", selector: "button[data-qa=signup-button]" });
      await waitText(link, "Enter Account Information");
      await drive(link, { op: "drive-click", selector: "label[for=id_gender1]" });
      await drive(link, { op: "drive-fill", selector: "#password", text: "BaoProof-record-9" });
      await drive(link, { op: "drive-select", selector: "#days", value: "10" });
      await drive(link, { op: "drive-select", selector: "#months", value: "January" });
      await drive(link, { op: "drive-select", selector: "#years", value: "1990" });
      await drive(link, { op: "drive-fill", selector: "#first_name", text: "Bao" });
      await drive(link, { op: "drive-fill", selector: "#last_name", text: "Record" });
      await drive(link, { op: "drive-fill", selector: "#address1", text: "1 Proof Street" });
      await drive(link, { op: "drive-select", selector: "#country", value: "Canada" });
      await drive(link, { op: "drive-fill", selector: "#state", text: "Ontario" });
      await drive(link, { op: "drive-fill", selector: "#city", text: "Toronto" });
      await drive(link, { op: "drive-fill", selector: "#zipcode", text: "M5V1A1" });
      await drive(link, { op: "drive-fill", selector: "#mobile_number", text: "5550100000" });
      await drive(link, { op: "drive-click", selector: "button[data-qa=create-account]" });
      await waitText(link, "ACCOUNT CREATED");
      await drive(link, { op: "drive-click", selector: "a[data-qa=continue-button]" });
      await waitText(link, "Logged in as");
      await drive(link, { op: "drive-click", selector: "a[href='/contact_us']" });
      await waitText(link, "Get In Touch");
      await drive(link, { op: "drive-fill", selector: "input[data-qa=name]", text: "Bao Record" });
      await drive(link, { op: "drive-fill", selector: "input[data-qa=email]", text: email });
      await drive(link, { op: "drive-fill", selector: "input[data-qa=subject]", text: "Proof note" });
      await drive(link, { op: "drive-fill", selector: "textarea[data-qa=message]", text: "Hello from the proof record." });
      await cmd(link, "upload", { selector: "input[name=upload_file]", files: [{ name: path.basename(recordFile), path: recordFile }], gesture: emptyGesture() }, 30000);
      await settle();
      await drive(link, { op: "drive-click", selector: "input[data-qa=submit-button]" });
      await waitText(link, "submitted successfully");
      await drive(link, { op: "drive-click", selector: "a[href='/delete_account']" });
      await waitText(link, "ACCOUNT DELETED");
    });
    taskResults.p1 = await scoreTask(link, workflow, "p1", "completed", (run) => p1Args(workflow, run, run === 1 ? replayA : replayB), scoreP1, [replayA, replayB]);
  } catch (err) {
    taskResults.p1 = { error: err instanceof Error ? err.message : String(err) };
    log(`p1 ${taskResults.p1 && (taskResults.p1 as { error?: string }).error}`);
  }
  save();
  try {
    const workflow = await recordWorkflow(link, "ext-p5", SITES.books, async (capture) => {
      await waitText(link, "Books to Scrape");
      await drive(link, { op: "drive-click", selector: "a[href*='mystery']" });
      await waitText(link, "mystery");
      const proposed = await cmd(link, "propose", { selector: "article.product_pod" }, 20000);
      const proposal = proposed.proposal as PageProposal | undefined;
      if (!proposal || proposal.mode !== "list" || (proposal.count || 0) < 2) {
        throw new Error(`extract did not see a book list (${proposal?.error || proposal?.mode || "empty"})`);
      }
      const names: Record<string, string> = {};
      const drop: string[] = [];
      for (const column of proposal.columns) {
        const sample = (column.samples || []).join(" ");
        if (column.read === "title" || column.name === "title") names[column.id] = "title";
        else if (column.read === "rating" || /^(One|Two|Three|Four|Five)$/.test(column.samples?.[0] || "")) names[column.id] = "rating";
        else if (/£\d/.test(sample) || column.name.includes("price")) names[column.id] = "price";
        else drop.push(column.id);
      }
      const spec = specFromProposal(proposal, { names, drop, maxPages: 3, as: "books" });
      const click = [...capture.events].reverse().find((event) => event.op === "click");
      if (click) click.parameter = "category";
      capture.push({ kind: "act", op: "extract", extract: spec, locators: spec.locators });
    });
    taskResults.p5 = await scoreTask(link, workflow, "p5", "completed", (run) => argsFor(workflow, {
      byName: { category: run === 1 ? "Travel" : "Historical Fiction" },
    }) as ReplayArgs, (input) => {
      const csv = outputCsv(input.replay.outputs as Parameters<typeof outputCsv>[0], "books") || "";
      return scoreP5({ ...input, csv });
    }, ["", ""]);
  } catch (err) {
    taskResults.p5 = { error: err instanceof Error ? err.message : String(err) };
    log(`p5 ${String((taskResults.p5 as { error?: string }).error)}`);
  }
  save();
  try {
    const workflow = await recordWorkflow(link, "ext-p9", SITES.shop, async () => {
      await waitText(link, "YouTube Organic Cotton", 30000);
      await drive(link, { op: "drive-click", selector: "a[href*='YouTube']" });
      await waitText(link, "Add to Cart");
      await drive(link, { op: "drive-select", selector: "#sizeSelect", value: "M" });
      await drive(link, { op: "drive-select", selector: "#quantitySelect", value: "2" });
      await drive(link, { op: "drive-click", text: "Add to Cart" });
      await waitText(link, "View Cart");
      await drive(link, { op: "drive-click", selector: "#viewCartAnchor" });
      await waitText(link, "Your Cart");
      await drive(link, { op: "drive-click", text: "Checkout" });
      await waitText(link, "Account Information", 20000);
      await drive(link, { op: "drive-fill", selector: "#accountEmail", text: "bao-buyer@example.com" });
      await drive(link, { op: "drive-fill", selector: "#accountPhone", text: "4155550199" });
      await drive(link, { op: "drive-fill", selector: "#shipAddress", text: "1 Market" });
      await drive(link, { op: "drive-fill", selector: "#shipCity", text: "San Francisco" });
      await drive(link, { op: "drive-fill", selector: "#shipState", text: "CA" });
      await drive(link, { op: "drive-fill", selector: "#shipZip", text: "94105" });
      await drive(link, { op: "drive-fill", selector: "#ccName", text: "Bao" });
      await drive(link, { op: "drive-click", text: "Place Order" });
      await settle();
    });
    taskResults.p9 = await scoreTask(link, workflow, "p9", "needs_human", (run) => argsFor(workflow, {
      byDefault: run === 1 ? P9_A : P9_B,
    }) as ReplayArgs, scoreP9, ["", ""]);
  } catch (err) {
    taskResults.p9 = { error: err instanceof Error ? err.message : String(err) };
    log(`p9 ${String((taskResults.p9 as { error?: string }).error)}`);
  }
  results.tasks = taskResults;
  save();
}

async function scoreTask(
  link: ExtensionLink,
  workflow: WorkflowV2,
  id: string,
  expect: "completed" | "needs_human",
  argsForRun: (run: 1 | 2) => ReplayArgs,
  score: (input: Parameters<typeof scoreP1>[0]) => { pass: boolean; cause: string; detail: string },
  files: [string, string],
): Promise<Record<string, unknown>> {
  const runs = [];
  for (const run of [1, 2] as const) {
    await cmd(link, "clear-site", { url: workflow.startUrl }).catch(() => undefined);
    const args = argsForRun(run);
    const played = await replayExtension(link, workflow, args, true);
    const judged = score({
      run,
      replay: runView(played.result, played.proofs),
      page: played.page,
      workflow,
      args,
      files: { recordFile: files[0], replayFile: files, recordImage: files[0], replayImage: files },
      openUrl: workflow.startUrl,
      expect,
      csv: outputCsv(played.result.outputs, "books") || "",
    });
    await shot(link, `${id}-extension-r${run}.jpg`);
    runs.push({
      driver: "extension",
      run,
      pass: judged.pass,
      cause: judged.cause,
      detail: judged.detail,
      status: played.result.status,
      pausedKind: played.result.pausedKind,
      modelCalls: played.result.modelCalls,
    });
    log(`${id} extension r${run} ${judged.pass ? "pass" : judged.detail}`);
  }
  const pw = await replayPlaywright(workflow, argsForRun(1));
  const pwScore = score({
    run: 1,
    replay: runView(pw.result, pw.proofs),
    page: pw.page,
    workflow,
    args: argsForRun(1),
    files: { recordFile: files[0], replayFile: files, recordImage: files[0], replayImage: files },
    openUrl: workflow.startUrl,
    expect,
    csv: outputCsv(pw.result.outputs, "books") || "",
  });
  const playwright = {
    driver: "playwright",
    run: 1,
    pass: pwScore.pass,
    cause: pwScore.cause,
    detail: pwScore.detail,
    status: pw.result.status,
    pausedKind: pw.result.pausedKind,
    modelCalls: pw.result.modelCalls,
  };
  log(`${id} playwright ${pwScore.pass ? "pass" : pwScore.detail}`);
  const passed = runs.filter((item) => item.pass).length;
  return { pass: `${passed}/2`, modelCalls: runs.map((item) => item.modelCalls).join(", "), runs, playwright, steps: workflow.steps.map((step) => `${step.action} ${step.label}`) };
}

async function runWorker(link: ExtensionLink, chrome: ChromeRun, port: number): Promise<void> {
  log("worker");
  await chrome.launch({});
  const url = `http://127.0.0.1:${port}/worker.html`;
  await cmd(link, "open", { url, inject: true, fresh: true, dialogs: false }, 30000);
  await drive(link, { op: "drive-click", selector: "#one" });
  const first = await waitText(link, "one");
  const serial = link.helloSerial;
  const dropped = await cmd(link, "drop-worker", {}, 10000);
  const hello = await link.waitForHello(serial, 15000);
  await drive(link, { op: "drive-click", selector: "#two" });
  const second = await waitText(link, "two");
  let stall = "";
  const stallSerial = link.helloSerial;
  try {
    await cmd(link, "stall-and-drop", {}, 10000);
    stall = "resolved";
  } catch (err) {
    stall = err instanceof Error ? err.message : String(err);
  }
  await link.waitForHello(stallSerial, 15000).catch(() => undefined);
  const ping = await cmd(link, "ping", {}, 10000);
  const resumed = String(second.text || "").includes("one") && String(second.text || "").includes("two");
  const clean = /link dropped|restarted during the step/.test(stall);
  results.worker = {
    first: String(first.text || "").includes("one"),
    dropped,
    resumedHello: hello.resumed === true,
    resumed,
    stall,
    clean,
    ping: ping.ok === true || ping.phase != null,
  };
  log(`worker resumed=${resumed} stall=${stall}`);
  await runCadence(link, url);
  save();
}

async function runCadence(link: ExtensionLink, url: string): Promise<void> {
  await cmd(link, "disarm");
  await cmd(link, "observe", { patterns: [new URL(url).origin + "/*"] });
  await humanGoto(link, url);
  const box = await cmd(link, "box", { selector: "#note" }, 10000);
  await focusChrome();
  xdo(["mousemove", String(box.x || 0), String(box.y || 0), "click", "1"]);
  await sleep(200);
  xdo(["type", "--delay", "90", "bao"]);
  await sleep(300);
  const humanEvents = await flushEvents(link);
  const keys = humanEvents.filter((event) => event.type === "keydown" && event.t != null);
  const keyGaps: number[] = [];
  for (let i = 1; i < keys.length; i++) keyGaps.push(Math.max(0, Math.round((keys[i]!.t || 0) - (keys[i - 1]!.t || 0))));
  await cmd(link, "open", { url, inject: true, fresh: true, dialogs: false }, 30000);
  await cmd(link, "drive-fill", { selector: "#note", text: "bao", gesture: { dwellMs: 0, pointer: [], keyGaps } }, 20000);
  await sleep(200);
  const replayEvents = await flushEvents(link);
  const replayKeys = replayEvents.filter((event) => event.type === "keydown" && event.trusted === false && event.t != null);
  const replayGaps: number[] = [];
  for (let i = 1; i < replayKeys.length; i++) replayGaps.push(Math.max(0, Math.round((replayKeys[i]!.t || 0) - (replayKeys[i - 1]!.t || 0))));
  results.cadence = {
    humanGaps: keyGaps,
    replayGaps,
    humanTrusted: keys.some((event) => event.trusted === true),
    replayTrusted: replayKeys.some((event) => event.trusted === true),
  };
}

async function runGlance(link: ExtensionLink, chrome: ChromeRun): Promise<void> {
  log("glance");
  await chrome.launch({});
  const sites = [
    ["cloudflare", SITES.cloudflare],
    ["imperva", SITES.imperva],
  ] as const;
  const out: Record<string, unknown> = {};
  for (const [name, url] of sites) {
    await cmd(link, "disarm").catch(() => undefined);
    let page = await humanGoto(link, url);
    await sleep(WAIT_MS);
    page = await readPage(link);
    const human = challenged(page);
    await focusChrome();
    const humanShot = windowShot(`glance-${name}-human.png`);
    writeFileSync(path.join(ARTIFACTS, `glance-${name}-human.txt`), `${human.snippet}\n`);
    await cmd(link, "open", { url, inject: false, fresh: true, dialogs: false }, 45000);
    await sleep(WAIT_MS);
    page = await readPage(link);
    const extension = challenged(page);
    await focusChrome();
    const extensionShot = windowShot(`glance-${name}-extension.png`);
    writeFileSync(path.join(ARTIFACTS, `glance-${name}-extension.txt`), `${extension.snippet}\n`);
    out[name] = { human, extension, humanShot, extensionShot };
    log(`glance ${name} human ${human.reason} extension ${extension.reason}`);
  }
  results.glance = out;
  save();
}

async function runDebugger(link: ExtensionLink, chrome: ChromeRun, port: number): Promise<void> {
  log("debugger");
  await chrome.launch({});
  const url = `http://127.0.0.1:${port}/worker.html`;
  await cmd(link, "open", { url, inject: true, fresh: true, dialogs: false }, 30000);
  const measured = await cmd(link, "measure-debugger", {}, 15000);
  const windowFile = windowShot("debugger-infobar.png");
  await cmd(link, "detach-debugger").catch(() => undefined);
  results.debugger = {
    webdriver: measured.webdriver === true,
    innerDelta: measured.innerDelta,
    attached: measured.attached === true,
    windowShot: windowFile,
    prefer: "element.click and InputEvent. chrome.debugger is only used for DOM.setFileInputFiles and this measurement.",
  };
  save();
}

function startFixture(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const botd = (req.url || "").startsWith("/botd");
    const body = botd
      ? `<!doctype html><meta charset="utf-8"><title>BotD</title>
      <p id="verdict">loading botd</p>
      <script type="module">
        const verdict = document.getElementById("verdict");
        try {
          const lib = await import("https://openfpcdn.io/botd/v2");
          const result = await (await lib.load()).detect();
          verdict.textContent = "bot: " + result.bot + " kind: " + (result.botKind || "none");
        } catch (err) {
          verdict.textContent = "botd error: " + (err && err.message ? err.message : err);
        }
      </script>`
      : `<!doctype html><meta charset="utf-8"><title>worker</title>
      <button id="one">one</button><button id="two">two</button>
      <input id="note">
      <p id="log"></p>
      <script>
        document.getElementById("one").onclick = () => { document.getElementById("log").textContent += "one "; };
        document.getElementById("two").onclick = () => { document.getElementById("log").textContent += "two "; };
      </script>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(BAO, { recursive: true });
  if (!existsSync(path.join(EXT_DIR, "manifest.json"))) throw new Error("extension/dist is missing. Run npm run build:extension.");
  const fixture = await startFixture();
  SITES.botd = `http://127.0.0.1:${fixture.port}/botd`;
  results.botdSource = "https://openfpcdn.io/botd/v2 (fingerprintjs.github.io/BotD returns 404)";
  const origins = [
    "https://tls.peet.ws/*",
    "https://abrahamjuliot.github.io/*",
    "https://fingerprintjs.github.io/*",
    "https://nowsecure.nl/*",
    "https://www.nowsecure.nl/*",
    "https://bluefish.impvdemo.com/*",
    "https://www.imperva.com/*",
    "https://imperva.com/*",
    "https://bot.sannysoft.com/*",
    "https://automationexercise.com/*",
    "https://www.automationexercise.com/*",
    "https://books.toscrape.com/*",
    "https://shop.polymer-project.org/*",
    `http://127.0.0.1:${fixture.port}/*`,
  ];
  const link = await startExtensionLink({
    home: BAO,
    configHome: HOME,
    hostScript: hostScriptPath(),
    extraDirs: [path.join(PROFILE, "NativeMessagingHosts"), path.join(RATES_PROFILE, "NativeMessagingHosts")],
  });
  const chrome = new ChromeRun(link, PROFILE);
  try {
    log("grant");
    await grant(link, chrome, origins);
    if (!existsSync(RATES_PROFILE)) {
      run("cp", ["-a", PROFILE, RATES_PROFILE]);
      unlock(RATES_PROFILE);
    }
    const section = async (name: string, run: () => Promise<void>) => {
      if (!want(name)) return;
      try {
        await run();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[`${name}Error`] = message;
        log(`${name} error ${message}`);
        save();
        await chrome.quit().catch(() => undefined);
      }
    };
    await section("fingerprints", () => runFingerprints(link, chrome));
    await section("signals", () => runSignals(link, chrome, patternsFor(origins)));
    await section("tasks", () => runTasks(link, chrome));
    await section("debugger", () => runDebugger(link, chrome, fixture.port));
    await section("worker", () => runWorker(link, chrome, fixture.port));
    await section("glance", () => runGlance(link, chrome));
    await chrome.quit();
    if (want("rates")) {
      const rates = new ChromeRun(link, RATES_PROFILE);
      if (!existsSync(RATES_PROFILE)) {
        await chrome.quit();
        run("cp", ["-a", PROFILE, RATES_PROFILE]);
        unlock(RATES_PROFILE);
      }
      try {
        await runRates(link, rates);
      } finally {
        await rates.quit();
      }
    }
  } catch (err) {
    results.fatal = err instanceof Error ? err.message : String(err);
    log(`fatal ${results.fatal}`);
    save();
  } finally {
    await chrome.quit();
    await link.close();
    fixture.server.close();
    results.finishedAt = new Date().toISOString();
    save();
  }
  if (results.fatal) process.exitCode = 1;
}

void main();
