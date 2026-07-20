// Generate Chrome Web Store listing assets from the REAL extension UI.
// Loads the unpacked extension (Playwright, already a devDep), seeds realistic
// QA/dev workflows + run history, screenshots the actual dashboard / side panel /
// filmstrip, frames each into a 1280x800 store tile, and emits the 440x280 promo.
//   node store/gen-store-assets.mjs   [--raw]
import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(__dirname, "screenshots");
const RAW = resolve(OUT, "raw");
mkdirSync(RAW, { recursive: true });
const rawOnly = process.argv.includes("--raw");
const svg = readFileSync(resolve(ROOT, "assets/icon.svg"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataURI = (buf) => `data:image/png;base64,${buf.toString("base64")}`;

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});
async function liveSw() {
  for (const sw of ctx.serviceWorkers()) { try { await sw.evaluate(() => 1); return sw; } catch (_) {} }
  return ctx.waitForEvent("serviceworker", { timeout: 10_000 });
}
const swEval = async (fn, arg) => (await liveSw()).evaluate(fn, arg);
const extId = new URL((await liveSw()).url()).host;

// --- Render two believable page frames (recorded vs replayed) for the audit shot ---
async function renderFrame(html) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1000, height: 640 });
  await p.setContent(html, { waitUntil: "networkidle" });
  const buf = await p.screenshot();
  await p.close();
  return dataURI(buf);
}
const appShell = (body) => `<!doctype html><meta charset=utf8>
  <style>*{margin:0;box-sizing:border-box;font-family:system-ui}
  body{background:#eef1f6}.top{height:52px;background:#fff;border-bottom:1px solid #e5e7ee;
  display:flex;align-items:center;gap:10px;padding:0 22px;font-weight:700;color:#1c2333}
  .top .logo{width:22px;height:22px;border-radius:6px;background:#3355cc}
  .main{padding:34px 40px}.h{font-size:26px;font-weight:800;color:#151a29;letter-spacing:-.02em}
  .sub{color:#6a7285;margin-top:6px}.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:26px}
  .card{background:#fff;border:1px solid #e7eaf1;border-radius:12px;padding:18px;min-height:96px}
  .k{color:#8a93a6;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
  .v{font-size:24px;font-weight:800;color:#1c2333;margin-top:8px}
  .banner{margin-top:24px;background:#fdecea;border:1px solid #f5c2bb;color:#b5271b;
  border-radius:10px;padding:14px 16px;font-weight:600;display:flex;gap:10px;align-items:center}
  </style><div class=top><span class=logo></span>Acme Analytics</div><div class=main>${body}</div>`;
const recordedFrame = await renderFrame(appShell(
  `<div class=h>Dashboard</div><div class=sub>Welcome back, QA</div>
   <div class=grid><div class=card><div class=k>Active users</div><div class=v>12,480</div></div>
   <div class=card><div class=k>Revenue</div><div class=v>$84.2k</div></div>
   <div class=card><div class=k>Reports</div><div class=v>36</div></div></div>`));
const replayedFrame = await renderFrame(appShell(
  `<div class=h>Sign in</div><div class=sub>Session expired</div>
   <div class=banner>⚠ We couldn't verify your session. Please sign in again.</div>`));

// --- Seed realistic QA/dev workflows ---
const ids = await swEval(async () => {
  const mk = self.baoSaveWorkflow;
  const login = await mk("Login smoke test", "https://app.acme.com/login", [
    { action: "click", label: "Go to app.acme.com/login", ts: 1 },
    { action: "input", label: 'Type into "Email"', value: "qa@acme.com", ts: 2,
      target: { text: "Email", selectors: [{ type: "aria", value: "textbox “Email”" }, { type: "css", value: "input#email" }] } },
    { action: "input", label: "Password", sensitive: true, ts: 3,
      target: { selectors: [{ type: "css", value: "input#password" }] } },
    { action: "click", label: 'Click "Sign in"', ts: 4,
      target: { text: "Sign in", selectors: [{ type: "testid", value: "signin-btn" }, { type: "aria", value: "button “Sign in”" }] } },
    { action: "assert", label: 'Expect "Dashboard" present', ts: 5 },
  ]);
  const report = await mk("Export weekly report", "https://app.acme.com/reports", [
    { action: "click", label: 'Open "Reports"', ts: 1 },
    { action: "click", label: 'Select "Weekly"', ts: 2 },
    { action: "click", label: "Download report.csv", ts: 3 },
  ]);
  await mk("Checkout regression", "https://shop.acme.com/cart", [
    { action: "click", label: 'Click "Checkout"', ts: 1 },
    { action: "input", label: 'Type into "Address"', value: "1 Market St", ts: 2 },
    { action: "click", label: 'Click "Place order"', ts: 3 },
    { action: "assert", label: 'Expect "Order confirmed" present', ts: 4 },
  ]);
  return { login: login.id, report: report.id };
});

