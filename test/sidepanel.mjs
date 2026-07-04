// T15 UI smoke: the side panel opened as a regular extension page.
// Home view: cards grouped by domain, search filters, rename persists,
// delete+undo keeps the workflow, delete+expiry removes it. Live surfaces:
// the panel flips to the recording view while a scripted record streams steps,
// Stop hands off to the detail view with the generated name in inline-edit
// mode, and a scripted run renders storage-driven ✓ progress + summary.
//
// Run: npm run test:sidepanel   (or: node test/sidepanel.mjs)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture.html")).href;
const UNDO_MS = 5000; // keep in sync with src/sidepanel.ts

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
    headless: !process.env.HEADED,
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
        { action: "click", label: 'Click "Comment"', ts: 1, frame: { url: "https://substack.com/inbox" } },
      ]);
      const b = await self.baoSaveWorkflow("Upvote story", "https://news.ycombinator.com/", [
        { action: "click", label: "Click upvote", ts: 1 },
        { action: "click", label: "Click confirm", ts: 2 },
      ]);
      return { a: a.id, b: b.id };
    });

    const panel = await ctx.newPage();
    const pageErrors = [];
    panel.on("pageerror", (e) => pageErrors.push(String(e)));
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await sleep(400);

    // ---- Home: grouped by domain ----
    check("two cards render", (await panel.locator(".card").count()) === 2);
    const groups = await panel.locator(".group-h").allTextContents();
    check("grouped by domain", groups.some((g) => g.includes("substack.com")) &&
      groups.some((g) => g.includes("news.ycombinator.com")), JSON.stringify(groups));

    // ---- Search filters across groups ----
    await panel.fill("#search", "substack");
    check("search filters to one card", (await panel.locator(".card").count()) === 1);
    check("empty group disappears", (await panel.locator(".group-h").count()) === 1);
    await panel.fill("#search", "");

    // ---- Rename persists ----
    await panel.locator(".card", { hasText: "Comment on post" }).locator("button", { hasText: "⋯" }).click();
    await panel.locator(".menu-pop button", { hasText: "Rename" }).click();
    await panel.locator(".card .name input").fill("Comment v2");
    await panel.keyboard.press("Enter");
    await sleep(300);
    const namedA = await swEval(async (id) => (await self.baoGetWorkflow(id))?.name, seeded.a);
    check("rename persists via bao-wf-update", namedA === "Comment v2", namedA);

    // ---- Delete + undo keeps the workflow ----
    const cardA = () => panel.locator(".card", { hasText: "Comment v2" });
    await cardA().locator("button", { hasText: "⋯" }).click();
    await panel.locator(".menu-pop button", { hasText: "Delete" }).click();
    check("delete is optimistic", (await cardA().count()) === 0);
    await panel.click("#undo");
    await sleep(200);
    check("undo restores the card", (await cardA().count()) === 1);
    await sleep(UNDO_MS + 700); // past the (cancelled) expiry
    check("undone delete never fired", (await swEval((id) => self.baoGetWorkflow(id), seeded.a)) !== null);

    // ---- Delete + expiry removes it ----
    await cardA().locator("button", { hasText: "⋯" }).click();
    await panel.locator(".menu-pop button", { hasText: "Delete" }).click();
    await sleep(UNDO_MS + 700);
    check("expired delete removed the workflow",
      (await swEval((id) => self.baoGetWorkflow(id), seeded.a)) === null);

    // ---- Live recording feed + stop → rename handoff ----
    const page = await ctx.newPage();
    await page.goto(FIXTURE);
    await page.waitForLoadState("domcontentloaded");
    const tabId = await swEval(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, FIXTURE);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    await swEval((id) => self.baoRecStart(id), tabId);
    await sleep(300);
    check("panel flipped to the recording view", await panel.locator("#recording").isVisible());
    await page.fill("#email", "live@example.com");
    await page.click('[data-testid="submit-btn"]');
    await sleep(600); // streamed steps land in session storage → feed re-renders
    const feedRows = await panel.locator("#recfeed div").count(); // includes the cursor row
    check("live feed shows the captured steps", feedRows >= 3, `${feedRows} rows`);

    await panel.click("#stop");
    await sleep(500);
    check("stop lands in the detail view", await panel.locator("#detail").isVisible());
    const renameInput = panel.locator("#dname input");
    check("generated name is in inline-edit mode", await renameInput.count() === 1,
      await renameInput.inputValue().catch(() => "no input"));
    await panel.keyboard.type("Named in panel"); // pre-selected → typing replaces
    await panel.keyboard.press("Enter");
    await sleep(400);
    const autoWfId = await swEval(async () => {
      const list = await self.baoListWorkflows();
      return list.find((w) => w.name === "Named in panel")?.id ?? null;
    });
    check("typed name replaced the generated one", autoWfId != null, autoWfId);

    // ---- Storage-driven run progress in the detail view ----
    await swEval(({ id, tabId }) => self.baoRunWorkflow(tabId, id), { id: autoWfId, tabId });
    await panel.waitForSelector("#dsummary:not([hidden])", { timeout: 20_000 });
    check("run summary rendered", (await panel.locator("#dsummary").textContent())?.includes("Replayed"),
      await panel.locator("#dsummary").textContent());
    const doneRows = await panel.locator(".srow.done").count();
    check("steps got live ✓ marks", doneRows >= 2, `${doneRows} done rows`);
    check("run button re-enabled after done", !(await panel.locator("#drun").isDisabled()));

    // ---- Zero-step stop → home + toast ----
    await panel.click("#dback");
    await swEval((id) => self.baoRecStart(id), tabId);
    await sleep(300);
    await panel.click("#stop");
    await sleep(400);
    check("zero-step stop returns home", await panel.locator("#home").isVisible());
    check("nothing-captured toast shown",
      (await panel.locator("#toastmsg").textContent())?.includes("Nothing captured"));

    check("no page errors in the panel", pageErrors.length === 0, pageErrors.join(" | "));
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
