// Bao M0 — drive record/replay against a REAL, logged-in, dynamic site.
//
// The trick vs. the fixture e2e: a *persistent* Chrome profile so your login
// survives between runs, and headed mode so you can log in / interact by hand.
//
//   node test/live.mjs login  <url>                  # one-time: log in, session is saved
//   node test/live.mjs record <url> [--seconds N] [--out file]
//   node test/live.mjs replay <url> [--in file]
//
// Examples:
//   node test/live.mjs login  https://substack.com
//   node test/live.mjs record https://yourpub.substack.com/publish/post   # interact, then press Enter
//   node test/live.mjs replay https://yourpub.substack.com/publish/post
import { chromium } from "playwright";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, "out");
const PROFILE = resolve(ROOT, ".chrome-profile"); // persistent → keeps your login

const [, , cmd, url, ...rest] = process.argv;
const flag = (name, def) => {
  const i = rest.indexOf(name);
  return i === -1 ? def : rest[i + 1];
};
const stepsFile = flag("--out", flag("--in", resolve(OUT, "live-steps.json")));

if (!cmd || !url) {
  console.error("usage: node test/live.mjs <login|record|replay> <url> [--seconds N] [--out/--in file]");
  process.exit(2);
}

function waitForEnter(msg) {
  process.stdout.write(msg);
  return new Promise((r) => {
    process.stdin.resume();
    process.stdin.once("data", () => { process.stdin.pause(); r(); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  // Persistent profile + headed: this is what makes logged-in testing possible.
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium",
    headless: false,
    viewport: null,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  return { ctx, sw };
}

// Same path popup.js uses: relay a command to the content script via the SW.
const send = (sw, tabId, msg) =>
  sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, msg]);

// content.js auto-injects at `document_idle`, which fires *after* the
// `domcontentloaded` we wait on in openTab. On a fast local page that gap is
// nil, but on a heavy site (substack, etc.) we can message the tab before the
// content script's onMessage listener exists → "Could not establish
// connection. Receiving end does not exist." Poll a status ping until it
// answers, and if the auto-injection never lands, inject programmatically
// (manifest already grants "scripting"). Also covers SW/navigation teardown.
async function ensureReady(sw, tabId, { tries = 25, delay = 200 } = {}) {
  let injected = false;
  for (let i = 0; i < tries; i++) {
    try {
      const st = await send(sw, tabId, { cmd: "status" });
      if (st && "recording" in st) return st;
    } catch (e) {
      if (!/Receiving end does not exist|Could not establish connection/.test(e.message)) throw e;
    }
    // Halfway through, stop waiting on auto-injection and force it.
    if (!injected && i >= Math.floor(tries / 2)) {
      injected = true;
      await sw.evaluate(
        (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] }),
        tabId
      );
    }
    await sleep(delay);
  }
  throw new Error("content script never became ready on this page");
}

async function openTab(ctx, sw, target) {
  const page = await ctx.newPage();
  await page.goto(target, { waitUntil: "domcontentloaded" });
  // Match on the URL the tab actually *landed* on, not the one we asked for:
  // sites like substack 301 www→apex, so `target` no longer matches the tab.
  const final = page.url();
  const { origin, pathname } = new URL(final);
  const tabId = await sw.evaluate(async ([pattern, finalUrl]) => {
    // Try the resolved origin+path first, then fall back to the active tab in
    // case a later redirect (or query/hash) leaves the URL pattern off.
    const [byUrl] = await chrome.tabs.query({ url: pattern });
    if (byUrl) return byUrl.id;
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return active?.id ?? null;
  }, [`${origin}${pathname}*`, final]);
  return { page, tabId };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { ctx, sw } = await launch();

  try {
    if (cmd === "login") {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitForEnter(
        `\nLog in fully in the opened window, then press Enter here to save the session…\n`
      );
      console.log(`✓ session saved to ${PROFILE} — record/replay will reuse it.`);
      return;
    }

    const { page, tabId } = await openTab(ctx, sw, url);
    if (tabId == null) throw new Error("could not find the tab via service worker");
    await ensureReady(sw, tabId);

    if (cmd === "record") {
      await send(sw, tabId, { cmd: "start-record" });
      const seconds = flag("--seconds");
      if (seconds) {
        console.log(`● recording for ${seconds}s — interact with the page now…`);
        await sleep(Number(seconds) * 1000);
      } else {
        await waitForEnter("● recording — interact with the page, then press Enter to stop…\n");
      }
      const { steps } = await send(sw, tabId, { cmd: "stop-record" });
      await writeFile(stepsFile, JSON.stringify(steps, null, 2));
      console.log(`✓ captured ${steps.length} steps → ${stepsFile}`);
      steps.forEach((s, i) =>
        console.log(`  ${i + 1}. ${s.label}${s.value ? ` = "${s.value}"` : ""}`)
      );
      return;
    }

    if (cmd === "replay") {
      const steps = JSON.parse(await readFile(stepsFile, "utf8"));
      console.log(`▶ replaying ${steps.length} steps…`);
      const res = await send(sw, tabId, { cmd: "replay", steps });
      await writeFile(
        resolve(OUT, "live-replay-results.json"),
        JSON.stringify(res, null, 2)
      );
      if (res.ok) console.log(`✓ replayed ${steps.length} steps → out/live-replay-results.json`);
      else
        console.log(
          `✗ failed at step ${res.failedAt + 1}: ${res.results.at(-1).reason}\n  → out/live-replay-results.json`
        );
      await waitForEnter("Press Enter to close the browser…\n");
      return;
    }

    throw new Error(`unknown command: ${cmd}`);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error("✗", e.message || e);
  process.exit(1);
});
