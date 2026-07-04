// Bao — LIVE blindspot smoke, virtualization. use-cases-and-snapshot-fallback.md §8.
//
// Asserts ag-grid.com renders only a WINDOWED slice of rows (a handful of [role=row]
// nodes standing in for thousands of data rows) — the recycled-node lie the anchor +
// scroll-find machinery exists to survive. Opt-in; a load failure / bot-block is a SKIP.
//
// Run: npm run test:live:virtual                (headless)
//      npm run test:live:virtual -- --headed    (watch in a real window)
import { runCases, openReady, sleep, ok, bad, Skip } from "./live-helpers.mjs";

await runCases({
  "virtualization — ag-grid.com (windowed grid: few rows for many rows of data)": async (ctx, sw) => {
    const { page } = await openReady(ctx, sw, "https://www.ag-grid.com/example/", 9000);
    // The grid renders client-side; poll briefly so a slow hydrate doesn't false-skip.
    let sig = { ag: false, rows: 0 };
    for (let i = 0; i < 6 && !sig.ag; i++) {
      sig = await page.evaluate(() => ({
        ag: !!document.querySelector("[class*='ag-']"),
        rows: document.querySelectorAll('[role="row"]').length,
      }));
      if (!sig.ag) await sleep(1000);
    }
    if (!sig.ag) throw new Skip("ag-grid not found (page changed?)");
    ok("ag-grid present", "");
    // The demo grid holds thousands of rows; a windowed slice in the DOM is the tell.
    (sig.rows > 0 && sig.rows < 200 ? ok : bad)("only a windowed slice of rows is in the DOM", `${sig.rows} rows`);
  },
}, "live-blindspots virtual");
