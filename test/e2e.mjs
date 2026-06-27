// Bao M0 e2e: loads the unpacked extension, records a real user session on a
// fixture page, then replays it — driving the *real* content.js through the same
// chrome.tabs.sendMessage path the popup uses. Outputs are dumped to ./out.
//
// Run: npm test   (or: node test/e2e.mjs)
import { chromium } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "out");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture.html")).href;

const log = (...a) => console.log("•", ...a);
let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

// Relay a popup-style command to the content script via the service worker —
// this is exactly what popup.js does (chrome.tabs.sendMessage to the active tab).
async function sendToContent(sw, tabId, msg) {
  return sw.evaluate(
    ([id, m]) => chrome.tabs.sendMessage(id, m),
    [tabId, msg]
  );
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // `channel: "chromium"` uses the full Chromium build (not headless-shell) whose
  // new headless mode supports MV3 extensions. Set HEADED=1 to watch it run.
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
    ],
  });

  try {
    // 1) Extension loaded → its service worker registers (proves manifest is valid).
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
    const extId = new URL(sw.url()).host;
    check("extension service worker registered", !!extId, extId);

    // 2) Open the fixture; content.js auto-injects via the manifest.
    const page = await ctx.newPage();
    await page.goto(FIXTURE);
    await page.waitForLoadState("domcontentloaded");

    const tabId = await sw.evaluate(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, FIXTURE);
    check("fixture tab found by service worker", tabId != null, `tabId=${tabId}`);

    const status = await sendToContent(sw, tabId, { cmd: "status" });
    check("content script responds (injected)", status && "recording" in status);

    // 3) Record a real session: type + click, driven as real DOM events.
    await sendToContent(sw, tabId, { cmd: "start-record" });
    await page.fill("#email", "ada@example.com");
    await page.fill("#bio", "Hello from the replay.");
    await page.click('[data-testid="submit-btn"]');
    const { steps } = await sendToContent(sw, tabId, { cmd: "stop-record" });

    check("captured 3 steps", steps?.length === 3, `got ${steps?.length}`);
    check(
      "submit click captured via testid selector",
      steps?.some((s) => s.target.selectors[0]?.type === "testid")
    );
    await writeFile(
      resolve(OUT, "recorded-steps.json"),
      JSON.stringify(steps, null, 2)
    );
    log("wrote out/recorded-steps.json");

    // 4) Reset the page state, then replay the recording.
    await page.click("#ember123-reset"); // clears inputs
    const beforeEmail = await page.inputValue("#email");
    check("inputs cleared before replay", beforeEmail === "");

    // Clear the fixture's own event log so we only see replay-driven events.
    await page.evaluate(() => (window.__events = []));

    const replay = await sendToContent(sw, tabId, { cmd: "replay", steps });
    check("replay reported ok", replay?.ok === true, JSON.stringify(replay?.results));

    // 5) Assert the replay actually re-drove the page (the deterministic-replay claim).
    const afterEmail = await page.inputValue("#email");
    const afterBio = await page.inputValue("#bio");
    const events = await page.evaluate(() => window.__events);
    check("email refilled by replay", afterEmail === "ada@example.com", afterEmail);
    check("bio refilled by replay", afterBio === "Hello from the replay.", afterBio);
    check(
      "submit fired by replay",
      events.some((e) => e.kind === "click" && e.detail === "submit-btn")
    );

    await writeFile(
      resolve(OUT, "replay-results.json"),
      JSON.stringify(
        { ok: replay?.ok, results: replay?.results, pageEvents: events },
        null,
        2
      )
    );
    log("wrote out/replay-results.json");
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
