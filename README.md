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
1. Click the icon → **● Record**
2. Click around / type into fields on the page
3. Reopen the icon → **■ Stop** (shows the captured steps in plain English)
4. Reload or reset the page → **▶ Replay** (watch the red highlight re-drive it)

## Test it (automated)
A headless e2e loads the unpacked extension, records a real session on a fixture
page, replays it, and dumps the artifacts to `out/`.

```sh
npm install
npx playwright install chromium   # one-time: downloads the browser
npm test                          # HEADED=1 npm test to watch it run
```

It drives the **real** `content.ts` (built to `dist/content.js`) through
`chrome.tabs.sendMessage` (the same path `popup.ts` uses) and asserts the page was actually re-driven. Outputs:
- `out/recorded-steps.json` — captured steps with the ranked selector candidates
- `out/replay-results.json` — per-step resolution (`via` selector) + the events the page fired during replay

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
HEADED=1 node test/live-notes.mjs 3              # watch it; target a different note
```

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
  `paused_for_user` with a popup Continue button) — both survive full-document
  navigations and SW death; see `test/nav.mjs`
- contenteditable replay drives editors via `execCommand("insertText")` (deprecated but
  still the only synthetic path most editors accept) with a `beforeinput` dispatch
  fallback; heavily custom editors may reject both — replay then fails the step with a
  clear report rather than pretending (Google Docs is canvas-rendered anyway)
- No screenshots / audit trail yet (full-viewport capture comes with the auditable-replay work)
- Naive `change`/`input` coalescing; no dropdown/keypress/scroll steps yet
- Selector heuristics are a starting port of Playwright/Chrome-Recorder ideas, not tuned
