// T2 regression: contenteditable / rich-text capture + replay.
// Two editors: (a) a bare contenteditable div (browser-native editing) and (b) a
// strict model-driven editor that preventDefaults beforeinput and reverts any DOM
// mutation that bypassed its model — the ProseMirror/Lexical trap. Recording must
// capture typing into both as coalesced `input` steps (mode:"contenteditable"),
// and replay on a reset page must land the text in both.
//
// Run: npm run test:editable   (or: node test/editable.mjs)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture-editable.html")).href;

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

    // Sanity: the strict editor really does reject direct DOM mutation.
    const rejected = await page.evaluate(() => {
      const s = document.getElementById("strict");
      s.textContent = "sneaky direct write";
      return new Promise((r) => setTimeout(() => r(s.textContent), 50));
    });
    check("strict editor reverts direct DOM writes", rejected === "", JSON.stringify(rejected));

    // 1) Record real typing into both editors.
    await sendToContent(sw, tabId, { cmd: "start-record" });
    await page.click("#plain");
    await page.keyboard.type("Hello plain editor");
    await page.click("#strict");
    await page.keyboard.type("Hello strict editor");
    await page.waitForTimeout(100); // beforeinput capture reads text on next tick
    const { steps } = await sendToContent(sw, tabId, { cmd: "stop-record" });

    const inputs = (steps || []).filter((s) => s.action === "input");
    check("exactly 2 input steps (coalesced per editor)", inputs.length === 2, `got ${inputs.length}`);
    check("both are mode=contenteditable", inputs.every((s) => s.mode === "contenteditable"));
    check("plain text captured", inputs.some((s) => s.value?.includes("Hello plain editor")));
    check("strict text captured (via beforeinput — no native input event fires)",
      inputs.some((s) => s.value?.includes("Hello strict editor")));

    // 2) Reset the page, then replay.
    await page.click("#reset");
    const cleared = await page.evaluate(() =>
      [document.getElementById("plain").innerText.trim(), document.getElementById("strict").innerText.trim()]);
    check("editors cleared before replay", cleared.every((t) => t === ""), JSON.stringify(cleared));

    const replay = await sendToContent(sw, tabId, { cmd: "replay", steps });
    check("replay reported ok", replay?.ok === true, JSON.stringify(replay?.results));

    const after = await page.evaluate(() => ({
      plain: document.getElementById("plain").innerText,
      strict: document.getElementById("strict").innerText,
    }));
    check("plain editor refilled by replay", after.plain.includes("Hello plain editor"), after.plain);
    check("strict editor refilled by replay (model-driven path)",
      after.strict.includes("Hello strict editor"), after.strict);
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
