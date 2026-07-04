// T4 regression: keyboard capture — Enter-submit, Escape-dismiss.
// The form has no submit button, so the only submit path is Enter in the field.
// Recording must: capture the typing (onInput), capture Enter as a `keypress` tagged
// `submits:true`, DROP the redundant bare `submit` step (dedup), and capture Escape.
// Replay's synthetic Enter is isTrusted:false so it won't fire the browser's implicit
// submit — the `submits` tag must make replay requestSubmit() the form; Escape must
// re-dispatch and close the modal.
//
// Run: npm run test:keyboard   (or: node test/keyboard.mjs)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture-keyboard.html")).href;

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

    // 1) Record: type, Enter (submits the form), then Escape (closes the modal).
    await sendToContent(sw, tabId, { cmd: "start-record" });
    await page.click("#q");
    await page.keyboard.type("hello world");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(50); // let submit fire so the dedup can tag the Enter step
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);
    const { steps } = await sendToContent(sw, tabId, { cmd: "stop-record" });

    const actions = (steps || []).map((s) => s.action);
    check("recorded input + keypress(Enter) + keypress(Escape)",
      actions.filter((a) => a === "input").length === 1
      && (steps || []).filter((s) => s.action === "keypress").length === 2,
      JSON.stringify(actions));
    const enter = (steps || []).find((s) => s.action === "keypress" && s.key === "Enter");
    const escape = (steps || []).find((s) => s.action === "keypress" && s.key === "Escape");
    check("Enter keypress tagged submits:true", enter?.submits === true);
    check("bare submit step was deduped away", !actions.includes("submit"), JSON.stringify(actions));
    check("Escape keypress captured", !!escape);

    // 2) Replay on a fresh page.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const replay = await sendToContent(sw, tabId, { cmd: "replay", steps });
    check("replay reported ok", replay?.ok === true, JSON.stringify(replay?.results));

    const after = await page.evaluate(() => ({
      result: document.getElementById("result").textContent,
      submits: window.__submits,
      escapes: window.__escapes,
      modalHidden: document.getElementById("modal").hidden,
    }));
    check("form actually submitted via requestSubmit fallback", after.submits === 1, JSON.stringify(after));
    check("submit handler saw the typed value", after.result === "submitted: hello world", after.result);
    check("Escape re-dispatched and closed the modal", after.modalHidden === true && after.escapes === 1,
      JSON.stringify(after));
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
