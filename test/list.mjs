// Bao — the repeated-list regression: prove replay hits the RIGHT card among many
// identical ones, and that it survives DOM mutation (reorder / insert / delete)
// that shatters positional (nth-of-type) selectors.
//
// Run: npm run test:list   (or: node test/list.mjs ; HEADED=1 to watch)
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "out");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture-list.html")).href;
const TARGET = "c-1004"; // Dana's card — deliberately NOT the first card

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  await mkdir(OUT, { recursive: true });
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

    // Record a click on the target card's "Copy link" (one of six identical buttons).
    await send(tabId, { cmd: "start-record" });
    await page.click(`.card:has(a[href*="${TARGET}"]) button[aria-label="Copy link"]`);
    const { steps } = await send(tabId, { cmd: "stop-record" });
    await writeFile(resolve(OUT, "list-steps.json"), JSON.stringify(steps, null, 2));

    const t = steps[0]?.target;
    check("captured 1 step", steps?.length === 1);
    check("leaf is ambiguous → an anchor was attached", !!t?.anchor, JSON.stringify(t?.anchor));
    check("anchor keys off the card's stable id", t?.anchor?.id === TARGET, t?.anchor?.id);
    check("target marked unique (resolvable)", t?.unique === true);

    // The brittle truth: the recorded css path is positional. We'll prove below it
    // points at the WRONG card after a reorder — i.e. the anchor is load-bearing.
    const cssSel = t.selectors.find((s) => s.type === "css")?.value;

    async function replayAndCheck(label, mutate) {
      if (mutate) await page.evaluate(mutate);
      await page.evaluate(() => (window.__fired = []));
      const res = await send(tabId, { cmd: "replay", steps });
      const fired = await page.evaluate(() => window.__fired);
      check(`[${label}] replay ok`, res?.ok === true, JSON.stringify(res?.results));
      check(`[${label}] clicked the RIGHT card`, fired[0]?.card === TARGET,
        `fired ${JSON.stringify(fired)}`);
      return res;
    }

    // 1) baseline — same DOM
    await replayAndCheck("baseline", null);

    // 2) full reorder (reverse) — nth-of-type now lies
    const cssCardAfterReorder = await page.evaluate((sel) => {
      window.__reorder([5, 4, 3, 2, 1, 0]);
      try {
        const el = document.querySelector(sel);
        return el?.closest(".card")?.querySelector("a.permalink")?.getAttribute("href").match(/c-\d+/)?.[0] ?? null;
      } catch { return "INVALID"; }
    }, cssSel);
    check("control: recorded css path now points at the WRONG card (or breaks)",
      cssCardAfterReorder !== TARGET, `css → ${cssCardAfterReorder}`);
    await replayAndCheck("after reorder", null);

    // 3) insert a new card at the top — shifts every positional index
    await replayAndCheck("after prepend", () => window.__prepend());

    // 4) delete the current first card
    await replayAndCheck("after delete-first", () => window.__deleteFirst());
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