// --- Seed run history (a pass + a fail with real frames) for the login workflow ---
await swEval(async ({ wfId, recF, repF }) => {
  const put = (dbName, stores, store, key, blob) => new Promise((res, rej) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => { for (const s of stores) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    req.onsuccess = () => { const db = req.result; const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(blob, key); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
    req.onerror = () => rej(req.error);
  });
  const now = Date.now();
  const pass = {
    id: "run-pass", workflowId: wfId, workflowName: "Login smoke test",
    startUrl: "https://app.acme.com/login", startedAt: now - 86400000 - 3200, finishedAt: now - 86400000,
    outcome: "passed", results: [0,1,2,3,4].map((i) => ({ i, ok: true, via: ["nav","aria","masked","testid","assert"][i] })),
    steps: ["Go to /login","Type Email","Password","Sign in","Expect Dashboard"].map((label) => ({ label })),
    frames: [null,null,null,null,null],
  };
  const fail = {
    id: "run-fail", workflowId: wfId, workflowName: "Login smoke test",
    startUrl: "https://app.acme.com/login", startedAt: now - 4200, finishedAt: now, outcome: "failed",
    results: [{ i:0, ok:true, via:"nav" },{ i:1, ok:true, via:"aria" },{ i:2, ok:true, via:"masked" },
              { i:3, ok:true, via:"testid" },{ i:4, ok:false, reason:'"Dashboard" not found on page' }],
    steps: [{ label: "Go to app.acme.com/login", meta:{ goldenScreenshotRef:"g0" } },
            { label: "Type Email" },{ label: "Password" },{ label: "Sign in" },{ label: "Expect Dashboard" }],
    frames: ["run-fail:0", null, null, null, null],
  };
  await put("bao-golden", ["shots"], "shots", "g0", await (await fetch(recF)).blob());
  await put("bao-history", ["runs","frames"], "runs", "run-pass", pass);
  await put("bao-history", ["runs","frames"], "runs", "run-fail", fail);
  await put("bao-history", ["runs","frames"], "frames", "run-fail:0", await (await fetch(repF)).blob());
}, { wfId: ids.login, recF: recordedFrame, repF: replayedFrame });

// --- Raw captures of the real UI ---
async function capture(name, path, w, h, prep) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.goto(`chrome-extension://${extId}/${path}`);
  await sleep(500);
  if (prep) await prep(p);
  await sleep(300);
  writeFileSync(resolve(RAW, `${name}.png`), await p.screenshot());
  await p.close();
}
await capture("dashboard-detail", "dashboard.html", 1360, 852, async (p) => {
  await p.locator(".card", { hasText: "Login smoke test" }).click(); await sleep(400);
});
await capture("dashboard-debug", "dashboard.html", 1360, 852, async (p) => {
  await p.locator(".card", { hasText: "Login smoke test" }).click(); await sleep(300);
  await p.click("#ddebug"); await sleep(300);
  await p.locator("details.dbg summary").nth(3).click().catch(() => {}); await sleep(250); // expand the "Sign in" step
});
await capture("sidepanel", "sidepanel.html", 396, 720);
await capture("filmstrip", "dashboard.html", 1360, 852, async (p) => {
  await p.locator(".card", { hasText: "Login smoke test" }).click(); await sleep(300);
  await p.locator(".run-row").first().click(); await sleep(400);
});
console.log("raw captures ->", RAW);
if (rawOnly) { await ctx.close(); process.exit(0); }

