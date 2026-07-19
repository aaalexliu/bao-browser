# Bao M0 Spike

Proves the risky core: **record → deterministic replay** on a single page.
No LLM, no backend, no cross-navigation (those are M1+).

## Load it
1. `npm install && npm run build` — sources are TypeScript (`src/`), esbuild bundles
   them to `dist/` (use `npm run watch` while developing)
2. `chrome://extensions` → toggle **Developer mode** (top right)
3. **Load unpacked** → select this folder (`bao-browser-m0`)
4. Pin the extension, open any normal `http(s)` page (not `chrome://` pages)

## Try it
1. Click the toolbar icon — the **side panel** opens (T15; it stays open while you
   work, unlike the old popup)
2. **● Record**, then click around / type into fields on the page — steps appear
   live in the panel as you interact
3. **■ Stop** — the recording is auto-saved with a generated name; the name is
   focused for an inline rename (typing replaces it, Enter commits)
4. **▶ Run** from a workflow card or its detail view — the step list shows live
   ✓/✗ progress, pauses inline with a **Continue** button when a step needs you
5. Workflows are searchable, grouped by site, pinnable, and import/export as JSON
   (the exported file is directly usable by `node test/run.mjs`)
6. Open the **dashboard** (the ⤢ button in the panel header, or right-click the
   extension → Options) for a full-page home: browse the library at width, **edit** a
   workflow's steps (reorder / delete / edit values, no re-record - T16 §3), and
   re-watch **run history** as a record-vs-replay **filmstrip**. Every replay now saves
   a screenshot per step (IndexedDB `bao-history`), paired with the record-time golden
   frame so you can scrub what replay saw against what recording expected.

## Test it (automated)
A headless e2e loads the unpacked extension, records a real session on a fixture
page, replays it, and dumps the artifacts to `out/`.

```sh
npm install
npx playwright install chromium   # one-time: downloads the browser
npm test                          # npm test -- --headed to watch it run
```

It drives the **real** `content.ts` (built to `dist/content.js`) through
`chrome.tabs.sendMessage` (the same path `sidepanel.ts` uses) and asserts the page was actually re-driven. Outputs:
- `out/recorded-steps.json` — captured steps with the ranked selector candidates
- `out/replay-results.json` — per-step resolution (`via` selector) + the events the page fired during replay

**Assertions + headless runner (T6)** — recording supports *expectations*, not just
actions: press **Alt+Shift+A** while recording, then click an element to capture an
`assert` (defaults to "expect this text present"; the panel shows it as `Expect: …`).
Assertions are checked at replay, are **non-fatal** (all are reported; the run fails
iff any assert fails), and support `textPresent | elementVisible | elementAbsent |
urlMatches`. The thin CI runner replays a saved trace and reports a ✓/✗ table:

```sh
node test/run.mjs <steps.json> <url>   # exit 0 = all passed, 1 = a step/assert failed
```

`npm test` also runs `test/list.mjs` (`npm run test:list`), the repeated-list
regression: it records a click on one of six identical cards, then reorders /
prepends / deletes / swaps buttons and asserts replay still hits the right one
via its **ancestor anchor** (a stable id, href, or text fingerprint) — the case
that breaks naive aria/text/nth-of-type selectors.

## Test against a real, logged-in site (Substack, LinkedIn, …)
The fixture above runs in a throwaway profile. To drive a real authenticated page
you need a **persistent profile** (so your login survives) and a **headed**
browser (so you can log in and interact by hand). `test/live.mjs` does this:

```sh
# 1) One-time: log in. A real Chrome window opens — log in fully, then press Enter.
node test/live.mjs login  https://substack.com

# 2) Record: interact with the page yourself, then press Enter to stop.
node test/live.mjs record https://YOURPUB.substack.com/publish/post --out out/post.json

# 3) Replay: re-drives the page from the saved steps.
node test/live.mjs replay https://YOURPUB.substack.com/publish/post --in out/post.json
```

The session is stored in `.chrome-profile/` (git-ignored) and reused on every run,
so you only log in once. `--seconds N` auto-stops recording instead of waiting for Enter.

