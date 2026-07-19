// T16 UI smoke: the full-page dashboard opened as a regular extension page.
// Seeds two workflows on different domains + one run record (straight into the
// bao-history IndexedDB the SW reads), then asserts: cards render grouped by host,
// search filters, selecting a workflow renders its steps (with the ↦ start row) and
// its run history. Editing + the filmstrip land in later steps.
//
// Run: npm run test:dashboard   (or: node test/dashboard.mjs)
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED && !process.argv.includes("--headed") && !process.argv.includes("-H"),
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
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

    // ---- Seed two workflows on different domains ----
    const seeded = await swEval(async () => {
      const a = await self.baoSaveWorkflow("Comment on post", "https://substack.com/inbox", [
        { action: "click", label: 'Click "Comment"', ts: 1 },
      ]);
      const b = await self.baoSaveWorkflow("Upvote story", "https://news.ycombinator.com/", [
        { action: "click", label: "Click upvote", ts: 1 },
        { action: "click", label: "Click confirm", ts: 2 },
      ]);
      return { a: a.id, b: b.id };
    });

    // ---- Seed one run record for workflow B straight into bao-history ----
    await swEval(async ({ wfId }) => {
      const now = Date.now();
      const rec = {
        id: "run-seed1", workflowId: wfId, workflowName: "Upvote story",
        startUrl: "https://news.ycombinator.com/", startedAt: now - 4200, finishedAt: now,
        outcome: "passed", results: [{ i: 0, ok: true }, { i: 1, ok: true }],
        steps: [{ action: "click", label: "Click upvote", ts: 1 }, { action: "click", label: "Click confirm", ts: 2 }],
        frames: [null, null],
      };
      await new Promise((res, rej) => {
        const req = indexedDB.open("bao-history", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("runs")) db.createObjectStore("runs");
          if (!db.objectStoreNames.contains("frames")) db.createObjectStore("frames");
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("runs", "readwrite");
          tx.objectStore("runs").put(rec, rec.id);
          tx.oncomplete = () => { db.close(); res(); };
          tx.onerror = () => rej(tx.error);
        };
        req.onerror = () => rej(req.error);
      });
    }, { wfId: seeded.b });

    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`chrome-extension://${extId}/dashboard.html`);
    await sleep(400);

    // ---- Library: two cards, grouped by domain ----
    check("two cards render", (await page.locator(".card").count()) === 2);
    const groups = await page.locator(".group-h").allTextContents();
    check("grouped by domain", groups.some((g) => g.includes("substack.com")) &&
      groups.some((g) => g.includes("news.ycombinator.com")), JSON.stringify(groups));

    // ---- Search filters across groups ----
    await page.fill("#search", "substack");
    check("search filters to one card", (await page.locator(".card").count()) === 1);
    await page.fill("#search", "");
    await sleep(100);

    // ---- Detail: selecting a workflow renders its steps ----
    check("placeholder shown before selection", await page.locator("#placeholder").isVisible());
    await page.locator(".card", { hasText: "Upvote story" }).click();
    await sleep(300);
    check("detail pane opens", await page.locator("#detail").isVisible());
    check("detail shows the workflow name", (await page.locator("#dname").textContent()) === "Upvote story",
      await page.locator("#dname").textContent());
    check("selected card is highlighted", (await page.locator(".card.sel").count()) === 1);
    const startRow = page.locator("#dsteps .srow.start");
    check("steps lead with the ↦ start row", await startRow.count() === 1,
      await startRow.textContent().catch(() => "none"));
    check("start row names the start URL",
      (await startRow.textContent())?.includes("Start at https://news.ycombinator.com/"));
    check("two step rows render (excluding the start row)",
      (await page.locator("#dsteps .srow:not(.start)").count()) === 2);

    // ---- Run history: the seeded record renders ----
    check("one run-row renders", (await page.locator(".run-row").count()) === 1);
    check("run-row shows a passed dot", (await page.locator(".run-row .dot.passed").count()) === 1);
    const runText = await page.locator(".run-row").textContent();
    check("run-row summarizes outcome + steps + duration",
      runText?.includes("Passed") && runText?.includes("2/2 steps") && /\d\.\ds/.test(runText || ""), runText);

    // ---- Switching selection swaps the detail ----
    await page.locator(".card", { hasText: "Comment on post" }).click();
    await sleep(300);
    check("detail follows the new selection", (await page.locator("#dname").textContent()) === "Comment on post");
    check("empty history reads 'No runs yet.'",
      (await page.locator("#druns").textContent())?.includes("No runs yet"),
      await page.locator("#druns").textContent());

    check("no page errors in the dashboard", pageErrors.length === 0, pageErrors.join(" | "));
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
