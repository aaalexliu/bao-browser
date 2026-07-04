// T6 regression: the `assert` primitive + the thin runner.
// (1) Record a flow with two assertions captured via the Alt+Shift+A chord (click →
//     "Expect: textPresent"), verify capture and non-fatal in-page replay.
// (2) Pin the other assert kinds (elementVisible / elementAbsent / urlMatches) at the
//     replay level with hand-built steps.
// (3) Drive test/run.mjs as a subprocess: exit 0 on the unchanged page, exit 1 when a
//     ?title= change makes one assertion fail — asserting the CI contract.
//
// Run: npm run test:assert   (or: node test/assert.mjs)
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture-assert.html")).href;
const STEPS_OUT = resolve(ROOT, "out", "assert-steps.json");

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

    // 1) Record: Save (reveals "Saved!"), then two assertions via the Alt+Shift+A chord.
    await sendToContent(sw, tabId, { cmd: "start-record" });
    await page.click("#save");
    await page.keyboard.press("Alt+Shift+A");
    await page.click("#status"); // now reads "Saved!"
    await page.keyboard.press("Alt+Shift+A");
    await page.click("#title");  // "Quarterly Report"
    await page.waitForTimeout(50);
    const { steps } = await sendToContent(sw, tabId, { cmd: "stop-record" });

    const actions = (steps || []).map((s) => s.action);
    check("recorded click + two asserts (chord click didn't record a click step)",
      JSON.stringify(actions) === JSON.stringify(["click", "assert", "assert"]), JSON.stringify(actions));
    const asserts = (steps || []).filter((s) => s.action === "assert");
    check("both asserts are textPresent with the element's text",
      asserts.every((s) => s.assert?.kind === "textPresent")
      && asserts.some((s) => s.assert?.value === "Saved!")
      && asserts.some((s) => s.assert?.value === "Quarterly Report"),
      JSON.stringify(asserts.map((s) => s.assert)));
    check('assert steps carry an "Expect:" label for the popup',
      asserts.every((s) => s.label.startsWith("Expect:")), JSON.stringify(asserts.map((s) => s.label)));

    // 2) In-page replay on a fresh page → both assertions pass, run ok.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const rep = await sendToContent(sw, tabId, { cmd: "replay", steps });
    check("replay ok — save clicked, both asserts passed", rep?.ok === true, JSON.stringify(rep?.results));

    // 2b) The other three assert kinds, hand-built (no capture UX yet), against the
    //     post-save DOM: #save visible, #draft absent (hidden on save), url matches.
    const saveTarget = steps.find((s) => s.action === "click").target;
    const draftTarget = { selectors: [{ type: "id", value: "#draft", score: 0.8 }], reach: "light", unique: true };
    const manual = [
      steps[0], // click Save (hides #draft)
      { action: "assert", label: "vis", ts: 0, target: saveTarget, assert: { kind: "elementVisible" } },
      { action: "assert", label: "abs", ts: 0, target: draftTarget, assert: { kind: "elementAbsent" } },
      { action: "assert", label: "url", ts: 0, assert: { kind: "urlMatches", value: "fixture-assert" } },
      { action: "assert", label: "urlbad", ts: 0, assert: { kind: "urlMatches", value: "nope-not-here" } },
    ];
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const rep2 = await sendToContent(sw, tabId, { cmd: "replay", steps: manual });
    const byi = new Map((rep2?.results || []).map((r) => [r.i, r]));
    check("elementVisible passes for #save", byi.get(1)?.ok === true);
    check("elementAbsent passes for hidden #draft", byi.get(2)?.ok === true, byi.get(2)?.reason);
    check("urlMatches passes for a matching pattern", byi.get(3)?.ok === true);
    check("urlMatches FAILS for a non-matching pattern (non-fatal, run continues)",
      byi.get(4)?.ok === false && rep2?.ok === false, JSON.stringify(rep2?.results));

    // 3) The runner contract: exit 0 unchanged, exit 1 when the title change breaks one.
    mkdirSync(dirname(STEPS_OUT), { recursive: true });
    writeFileSync(STEPS_OUT, JSON.stringify(steps, null, 2));
    const runOK = spawnSync("node", ["test/run.mjs", STEPS_OUT, FIXTURE], { cwd: ROOT, encoding: "utf8" });
    check("runner exits 0 on the unchanged page", runOK.status === 0, `status=${runOK.status}`);
    check("runner report shows both asserts ✓", (runOK.stdout.match(/✓/g) || []).length >= 2);

    const changedUrl = `${FIXTURE}?title=Dashboard`;
    const runBad = spawnSync("node", ["test/run.mjs", STEPS_OUT, changedUrl], { cwd: ROOT, encoding: "utf8" });
    check("runner exits 1 when the title change fails an assert", runBad.status === 1, `status=${runBad.status}`);
    check("runner report shows the failing assert ✗ and the passing one ✓",
      runBad.stdout.includes("✗") && runBad.stdout.includes("Quarterly Report"), runBad.stdout.trim().split("\n").pop());
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
