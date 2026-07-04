// T8 regression: M1 cross-navigation — record across a full-document nav, replay
// through it via the SW-owned, storage-backed RunState machine, pause on
// waitForUser (and survive a forced SW kill while paused), then resume.
//
// Run: npm run test:nav   (or: node test/nav.mjs)
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const pages = {
    "/a.html": await readFile(resolve(__dirname, "fixture-nav-a.html")),
    "/b.html": await readFile(resolve(__dirname, "fixture-nav-b.html")),
  };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(pages[req.url] || pages["/a.html"]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${server.address().port}`;

  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED && !process.argv.includes("--headed") && !process.argv.includes("-H"),
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  // The SW is disposable by design — always grab a live handle before evaluating.
  async function liveSw() {
    for (const sw of ctx.serviceWorkers()) {
      try { await sw.evaluate(() => 1); return sw; } catch (_) {}
    }
    return ctx.waitForEvent("serviceworker", { timeout: 10_000 });
  }
  const swEval = async (fn, arg) => (await liveSw()).evaluate(fn, arg);

  async function runStatus() {
    return swEval(() => self.baoRunStatus());
  }
  async function waitForPhase(phases, timeout = 15_000) {
    const start = Date.now();
    for (;;) {
      const run = await runStatus();
      if (run && phases.includes(run.phase)) return run;
      if (Date.now() - start > timeout) return run;
      await sleep(200);
    }
  }

  try {
    await liveSw();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/a.html`);
    await page.waitForLoadState("domcontentloaded");
    const tabId = await swEval(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, `${BASE}/a.html`);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    // ---- Phase 1: record across a full-document navigation ----
    await swEval((id) => self.baoRecStart(id), tabId);
    await page.fill("#name", "Ada Lovelace");
    await page.click("#to-report"); // full-document nav → recorder dies with page A
    await page.waitForURL("**/b.html");
    // The fresh document re-arms itself via the boot handshake; wait for it.
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      try {
        const st = await swEval(async (id) => chrome.tabs.sendMessage(id, { cmd: "status" }, { frameId: 0 }), tabId);
        if (st?.recording) break;
      } catch (_) {}
      await sleep(100);
    }
    await page.click("#finish");
    await sleep(200); // let the last streamed step land in storage
    const { steps } = await swEval(() => self.baoRecStop()); // T15: stop returns { steps, workflow }

    const actions = steps.map((s) => s.action);
    check("merged trace spans both documents", JSON.stringify(actions) === '["input","click","navigate","click"]',
      JSON.stringify(actions));
    const nav = steps.find((s) => s.action === "navigate");
    check("nav marker carries the destination + wait", nav?.url?.endsWith("/b.html") && nav?.wait?.type === "navigation",
      JSON.stringify({ url: nav?.url, wait: nav?.wait }));
    check("input coalesced with full value", steps[0]?.value === "Ada Lovelace", steps[0]?.value);

    // ---- Phase 2: replay across the navigation, from a cold start ----
    await page.goto(`${BASE}/a.html`);
    await page.waitForLoadState("domcontentloaded");
    await swEval(({ id, steps }) => self.baoRunStart(id, steps), { id: tabId, steps });
    const run = await waitForPhase(["done", "failed"]);
    check("run completed", run?.phase === "done", JSON.stringify(run?.lastError || run?.phase));
    check("all steps reported ok", run?.results?.length === steps.length && run.results.every((r) => r.ok),
      JSON.stringify(run?.results));
    check("ended on page B", page.url().endsWith("/b.html"), page.url());
    check("page-B click actually fired", (await page.textContent("#out")) === "finished");

    // ---- Phase 3: waitForUser — pause, survive a forced SW kill, resume ----
    const steps2 = [...steps];
    steps2.splice(3, 0, { action: "waitForUser", label: "Check the report, then continue" });
    await page.goto(`${BASE}/a.html`);
    await page.waitForLoadState("domcontentloaded");
    await swEval(({ id, steps }) => self.baoRunStart(id, steps), { id: tabId, steps: steps2 });
    let paused = await waitForPhase(["paused_for_user", "done", "failed"]);
    check("run paused for user on page B", paused?.phase === "paused_for_user", paused?.phase);
    check("pause happened BEFORE the final click", (await page.textContent("#out")) === "");

    // Forced SW kill mid-pause (m1-design acceptance): state must live in storage,
    // not in the worker. Kill it via CDP, wake it with an unrelated page load
    // (boot ping), and the run must still be paused at the same step.
    let killed = false;
    try {
      const cdp = await ctx.browser().newBrowserCDPSession();
      const { targetInfos } = await cdp.send("Target.getTargets");
      const swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.includes("background.js"));
      if (swTarget) {
        await cdp.send("Target.closeTarget", { targetId: swTarget.targetId });
        killed = true;
      }
    } catch (e) {
      console.log("  (SW kill via CDP unavailable — skipping kill assertion)", String(e).slice(0, 80));
    }
    if (killed) {
      await sleep(500);
      const waker = await ctx.newPage(); // any page load boot-pings → SW respawns
      await waker.goto(`${BASE}/a.html`);
      await waker.close();
      const rehydrated = await waitForPhase(["paused_for_user"]);
      check("pause survived SW kill (rehydrated from storage)", rehydrated?.phase === "paused_for_user",
        rehydrated?.phase);
    }

    await sleep(1000); // linger in the pause a moment before resuming
    await swEval(() => self.baoRunContinue());
    const done = await waitForPhase(["done", "failed"]);
    check("run resumed and completed after Continue", done?.phase === "done",
      JSON.stringify(done?.lastError || done?.phase));
    check("final click fired after resume", (await page.textContent("#out")) === "finished");
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
