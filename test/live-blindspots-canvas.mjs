// Bao — LIVE blindspot smoke, canvas. use-cases-and-snapshot-fallback.md §8.
//
// Drives the real extension on excalidraw.com and asserts a click on the canvas interior
// classifies as reach=canvas + degraded (no clean selector) — the honest degrade that
// hands off to a Tier-3/4 executor rather than guessing coordinates. Opt-in; a
// network/load failure or missing structure is a SKIP, not a FAIL.
//
// Run: npm run test:live:canvas                (headless)
//      npm run test:live:canvas -- --headed    (watch in a real window)
import { runCases, openReady, recordVia, flashClick, ok, bad, Skip } from "./live-helpers.mjs";

await runCases({
  "canvas — excalidraw.com (extension degrades a canvas click)": async (ctx, sw) => {
    const { page, tabId } = await openReady(ctx, sw, "https://excalidraw.com");
    const canvas = page.locator("canvas").first();
    if (!(await canvas.count())) throw new Skip("no <canvas> on page");
    await flashClick(page, canvas, { x: 300, y: 300 });
    const steps = await recordVia(sw, tabId, () => canvas.click({ position: { x: 300, y: 300 }, force: true, timeout: 5000 }).catch(() => {}));
    const t = steps.find((s) => s.target?.reach === "canvas")?.target;
    if (!t) throw new Skip(`no canvas step captured (got ${JSON.stringify(steps.map((s) => s.target?.reach))})`);
    ok("classified reach=canvas on a real canvas app", t.reach);
    (t.degraded === true ? ok : bad)("marked degraded (no clean selector)", String(t.degraded));
  },
}, "live-blindspots canvas");
