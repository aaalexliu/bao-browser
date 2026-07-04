// T12 regression: golden screenshots per step.
// While recording, the SW grabs one full-viewport JPEG per element step
// (captureVisibleTab → OffscreenCanvas downscale to ≤1000px), stores it LOCAL-ONLY in
// IndexedDB keyed by the step seq, and stamps meta.goldenScreenshotRef onto the step.
// Each ref must resolve to a decodable JPEG of plausible dimensions.
//
// Run: npm run test:golden   (or: node test/golden.mjs)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture.html")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

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
    await liveSw();
    const page = await ctx.newPage();
    await page.goto(FIXTURE);
    await page.waitForLoadState("domcontentloaded");
    const tabId = await swEval(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, FIXTURE);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    // Record via the SW session so steps stream through onRecStep (which schedules the
    // golden capture). Pace actions >600ms apart so the 2/s throttle captures each one.
    await swEval((id) => self.baoRecStart(id), tabId);
    await page.fill("#email", "ada@example.com");
    await sleep(700);
    await page.fill("#bio", "Hello from the replay.");
    await sleep(700);
    await page.click('[data-testid="submit-btn"]');
    await sleep(1500); // let the last golden capture + ref-stamp flush before stop
    const { steps } = await swEval(() => self.baoRecStop()); // T15: stop returns { steps, workflow }

    const elementSteps = (steps || []).filter((s) => s.target);
    check("3 element steps recorded", elementSteps.length === 3, JSON.stringify(steps?.map((s) => s.action)));

    const refs = elementSteps.map((s) => s.meta?.goldenScreenshotRef);
    check("every element step got a goldenScreenshotRef", refs.every(Boolean), JSON.stringify(refs));
    check("refs are distinct (one frame per step)", new Set(refs).size === refs.length, JSON.stringify(refs));

    // Each ref resolves to a decodable JPEG of plausible, downscaled dimensions.
    for (let i = 0; i < refs.length; i++) {
      const shot = await swEval((ref) => self.baoGetGolden(ref), refs[i]);
      check(`golden #${i + 1} decodes to a JPEG`, shot?.type === "image/jpeg" && shot?.size > 0,
        JSON.stringify(shot));
      check(`golden #${i + 1} downscaled to ≤1000px wide, non-empty`,
        shot?.width > 0 && shot?.width <= 1000 && shot?.height > 0,
        shot && `${shot.width}x${shot.height}`);
    }

    // A missing key returns null (proves the read path, not a false positive).
    const miss = await swEval(() => self.baoGetGolden("no-such-ref"));
    check("unknown ref resolves to null", miss === null);
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
