// Bao — shared plumbing for the per-category live suites (live-gaps-*.mjs, and the
// blindspot suites).
//
// Each category is its own runnable file (record→replay→assert against a live,
// no-login target from recording-gaps-and-app-universe.md §Part 3 / the blindspot
// docs); they share the launch, the record/replay helpers, the ✓/✗/⊘ reporting, and
// the runner here.
//
// Contract: opt-in, NOT part of `npm test`. Real sites flake, so a load failure / fresh
// bot-block / missing structure is a SKIP; a FAIL means the site loaded and exhibited
// its structure but record→replay produced the wrong effect — i.e. a shipped capability
// regressed.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
export const HEADED = argv.includes("--headed") || argv.includes("-H");
// A case-insensitive positional filter — handy for the multi-case editors file
// (`... -- lexical`); a no-op for the single-case files.
const ONLY = argv.find((a) => !a.startsWith("-"))?.toLowerCase();

// Reporting counters shared within a single process (each file imports its own copy).
let pass = 0, fail = 0, skip = 0;
export const ok = (n, e) => { console.log(`  ✓ ${n}${e ? ` — ${e}` : ""}`); pass++; };
export const bad = (n, e) => { console.log(`  ✗ ${n}${e ? ` — ${e}` : ""}`); fail++; };
export class Skip extends Error {}

export const send = (sw, tabId, msg, opts) =>
  sw.evaluate(([id, m, o]) => chrome.tabs.sendMessage(id, m, o || {}), [tabId, msg, opts]);

// Record via the SW's cross-frame buffer: reset the buffer, arm the real content
// script, run `act`, stop, and drain what the content
// script reported at stop-record (`bao-frame-steps`) — includes softNav markers and
// coalesced input steps.
export async function recordVia(sw, tabId, act) {
  await sw.evaluate(() => { self.__baoSteps = []; });
  await send(sw, tabId, { cmd: "start-record" }).catch(() => {});
  await act();
  await send(sw, tabId, { cmd: "stop-record" }).catch(() => {});
  await sleep(350);
  return sw.evaluate(() => self.baoDrainSteps());
}
// Replay through the REAL content-script replayer (the M0 single-page path — every
// gap category here is a single-document flow).
export const replayVia = (sw, tabId, steps) => send(sw, tabId, { cmd: "replay", steps });

// Poll until the content script answers (heavy pages inject late); force-inject at the
// halfway mark if auto-injection hasn't landed. Reused after a page.reload().
export async function ensureReady(sw, tabId) {
  for (let i = 0; i < 20; i++) {
    try { const st = await send(sw, tabId, { cmd: "status" }); if (st && "recording" in st) return; } catch (_) {}
    if (i === 10) await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["dist/content.js"] }), tabId).catch(() => {});
    await sleep(300);
  }
}

export async function openReady(ctx, sw, url, waitMs = 4000) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) { throw new Skip(`navigation failed: ${e.message.slice(0, 60)}`); }
  await sleep(waitMs); // hydration: SPA mount / editor init
  const final = page.url();
  const { origin, pathname } = new URL(final);
  const tabId = await sw.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0]?.id, `${origin}${pathname}*`);
  if (tabId == null) throw new Skip("tab not found via SW");
  await ensureReady(sw, tabId);
  return { page, tabId };
}

export const reaches = (steps) => JSON.stringify(steps.map((s) => `${s.action}${s.mode ? ":" + s.mode : ""}`));
export const token = () => "baolive" + Math.random().toString(36).slice(2, 8);

// HEADED-only: paint a red border over what we're about to click (and a dot at the
// exact point, for canvas) so a watcher can SEE the real action. pointer-events:none so
// it never intercepts the click; self-removes; a no-op when not HEADED.
export async function flashClick(page, locator, pos) {
  if (!HEADED) return;
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return;
  await page.evaluate(({ box, pos }) => {
    const mk = (css) => {
      const d = document.createElement("div");
      d.className = "__baoFlash";
      d.style.cssText = `z-index:2147483647;pointer-events:none;position:fixed;${css}`;
      document.documentElement.appendChild(d);
    };
    mk(`left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;border:3px solid red;box-shadow:0 0 0 4px rgba(255,0,0,.25)`);
    if (pos) mk(`left:${box.x + pos.x - 9}px;top:${box.y + pos.y - 9}px;width:18px;height:18px;border-radius:50%;border:3px solid red;background:rgba(255,0,0,.35)`);
    setTimeout(() => document.querySelectorAll(".__baoFlash").forEach((n) => n.remove()), 2500);
  }, { box, pos });
  await page.waitForTimeout(700); // let the watcher see the target before the click fires
}

// Launch one persistent Chrome with the unpacked extension, run each case in `cases`
// (a { name: async (ctx, sw) => {} } map), report, and exit 0/1. Called once per file.
export async function runCases(cases, label) {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !HEADED,
    // Realistic UA so CDN-fronted sites don't bot-block the automated session outright
    // (a blocked site is a SKIP, per the live contract).
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 1000 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
    for (const [name, fn] of Object.entries(cases)) {
      if (ONLY && !name.toLowerCase().includes(ONLY)) continue;
      console.log(`\n• ${name}`);
      try { await fn(ctx, sw); }
      catch (e) {
        if (e instanceof Skip) { console.log(`  ⊘ SKIP — ${e.message}`); skip++; }
        else { console.log(`  ✗ ERROR — ${e.message?.slice(0, 120)}`); fail++; }
      }
    }
  } finally {
    await ctx.close();
  }
  console.log(`\n${fail ? "✗" : "✓"} ${label}: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail ? 1 : 0);
}
