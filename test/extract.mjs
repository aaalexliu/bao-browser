// M4 slice 2: extract (scalar). Record clicks on a few elements to capture real
// Targets, rewrite those steps into `extract` steps (one per source: text, attr,
// href, form value), then replay through the SW RunState machine. Proves the SW
// commits each read value into run.bindings, and that an extracted binding then
// feeds a downstream {{substitution}} into a field — read-into-binding, end to end.
// Also proves an extract whose target is gone fails the run cleanly.
//
// Run: npm run test:extract   (or: node test/extract.mjs)
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
  const html = await readFile(resolve(__dirname, "fixture-extract.html"));
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
      await sleep(150);
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

    // ---- Record clicks to capture real Targets, then a search to reuse for {{sub}} ----
    await swEval((id) => self.baoRecStart(id), tabId);
    await page.click("#name");     // capture target for text + attr extract
    await page.click("#profile");  // capture target for href extract (nav suppressed)
    await page.click("#preset");   // capture target for form-value extract
    await page.fill("#q", "placeholder-term");
    await page.click("#go");
    await sleep(200);
    const { steps } = await swEval(() => self.baoRecStop());
    const clicks = steps.filter((s) => s.action === "click");
    const inputStep = steps.find((s) => s.action === "input");
    check("recorded 4 clicks + 1 input", clicks.length === 4 && !!inputStep,
      JSON.stringify(steps.map((s) => s.action)));

    // ---- Rewrite the captured targets into extract steps, one per source ----
    const ex = (label, target, extract) => ({ action: "extract", label, ts: 0, target, extract });
    const runSteps = [
      ex("Copy the name",   clicks[0].target, { source: "text", into: "person" }),
      ex("Copy the id",     clicks[0].target, { source: "attr", attr: "data-id", into: "uid" }),
      ex("Copy the link",   clicks[1].target, { source: "href", into: "link" }),
      ex("Copy the preset", clicks[2].target, { source: "value", into: "preset" }),
      // Downstream: the extracted `person` binding feeds the search field via {{sub}}.
      { ...inputStep, value: "{{person}}" },
      clicks[3], // click #go — echoes the field into #out
    ];

    await page.goto(`${BASE}/`);
    await page.waitForLoadState("domcontentloaded");
    await swEval(({ id, steps }) => self.baoRunStart(id, steps, { inputs: {} }),
      { id: tabId, steps: runSteps });
    const run = await waitForPhase(["done", "failed"]);
    check("extract run completed", run?.phase === "done", JSON.stringify(run?.lastError || run?.phase));

    const b = run?.bindings || {};
    check("text extracted into binding", b.person === "Ada Lovelace", JSON.stringify(b.person));
    check("attr extracted into binding", b.uid === "u-42", JSON.stringify(b.uid));
    check("href extracted into binding (absolute)", b.link === `${BASE}/users/42`, JSON.stringify(b.link));
    check("form value extracted into binding", b.preset === "preset-value", JSON.stringify(b.preset));
    check("extracted binding feeds a downstream {{substitution}}",
      (await page.textContent("#out")) === "Ada Lovelace", await page.textContent("#out"));
    check("extracted value recorded on the step result (audit)",
      run?.results?.find((r) => r.via === "extract:text")?.extracted === "Ada Lovelace",
      JSON.stringify(run?.results?.map((r) => r.extracted)));

    // ---- A missing target fails the run cleanly, not with a stack trace ----
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => document.getElementById("name")?.remove());
    await swEval(({ id, steps }) => self.baoRunStart(id, steps, { inputs: {} }),
      { id: tabId, steps: [runSteps[0]] });
    const failed = await waitForPhase(["done", "failed"]);
    check("extract with a missing target fails cleanly", failed?.phase === "failed",
      JSON.stringify(failed?.lastError || failed?.phase));
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
