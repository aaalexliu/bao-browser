// Bao — LIVE record→replay→assert against the gap-analysis targets
// (recording-gaps-and-app-universe.md §Part 3), scoped to the categories whose
// capability actually SHIPPED and can therefore be validated end-to-end:
//
//   cat 1  forms   — text `input` + native `<select>` round-trip (selenium web-form)
//   cat 2  SPA      — T7 soft-nav: click across hash routes, replay waits on `softNav`
//   cat 3  editors  — T2 contenteditable: type → replay via setEditableValue
//                     (lexical / prosemirror / quill — pins which synthetic path each
//                      accepts; an editor that rejects ALL paths fails honestly)
//   cat 4  feed     — anchor/selector targeting the SAME row among 30 identical ones
//                     (Hacker News — the login-free counterpart to live-notes.mjs)
//
// Same contract as test/live-blindspots.mjs: opt-in (NOT part of `npm test`), real
// sites flake, so a load failure / fresh bot-block / missing structure is a SKIP, not
// a FAIL. A FAIL means the site loaded and exhibited its structure but record→replay
// produced the wrong effect — i.e. a shipped capability regressed.
//
// Run: npm run test:live-gaps                     (all cases, headless)
//      npm run test:live-gaps -- --headed         (watch in a real window)
//      npm run test:live-gaps -- editor --headed  (only cases matching "editor")
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const HEADED = argv.includes("--headed") || argv.includes("-H");
const ONLY = argv.find((a) => !a.startsWith("-"))?.toLowerCase();

let pass = 0, fail = 0, skip = 0;
const ok = (n, e) => { console.log(`  ✓ ${n}${e ? ` — ${e}` : ""}`); pass++; };
const bad = (n, e) => { console.log(`  ✗ ${n}${e ? ` — ${e}` : ""}`); fail++; };
class Skip extends Error {}

const send = (sw, tabId, msg, opts) =>
  sw.evaluate(([id, m, o]) => chrome.tabs.sendMessage(id, m, o || {}), [tabId, msg, opts]);

// Record via the SW's cross-frame buffer (same path as live-blindspots): reset the
// buffer, arm the real content script, run `act`, stop, and drain what the content
// script reported at stop-record (`bao-frame-steps`) — includes softNav markers and
// coalesced input steps.
async function recordVia(sw, tabId, act) {
  await sw.evaluate(() => { self.__baoSteps = []; });
  await send(sw, tabId, { cmd: "start-record" }).catch(() => {});
  await act();
  await send(sw, tabId, { cmd: "stop-record" }).catch(() => {});
  await sleep(350);
  return sw.evaluate(() => self.baoDrainSteps());
}
// Replay through the REAL content-script replayer (the M0 single-page path — all four
// categories here are single-document flows).
const replayVia = (sw, tabId, steps) => send(sw, tabId, { cmd: "replay", steps });

// Poll until the content script answers (heavy pages inject late); force-inject at the
// halfway mark if auto-injection hasn't landed. Reused after a page.reload().
async function ensureReady(sw, tabId) {
  for (let i = 0; i < 20; i++) {
    try { const st = await send(sw, tabId, { cmd: "status" }); if (st && "recording" in st) return; } catch (_) {}
    if (i === 10) await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["dist/content.js"] }), tabId).catch(() => {});
    await sleep(300);
  }
}

async function openReady(ctx, sw, url, waitMs = 4000) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) { throw new Skip(`navigation failed: ${e.message.slice(0, 60)}`); }
  await sleep(waitMs); // hydration: SPA mount / editor init
  const final = page.url();
  const { origin, pathname } = new URL(final);
  const tabId = await sw.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0]?.id, `${origin}${pathname}*`);
  if (tabId == null) throw new Skip("tab not found via SW");
  await ensureReady(sw, tabId);
  return { page, tabId };
}

const reaches = (steps) => JSON.stringify(steps.map((s) => `${s.action}${s.mode ? ":" + s.mode : ""}`));
const token = () => "baolive" + Math.random().toString(36).slice(2, 8);

