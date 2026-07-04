// Bao — LIVE blindspot smoke, closed shadow DOM. use-cases-and-snapshot-fallback.md §8.
//
// Asserts a real CLOSED shadow root exists in the wild (salesforce.com ships a
// <cs-native-frame-holder> whose shadowRoot is null). We do NOT force-open here —
// patching attachShadow before the widget mounts can break its own init; force-open's
// fix is proven deterministically in test/forceopen.mjs. The live claim is only that the
// closed boundary EXISTS. Opt-in; a load failure / bot-block is a SKIP, not a FAIL.
//
// Run: npm run test:live:closed-shadow                (headless)
//      npm run test:live:closed-shadow -- --headed    (watch in a real window)
import { runCases, openReady, sleep, ok, bad, Skip } from "./live-helpers.mjs";

await runCases({
  "closed shadow — salesforce.com (a real closed shadow root exists in the wild)": async (ctx, sw) => {
    const { page } = await openReady(ctx, sw, "https://www.salesforce.com", 5000);
    let found = false;
    for (let i = 0; i < 9 && !found; i++) {
      found = await page.evaluate(() => !!document.querySelector("cs-native-frame-holder"));
      if (!found) await sleep(1000);
    }
    if (!found) throw new Skip("closed-shadow widget <cs-native-frame-holder> didn't load");
    const closed = await page.evaluate(() => document.querySelector("cs-native-frame-holder").shadowRoot === null);
    (closed ? ok : bad)("real <cs-native-frame-holder> has a CLOSED root (shadowRoot===null)", String(closed));
  },
}, "live-blindspots closed-shadow");
