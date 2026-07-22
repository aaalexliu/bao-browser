// Regenerate the Chrome Web Store screenshots (1280x800) deterministically.
//
// Loads the built extension exactly as the E2E tests do (launchPersistentContext +
// --load-extension), seeds a fixed set of demo workflows + run history through the
// same SW entry points the tests use (self.baoSaveWorkflow + the bao-history IDB),
// then screenshots the real dashboard and side-panel UI. No live sites, no hand
// arranging: same input -> same PNGs every run.
//
//   npm run screenshots           (builds dist/ first, then runs this)
//   node assets/gen-screenshots.mjs   (assumes dist/ is already built)
//
// Output -> assets/store/01-dashboard.png, assets/store/02-sidepanel.png
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "assets/store");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- The demo library. Ordered so the newest (substack) sits at the top. ----
const s = (label, extra = {}) => ({ action: "click", label, ts: 1, ...extra });
const WORKFLOWS = [
  {
    key: "ramp",
    name: "File an expense",
    startUrl: "https://app.ramp.com/expenses/new",
    steps: [
      s('Click "New expense"'),
      { action: "input", label: "Type amount", value: "48.00", ts: 2 },
      s('Click "Submit"', { ts: 3 }),
    ],
  },
  {
    key: "hn",
    name: "Upvote top story",
    startUrl: "https://news.ycombinator.com/",
    steps: [s("Click upvote"), s("Click confirm", { ts: 2 })],
  },
  {
    key: "substack",
    name: "Publish a post",
    startUrl: "https://yourpub.substack.com/publish/post",
    steps: [
      s('Click "New post"'),
      { action: "input", label: "Type title", value: "Weekly digest", ts: 2 },
      s('Click "Continue"', { ts: 3 }),
      s('Click "Publish now"', { ts: 4 }),
    ],
  },
];

// Three green runs for "Publish a post", so the dashboard detail shows a run history.
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const publishSteps = WORKFLOWS.find((w) => w.key === "substack").steps;
const okResults = publishSteps.map((_, i) => ({ i, ok: true }));
const RUNS = [
  { ago: 59 * MIN, dur: 4100 },
  { ago: 1 * DAY, dur: 3900 },
  { ago: 2 * DAY, dur: 4300 },
].map((r, i) => {
  const finishedAt = Date.now() - r.ago;
  return {
    id: `run-demo-${i}`,
    workflowId: "", // filled in with the real id in the SW
    workflowName: "Publish a post",
    startUrl: "https://yourpub.substack.com/publish/post",
    startedAt: finishedAt - r.dur,
    finishedAt,
    outcome: "passed",
    results: okResults,
    steps: publishSteps,
    frames: publishSteps.map(() => null),
  };
});

// The composed side-panel shot: the real panel UI floating on a branded field.
const composeHtml = (panelB64) => `<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1280px;height:800px;overflow:hidden;display:flex;
    font-family:-apple-system,system-ui,"Segoe UI",sans-serif;
    background:linear-gradient(150deg,#FFF6EC 0%,#FBE7CF 100%)}
  .copy{flex:1;padding:0 72px;display:flex;flex-direction:column;justify-content:center;gap:20px}
  .badge{display:inline-flex;align-items:center;gap:9px;font-weight:700;font-size:17px;
    color:#B5591C}
  .badge .dot{width:26px;height:26px;border-radius:8px;
    background:linear-gradient(155deg,#FFB86B,#E8813A)}
  h1{font-size:52px;font-weight:800;letter-spacing:-1.5px;line-height:1.05;color:#2C2620}
  p{font-size:21px;line-height:1.45;color:#6B5B49;max-width:440px}
  .panel-wrap{width:452px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
    padding-right:64px}
  .panel{width:388px;border-radius:16px;overflow:hidden;background:#fff;
    border:1px solid rgba(0,0,0,.06);box-shadow:0 24px 60px rgba(120,70,20,.28)}
  .panel img{display:block;width:100%}
</style>
<div class="copy">
  <div class="badge"><span class="dot"></span>Bao</div>
  <h1>Record once.<br>Replay anywhere.</h1>
  <p>Capture any workflow in the side panel - Bao replays every step deterministically,
     on any site.</p>
</div>
<div class="panel-wrap">
  <div class="panel"><img src="data:image/png;base64,${panelB64}" /></div>
</div>`;

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED && !process.argv.includes("--headed"),
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });

  async function liveSw() {
    for (const sw of ctx.serviceWorkers()) {
      try { await sw.evaluate(() => 1); return sw; } catch (_) {}
    }
    return ctx.waitForEvent("serviceworker", { timeout: 10_000 });
  }
  const swEval = async (fn, arg) => (await liveSw()).evaluate(fn, arg);

  try {
    const extId = new URL((await liveSw()).url()).host;

    // ---- Seed the library through the SW's own save path ----
    const ids = await swEval(async (wfs) => {
      const out = {};
      for (const w of wfs) out[w.key] = (await self.baoSaveWorkflow(w.name, w.startUrl, w.steps)).id;
      return out;
    }, WORKFLOWS);

    // ---- Seed the run history straight into bao-history (as the T16 test does) ----
    await swEval(async ({ wfId, runs }) => {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open("bao-history", 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains("runs")) d.createObjectStore("runs");
          if (!d.objectStoreNames.contains("frames")) d.createObjectStore("frames");
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction("runs", "readwrite");
        for (const r of runs) { r.workflowId = wfId; tx.objectStore("runs").put(r, r.id); }
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    }, { wfId: ids.substack, runs: RUNS });

    // ---- 01: the dashboard, "Publish a post" selected ----
    const dash = await ctx.newPage();
    await dash.goto(`chrome-extension://${extId}/dashboard.html`);
    await sleep(500);
    await dash.locator(".card", { hasText: "Publish a post" }).click();
    await sleep(400);
    writeFileSync(resolve(OUT, "01-dashboard.png"), await dash.screenshot());
    console.log("  wrote assets/store/01-dashboard.png");

    // ---- 02: the side panel, composed onto a branded field ----
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 440, height: 800 });
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await sleep(500);
    const panelB64 = (await panel.screenshot()).toString("base64");

    const compose = await ctx.newPage();
    await compose.setViewportSize({ width: 1280, height: 800 });
    await compose.setContent(composeHtml(panelB64), { waitUntil: "networkidle" });
    await sleep(150);
    writeFileSync(resolve(OUT, "02-sidepanel.png"), await compose.screenshot());
    console.log("  wrote assets/store/02-sidepanel.png");
  } finally {
    await ctx.close();
  }
}

main().catch((e) => { console.error("\n✗ screenshot gen failed:", e); process.exit(1); });
