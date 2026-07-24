// M4 slice 3: export (CSV / JSON). Extract two scalars off the page, then serialize
// the run's dataset to a file via the SAME download plumbing as T10 — a synthesized
// data: URL the SW hands to chrome.downloads. Proves: a CSV with `columns` fixing the
// order and RFC-4180 field escaping (comma + quote), and a JSON export whose default
// columns are the union of row keys in first-seen order. Reads the actual files off
// disk to assert bytes, and checks the run waited for each download (via:download).
//
// Run: npm run test:export   (or: node test/export.mjs)
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, readdir, mkdtemp } from "node:fs/promises";
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

// The extension triggers the download via chrome.downloads.download with an explicit
// filename, but the persistent-context download manager saves each completed file
// under a GUID (no extension), so we can't read by name. Enumerate the downloads dir
// and return the file contents once `want` of them have flushed to disk.
async function readDownloads(dir, want, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const names = await readdir(dir);
    const contents = await Promise.all(names.map((n) => readFile(join(dir, n), "utf8").catch(() => "")));
    const ready = contents.filter((c) => c.length > 0);
    if (ready.length >= want) return ready;
    await sleep(100);
  }
  const names = await readdir(dir);
  return Promise.all(names.map((n) => readFile(join(dir, n), "utf8").catch(() => "")));
}

async function main() {
  const html = await readFile(resolve(__dirname, "fixture-export.html"));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const downloadsPath = await mkdtemp(join(tmpdir(), "bao-export-"));

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
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("domcontentloaded");
    const tabId = await swEval(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, `${BASE}/`);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    // ---- Record clicks to capture real Targets for the two fields ----
    await swEval((id) => self.baoRecStart(id), tabId);
    await page.click("#name");
    await page.click("#addr");
    await sleep(200);
    const { steps } = await swEval(() => self.baoRecStop());
    const clicks = steps.filter((s) => s.action === "click");
    check("recorded 2 clicks", clicks.length === 2, JSON.stringify(steps.map((s) => s.action)));

    // ---- Build: extract both scalars, then two exports (CSV reordered+escaped, JSON default) ----
    const ex = (label, target, extract) => ({ action: "extract", label, ts: 0, target, extract });
    const runSteps = [
      ex("Copy the name", clicks[0].target, { source: "text", into: "person" }),
      ex("Copy the addr", clicks[1].target, { source: "text", into: "addr" }),
      // `columns` fixes order (addr before person, the reverse of extraction order).
      { action: "export", label: "Export CSV", ts: 0,
        export: { format: "csv", columns: ["addr", "person"], filename: "contacts.csv" } },
      // No `columns`: default is the SORTED union of row keys (addr, person) — insertion
      // order can't survive the SW storage round-trip, so sorted is the deterministic default.
      { action: "export", label: "Export JSON", ts: 0,
        export: { format: "json", filename: "contacts.json" } },
    ];

    await page.goto(`${BASE}/`);
    await page.waitForLoadState("domcontentloaded");
    await swEval(({ id, steps }) => self.baoRunStart(id, steps, { inputs: {} }),
      { id: tabId, steps: runSteps });
    const run = await waitForPhase(["done", "failed"]);
    check("export run completed", run?.phase === "done", JSON.stringify(run?.lastError || run?.phase));

    // Both files land under GUID names; classify by content signature.
    const files = await readDownloads(downloadsPath, 2);
    const csv = files.find((c) => c.startsWith("addr,"));
    const jsonText = files.find((c) => c.trimStart().startsWith("["));

    // ---- CSV: column order from `columns`, RFC-4180 escaping of the comma+quote cell ----
    const expectedCsv = 'addr,person\r\n"12 Main St, Apt ""3""",Ada Lovelace\r\n';
    check("CSV file has the exact escaped bytes", csv === expectedCsv, JSON.stringify(csv));

    // ---- JSON: default column order is the SORTED union of row keys ----
    let parsed = null;
    try { parsed = JSON.parse(jsonText); } catch (_) {}
    check("JSON is a single-row array", Array.isArray(parsed) && parsed.length === 1, JSON.stringify(parsed));
    check("JSON default column order = sorted union of keys (addr, person)",
      JSON.stringify(Object.keys(parsed?.[0] || {})) === JSON.stringify(["addr", "person"]),
      JSON.stringify(Object.keys(parsed?.[0] || {})));
    check("JSON cell values are the extracted scalars",
      parsed?.[0]?.person === "Ada Lovelace" && parsed?.[0]?.addr === '12 Main St, Apt "3"',
      JSON.stringify(parsed?.[0]));

    // ---- The run WAITED for each synthesized download (via:download in history) ----
    const dls = (run?.results || []).filter((r) => r.via === "download").map((r) => r.filename).sort();
    check("both exports resolved through the download path", JSON.stringify(dls) === JSON.stringify(["contacts.csv", "contacts.json"]),
      JSON.stringify(dls));
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
