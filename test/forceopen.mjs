// Bao — Tier-C item 6 regression: opt-in MAIN-world attachShadow force-open turns a
// CLOSED shadow root (otherwise a hard limit → degrade) into an open one, so the
// deterministic Tier-A shadow-piercing capture replays it with no VLM, no CDP.
// Real-world shape: salesforce.com's closed <cs-native-frame-holder> (see the design
// doc §8 Tier-C). Here we use the controlled closed-shadow fixture.
//
// Run: npm run test:forceopen   (-- --headed to watch)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture-shadow.html")).href;

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED && !process.argv.includes("--headed") && !process.argv.includes("-H"),
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
    const send = (tabId, msg) => sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, msg]);
    const page = await ctx.newPage();
    const open = async () => {
      await page.goto(FIXTURE);
      await page.waitForLoadState("domcontentloaded");
      return sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, FIXTURE);
    };
    const recordOne = async (tabId, act) => {
      await send(tabId, { cmd: "start-record" });
      await act();
      return (await send(tabId, { cmd: "stop-record" })).steps;
    };

    // ---- CONTROL: force-open OFF → closed shadow is opaque, capture degrades ----
    console.log("\n• control (force-open OFF): closed shadow degrades");
    let tabId = await open();
    let closedReachable = await page.evaluate(() => document.querySelector("closed-card").shadowRoot !== null);
    check("closed root is NOT reachable by default", closedReachable === false);
    let steps = await recordOne(tabId, () => page.click("closed-card"));
    check("capture degrades (reach=opaque-custom)", steps[0]?.target?.reach === "opaque-custom", steps[0]?.target?.reach);
    check("marked degraded", steps[0]?.target?.degraded === true);

    // ---- ENABLE force-open, reload so the document_start patch runs ----
    console.log("\n• enable force-open (Tier-C item 6), reload");
    const enabled = await sw.evaluate(() => self.baoSetForceOpen(true));
    check("force-open registered", enabled?.ok === true, JSON.stringify(enabled));
    tabId = await open(); // fresh navigation → MAIN-world patch applies at document_start
    closedReachable = await page.evaluate(() => document.querySelector("closed-card").shadowRoot !== null);
    check("closed root is now OPEN (force-open worked)", closedReachable === true);

    // ---- capture + replay the once-closed inner button, fully deterministically ----
    console.log("\n• capture + replay the (now open) inner button");
    steps = await recordOne(tabId, () => page.click("closed-card button[data-testid=closed-btn]"));
    check("reach upgraded to open-shadow", steps[0]?.target?.reach === "open-shadow", steps[0]?.target?.reach);
    check("not degraded anymore", !steps[0]?.target?.degraded);
    check("top selector is a shadow-piercing path", steps[0]?.target?.selectors?.[0]?.type === "shadowpath");
    await page.evaluate(() => (window.__fired = []));
    const res = await send(tabId, { cmd: "replay", steps });
    check("replay ok (deterministic — no VLM/CDP)", res?.ok === true, JSON.stringify(res?.results));
    check("replay fired the once-closed inner button",
      (await page.evaluate(() => window.__fired))[0]?.testid === "closed-btn");

    // ---- DISABLE: back to honest degrade ----
    console.log("\n• disable force-open → back to opaque/degrade");
    const disabled = await sw.evaluate(() => self.baoSetForceOpen(false));
    check("force-open unregistered", disabled?.ok === true, JSON.stringify(disabled));
    tabId = await open();
    closedReachable = await page.evaluate(() => document.querySelector("closed-card").shadowRoot !== null);
    check("closed root opaque again", closedReachable === false);
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
