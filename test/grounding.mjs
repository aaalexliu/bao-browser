// T11 regression: per-target grounding on EVERY step.
// Every recorded step must carry the self-healing fuel product-design-v1 calls
// non-negotiable #1: a viewport-relative bbox (x/y/w/h as %, plus capture-time vw/vh),
// the element's text and aria role, and step-level meta {viewport, recordedAt}. This
// data is unused at replay today — it exists so a future VLM heal needs no re-record.
//
// Run: npm run test:grounding   (or: node test/grounding.mjs)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture.html")).href;

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function sendToContent(sw, tabId, msg) {
  return sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, msg]);
}

const isPct = (n) => typeof n === "number" && n >= -50 && n <= 150; // viewport-relative %

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
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

    // Record a type + type + click, driven as real DOM events.
    await sendToContent(sw, tabId, { cmd: "start-record" });
    await page.fill("#email", "ada@example.com");
    await page.fill("#bio", "Hello from the replay.");
    await page.click('[data-testid="submit-btn"]');
    const { steps } = await sendToContent(sw, tabId, { cmd: "stop-record" });
    check("captured 3 steps", steps?.length === 3, `got ${steps?.length}`);

    // Every step: step.meta present and sane.
    const metaOk = (steps || []).every((s) =>
      s.meta && s.meta.viewport?.w > 0 && s.meta.viewport?.h > 0 && s.meta.recordedAt > 0);
    check("every step carries meta {viewport, recordedAt}", metaOk,
      JSON.stringify(steps?.map((s) => s.meta)));

    // Every step's target: bbox (viewport %, with vw/vh), text, role.
    const bboxOk = (steps || []).every((s) => {
      const b = s.target?.bbox;
      return b && ["x", "y", "w", "h"].every((k) => isPct(b[k])) && b.vw > 0 && b.vh > 0;
    });
    check("every target carries a viewport-% bbox with vw/vh", bboxOk,
      JSON.stringify(steps?.map((s) => s.target?.bbox)));

    const roleOk = (steps || []).every((s) => "role" in (s.target || {}));
    check("every target carries a role field", roleOk,
      JSON.stringify(steps?.map((s) => s.target?.role)));

    const textOk = (steps || []).every((s) => typeof s.target?.text === "string");
    check("every target carries a text field", textOk,
      JSON.stringify(steps?.map((s) => s.target?.text)));

    // Spot-check semantics: the submit button's role/text are the real ones, and its
    // bbox width is a plausible fraction of the viewport (not zero, not the whole page).
    const click = steps.find((s) => s.action === "click");
    check("submit button role is 'button'", click?.target?.role === "button", click?.target?.role);
    check("submit button captured its text", (click?.target?.text || "").length > 0, click?.target?.text);
    check("submit bbox width is a sane % (0 < w < 100)",
      click?.target?.bbox?.w > 0 && click?.target?.bbox?.w < 100, click?.target?.bbox?.w);
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
