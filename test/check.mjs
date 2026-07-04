// T3 regression: checkbox / radio record STATE, replay as SET not toggle.
// A recorded check must end in the recorded state regardless of the box's state at
// replay: against an unchecked box it flips; against a pre-checked box it's a no-op
// (a naive el.click() would wrongly un-check it). Radio records the chosen option.
//
// Run: npm run test:check   (or: node test/check.mjs)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture-check.html")).href;

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function sendToContent(sw, tabId, msg) {
  return sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, msg]);
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

    const page = await ctx.newPage();
    await page.goto(FIXTURE);
    await page.waitForLoadState("domcontentloaded");

    const tabId = await sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, FIXTURE);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    // 1) Record: check the terms box, tick the label-wrapped newsletter box, pick green.
    await sendToContent(sw, tabId, { cmd: "start-record" });
    await page.check("#terms");
    await page.getByText("Subscribe to newsletter").click();
    await page.getByText("Green", { exact: true }).click();
    await page.waitForTimeout(50); // setChecked reads settled state on next task
    const { steps } = await sendToContent(sw, tabId, { cmd: "stop-record" });

    const setChecks = (steps || []).filter((s) => s.action === "setChecked");
    check("3 setChecked steps (no generic click steps)", setChecks.length === 3
      && !steps.some((s) => s.action === "click"),
      JSON.stringify(steps?.map((s) => s.action)));
    check("all recorded end-states are checked=true", setChecks.every((s) => s.checked === true),
      JSON.stringify(setChecks.map((s) => s.checked)));
    check("label-wrapped newsletter box resolved to its input (via label's a11y name)",
      setChecks.some((s) => JSON.stringify(s.target?.selectors || []).includes("Subscribe to newsletter")));

    // 2a) Replay against a fresh (all-unchecked) page → everything flips to checked.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    let replay = await sendToContent(sw, tabId, { cmd: "replay", steps });
    check("replay #1 ok (unchecked → checked)", replay?.ok === true, JSON.stringify(replay?.results));
    let state = await page.evaluate(() => ({
      terms: document.getElementById("terms").checked,
      news: document.querySelector('[name="news"]').checked,
      green: document.querySelector('[value="green"]').checked,
    }));
    check("terms checked", state.terms);
    check("newsletter checked", state.news);
    check("green radio selected", state.green);

    // 2b) Replay against a PRE-CHECKED terms box → must stay checked (set, not toggle).
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => { document.getElementById("terms").checked = true; });
    replay = await sendToContent(sw, tabId, { cmd: "replay", steps });
    check("replay #2 ok (pre-checked → no-op)", replay?.ok === true, JSON.stringify(replay?.results));
    const stillChecked = await page.evaluate(() => document.getElementById("terms").checked);
    check("pre-checked terms box stayed checked (NOT toggled off)", stillChecked === true);
  } finally {
    await ctx.close();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error("\n✗ harness error:", e);
    process.exit(1);
  });
