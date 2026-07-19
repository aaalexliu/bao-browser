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
    page.on("dialog", (d) => d.accept()); // accept the last-step delete confirm()
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

    // ---- Light step editing: reorder + delete, then Save persists ----
    // "Upvote story" is selected. Steps: [Click upvote, Click confirm].
    await page.click("#dedit");
    check("edit mode shows editable rows", (await page.locator("#dsteps .srow.edit").count()) === 2);
    check("run/export/delete hidden while editing", !(await page.locator("#drun").isVisible()));
    check("save + cancel shown while editing", await page.locator("#dsave").isVisible());
    // Move the first step (upvote) down → order becomes [confirm, upvote].
    await page.locator("#dsteps .srow.edit").first().locator(".ctl button").nth(1).click();
    check("first row is now the confirm step",
      (await page.locator("#dsteps .srow.edit").first().locator(".lbl").textContent())?.includes("confirm"),
      await page.locator("#dsteps .srow.edit").first().locator(".lbl").textContent());
    // Delete the now-first step (confirm) → only upvote remains.
    await page.locator("#dsteps .srow.edit").first().locator(".ctl .del").click();
    check("one edit row remains after delete", (await page.locator("#dsteps .srow.edit").count()) === 1);
    await page.click("#dsave");
    await sleep(300);
    const saved = await swEval((id) => self.baoGetWorkflow(id), seeded.b);
    check("save persisted the edit (1 step, the reordered survivor)",
      saved?.steps?.length === 1 && saved.steps[0].label === "Click upvote" && saved.steps[0].index === 0,
      JSON.stringify(saved?.steps?.map((s) => s.label)));
    check("version bumped after save", saved?.version === 2, String(saved?.version));
    check("back to read mode after save", await page.locator("#dedit").isVisible());

    // Cancel discards edits.
    await page.click("#dedit");
    await page.locator("#dsteps .srow.edit .ctl .del").first().click();
    check("edit removed the row in the draft", (await page.locator("#dsteps .srow.edit").count()) === 0);
    await page.click("#dcancel");
    const afterCancel = await swEval((id) => self.baoGetWorkflow(id), seeded.b);
    check("cancel discarded the draft (still 1 step)", afterCancel?.steps?.length === 1);

    // ---- Switching selection swaps the detail ----
    await page.locator(".card", { hasText: "Comment on post" }).click();
    await sleep(300);
    check("detail follows the new selection", (await page.locator("#dname").textContent()) === "Comment on post");
    check("empty history reads 'No runs yet.'",
      (await page.locator("#druns").textContent())?.includes("No runs yet"),
      await page.locator("#druns").textContent());

    // ---- Filmstrip player: re-watch a run, record-time vs replay-time, step by step ----
    // Seed a workflow + a run record with real golden (record) + history (replay) blobs.
    const filmWf = await swEval(() => self.baoSaveWorkflow("Filmstrip demo", "https://x.test/", [
      { action: "input", label: "Fill name", value: "Ada", ts: 1 },
      { action: "click", label: "Click submit", ts: 2 },
    ]));
    await swEval(async ({ wfId }) => {
      const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const putBlob = (dbName, stores, store, key, blob) => new Promise((res, rej) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => { for (const s of stores) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
        req.onsuccess = () => { const db = req.result; const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(blob, key); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
        req.onerror = () => rej(req.error);
      });
      await putBlob("bao-golden", ["shots"], "shots", "film-golden", await (await fetch(png)).blob());
      const rec = {
        id: "run-film", workflowId: wfId, workflowName: "Filmstrip demo", startUrl: "https://x.test/",
        startedAt: Date.now() - 2000, finishedAt: Date.now(), outcome: "failed",
        results: [{ i: 0, ok: true, via: "aria" }, { i: 1, ok: false, reason: "boom" }],
        steps: [{ action: "input", label: "Fill name", value: "Ada", meta: { goldenScreenshotRef: "film-golden" } },
                { action: "click", label: "Click submit" }],
        frames: ["run-film:0", null],
      };
      await putBlob("bao-history", ["runs", "frames"], "runs", "run-film", rec);
      await putBlob("bao-history", ["runs", "frames"], "frames", "run-film:0", await (await fetch(png)).blob());
    }, { wfId: filmWf.id });

    await page.locator(".card", { hasText: "Filmstrip demo" }).click();
    await sleep(300);
    await page.locator(".run-row").click();
    await sleep(200);
    check("player opens", await page.locator("#player").isVisible());
    check("player header shows the failed outcome",
      (await page.locator("#poutcome").textContent()) === "Failed" &&
      (await page.locator("#pdot.failed").count()) === 1);
    check("step 1 shows both frames as images",
      (await page.locator("#pgolden img").getAttribute("src"))?.startsWith("blob:") &&
      (await page.locator("#preplay img").getAttribute("src"))?.startsWith("blob:"));
    check("step 1 result line shows the ✓ via", (await page.locator("#pstepresult").textContent())?.includes("aria"));
    check("two scrubber dots render", (await page.locator("#pdots .d").count()) === 2);
    check("prev disabled on the first step", await page.locator("#pprev").isDisabled());

    await page.click("#pnext");
    await sleep(150);
    check("step 2 shows placeholders (no captured frames)",
      (await page.locator("#pgolden .noframe").count()) === 1 && (await page.locator("#preplay .noframe").count()) === 1);
    check("step 2 result line shows the ✗ reason", (await page.locator("#pstepresult").textContent())?.includes("boom"));
    check("next disabled on the last step", await page.locator("#pnext").isDisabled());

    await page.locator("#pdots .d").first().click(); // jump back via a dot
    await sleep(150);
    check("dot jump returns to step 1", (await page.locator("#pgolden img").count()) === 1);

    await page.click("#pclose");
    check("player closes", await page.locator("#player").isHidden());

    // Delete this run from the player → history empties for the workflow.
    await page.locator(".run-row").click();
    await sleep(150);
    await page.click("#pdelrun");
    await sleep(250);
    check("delete-this-run empties the history",
      (await page.locator("#druns").textContent())?.includes("No runs yet") &&
      (await page.locator(".run-row").count()) === 0);

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
