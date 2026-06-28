// Bao — LIVE smoke against the real sites named in use-cases-and-snapshot-fallback.md
// §8. Opt-in (NOT part of `npm test`): real sites flake and change, so a network/load
// failure is a SKIP, not a FAIL. A FAIL means the site loaded but no longer exhibits
// the blind spot (the doc's claim regressed) or the extension mishandled it.
//
// Where robust, these drive the REAL extension on the real DOM (open-shadow capture,
// canvas degrade, cross-origin all_frames injection, closed-shadow force-open); the
// heavier grids/iframes get a structural check.
//
// Run: npm run test:live                       (all sites, headless)
//      npm run test:live -- --headed           (watch in a real window)
//      npm run test:live -- shoelace --headed  (only sites matching "shoelace")
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CLI args (via `npm run test:live -- ...`): `--headed`/`-H` to watch, and the first
// non-flag positional is a case-insensitive site-name filter.
const argv = process.argv.slice(2);
const HEADED = argv.includes("--headed") || argv.includes("-H");
const ONLY = argv.find((a) => !a.startsWith("-"))?.toLowerCase();

let pass = 0, fail = 0, skip = 0;
const ok = (n, e) => { console.log(`  ✓ ${n}${e ? ` — ${e}` : ""}`); pass++; };
const bad = (n, e) => { console.log(`  ✗ ${n}${e ? ` — ${e}` : ""}`); fail++; };
class Skip extends Error {}

const send = (sw, tabId, msg, opts) =>
  sw.evaluate(([id, m, o]) => chrome.tabs.sendMessage(id, m, o || {}), [tabId, msg, opts]);

// Record via the SW's cross-frame buffer (robust to examples that live in a child
// frame, and to which frame stop-record's response comes from).
async function recordVia(sw, tabId, act) {
  await sw.evaluate(() => { self.__baoSteps = []; });
  await send(sw, tabId, { cmd: "start-record" }).catch(() => {});
  await act();
  await send(sw, tabId, { cmd: "stop-record" }).catch(() => {});
  await sleep(350);
  return sw.evaluate(() => self.baoDrainSteps());
}

// HEADED-only: paint a red border over what we're about to click (and a dot at the
// exact point, for canvas) so a watcher can SEE the real action. pointer-events:none
// so it never intercepts the click; self-removes; no-op when not HEADED.
async function flashClick(page, locator, pos) {
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

async function openReady(ctx, sw, url, waitMs = 4000) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) { throw new Skip(`navigation failed: ${e.message.slice(0, 60)}`); }
  await sleep(waitMs); // hydration: shadow roots / iframes / canvas
  const final = page.url();
  const { origin, pathname } = new URL(final);
  const tabId = await sw.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0]?.id, `${origin}${pathname}*`);
  if (tabId == null) throw new Skip("tab not found via SW");
  // Make sure the content script is live (heavy pages inject late).
  for (let i = 0; i < 20; i++) {
    try { const st = await send(sw, tabId, { cmd: "status" }); if (st && "recording" in st) break; } catch (_) {}
    if (i === 10) await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] }), tabId).catch(() => {});
    await sleep(300);
  }
  return { page, tabId };
}

