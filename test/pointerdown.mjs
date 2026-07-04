// T5 regression: capture-timing hardening — grab the target at pointerdown.
// The button removes itself in its own mousedown handler, so `click` fires after the
// node is gone (it retargets to #host). Only a pointerdown-time capture — run while
// the node is still connected — preserves usable selectors. We drive the raw mouse
// sequence by coordinates (not page.click, which trips on the detaching element).
//
// Run: npm run test:pointerdown   (or: node test/pointerdown.mjs)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture-pointerdown.html")).href;

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
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED && !process.argv.includes("--headed") && !process.argv.includes("-H"),
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });

    const page = await ctx.newPage();
    await page.goto(FIXTURE);
    await page.waitForLoadState("domcontentloaded");

    const tabId = await sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, FIXTURE);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    // 1) Record a click on the self-removing button, driven by raw coordinates.
    await sendToContent(sw, tabId, { cmd: "start-record" });
    const box = await page.locator("#vanish").boundingBox();
    check("button present before the click", box != null);
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down(); // fires pointerdown (recorder captures) then mousedown (removes)
    await page.mouse.up();   // fires click, retargeted to #host
    await page.waitForTimeout(50);

    const gone = await page.locator("#vanish").count();
    check("button really removed itself on mousedown", gone === 0);

    const { steps } = await sendToContent(sw, tabId, { cmd: "stop-record" });
    const clicks = (steps || []).filter((s) => s.action === "click");
    check("a click step was still captured", clicks.length === 1,
      JSON.stringify(steps?.map((s) => s.action)));

    // The whole point: usable selectors, captured before the node vanished — not the
    // #host fallback the retargeted click would have produced.
    const target = clicks[0]?.target;
    const sel = JSON.stringify(target?.selectors || []);
    check("captured the vanished button's selectors (testid), not the #host retarget",
      sel.includes("vanish-btn"), sel);
    check("target is not the #host retarget", !JSON.stringify(target || {}).includes('"#host"'));
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
