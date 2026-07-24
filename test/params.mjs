// M4 slice 1: parameterization — variables + {{substitution}}. Record a search on a
// literal term, rewrite the input step's value to a {{search_term}} template, then
// replay through the SW RunState machine with the term supplied as a run input. The
// value that reaches the field must be the supplied one, proving substitution happens
// at dispatch. Also asserts a ref with no binding is left verbatim (fails visibly, not
// silently blanked).
//
// Run: npm run test:params   (or: node test/params.mjs)
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
  const html = await readFile(resolve(__dirname, "fixture-params.html"));
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

    // ---- Record a search on a literal term ----
    await swEval((id) => self.baoRecStart(id), tabId);
    await page.fill("#q", "placeholder-term");
    await page.click("#go");
    await sleep(200);
    const { steps } = await swEval(() => self.baoRecStop());
    const inputStep = steps.find((s) => s.action === "input");
    check("recorded an input step", !!inputStep, JSON.stringify(steps.map((s) => s.action)));

    // ---- Parameterize: replace the recorded literal with a {{search_term}} template ----
    const tmpl = steps.map((s) => (s === inputStep ? { ...s, value: "{{search_term}}" } : s));

    // ---- Replay with the term supplied as a run input ----
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("domcontentloaded");
    await swEval(({ id, steps }) => self.baoRunStart(id, steps, { inputs: { search_term: "wireless headphones" } }),
      { id: tabId, steps: tmpl });
    const run = await waitForPhase(["done", "failed"]);
    check("parameterized run completed", run?.phase === "done", JSON.stringify(run?.lastError || run?.phase));
    check("bindings seeded from inputs", run?.bindings?.search_term === "wireless headphones",
      JSON.stringify(run?.bindings));
    check("{{search_term}} substituted into the field at dispatch",
      (await page.textContent("#out")) === "wireless headphones", await page.textContent("#out"));
    check("template preserved on the stored step (history/loop reuse)",
      run?.steps?.find((s) => s.action === "input")?.value === "{{search_term}}",
      run?.steps?.find((s) => s.action === "input")?.value);

    // ---- A ref with no binding is left verbatim (visible failure, not silent blank) ----
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("domcontentloaded");
    await swEval(({ id, steps }) => self.baoRunStart(id, steps, { inputs: {} }), { id: tabId, steps: tmpl });
    await waitForPhase(["done", "failed"]);
    check("unbound {{ref}} passes through verbatim", (await page.textContent("#out")) === "{{search_term}}",
      await page.textContent("#out"));
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
