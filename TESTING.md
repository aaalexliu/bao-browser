# Testing Bao

> Entry point: [README.md](README.md). This file is the full test-suite reference —
> deterministic regressions, the headless CI runner, and the opt-in live-site smoke suites.

Definition of done for any capability is the repo standard:
**`record → replay → assert correct effect`**, driven through the real `content.js`
(built to `dist/`) via `chrome.tabs.sendMessage` — the same path `sidepanel.ts` uses.

## Automated e2e (default)

A headless Chromium loads the unpacked extension, records a real session on a fixture
page, replays it, and dumps artifacts to `out/`.

```sh
npm install
npx playwright install chromium   # one-time: downloads the browser
npm test                          # npm test -- --headed to watch it run
```

Outputs:
- `out/recorded-steps.json` — captured steps with the ranked selector candidates
- `out/replay-results.json` — per-step resolution (`via` selector) + the events the page fired during replay

`npm test` also runs `test/list.mjs` (`npm run test:list`), the repeated-list
regression: it records a click on one of six identical cards, then reorders /
prepends / deletes / swaps buttons and asserts replay still hits the right one via
its **ancestor anchor** (a stable id, href, or text fingerprint) — the case that
breaks naive aria/text/nth-of-type selectors.

## Assertions + the headless CI runner

Recording supports *expectations*, not just actions: press **Alt+Shift+A** while
recording, then click an element to capture an `assert` (defaults to "expect this
text present"; the panel shows it as `Expect: …`). Assertions are checked at replay,
are **non-fatal** (all are reported; the run fails iff any assert fails), and support
`textPresent | elementVisible | elementAbsent | urlMatches`. The thin CI runner
replays a saved trace and reports a ✓/✗ table:

```sh
node test/run.mjs <steps.json> <url>   # exit 0 = all passed, 1 = a step/assert failed
```

Any exported workflow JSON (from the panel or dashboard) is directly consumable here.

## Test against a real, logged-in site (Substack, LinkedIn, …)

The fixture suite runs in a throwaway profile. To drive a real authenticated page you
need a **persistent profile** (so your login survives) and a **headed** browser (so
you can log in and interact by hand). `test/live.mjs` does this:

```sh
# 1) One-time: log in. A real Chrome window opens — log in fully, then press Enter.
node test/live.mjs login  https://substack.com

# 2) Record: interact with the page yourself, then press Enter to stop.
node test/live.mjs record https://YOURPUB.substack.com/publish/post --out out/post.json

# 3) Replay: re-drives the page from the saved steps.
node test/live.mjs replay https://YOURPUB.substack.com/publish/post --in out/post.json
```

The session is stored in `.chrome-profile/` (git-ignored) and reused on every run, so
you only log in once. `--seconds N` auto-stops recording instead of waiting for Enter.

**Live smoke test of anchoring** — `test/live-notes.mjs` is the real-Substack
counterpart to the deterministic list regression. It records a Share-click on a chosen
note in the Notes feed (many identical Share buttons), replays through the real content
script, and asserts it acted on the *same* note by its stable id:

```sh
node test/live.mjs login https://substack.com   # one-time, if not already
node test/live-notes.mjs                         # default: target note #2 (not the first)
node test/live-notes.mjs 3 --headed              # watch it; target a different note
```

## Live gap-analysis suite

One runnable file per category (sharing `test/live-helpers.mjs`) drives real
record→replay→assert against the no-login targets in
`recording-gaps-and-app-universe.md` §Part 3, scoped to the categories whose
capability actually shipped (so a live FAIL means a regression):

```sh
npm run test:live-gaps               # all four categories, headless
npm run test:live-gaps:forms         # cat 1 only
npm run test:live-gaps:spa           # cat 2 only
npm run test:live-gaps:editors       # cat 3 only
npm run test:live-gaps:feed          # cat 4 only

# Watch one in a real window (headed is per-category — the aggregate is headless):
npm run test:live-gaps:editors -- --headed
npm run test:live-gaps:editors -- lexical   # filter within a multi-case file
```

- **cat 1 forms** (`live-gaps-forms.mjs`) — selenium web-form: records a text `input` +
  native `<select>`, resets both, replays, asserts the values are driven back.
- **cat 2 SPA** (`live-gaps-spa.mjs`) — TodoMVC: clicks across hash routes, asserts a
  `softNav` marker is captured and that replay *waits* on the route (`via=softNav`).
- **cat 3 editors** (`live-gaps-editors.mjs`) — Lexical / ProseMirror / Quill: types a
  unique token, resets via reload, replays through the contenteditable actuator.
  ProseMirror/Quill must accept a synthetic path; **Lexical is the documented "strict
  editor" case** — it cleanly rejects all synthetic paths, treated as the expected
  honest outcome, not a fail.
- **cat 4 feed** (`live-gaps-feed.mjs`) — Hacker News: records a click on story #4 of 30
  identical rows and asserts replay hits the *same* story by its stable `item?id=`.

Same contract as the smoke suite: opt-in (not part of `npm test`); a load failure /
bot-block / missing structure is a **SKIP**, a wrong replay effect is a **FAIL**.

## Live blind-spot suite

`test/live-blindspots-*.mjs` (one file per site, `npm run test:live`) drives the real
extension against the real sites that exercise each structural boundary:

| Site | Asserts |
|---|---|
| shoelace.style | captures `reach=open-shadow` + a `shadowpath` on a real `<sl-button>` |
| excalidraw.com | classifies a canvas click `reach=canvas` + degraded |
| stripe.dev | the `all_frames` content script answers **inside** the cross-origin frame |
| ag-grid.com | windowed grid: only ~18 of thousands of rows in the DOM |
| salesforce.com | real `<cs-native-frame-holder>` has a **closed** root |

Run individually: `npm run test:live:open-shadow` / `:canvas` / `:frames` / `:virtual`
/ `:closed-shadow`. Live sites flake, so these are opt-in — a load failure or fresh
bot-block is a **SKIP**, not a FAIL. Note: ag-grid (CloudFront) and salesforce (Akamai)
bot-block automated sessions unless a realistic `User-Agent` is set.

## Reality check on dynamic pages

Replay is only as deterministic as the page. A *stable* surface (compose box, settings
form) replays reliably. Repeated **feeds** used to be a poor target — but anchored
capture now re-resolves a specific card by its stable id / href / text even after the
feed reorders (see the list regression). The remaining limit is content that has
*scrolled out of the DOM* entirely (virtualization is handled by scroll-find; content
that never renders is not).

## Probe (keeping the live-target registry honest)

```sh
npm run probe   # test/probe-sites.mjs — re-verifies each live target still loads + shows its signal
```

Live sites rot; re-run the probe before trusting the target tables in
`recording-gaps-and-app-universe.md` §Part 3 if they're more than a month old.
