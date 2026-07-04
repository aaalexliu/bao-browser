// T7 regression: SPA soft-navigation awareness (record + replay).
// The fixture routes via history.pushState (served over local HTTP — pushState
// needs a real origin). Recording a click that soft-navigates and then typing on
// the new route must insert a synthetic softNav marker between the two steps;
// replay from the start route must WAIT for the URL to match before resolving the
// route-2 element — with digit runs wildcarded, because the item id minted at
// replay time differs from the recorded one.
//
// Run: npm run test:spa   (or: node test/spa.mjs)
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

async function sendToContent(sw, tabId, msg) {
  return sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, msg]);
}

async function main() {
  // Every path serves the same document — the fixture's client router does the rest.
  const html = await readFile(resolve(__dirname, "fixture-spa.html"));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED && !process.argv.includes("--headed") && !process.argv.includes("-H"),
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });

    const page = await ctx.newPage();
    await page.goto(`${BASE}/route-1`);
    await page.waitForLoadState("domcontentloaded");

    const tabId = await sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, `${BASE}/route-1`);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    // 1) Record: click through the soft nav, then type on route 2.
    await sendToContent(sw, tabId, { cmd: "start-record" });
    await page.click("#open-item");
    await page.fill("#note", "hello from route 2"); // waits for the delayed render
    const { steps } = await sendToContent(sw, tabId, { cmd: "stop-record" });

    check("3 steps recorded (click, softNav, input)", steps?.length === 3,
      JSON.stringify(steps?.map((s) => s.action)));
    const nav = steps?.find((s) => s.action === "softNav");
    check("softNav marker sits between the steps", steps?.[1]?.action === "softNav");
    check("softNav captured the routed URL", nav?.urlAfter?.includes("/item/"), nav?.urlAfter);
    check("urlPattern wildcards digit runs", /\\d\+/.test(nav?.urlPattern || ""), nav?.urlPattern);
    const recordedId = nav?.urlAfter?.split("/item/")[1];

    // 2) Replay from route 1, cold (full reload — fresh document, fresh router).
    await page.goto(`${BASE}/route-1`);
    await page.waitForLoadState("domcontentloaded");
    const replay = await sendToContent(sw, tabId, { cmd: "replay", steps });
    check("replay reported ok", replay?.ok === true, JSON.stringify(replay?.results));
    check("softNav step waited and matched", replay?.results?.some((r) => r.via === "softNav"));

    // 3) The replay-time id differs from the recorded one — the wildcard did the work.
    const url = page.url();
    const replayId = url.split("/item/")[1];
    check("landed on an /item/ route", url.includes("/item/"), url);
    check("replay-time id differs from record-time id (pattern matched anyway)",
      replayId && replayId !== recordedId, `recorded=${recordedId} replayed=${replayId}`);
    const note = await page.inputValue("#note");
    check("route-2 input refilled after the route settled", note === "hello from route 2", note);
  } finally {
    await ctx.close();
    server.close();
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
