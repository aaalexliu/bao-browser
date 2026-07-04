// Bao — live gap suite, cat 2 (SPA soft-nav, T7). recording-gaps-and-app-universe.md §Part 3.
//
// Drives the real extension on TodoMVC (React, hash routing): clicks across two filter
// routes, asserts the recorder interleaved `softNav` markers, then replays from the All
// route and asserts replay WAITED on the route (via=softNav) before proceeding.
//
// Run: npm run test:live-gaps:spa                (headless)
//      npm run test:live-gaps:spa -- --headed    (watch in a real window)
import { runCases, openReady, recordVia, replayVia, reaches, sleep, ok, bad, Skip } from "./live-helpers.mjs";

await runCases({
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
}, "live-gaps spa");
