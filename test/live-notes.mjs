// Bao — on-demand LIVE smoke test of anchored capture against real Substack Notes.
//
// Records a Share-click on a chosen note in a feed of many identical Share
// buttons, then replays through the real content.js and asserts it acted on the
// SAME note (by the note's stable id), not the first one. This is the live
// counterpart to the deterministic test/list.mjs regression.
//
// Needs a logged-in session in the persistent profile (one-time):
//   node test/live.mjs login https://substack.com
// Then:
//   node test/live-notes.mjs [targetIndex]     # default index 2 (NOT the first note)
//   HEADED=1 node test/live-notes.mjs          # watch it run
import { chromium } from "playwright";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PROFILE = resolve(ROOT, ".chrome-profile");
const TARGET_INDEX = Number(process.argv[2] ?? 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chromium",
    headless: !process.env.HEADED,
    viewport: { width: 1400, height: 1100 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  }).catch((e) => {
    if (/ProcessSingleton|already in use/.test(e.message))
      throw new Error("the profile is locked — close any Chrome-for-Testing window using .chrome-profile first.");
    throw e;
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
  const send = (tabId, msg) => sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, msg]);

  try {
    const page = await ctx.newPage();
    await page.goto("https://substack.com/notes", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);

    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
    // ensure content.js is live (auto-inject can lag on a heavy page)
    for (let i = 0; i < 20; i++) {
      try { const st = await send(tabId, { cmd: "status" }); if (st && "recording" in st) break; } catch {}
      if (i === 8) await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["dist/content.js"] }), tabId);
      await sleep(200);
    }

    // Tag each note's Share button + container with the note's stable id so we have
    // an oracle independent of the selector machinery.
    const ids = await page.evaluate(() => {
      const shareBtns = [...document.querySelectorAll('button,[role="button"]')]
        .filter((e) => /share/i.test(e.getAttribute("aria-label") || "") || (e.textContent || "").trim() === "Share");
      return shareBtns.map((btn) => {
        let n = btn, link = null;
        for (let i = 0; i < 25 && n && !link; i++) { n = n.parentElement; link = n?.querySelector?.('a[href*="/note/"], a[href*="/p/"]'); }
        const id = (link?.getAttribute("href") || "").match(/c-\d+|\/p\/[\w-]+/)?.[0] || null;
        if (id) btn.setAttribute("data-bao-note", id);
        return id;
      });
    });
    const targetId = ids[TARGET_INDEX];
    if (!targetId) throw new Error(`no note id at index ${TARGET_INDEX} (are you logged in? feed had ${ids.filter(Boolean).length} ided notes)`);
    console.log(`feed note ids: ${JSON.stringify(ids)}`);
    console.log(`target: note #${TARGET_INDEX} = ${targetId}  (first note is ${ids[0]})`);

    // RECORD the Share click on the target note.
    await send(tabId, { cmd: "start-record" });
    await page.click(`[data-bao-note="${targetId}"]`);
    await sleep(600);
    const { steps } = await send(tabId, { cmd: "stop-record" });
    console.log(`captured anchor: ${JSON.stringify(steps[0]?.target?.anchor)}  within: ${JSON.stringify(steps[0]?.target?.within)}`);

    // REPLAY and observe which note content.js actually clicked.
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(300);
    await page.evaluate(() => {
      window.__clicked = [];
      document.addEventListener("click", (e) => {
        const id = e.target.closest("[data-bao-note]")?.getAttribute("data-bao-note");
        if (id) window.__clicked.push(id);
      }, true);
    });
    const res = await send(tabId, { cmd: "replay", steps });
    await sleep(500);
    const clicked = (await page.evaluate(() => window.__clicked))[0];

    console.log(`\nreplay ok: ${res.ok}, via: ${res.results?.[0]?.via}`);
    console.log(`intended ${targetId} | replay clicked ${clicked}`);
    const pass = clicked === targetId;
    console.log(pass ? "✓ PASS — same note" : `✗ FAIL — clicked ${clicked} (feed pos ${ids.indexOf(clicked)})`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await ctx.close();
  }
}

main().catch((e) => { console.error("✗", e.message || e); process.exit(1); });
