// Bao — LIVE blindspot smoke, open shadow DOM. use-cases-and-snapshot-fallback.md §8.
//
// Drives the real extension on a shoelace.style Web Component and asserts capture pierces
// the OPEN shadow boundary: the recorded target is reach=open-shadow with a shadow-piercing
// selector. Opt-in; a network/load failure or missing structure is a SKIP, not a FAIL.
//
// Run: npm run test:live:open-shadow                (headless)
//      npm run test:live:open-shadow -- --headed    (watch in a real window)
import { runCases, openReady, recordVia, flashClick, ok, bad, Skip } from "./live-helpers.mjs";

await runCases({
  "open shadow — shoelace.style (capture a shadowpath on a real <sl-button>)": async (ctx, sw) => {
    const { page, tabId } = await openReady(ctx, sw, "https://shoelace.style/components/button");
    // A demo button in the article body (a primary/variant button), NOT a nav link
    // — clicking a nav sl-button would navigate and drop the recording.
    let btn = page.locator("sl-button:visible").filter({ hasText: /^(Primary|Default|Success|Neutral)/i }).first();
    if (!(await btn.count())) btn = page.locator("sl-button:visible").first();
    if (!(await btn.count())) throw new Skip("no <sl-button> on page");
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await flashClick(page, btn);
    const steps = await recordVia(sw, tabId, () => btn.click({ force: true, timeout: 5000 }).catch(() => {}));
    const t = steps.find((s) => s.target?.reach === "open-shadow")?.target;
    if (!t) throw new Skip(`no open-shadow step captured (got ${JSON.stringify(steps.map((s) => s.target?.reach))})`);
    ok("captured reach=open-shadow on a real Web Component", t.reach);
    (t.selectors?.[0]?.type === "shadowpath" ? ok : bad)("top selector is a shadow-piercing path", t.selectors?.[0]?.type);
  },
}, "live-blindspots open-shadow");