// --- Compose each capture into a 1280x800 branded store tile ---
async function tile(name, eyebrow, title, rawFile, mode) {
  const raw = dataURI(readFileSync(resolve(RAW, rawFile)));
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const shot = mode === "panel"
    ? `<div class="panel-shell"><div class="pbar"><span class="pt">Bao side panel</span></div><img src="${raw}"></div>`
    : `<div class="win"><div class="wbar"><i></i><i></i><i></i><span class="wt">Bao</span></div><img src="${raw}"></div>`;
  const layout = mode === "panel"
    ? `<div class="split"><div class="copy"><p class="eyebrow">${eyebrow}</p><h2>${title}</h2>
         <ul class="pts"><li>Record while you work - no context switch</li>
         <li>Search &amp; group workflows by site</li><li>One click to replay</li></ul></div>${shot}</div>`
    : `<header><p class="eyebrow">${eyebrow}</p><h2>${title}</h2></header>${shot}`;
  await page.setContent(`<!doctype html><meta charset=utf8><style>
    *{margin:0;box-sizing:border-box}
    body{width:1280px;height:800px;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
      background:radial-gradient(120% 120% at 12% 0%, #eef2ff 0%, #e7ecfb 42%, #dfe6f8 100%);
      color:#10131f;padding:54px 60px;display:flex;flex-direction:column}
    .eyebrow{font:600 14px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:#2743a8}
    h2{font-size:38px;font-weight:800;letter-spacing:-.02em;margin-top:14px;max-width:20ch;line-height:1.06}
    header{margin-bottom:30px}
    .win{border-radius:14px;overflow:hidden;background:#fff;border:1px solid #d3daea;
      box-shadow:0 2px 4px rgba(16,19,31,.06),0 34px 70px -30px rgba(24,38,90,.5);margin:0 auto;width:1090px}
    .wbar{height:38px;background:#f3f5fa;border-bottom:1px solid #e4e8f1;display:flex;align-items:center;gap:8px;padding:0 15px}
    .wbar i{width:11px;height:11px;border-radius:50%;background:#d6dbe6}
    .wbar i:nth-child(1){background:#f0685a}.wbar i:nth-child(2){background:#f5bf4f}.wbar i:nth-child(3){background:#35c48d}
    .wbar .wt{margin-left:10px;font:600 12px ui-monospace,Menlo,monospace;color:#8791a8}
    .win img{display:block;width:100%}
    .split{display:flex;gap:52px;align-items:center;height:100%}
    .copy{flex:1}.copy h2{font-size:40px}.pts{list-style:none;margin:26px 0 0;padding:0;display:flex;flex-direction:column;gap:14px}
    .pts li{font-size:17px;color:#3a4256;padding-left:26px;position:relative}
    .pts li::before{content:"";position:absolute;left:0;top:9px;width:11px;height:11px;border-radius:3px;background:#3355cc}
    .panel-shell{width:380px;flex:none;border-radius:14px;overflow:hidden;background:#fff;border:1px solid #d3daea;
      box-shadow:0 2px 4px rgba(16,19,31,.06),0 34px 70px -30px rgba(24,38,90,.5)}
    .panel-shell .pbar{height:34px;background:#f3f5fa;border-bottom:1px solid #e4e8f1;display:flex;align-items:center;padding:0 14px}
    .panel-shell .pt{font:600 12px ui-monospace,Menlo,monospace;color:#8791a8}
    .panel-shell img{display:block;width:100%}
  </style>${layout}`, { waitUntil: "networkidle" });
  await sleep(250);
  writeFileSync(resolve(OUT, `${name}.png`), await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 800 } }));
  await page.close();
  console.log("  tile ->", `${name}.png`);
}

await tile("1-library", "Your workflow library", "Read every step. Replay on demand.", "dashboard-detail.png", "window");
await tile("2-debug", "Nothing hidden", "See exactly how each step resolves.", "dashboard-debug.png", "window");
await tile("3-history", "Audit every run", "Record-time vs replay-time, side by side.", "filmstrip.png", "window");
await tile("4-panel", "Record where you work", "Capture a task without leaving the page.", "sidepanel.png", "panel");

// --- 440x280 small promo tile ---
{
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 440, height: 280 });
  await page.setContent(`<!doctype html><meta charset=utf8><style>
    *{margin:0;box-sizing:border-box}
    body{width:440px;height:280px;overflow:hidden;font-family:system-ui,sans-serif;
      background:linear-gradient(140deg,#3a63e0,#2540a8);color:#fff;
      display:flex;align-items:center;gap:20px;padding:0 34px}
    .g{width:96px;height:96px;flex:none;filter:drop-shadow(0 10px 22px rgba(0,0,0,.35))}
    h1{font-size:40px;font-weight:800;letter-spacing:-.02em;line-height:1}
    p{margin-top:10px;font-size:15px;color:#dbe4ff;font-weight:500}
    .g svg{width:100%;height:100%}
  </style><div class="g">${svg}</div><div><h1>Bao</h1><p>Record a browser task once.<br>Replay it deterministically.</p></div>`,
    { waitUntil: "networkidle" });
  await sleep(200);
  writeFileSync(resolve(__dirname, "promo-tile-440x280.png"), await page.screenshot());
  await page.close();
  console.log("  promo -> promo-tile-440x280.png");
}

await ctx.close();
console.log("done.");