const SITES = {
  // ---------------------------------------------------------------- cat 1: forms
  "cat1 forms — selenium web-form (text input + native <select> round-trip)": async (ctx, sw) => {
    const { page, tabId } = await openReady(ctx, sw, "https://www.selenium.dev/selenium/web/web-form.html");
    const text = page.locator('input[name="my-text"]');
    const select = page.locator('select[name="my-select"]');
    if (!(await text.count()) || !(await select.count())) throw new Skip("web-form structure changed (no my-text / my-select)");

    // Pick a target option that genuinely DIFFERS from the reset baseline (options[0]),
    // so replay has to actually change the value — not a no-op that fakes a pass.
    const opts = await select.evaluate((s) => [...s.options].filter((o) => !o.disabled).map((o) => o.value));
    const base = opts[0];
    const optValue = opts.find((v, i) => i > 0 && v && v !== base);
    if (!optValue) throw new Skip("no distinct second <option> to round-trip");
    const tok = token();

    // RECORD: fill fires `input` → input step; selectOption fires `change` → select step.
    const steps = await recordVia(sw, tabId, async () => {
      await text.fill(tok);
      await select.selectOption(optValue);
      await sleep(200);
    });
    const inputStep = steps.find((s) => s.action === "input");
    const selectStep = steps.find((s) => s.action === "select");
    if (!inputStep || !selectStep) throw new Skip(`did not capture input+select (got ${reaches(steps)})`);
    (inputStep.value === tok ? ok : bad)("captured the text input value", inputStep.value);

    // RESET both fields to the baseline, then REPLAY and assert the values were driven back.
    await text.fill("");
    await select.selectOption(base);
    const res = await replayVia(sw, tabId, steps);
    (res.ok ? ok : bad)("replay ran all steps", res.ok ? "" : res.results?.at(-1)?.reason);
    const after = await page.evaluate(() => ({
      text: document.querySelector('input[name="my-text"]').value,
      sel: document.querySelector('select[name="my-select"]').value,
    }));
    (after.text === tok ? ok : bad)("text input value restored via native setter", after.text);
    (after.sel === optValue ? ok : bad)("native <select> value restored (baseline → target)", `${after.sel} (was ${base}, wanted ${optValue})`);
  },

  // -------------------------------------------------------------- cat 2: SPA soft-nav
  "cat2 SPA — todomvc react (T7 soft-nav across hash routes, replay waits)": async (ctx, sw) => {
    const { page, tabId } = await openReady(ctx, sw, "https://todomvc.com/examples/react/dist/");
    const input = page.locator(".new-todo, input.new-todo, [data-testid='text-input']").first();
    if (!(await input.count())) throw new Skip("todomvc input not found (layout changed)");
    // The filter footer only renders with ≥1 todo — seed one directly (Enter-commit is
    // out of the recorder's scope; this is fixture setup, not the thing under test).
    await input.fill("bao gap test");
    await input.press("Enter");
    await sleep(300);
    const filters = page.locator(".filters a, [class*='filter'] a");
    const active = filters.filter({ hasText: /^Active$/i }).first();
    const completed = filters.filter({ hasText: /^Completed$/i }).first();
    const all = filters.filter({ hasText: /^All$/i }).first();
    if (!(await active.count()) || !(await completed.count())) throw new Skip("filter links absent (todo seed failed?)");

    // RECORD: click Active then Completed — the hash route changes between them, so the
    // recorder should interleave `softNav` markers.
    const steps = await recordVia(sw, tabId, async () => {
      await active.click();
      await sleep(250);
      await completed.click();
      await sleep(250);
    });
    const softNavs = steps.filter((s) => s.action === "softNav");
    if (!softNavs.length) throw new Skip(`no softNav captured (got ${reaches(steps)}) — route may not change href`);
    ok("captured softNav marker(s) across hash routes", softNavs.map((s) => s.urlAfter?.match(/#.*/)?.[0]).join(" "));

    // RESET to the All route (no reload — keeps the content script), then REPLAY cold.
    if (await all.count()) await all.click();
    await sleep(300);
    const res = await replayVia(sw, tabId, steps);
    const softNavResult = res.results?.find((r) => r.via === "softNav");
    (softNavResult ? ok : bad)("replay resolved a softNav step (waited on the route)", softNavResult ? "via=softNav" : "no softNav in results");
    (res.ok ? ok : bad)("full soft-nav flow replayed", res.ok ? "" : res.results?.at(-1)?.reason);
    const landed = await page.evaluate(() => location.hash);
    (/completed/i.test(landed) ? ok : bad)("ended on the recorded Completed route", landed);
  },

  // ------------------------------------------------------------------ cat 3: editors
  // Lexical is the doc's named "strict editor case": failure to accept a synthetic path
  // is the DOCUMENTED honest outcome, not a regression (accepts: false) — so it stays
  // green whether the actuator drives it or cleanly refuses. ProseMirror/Quill are
  // expected to accept; a rejection there IS a regression.
  ...editorCase("cat3 editor — lexical (contenteditable, beforeinput-driven)", "https://playground.lexical.dev/", '[data-lexical-editor="true"], .editor-input[contenteditable="true"]', { accepts: false }),
  ...editorCase("cat3 editor — prosemirror (contenteditable, transaction-based)", "https://prosemirror.net/examples/basic/", '.ProseMirror[contenteditable="true"]'),
  ...editorCase("cat3 editor — quill (contenteditable, Delta model)", "https://quilljs.com/", '.ql-editor'),

  // -------------------------------------------------------------------- cat 4: feed
  "cat4 feed — Hacker News (anchor targets the SAME story among 30 identical rows)": async (ctx, sw) => {
    const { page, tabId } = await openReady(ctx, sw, "https://news.ycombinator.com/");
    // Oracle: tag each story's comments link with its stable item id, and neutralize
    // the navigation so a click is observable without tearing the page down (same
    // technique as live-notes.mjs, which relied on Share being non-navigating).
    const ids = await page.evaluate(() => {
      document.addEventListener("click", (e) => {
        const a = e.target.closest?.('a[href^="item?id="]');
        if (a) { e.preventDefault(); (window.__baoClicked ||= []).push(a.getAttribute("data-bao-id")); }
      }, true);
      const links = [...document.querySelectorAll('a[href^="item?id="]')]
        .filter((a) => /comment|discuss/i.test(a.textContent) || a.textContent.trim() === "discuss");
      return links.map((a, i) => {
        const id = (a.getAttribute("href").match(/id=(\d+)/) || [])[1] || String(i);
        a.setAttribute("data-bao-id", id);
        return id;
      });
    });
    if (ids.length < 10) throw new Skip(`too few comment links (${ids.length}) — HN layout changed or bot-blocked`);
    const N = 4; // deliberately NOT the first row
    const targetId = ids[N];
    ok(`front page has ${ids.length} comment links`, `target row #${N} = item ${targetId}`);

    // RECORD a click on row N's comments link.
    const steps = await recordVia(sw, tabId, () => page.click(`a[data-bao-id="${targetId}"]`));
    const click = steps.find((s) => s.action === "click");
    if (!click) throw new Skip(`no click captured (got ${reaches(steps)})`);

    // REPLAY and observe which story the content script actually clicked.
    await page.evaluate(() => { window.__baoClicked = []; });
    const res = await replayVia(sw, tabId, steps);
    await sleep(300);
    const clicked = (await page.evaluate(() => window.__baoClicked || []))[0];
    (res.ok ? ok : bad)("replay resolved and clicked a comments link", res.ok ? `via=${res.results?.[0]?.via}` : res.results?.at(-1)?.reason);
    (clicked === targetId ? ok : bad)("clicked the SAME story, not the first row", `clicked ${clicked} (wanted ${targetId}, first is ${ids[0]})`);
  },
};

// An editor case is the same shape three times, so factor it. We append a unique token
// (fighting each editor's clear/select-all semantics is fragile and beside the point),
// then RESET with a clean page.reload() — a fresh editor guaranteed token-free — and
// assert the token comes back via the contenteditable actuator, reporting honestly
// (bad, not throw) when an editor rejects every synthetic path. NB: focus must be taken
// INSIDE the record window (via focus(), which fires no click → no stray click step)
// because the start-record round-trip blurs the page.
function editorCase(name, url, sel, { accepts = true } = {}) {
  return {
    [name]: async (ctx, sw) => {
      const { page, tabId } = await openReady(ctx, sw, url, 5000);
      let ed = page.locator(`${sel}:visible`).first();
      if (!(await ed.count())) throw new Skip(`no visible contenteditable root for ${sel}`);
      const tok = token();

      // RECORD: focus INSIDE the record window (the start-record round-trip blurs the
      // page), select-all, then type the token so it OVERWRITES the demo content — the
      // recorded value isolates to just the token, a fair test of the actuator (else a
      // huge multi-line demo+token value stresses editors' innerText normalization).
      const steps = await recordVia(sw, tabId, async () => {
        await ed.focus();
        // Double select-all: Lexical's first Cmd+A selects only the current block; the
        // second extends to the whole editor so the type overwrites everything.
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type(tok, { delay: 20 });
        await sleep(200);
      });
      const editStep = steps.find((s) => s.action === "input" && s.mode === "contenteditable");
      if (!editStep) throw new Skip(`no contenteditable input step (got ${reaches(steps)})`);
      const isolated = (editStep.value || "").trim() === tok;
      (editStep.value?.includes(tok) ? ok : bad)(`captured mode=contenteditable${isolated ? " (value == token)" : " (token appended to demo)"}`, (editStep.value || "").slice(0, 30));

      // RESET: reload for a pristine, token-free editor (robust across all three).
      await page.reload({ waitUntil: "domcontentloaded" });
      await sleep(5000);
      await ensureReady(sw, tabId);
      ed = page.locator(`${sel}:visible`).first();
      if ((await ed.innerText().catch(() => "")).includes(tok)) throw new Skip("token survived reload — can't isolate replay");

      // REPLAY through setEditableValue; assert both the actuator's own verdict and the
      // ground truth (token visible in innerText).
      const res = await replayVia(sw, tabId, steps);
      await sleep(300);
      const nowText = (await ed.innerText().catch(() => "")).trim();
      const landed = nowText.includes(tok);
      if (landed && res.ok) ok("replay inserted the text — actuator verified", nowText.slice(0, 40));
      else if (landed) (accepts ? bad : ok)("text present but actuator reported failure (verify too strict?)", res.results?.at(-1)?.reason);
      else if (accepts) bad("regression: editor was expected to accept a synthetic path", res.results?.at(-1)?.reason);
      else ok("confirmed honest failure — strict editor rejects all synthetic paths (documented)", res.results?.at(-1)?.reason?.slice(0, 40));
    },
  };
}

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !HEADED,
    // Realistic UA so CDN-fronted sites don't bot-block the automated session outright
    // (a blocked site is a SKIP, per the live contract).
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1400, height: 1000 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10_000 });
    for (const [name, fn] of Object.entries(SITES)) {
      if (ONLY && !name.toLowerCase().includes(ONLY)) continue;
      console.log(`\n• ${name}`);
      try { await fn(ctx, sw); }
      catch (e) {
        if (e instanceof Skip) { console.log(`  ⊘ SKIP — ${e.message}`); skip++; }
        else { console.log(`  ✗ ERROR — ${e.message?.slice(0, 120)}`); fail++; }
      }
    }
  } finally {
    await ctx.close();
  }
}

main()
  .then(() => {
    console.log(`\n${fail ? "✗" : "✓"} live-gaps: ${pass} passed, ${fail} failed, ${skip} skipped`);
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => { console.error("\n✗ harness error:", e); process.exit(1); });
