// Bao — Tier-A capture regression across the structural blind spots.
// Drives the REAL content.js (record → replay) through the same
// chrome.tabs.sendMessage path the popup uses, on local fixtures that reproduce
// each boundary. See use-cases-and-snapshot-fallback.md §8.
//
//   open / nested shadow  → composedPath piercing, full record→replay
//   native <select>       → change capture + select actuator, full record→replay
//   closed shadow         → graceful degrade (honest, no false selector)
//   canvas                → graceful degrade (pixels, no DOM target)
//
// Run: npm run test:blindspots   (HEADED=1 to watch)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const fx = (n) => pathToFileURL(resolve(__dirname, n)).href;

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
    const send = (tabId, msg) => sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, msg]);
    const page = await ctx.newPage();
    const openFixture = async (file) => {
      await page.goto(fx(file));
      await page.waitForLoadState("domcontentloaded");
      return sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, fx(file));
    };
    // Record one interaction and return its captured steps.
    const recordOne = async (tabId, act) => {
      await send(tabId, { cmd: "start-record" });
      await act();
      return (await send(tabId, { cmd: "stop-record" })).steps;
    };

    // ---- open shadow (single boundary): composedPath must reach the inner button ----
    console.log("\n• shadow: open (single boundary)");
    let tabId = await openFixture("fixture-shadow.html");
    let steps = await recordOne(tabId, () => page.click("open-card button[data-testid=open-btn]"));
    check("captured 1 step", steps?.length === 1, `got ${steps?.length}`);
    check("reach classified open-shadow", steps[0]?.target?.reach === "open-shadow", steps[0]?.target?.reach);
    check("top selector is a shadow-piercing path", steps[0]?.target?.selectors?.[0]?.type === "shadowpath");
    check("target resolvable (unique)", steps[0]?.target?.unique === true);
    await page.evaluate(() => (window.__fired = []));
    let res = await send(tabId, { cmd: "replay", steps });
    check("replay ok", res?.ok === true, JSON.stringify(res?.results));
    check("replay fired the INNER button (not the host)",
      (await page.evaluate(() => window.__fired))[0]?.testid === "open-btn");

    // ---- open shadow (nested ×2): path must hop two boundaries ----
    console.log("\n• shadow: nested ×2");
    steps = await recordOne(tabId, () => page.click("outer-card inner-card button[data-testid=nested-btn]"));
    const segs = JSON.parse(steps[0]?.target?.selectors?.[0]?.value || "[]");
    check("shadow path has 3 segments (outer→inner→btn)", segs.length === 3, JSON.stringify(segs));
    await page.evaluate(() => (window.__fired = []));
    res = await send(tabId, { cmd: "replay", steps });
    check("replay fired the deeply-nested button",
      res?.ok === true && (await page.evaluate(() => window.__fired))[0]?.testid === "nested-btn");

    // ---- closed shadow: must degrade honestly, not invent an inner selector ----
    console.log("\n• shadow: closed (graceful degrade)");
    steps = await recordOne(tabId, () => page.click("closed-card"));
    check("reach flags opaque-custom (closed-shadow tell)", steps[0]?.target?.reach === "opaque-custom", steps[0]?.target?.reach);
    check("marked degraded (no clean selector)", steps[0]?.target?.degraded === true);
    res = await send(tabId, { cmd: "replay", steps });
    check("replay fails cleanly with an escalation reason", res?.ok === false && /escalation/.test(res?.results?.[0]?.reason || ""), res?.results?.[0]?.reason);

    // ---- native <select>: change capture + actuator ----
    console.log("\n• native <select>");
    tabId = await openFixture("fixture-select.html");
    steps = await recordOne(tabId, () => page.selectOption("#state", "CA"));
    check("captured a select step", steps?.length === 1 && steps[0]?.action === "select", JSON.stringify(steps?.map((s) => s.action)));
    check("captured the chosen value", steps[0]?.value === "CA", steps[0]?.value);
    await page.selectOption("#state", ""); // reset, then prove replay re-drives it
    await page.evaluate(() => (window.__fired = []));
    res = await send(tabId, { cmd: "replay", steps });
    check("replay ok", res?.ok === true, JSON.stringify(res?.results));
    check("replay set the select to CA",
      res?.ok === true && (await page.inputValue("#state")) === "CA");

    // ---- canvas: pixels, no DOM target → degrade ----
    console.log("\n• canvas (graceful degrade)");
    tabId = await openFixture("fixture-canvas.html");
    const [cx, cy] = await page.evaluate(() => { const r = document.getElementById("c").getBoundingClientRect(); return [r.left + 80, r.top + 74]; });
    steps = await recordOne(tabId, () => page.mouse.click(cx, cy));
    check("captured 1 step", steps?.length === 1, `got ${steps?.length}`);
    check("reach classified canvas", steps[0]?.target?.reach === "canvas", steps[0]?.target?.reach);
    check("marked degraded + bbox captured (Tier-2/3 fuel)",
      steps[0]?.target?.degraded === true && steps[0]?.target?.bbox?.w > 0);
    res = await send(tabId, { cmd: "replay", steps });
    check("replay fails cleanly (needs escalation)", res?.ok === false && /escalation/.test(res?.results?.[0]?.reason || ""), res?.results?.[0]?.reason);
  } finally {
    await ctx.close();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => { console.error("\n✗ harness error:", e); process.exit(1); });
