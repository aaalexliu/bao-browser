// Bao — live gap suite, cat 4 (feed anchoring). §Part 3.
//
// The login-free counterpart to test/live-notes.mjs: Hacker News' front page is 30
// near-identical rows with stable `item?id=` comment links. Records a click on row #4,
// replays, and asserts the content script hit the SAME story (by id), not the first row.
//
// Run: npm run test:live-gaps:feed                (headless)
//      npm run test:live-gaps:feed -- --headed    (watch in a real window)
import { runCases, openReady, recordVia, replayVia, reaches, sleep, ok, bad, Skip } from "./live-helpers.mjs";

await runCases({
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
}, "live-gaps feed");