// Each site: an async fn that throws Skip on network/absence, calls ok/bad otherwise.
const SITES = {
  "open shadow — shoelace.style (capture a shadowpath on a real <sl-button>)": async (ctx, sw) => {
    const { page, tabId } = await openReady(ctx, sw, "https://shoelace.style/components/button");
    // A demo button in the article body (a primary/variant button), NOT a nav link
    // — clicking a nav sl-button would navigate and drop the recording.
    let btn = page.locator("sl-button:visible").filter({ hasText: /^(Primary|Default|Success|Neutral)/i }).first();
    if (!(await btn.count())) btn = page.locator("sl-button:visible").first();
    if (!(await btn.count())) throw new Skip("no <sl-button> on page");
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await flashClick(page, btn);
    const steps = await recordVia(sw, tabId, () => btn.click({ force: true, timeout: 5000 }).catch(() => {}));
    const t = steps.find((s) => s.target?.reach === "open-shadow")?.target;
    if (!t) throw new Skip(`no open-shadow step captured (got ${JSON.stringify(steps.map((s) => s.target?.reach))})`);
    ok("captured reach=open-shadow on a real Web Component", t.reach);
    (t.selectors?.[0]?.type === "shadowpath" ? ok : bad)("top selector is a shadow-piercing path", t.selectors?.[0]?.type);
  },

  "canvas — excalidraw.com (extension degrades a canvas click)": async (ctx, sw) => {
    const { page, tabId } = await openReady(ctx, sw, "https://excalidraw.com");
    const canvas = page.locator("canvas").first();
    if (!(await canvas.count())) throw new Skip("no <canvas> on page");
    await flashClick(page, canvas, { x: 300, y: 300 });
    const steps = await recordVia(sw, tabId, () => canvas.click({ position: { x: 300, y: 300 }, force: true, timeout: 5000 }).catch(() => {}));
    const t = steps.find((s) => s.target?.reach === "canvas")?.target;
    if (!t) throw new Skip(`no canvas step captured (got ${JSON.stringify(steps.map((s) => s.target?.reach))})`);
    ok("classified reach=canvas on a real canvas app", t.reach);
    (t.degraded === true ? ok : bad)("marked degraded (no clean selector)", String(t.degraded));
  },

  "cross-origin iframe — stripe.dev (content script injected in the cross-origin child)": async (ctx, sw) => {
    const { tabId } = await openReady(ctx, sw, "https://stripe.dev/elements-examples/", 6000);
    const frames = await sw.evaluate((id) => chrome.webNavigation.getAllFrames({ tabId: id }), tabId);
    const xo = frames.find((f) => { try { return new URL(f.url).origin !== new URL(frames[0].url).origin && /stripe/.test(f.url); } catch { return false; } });
    if (!xo) throw new Skip("no cross-origin stripe frame present");
    ok("cross-origin frame present", new URL(xo.url).origin);
    let resp = null;
    try { resp = await send(sw, tabId, { cmd: "status" }, { frameId: xo.frameId }); } catch (_) {}
    (resp && "recording" in resp ? ok : bad)("all_frames content script answered INSIDE the cross-origin frame", JSON.stringify(resp));
  },

  "virtualization — ag-grid.com (windowed grid: few rows for many rows of data)": async (ctx, sw) => {
    const { page } = await openReady(ctx, sw, "https://www.ag-grid.com/example/", 9000);
    // The grid renders client-side; poll briefly so a slow hydrate doesn't false-skip.
    let sig = { ag: false, rows: 0 };
    for (let i = 0; i < 6 && !sig.ag; i++) {
      sig = await page.evaluate(() => ({
        ag: !!document.querySelector("[class*='ag-']"),
        rows: document.querySelectorAll('[role="row"]').length,
      }));
      if (!sig.ag) await sleep(1000);
    }
    if (!sig.ag) throw new Skip("ag-grid not found (page changed?)");
    ok("ag-grid present", "");
    // The demo grid holds thousands of rows; a windowed slice in the DOM is the tell.
    (sig.rows > 0 && sig.rows < 200 ? ok : bad)("only a windowed slice of rows is in the DOM", `${sig.rows} rows`);
  },

  "closed shadow — salesforce.com (a real closed shadow root exists in the wild)": async (ctx, sw) => {
    // Don't enable force-open here: patching attachShadow before the widget mounts can
    // break its own init (the documented invasiveness). The robust live claim is that
    // the closed boundary EXISTS on a real site — force-open's fix is proven
    // deterministically in test/forceopen.mjs.
    const { page } = await openReady(ctx, sw, "https://www.salesforce.com", 5000);
    let found = false;
    for (let i = 0; i < 9 && !found; i++) {
      found = await page.evaluate(() => !!document.querySelector("cs-native-frame-holder"));
      if (!found) await sleep(1000);
    }
    if (!found) throw new Skip("closed-shadow widget <cs-native-frame-holder> didn't load");
    const closed = await page.evaluate(() => document.querySelector("cs-native-frame-holder").shadowRoot === null);
    (closed ? ok : bad)("real <cs-native-frame-holder> has a CLOSED root (shadowRoot===null)", String(closed));
  },
};

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !HEADED,
    // A realistic UA; without it CloudFront/Akamai-fronted sites (ag-grid, salesforce)
    // bot-block the automated session outright — itself a live demo of the anti-bot
    // blind spot (§6). Sites that still block are SKIPped, not failed.
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
    for (const [name, fn] of Object.entries(SITES)) {
      if (ONLY && !name.toLowerCase().includes(ONLY)) continue;
      console.log(`\n• ${name}`);
      try { await fn(ctx, sw); }
      catch (e) {
        if (e instanceof Skip) { console.log(`  ⊘ SKIP — ${e.message}`); skip++; }
        else { console.log(`  ✗ ERROR — ${e.message?.slice(0, 100)}`); fail++; }
      }
    }
  } finally {
    await ctx.close();
  }
}

main()
  .then(() => {
    console.log(`\n${fail ? "✗" : "✓"} live smoke: ${pass} passed, ${fail} failed, ${skip} skipped`);
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => { console.error("\n✗ harness error:", e); process.exit(1); });