**Live smoke test of anchoring** — `test/live-notes.mjs` is the real-Substack
counterpart to the deterministic list regression. It records a Share-click on a
chosen note in the Notes feed (many identical Share buttons), replays through the
real content script, and asserts it acted on the *same* note by its stable id:

```sh
node test/live.mjs login https://substack.com   # one-time, if not already
node test/live-notes.mjs                         # default: target note #2 (not the first)
node test/live-notes.mjs 3 --headed              # watch it; target a different note
```

**Live gap-analysis suite** — one runnable file per category (sharing
`test/live-helpers.mjs`) drives real record→replay→assert against the no-login targets
in `recording-gaps-and-app-universe.md` §Part 3, scoped to the categories whose
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
  native `<select>`, resets both, replays, asserts the values are driven back (real
  baseline→target round-trip)
- **cat 2 SPA (T7)** (`live-gaps-spa.mjs`) — TodoMVC: clicks across hash routes, asserts a
  `softNav` marker is captured and that replay *waits* on the route (`via=softNav`)
- **cat 3 editors (T2)** (`live-gaps-editors.mjs`) — Lexical / ProseMirror / Quill: types a
  unique token, resets via reload, replays through the contenteditable actuator.
  ProseMirror/Quill must accept a synthetic path; **Lexical is the documented "strict
  editor" case** — it cleanly rejects all synthetic paths, treated as the expected honest
  outcome, not a fail
- **cat 4 feed** (`live-gaps-feed.mjs`) — Hacker News: records a click on story #4 of 30
  identical rows and asserts replay hits the *same* story by its stable `item?id=` (the
  login-free counterpart to `live-notes.mjs`)

Same contract as the smoke suite: opt-in (not part of `npm test`); a load failure /
bot-block / missing structure is a **SKIP**, a wrong replay effect is a **FAIL**.

**Reality check on dynamic pages:** replay is only as deterministic as the page.
A *stable* surface (compose box, settings form) replays reliably. Repeated **feeds**
used to be a poor target — but anchored capture now re-resolves a specific card by
its stable id / href / text even after the feed reorders (see the list regression).
The remaining limit is content that has *scrolled out of the DOM* entirely.

## What it demonstrates (the M0 risk-burndown)
- **Ranked multi-selector capture** (`src/content.ts` → `getSelectors`): testid > aria > text > stable id > css path
- **Multi-selector fallback resolution** (`resolveStep`): tries each selector, first hit wins
- **The input actuator** (`setNativeValue`): native value setter + real `InputEvent` so React/Vue register the change
- **Graceful failure**: replay stops at the first unresolved step and reports which one

## Known M0 limits (by design — next milestones)
- ~~Single page only~~ **landed (M1/T8):** recording streams steps to the SW
  (`chrome.storage.session`), replay runs a storage-backed RunState machine in the SW
  (phases `executing → awaiting_nav → … → done|failed`, plus a resumable
  `paused_for_user` with an inline Continue button in the panel) — both survive full-document
  navigations and SW death; see `test/nav.mjs`
- contenteditable replay drives editors via `execCommand("insertText")` (deprecated but
  still the only synthetic path most editors accept) with a `beforeinput` dispatch
  fallback; heavily custom editors may reject both — replay then fails the step with a
  clear report rather than pretending (Google Docs is canvas-rendered anyway)
- ~~no keypress / checkbox-state / pointerdown-timing capture~~ **landed (P0/T3–T5):**
  checkbox/radio record their end-**state** and replay as *set*, not toggle
  (`test/check.mjs`); `Enter`/`Escape`/`Tab` record as `keypress` and Enter-submit is
  tagged so replay `requestSubmit()`s it (`test/keyboard.mjs`); the click target is
  grabbed at `pointerdown` so a node that unmounts before `click` is still captured
  (`test/pointerdown.mjs`)
- No screenshots / audit trail yet (full-viewport capture comes with the auditable-replay work)
- Naive `change`/`input` coalescing; no scroll steps yet
- Selector heuristics are a starting port of Playwright/Chrome-Recorder ideas, not tuned
