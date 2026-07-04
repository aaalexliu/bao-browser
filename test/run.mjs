// T6: the thin headless runner — the seed of the CI story.
//   node test/run.mjs <steps.json> <url>
// Loads the unpacked extension, navigates to <url>, replays <steps.json> through the
// real content script, prints a per-step ✓/✗ table, and exits 0 (all passed) or 1.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

async function main() {
  const [stepsPath, url] = process.argv.slice(2);
  if (!stepsPath || !url) {
    console.error("usage: node test/run.mjs <steps.json> <url>");
    process.exit(2);
  }
  const steps = JSON.parse(await readFile(resolve(process.cwd(), stepsPath), "utf8"));

  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED && !process.argv.includes("--headed") && !process.argv.includes("-H"),
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  let code = 1;
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });

    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForLoadState("domcontentloaded");

    // Match the exact navigated URL (query strings aren't valid tabs.query match
    // patterns, so filter all tabs instead).
    const wanted = page.url();
    const tabId = await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === u)?.id ?? null;
    }, wanted);
    if (tabId == null) throw new Error(`no tab for ${wanted}`);

    const res = await sw.evaluate(([id, s]) => chrome.tabs.sendMessage(id, { cmd: "replay", steps: s }), [tabId, steps]);
    const byIndex = new Map((res?.results || []).map((r) => [r.i, r]));

    console.log(`\n  ${url}`);
    steps.forEach((step, i) => {
      const r = byIndex.get(i);
      const mark = !r ? "·" : r.ok ? "✓" : "✗";
      const why = r && !r.ok ? `  — ${r.reason}` : r?.via ? `  (${r.via})` : "";
      console.log(`  ${mark} ${i + 1}. ${step.label}${why}`);
    });
    code = res?.ok ? 0 : 1;
    console.log(code === 0 ? "\n  ✓ all steps passed" : "\n  ✗ run failed");
  } finally {
    await ctx.close();
  }
  process.exit(code);
}

main().catch((e) => {
  console.error("\n✗ runner error:", e);
  process.exit(1);
});
