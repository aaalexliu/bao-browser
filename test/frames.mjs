// Bao — Tier-B cross-origin frame regression. A parent page on one port embeds an
// iframe served from another port (different origin). A content script runs inside
// EACH frame (all_frames); the SW merges their recordings by frameId and, at replay,
// routes each step back to its frame. Proves capture + replay across the same-origin
// boundary without CDP. See use-cases-and-snapshot-fallback.md §8 (Tier-B item 5).
//
// Run: npm run test:frames   (HEADED=1 to watch)
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
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

// Serve one HTML file (optionally templated) on a random port; return its origin.
async function serve(file, replace) {
  let html = await readFile(resolve(__dirname, file), "utf8");
  if (replace) for (const [k, v] of Object.entries(replace)) html = html.replaceAll(k, v);
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, server };
}

async function main() {
  const child = await serve("fixture-frame-child.html");
  const parent = await serve("fixture-frame-parent.html", { __CHILD_URL__: child.origin + "/" });

  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
    const bcast = (tabId, msg) => sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m).catch(() => {}), [tabId, msg]);

    const page = await ctx.newPage();
    await page.goto(parent.origin + "/");
    const childFrameLoc = page.frameLocator("iframe");
    await childFrameLoc.locator("#card").waitFor({ timeout: 10_000 }); // child content loaded
    const childFrame = page.frames().find((f) => f.url().startsWith(child.origin));
    check("cross-origin child frame present", !!childFrame && childFrame.url().startsWith(child.origin), childFrame?.url());

    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + "/*" }))[0]?.id, parent.origin);

    // ---- record across both frames ----
    await sw.evaluate(() => { self.__baoSteps = []; });
    await bcast(tabId, { cmd: "start-record" });
    await page.click('[data-testid="parent-btn"]');              // top frame
    await childFrameLoc.locator("#card").fill("4242424242424242"); // child frame
    await childFrameLoc.locator('[data-testid="pay-btn"]').click();// child frame
    await bcast(tabId, { cmd: "stop-record" });
    await page.waitForTimeout(250); // let each frame report to the SW
    const steps = await sw.evaluate(() => self.baoDrainSteps());

    check("captured 3 steps across frames", steps?.length === 3, `got ${steps?.length}`);
    check("step 0 recorded in the TOP frame", steps[0]?.frame?.top === true && steps[0]?.frame?.frameId === 0);
    const childSteps = steps.filter((s) => s.frame?.origin === child.origin);
    check("2 steps recorded in the CHILD (cross-origin) frame", childSteps.length === 2, JSON.stringify(childSteps.map((s) => s.action)));
    check("child steps carry a non-top frameId", childSteps.every((s) => s.frame?.frameId > 0), JSON.stringify(childSteps.map((s) => s.frame?.frameId)));

    // ---- replay: SW routes each step back to its frame ----
    await page.evaluate(() => (window.__fired = []));
    await childFrame.evaluate(() => { window.__fired = []; document.getElementById("card").value = ""; });
    const res = await sw.evaluate(([id, s]) => self.baoReplayAcrossFrames(id, s), [tabId, steps]);
    check("replay ok", res?.ok === true, JSON.stringify(res?.results));
    check("step 0 routed to frame 0, child steps to the child frame",
      res?.results?.[0]?.frameId === 0 && res?.results?.[1]?.frameId > 0 && res?.results?.[2]?.frameId === res?.results?.[1]?.frameId,
      JSON.stringify(res?.results?.map((r) => r.frameId)));

    const parentFired = await page.evaluate(() => window.__fired);
    check("parent button fired by replay", parentFired.some((e) => e.id === "parent-btn"));
    const cardVal = await childFrame.evaluate(() => document.getElementById("card").value);
    check("child input refilled across the origin boundary", cardVal === "4242424242424242", cardVal);
    const childFired = await childFrame.evaluate(() => window.__fired);
    check("child Pay fired with the typed card", childFired.some((e) => e.id === "pay-btn" && e.card === "4242424242424242"), JSON.stringify(childFired));
  } finally {
    await ctx.close();
    child.server.close();
    parent.server.close();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => { console.error("\n✗ harness error:", e); process.exit(1); });
