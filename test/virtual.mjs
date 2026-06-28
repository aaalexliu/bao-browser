// Bao — Tier-B virtualization regression: prove replay scroll-finds a target row
// that is NOT in the DOM at replay time (windowed list recycles ~14 nodes over
// 10,000 logical rows). Drives the real content.js. See §8 of the design doc.
//
// Run: npm run test:virtual   (HEADED=1 to watch it scroll)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture-virtual.html")).href;
const TARGET = "order-4400"; // far off-screen (row index 400) — never visible at top

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
    await page.goto(FIXTURE);
    await page.waitForLoadState("domcontentloaded");
    const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, FIXTURE);

    // Record: scroll the target into view (so it's a real, visible click), record it.
    await page.evaluate((id) => window.__scrollToId(id), TARGET);
    await send(tabId, { cmd: "start-record" });
    await page.click(`.row[data-id="${TARGET}"] button[data-testid="open"]`);
    const { steps } = await send(tabId, { cmd: "stop-record" });

    const t = steps[0]?.target;
    check("captured 1 step", steps?.length === 1, `got ${steps?.length}`);
    check("anchored on the row's stable content", t?.anchor?.kind === "text", JSON.stringify(t?.anchor));
    check("captured the scroll viewport", t?.scroll?.container === "#viewport", JSON.stringify(t?.scroll));

    // Scroll back to the top so the target is OUT of the DOM (the virtualization trap).
    await page.evaluate(() => { document.getElementById("viewport").scrollTop = 0; });
    await page.waitForTimeout(50);
    const presentAtTop = await page.evaluate((id) => !!document.querySelector(`.row[data-id="${id}"]`), TARGET);
    check("control: target is NOT in the DOM at replay start (virtualized away)", presentAtTop === false);

    // Replay: must scroll-find the row, then click the RIGHT one.
    await page.evaluate(() => (window.__fired = []));
    const res = await send(tabId, { cmd: "replay", steps });
    check("replay ok", res?.ok === true, JSON.stringify(res?.results));
    check("resolved via the content anchor (not an ambiguous on-screen row)",
      res?.results?.[0]?.via === "anchor", res?.results?.[0]?.via);
    const fired = await page.evaluate(() => window.__fired);
    check("clicked the RIGHT (scroll-found) row", fired[0]?.id === TARGET, JSON.stringify(fired));
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
