// T10 regression: download capture + replay wait.
// Record a click on a link served with Content-Disposition: attachment — the SW
// correlates chrome.downloads.onCreated to that click and tags it with the filename.
// Replay from a cold page must fire the click AND wait for the download to complete
// (state:complete) before the run reports done, with the filename in the run history.
//
// Run: npm run test:download   (or: node test/download.mjs)
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

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
  const html = await readFile(resolve(__dirname, "fixture-download.html"));
  const server = createServer((req, res) => {
    if (req.url.startsWith("/report.csv")) {
      res.setHeader("content-type", "text/csv");
      res.setHeader("content-disposition", 'attachment; filename="report.csv"');
      res.end("date,total\n2026-07-04,42\n");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const downloadsPath = await mkdtemp(join(tmpdir(), "bao-dl-"));

  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED && !process.argv.includes("--headed") && !process.argv.includes("-H"),
    acceptDownloads: true,
    downloadsPath,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  async function liveSw() {
    for (const sw of ctx.serviceWorkers()) {
      try { await sw.evaluate(() => 1); return sw; } catch (_) {}
    }
    return ctx.waitForEvent("serviceworker", { timeout: 10_000 });
  }
  const swEval = async (fn, arg) => (await liveSw()).evaluate(fn, arg);
  async function runStatus() { return swEval(() => self.baoRunStatus()); }
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
    await page.goto(`${BASE}/download.html`);
    await page.waitForLoadState("domcontentloaded");
    const tabId = await swEval(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, `${BASE}/download.html`);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    // ---- Record: click the download link; the SW correlates the download ----
    await swEval((id) => self.baoRecStart(id), tabId);
    await page.click("#dl");
    await sleep(1500); // let onCreated correlate + onChanged backfill the filename
    const { steps } = await swEval(() => self.baoRecStop()); // T15: stop returns { steps, workflow }

    check("one click step recorded", steps.length === 1 && steps[0].action === "click",
      JSON.stringify(steps.map((s) => s.action)));
    check("click step tagged as download-producing", !!steps[0]?.download, JSON.stringify(steps[0]?.download));
    check("download filename correlated", steps[0]?.download?.filename === "report.csv",
      steps[0]?.download?.filename);

    // ---- Replay: fire the click AND wait for completion before reporting done ----
    await page.goto(`${BASE}/download.html`);
    await page.waitForLoadState("domcontentloaded");
    await swEval(({ id, steps }) => self.baoRunStart(id, steps), { id: tabId, steps });

    const run = await waitForPhase(["done", "failed"]);
    check("run completed", run?.phase === "done", JSON.stringify(run?.lastError || run?.phase));
    // A plain click completion reports via the selector type; only the awaiting_download
    // path yields via:"download" — so this result is proof the run WAITED for the
    // download rather than insta-passing the click. (Observing the transient
    // awaiting_download phase directly is racy: the download here finishes in <200ms,
    // often before a status poll lands — the very record→download→complete-in-one-turn
    // race the recent-downloads buffer exists to absorb.)
    const dl = run?.results?.find((r) => r.via === "download");
    check("replay waited for the download (via:download in history)", dl?.ok === true && dl?.filename === "report.csv",
      JSON.stringify(dl));
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
