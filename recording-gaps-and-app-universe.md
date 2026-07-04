# Bao — Recording-Gap Task Specs & the App-Universe Map

> Siblings: [[product-design-v1]] (architecture, IR, executor seam), [[m1-design]]
> (cross-nav state machine), [[use-cases-and-snapshot-fallback]] (wedges, tiers,
> blind spots).
> This doc: (1) every known recording/capture gap specced as an executable task for
> an agent, ordered by priority; (2) a taxonomy of the full universe of browser-style
> applications, what fraction each layer of work unlocks, and where the approach
> bottoms out — with a HubSpot-class rich-SaaS walkthrough as the worked example;
> (3) bot-accessible, no-login live targets per category (verified via
> `npm run probe` / `test/probe-sites.mjs`) and what each test case must cover.

---

# Part 1 — Task specs

Conventions for every task: the recorder lives in `content.js` (one instance per
frame, `all_frames`), the SW is `background.js`, popup is `popup.js`. Regressions go
in `test/` as a fixture (`fixture-*.html`) + a `.mjs` harness following the pattern in
`test/e2e.mjs` (launch Chromium with the unpacked extension, drive the real
`content.js` via `chrome.tabs.sendMessage`, assert on the replay report). Definition
of done per task = `record → replay → assert correct effect` passes on its fixture and
`npm test` stays green. Keep each task a separate branch/PR.

## P0 — correctness & liability (small; ship before anything else)

### T1. Mask sensitive input values
- **Goal:** never persist a secret in plaintext. Today `onInput` records
  `step.value = el.value` for `type=password` fields and the popup writes it to
  `chrome.storage.local` unencrypted.
- **Do:** in `makeStep`/`onInput` (content.js), classify the field sensitive when
  `type === "password"`, `autocomplete` matches `cc-*|one-time-code|current-password|new-password`,
  or `name|id|aria-label` matches `/ssn|social.?security|passport|routing|account.?number/i`.
  For sensitive steps: set `step.sensitive = true`, store `value: null`, and a
  `valueMask` like `"••••••••"` for display. At replay, a sensitive step with no value
  degrades to a fail-with-report ("secret not stored — re-enter and continue"), which
  later becomes a `waitForUser` (T8) or a `{{variable}}` (M4 parameterization).
- **Also:** redact sensitive values from anything the harness dumps to `out/`.
- **Accept:** new `test/fixture-sensitive.html` (password + SSN-named field + normal
  field); recorded JSON contains no secret string anywhere (grep the serialized
  steps); normal field still records/replays.
- **Size:** S.

### T2. contenteditable / rich-text capture + replay
- **Goal:** typing into contenteditable surfaces (ProseMirror, Lexical, Slate, Quill,
  Gmail/Substack/Notion/HubSpot-notes composers) records an `input` step. Today
  `onInput` bails unless `isTextField(el)` — the typing is silently dropped.
- **Do (capture):** in `onInput`, if the composed target or an ancestor has
  `isContentEditable`, coalesce on the *editable root* (`el.closest('[contenteditable]')`
  or walk to the highest contentEditable ancestor — editors nest). Record
  `action:"input"`, `mode:"contenteditable"`, `value: root.innerText` (innerText, not
  innerHTML — we replay semantics, not markup).
- **Do (replay):** `setNativeValue` can't drive these. Replay order of attempts:
  (1) focus the root, select-all via `document.execCommand("selectAll")` then
  `execCommand("insertText", false, value)` — deprecated but still the only synthetic
  path most editors accept; (2) fallback: dispatch `beforeinput` +
  `InputEvent("input", {inputType:"insertText", data:value})` on the root; (3) verify
  `root.innerText` contains the value, else fail the step with a clear report.
- **Known limit (state in code comment + README):** heavily custom editors (Google
  Docs is canvas anyway) may reject all synthetic paths — the honest failure is
  correct behavior.
- **Accept:** `test/fixture-editable.html` with (a) a bare `contenteditable` div,
  (b) a minimal ProseMirror-style trap: an editor that ignores direct DOM mutation and
  only updates on `beforeinput`. Record typing, replay on a reset page, assert text
  present. Live smoke (optional, follow-up): Substack compose via `test/live.mjs`.
- **Size:** M. The replay half is the risky part; timebox execCommand vs beforeinput
  exploration to the two fixtures.

### T3. Checkbox / radio: record state, replay as *set* not *toggle* — ✅ shipped
> `setChecked` action records the settled post-click state (read on the next task, so a
> preventDefault revert is reflected); replay drives to that state via `el.click()` with
> a `.checked` + `change` fallback, and a no-op when already correct. Label-wrapped
> inputs resolve through the browser's synthesized control click (no double-record).
> Regression: `test/check.mjs` (unchecked→flips, pre-checked→no-op, radio group).
- **Goal:** a recorded check ends in the recorded state regardless of the box's state
  at replay. Today they're generic clicks and `el.click()` toggles — if defaults
  changed, replay inverts the intent.
- **Do (capture):** in `onClick`, when the resolved leaf is `input[type=checkbox|radio]`
  (or a `<label>` for one — resolve through `label.control`), emit
  `action:"setChecked"`, `value: el.checked` (the post-click state — click listener in
  capture phase fires before default action, so read it on a microtask:
  `queueMicrotask` or `setTimeout 0`; verify in the fixture).
- **Do (replay):** if `el.checked !== step.value` → `el.click()` (real click keeps
  framework handlers happy); verify; if still wrong, set `.checked` + dispatch
  `change` as fallback. No-op (already correct) counts as success.
- **Accept:** extend `test/fixture.html` or new fixture: record checking a box; replay
  once against unchecked (flips) and once against pre-checked (no-op, still checked);
  radio group records the chosen option.
- **Size:** S.

### T4. Keyboard capture: Enter-submit, Escape, Tab-commit — ✅ shipped
> Capture-phase `keydown` whitelisted to `{Enter,Escape,Tab}` → `keypress` steps;
> capture-phase `submit` dedupes against a recent click/Enter cause (tags it
> `submits:true`, drops the bare `submit`; a JS-triggered submit with no cause records a
> bare `submit` on the form). Replay dispatches `keydown`+`keyup` and, for a
> `submits:true` step whose synthetic key didn't fire the submit, falls back to
> `form.requestSubmit()`. Regression: `test/keyboard.mjs` (no-button Enter-submit +
> Escape-dismiss). Known limit unchanged: synthetic keys are `isTrusted:false` — sites
> gating on that fail cleanly (Tier 4).
- **Goal:** the `keypress` action the IR already defines. Enter-submitted forms
  currently record the typing but not the submission — replay types and then nothing
  happens.
- **Do (capture):** capture-phase `keydown` listener, only for keys in
  `{Enter, Escape, Tab}` (whitelist — do NOT record general typing; `onInput` owns
  text). Emit `action:"keypress"`, `key`, target = active element via composedPath.
  Also listen to `submit` (capture phase) and emit `action:"submit"` on the form —
  covers both Enter and button-implicit submits; dedupe: a `submit` within ~200ms
  after a recorded click/Enter on the same form replaces the need for both (keep the
  click, tag it `submits:true`; keep bare `submit` only when nothing else caused it).
- **Do (replay):** `keypress` → dispatch `keydown`+`keyup` (`KeyboardEvent`, bubbles,
  correct `key`/`code`) on the resolved target; for a step tagged `submits:true` where
  the dispatch produced no effect, fallback `form.requestSubmit()`.
- **Known limit:** synthetic keys are `isTrusted:false`; sites gating on that fail
  cleanly (report). Don't chase it here — that's Tier 4.
- **Accept:** fixture with a form submitted via Enter (no button) whose submit handler
  mutates the DOM; record type+Enter, replay, assert the mutation. Escape closing a
  modal as second case.
- **Size:** S–M.

### T5. Capture-timing hardening: grab the target at `pointerdown` — ✅ shipped
> Capture-phase `pointerdown` records a pending `{leaf, target, ts}` (running
> `getTarget` while the node is alive); the step commits from `onClick` normally, or from
> `onPointerUp` when the captured node has disconnected — because Chromium dispatches
> **no** `click` at all when the mousedown target is removed (verified), so a click-only
> flush would silently drop it. A `flushed` guard prevents a double-emit. Regression:
> `test/pointerdown.mjs` (button `remove()`s itself on mousedown; a click step with the
> real selectors is still captured, not the `#host` retarget).
- **Goal:** don't lose clicks whose target is unmounted before `click` fires (menus
  that close on mousedown, rows that re-render). product-design-v1's capture table
  says `pointerdown` + `click`; only `click` is implemented.
- **Do:** capture-phase `pointerdown` records a *pending* `{leaf, target: getTarget(leaf), ts}`
  (running `getTarget` immediately, while the node is alive). The `click` handler uses
  the pending capture if its composed leaf matches or if the click target is
  disconnected (`!el.isConnected`); clear pending after 500ms. Emit nothing on
  pointerdown alone (drags, text selection).
- **Accept:** fixture with a button that `remove()`s itself in its own `mousedown`
  handler; record, assert a click step with usable selectors was still captured.
- **Size:** S.

## P1 — wedge unlocks

### T6. `assert` primitive + thin runner/reporter — ✅ shipped
> `assert` action with `{kind: textPresent|elementVisible|elementAbsent|urlMatches}`,
> evaluated at replay and **non-fatal** (a failed expectation is recorded and replay
> continues so the runner reports them all; the run's `ok` is false iff any assert
> failed). Capture UX: `Alt+Shift+A` arms assert-mode, the next click captures a
> `textPresent` of the element's text (swallowed — no navigation/submit) and shows as
> `Expect: …` in the popup. Runner: `test/run.mjs <steps.json> <url>` — headless, prints
> a per-step ✓/✗ table, exits 0/1. Regression: `test/assert.mjs` (record two asserts →
> in-page replay → the other three kinds hand-built → `run.mjs` subprocess exits 0 on
> the unchanged page, 1 when a `?title=` change fails one). The other three kinds have
> no capture UX yet (textPresent is the recorded default); they're replay/IR features.
- **Goal:** the QA wedge's missing primitive (use-cases doc §2B): expectations, not
  just actions.
- **Do (IR + replay):** new `action:"assert"` with
  `assert: {kind: "textPresent"|"elementVisible"|"elementAbsent"|"urlMatches", value}`.
  Replay resolves the target with the existing `waitForStep` (absent-kind inverts:
  poll until gone or timeout) and records pass/fail in `results[]` without acting.
- **Do (capture UX, minimal):** recording-mode keyboard chord (e.g. Alt+Shift+A) arms
  assert-mode; next click captures the element as an assertion target
  (`textPresent` of its trimmed text by default) instead of a click step. Popup shows
  it as "Expect: …". No panel UI yet.
- **Do (runner):** `test/run.mjs <steps.json> <url>` — headless, loads the extension,
  navigates, replays, prints a per-step ✓/✗ table, exit code 0/1. This is the seed of
  the CI story; keep it <100 lines by reusing the e2e harness helpers.
- **Accept:** fixture flow with two asserts (one passing, one that fails after a
  deliberate page change) → runner exit codes and report reflect both.
- **Size:** M.

### T7. SPA soft-navigation awareness (record + replay)
- **Goal:** rich SaaS apps (HubSpot, Linear, Notion, Jira) never do full document
  loads — routes change via `history.pushState`. The content script *survives* these,
  so recording already works across routes; what's missing is (a) marking the route
  change in the trace and (b) waiting for the route to render at replay before the
  next step (today only the generic 5s `waitForStep` retry absorbs it).
- **Do (capture):** the recorder snapshots `location.href` per step already
  (`frameInfo`). Add: on a URL change between steps (poll on step-emit, or listen to
  `popstate` + patch-free detection by comparing `frame.url` step-over-step at stop
  time in the SW), insert a synthetic `softNav` marker step
  `{action:"softNav", urlAfter}` — cheap, derivable, no MAIN-world patching.
- **Do (replay):** before resolving step N+1, if step N carried/preceded a `softNav`,
  wait until `location.href` matches `urlAfter` (pattern-match: treat numeric path
  segments/ids as wildcards — record-time id ≠ replay-time id for "create then open"
  flows; store `urlPattern` with digit-runs normalized) with the standard timeout,
  then proceed to element wait.
- **Accept:** fixture SPA (two "routes" swapped via `pushState` + view re-render on a
  client router stub): record click-through across routes + input on route 2; replay
  from route 1 cold; assert route-2 step waited and succeeded.
- **Size:** M. **This, not M1, is the gating item for the rich-SaaS category** —
  see Part 2.

### T8. M1 cross-navigation (full-document): storage-backed state machine
- **Goal:** the multi-page gov-form wedge. Full spec exists — [[m1-design]] is the
  source of truth; this entry just scopes the agent-sized phases.
- **Phases (each independently landable):**
  1. **Record across navs:** recorder streams each step to the SW as it happens
     (`bao-frame-steps` per-step instead of batch-at-stop — the buffer moves from page
     memory to `chrome.storage.session`); recording state itself lives in storage so
     the freshly injected content script on the new document re-arms
     (`status`→resume). SW writes a `navigate` step + `wait:{type:"navigation"}` on
     `webNavigation.onCommitted` during recording. *Accept:* record type→click→(nav)→
     click on a two-document fixture pair; the merged trace has all steps + the nav
     marker.
  2. **Replay across navs:** the RunState machine from m1-design §1–2 (phases,
     re-inject on `onCommitted`, act on `readyState complete`, `chrome.alarms`
     timeouts, `dispatched` idempotency marker). *Accept:* the m1-design acceptance
     flow incl. forced SW kill mid-run.
  3. **`waitForUser`:** pause phase + popup Continue button (side panel later).
     *Accept:* pause survives a 60s wait + SW kill.
- **Size:** L (the big rock). Do not start before T1–T5 land — they all touch the
  recorder's event handlers and would conflict.

### T9. Wait over-capture (click→nav tagging)
- **Goal:** replay must not guess whether a click navigates ([[m1-design]] §5.1).
- **Do:** during recording the SW correlates `webNavigation.onCommitted`
  (frameId 0, the recorded tab) within ~2s of the last recorded click and tags that
  step `wait:{type:"navigation"}`. Same mechanism tags `producesDownload` later (T10).
  Ship inside T8 phase 1 or immediately after; separate task so it isn't dropped.
- **Accept:** two-document fixture: the recorded link-click step carries the nav
  wait; a non-navigating click doesn't.
- **Size:** S (on top of T8 phase 1).

### T10. Download capture + replay wait
- **Goal:** the "morning report → Download CSV" ending. Spec: [[m1-design]] §4
  verbatim (`chrome.downloads.onCreated` correlation at record; wait on
  `onChanged state:complete` at replay; alarm timeout).
- **Note:** needs `"downloads"` added to manifest permissions.
- **Accept:** fixture serving a `Content-Disposition: attachment` link; record click,
  replay asserts a completed download with the expected filename in run history.
- **Size:** M. Depends on T8 phases 1–2.

## P2 — over-capture & IR (the self-healing fuel; every recording made before this lands is un-healable later)

### T11. Per-target grounding: bbox + text + role + viewport on every step
- **Goal:** product-design-v1 "non-negotiable #1". Today bbox is captured only on
  degraded targets.
- **Do:** in `getTarget`, always include
  `bbox: {x,y,w,h, vw, vh}` (viewport-relative %, per the design), `textContent`
  (trimmed, ≤120 chars), `role` (from `implicitRole`), and on the step `meta:
  {viewport:{w,h}, recordedAt}`. Respect T1: for sensitive steps omit textContent.
- **Accept:** e2e asserts every recorded step in `out/recorded-steps.json` carries
  bbox/text/role/meta.
- **Size:** S.

### T12. Golden screenshots (SW `captureVisibleTab` per step)
- **Goal:** the audit filmstrip's record-time half + the VLM-heal crop source
  (derived `fullFrame ✂ bbox`, never stored separately).
- **Do:** recorder pings the SW per captured step; SW `captureVisibleTab` (JPEG ~q75,
  downscale to ~1000px wide via `OffscreenCanvas`), stores blob in IndexedDB keyed
  `runId/stepIndex`, writes `goldenScreenshotRef` onto the step. Rate-limit: coalesce
  to ≤2/s (`captureVisibleTab` throttles); on a burst of steps keep the latest.
  **Local-only** per the privacy stance; sensitive steps (T1) skip capture entirely.
- **Accept:** e2e records a 3-step flow → 3 refs resolve to decodable images of
  plausible dimensions.
- **Size:** M.

### T13. Tier-2 capture-only DOM subtree snapshot
- **Goal:** offline anchor re-derivation fuel ([[use-cases-and-snapshot-fallback]]
  §5a). Capture the *anchor subtree*, not the whole document (privacy).
- **Do:** on each step, serialize `outerHTML` of the anchor node (or the leaf's
  nearest ~3-hop ancestor when unanchored), input values masked (all `value`
  attributes stripped; T1 rules for text). Cap at 64KB/step. Store beside the step.
- **Accept:** list-fixture recording carries subtree snapshots; a masked password
  never appears; oversized subtree is truncated with a marker.
- **Size:** S.

### T14. IR alignment + named workflows
- **Goal:** steps become the durable Workflow IR of product-design-v1, not an
  anonymous array under one storage key.
- **Do:** wrap recordings as `Workflow {id, name, version, startUrl, variables:[],
  steps}`; steps gain `id, index`; popup gets save-with-name, list, pick-to-replay,
  delete (still popup, not side panel). Replay navigates to `startUrl` first if the
  current tab doesn't match. Migration: legacy `steps` key read once as
  "Untitled workflow".
- **Accept:** e2e saves two named workflows, replays the second by id.
- **Size:** M.

## Backlog (specced when a wedge demands them)
- **Hover capture** — record `pointerover` that precedes a click on a
  newly-appeared target; replay dispatches `pointerover/mouseover` on the hover
  source before resolving the click. Needed for hover-menus (some HubSpot/Jira nav).
- **Drag-and-drop** — synthetic `DataTransfer` is unreliable (design §"Cannot" 6);
  approach when needed: dispatch the full `dragstart→dragover→drop` sequence for
  HTML5-dnd apps, `pointerdown→pointermove→pointerup` for pointer-based libs
  (dnd-kit et al.); accept per-library flakiness, degrade honestly. Unlocks
  kanban/pipeline boards (Trello, Jira, HubSpot deals).
- **Clipboard/paste** — record `paste` (capture-phase, read `clipboardData` as the
  input value — it's just text input by another route); replay via T2's insertText
  path. Clipboard *write* buttons stay Tier-4 (needs trusted activation).
- **dblclick / contextmenu** — trivial capture-side additions when a use case needs
  them (grid cell edit is often dblclick).
- **Odd input types** — `type=range` is excluded from `isTextField` so slider moves
  record nothing; `<select multiple>` replays only one value (`el.value`); confirm
  date/color pickers round-trip (they pass `isTextField` today, unverified). One
  small task: record `range` via `change`, record `selectedOptions` for multi-selects.
- **Input coalescing hardening** — coalescing keys on the live element reference
  (`lastInputEl`), so a React remount mid-typing splits one intent into two steps;
  key on the resolved target instead when it bites.
- **Multi-tab / window.open** — explicitly out until a wedge demands it (v1 lock).

---

# Part 2 — The universe of browser apps, and what this approach covers

## The axes that decide automatability

Every browser app is some combination of six independent properties; each maps to a
specific Bao capability or blind spot:

| Axis | Easy end | Hard end | Bao answer |
|---|---|---|---|
| **Rendering** | HTML DOM | `<canvas>`/WebGL pixels | DOM: Tiers 0–1. Canvas: degrade → Tier 3/4 only |
| **Navigation** | full-page loads (MPA) | SPA soft routes | MPA: T8. SPA: T7 (recorder already survives — no teardown) |
| **List rendering** | static | virtualized/recycled | **solved** (anchor + scroll-find, Tier B) |
| **Component encapsulation** | plain DOM | open/closed shadow | open: **solved**. closed: opt-in force-open |
| **Origin topology** | one origin | cross-origin frames | **solved for capture/routing** (Tier B); trusted-input limits remain inside |
| **Input trust** | plain handlers | isTrusted / anti-bot / native UI | the hard wall — Tier 4 (CDP) or `waitForUser`, by design |

Selector churn (auto-generated ids, CSS-modules classes, obfuscated markup à la
Gmail) is a seventh, softer axis: it degrades Tier 0 but the anchor/text/aria layer
(Tier 1) exists precisely for it.

## The taxonomy

### 1. Form-and-record apps — *the home turf*
Gov portals, insurance/benefits, banking back-office, admin panels, internal CRUD
tools, university/HR systems, e-commerce sellers' consoles, legacy ERPs rendered as
server HTML.
**Traits:** DOM-native, MPA or light SPA, little virtualization, no canvas.
**Blockers today:** cross-nav (T8), waits (T9), file upload (`waitForUser`), the odd
anti-bot login.
**Verdict:** the wedge. T1–T5 + T8/T9 ≈ done.

### 2. Rich SaaS suites (CRM/support/PM) — *the expansion market; see HubSpot below*
HubSpot, Zendesk, Intercom, Jira/Linear/Asana/Monday, Airtable (grid views),
Salesforce *Lightning*, NetSuite, Workday.
**Traits:** React/SPA soft navs, virtualized tables, modals/drawers/portals,
contenteditable composers, some drag-drop, occasional open shadow (LWC), auto-generated
ids everywhere (anchor layer earns its keep).
**Blockers:** T7 (soft-nav) is the gate; then T2 (composers), checkbox semantics (T3),
Enter-commit (T4); drag-drop for board views (backlog); Workday-class apps add heavy
dynamic ids where Tier-1 anchoring gets stressed.
**Verdict:** record-side largely works *today* (SPA = no teardown!); replay needs T7.
Object-CRUD flows (create contact, update field, change stage via dropdown, log a
note) → automatable at Tier 0–1. Builder surfaces inside them (email/page editors) →
category 5. Board drag → backlog task. Realistic coverage after T2/T3/T4/T7:
**~70–80% of the repetitive flows** users actually do in these apps.

### 3. Email & productivity shells
Gmail, Outlook Web, Google Calendar, Proton.
**Traits:** aggressive virtualization (solved), obfuscated selectors (anchor layer),
contenteditable compose (T2), keyboard-shortcut-driven power flows (T4 covers only
Enter/Esc/Tab — full shortcut capture is backlog), Calendar's grid is DOM (fine) but
drag-to-create is drag-drop.
**Verdict:** read/triage/label/reply flows: automatable post-T2/T4. Gmail's markup
churn makes this the best stress test of anchoring outside the fixtures.

### 4. Feeds & chat
Slack, Discord, X, LinkedIn, Reddit, Substack Notes (already the live smoke target).
**Traits:** virtualized infinite feeds (solved), contenteditable composers (T2),
ephemeral content.
**The distinct limit is semantic, not technical:** "act on *the same* card" is solved
by anchors, but "act on the *newest* item matching X" is a *parameterized/conditional*
workflow — an IR feature (M4 territory: variables, `forEach`, conditions), not a
capture gap. Deterministic replay re-finds the *recorded* target; it does not select
*new* targets. Worth stating plainly in any QA/marketing use of this category.

### 5. Canvas-rendered workspaces — *outside the deterministic frontier*
Figma, Miro, Excalidraw, tldraw, Google Docs (body) & Sheets (cells), Google Maps,
Flutter Web, TradingView, many dashboards' chart internals.
**Traits:** no DOM for the content surface. The chrome *around* the canvas (toolbars,
dialogs, share buttons) is DOM and automatable; the canvas interior records as
`reach=canvas` + bbox and degrades honestly (already shipped).
**Verdict:** deterministic tiers will never drive the canvas interior — this is
Tier-3 (VLM locate + coordinate click) / Tier-4 land, per the wager. Don't sell into
it; do keep the bbox+crop fuel capture (T11/T12) so Tier 3 has something to eat.

### 6. Spreadsheet/grid-heavy data apps
Airtable, ag-Grid/Glide/Retool apps, Smartsheet; (Google Sheets → category 5).
**Traits:** virtualization (solved) + cell-editing idioms: dblclick-to-edit
(backlog: trivial), Enter/Tab-commit (T4), sometimes a single roving contenteditable
cell editor (T2), keyboard navigation between cells (backlog).
**Verdict:** near-automatable after T2/T4 + dblclick; a good second QA-wedge fixture
family.

### 7. Checkout / identity / payment rails
Stripe/Adyen/Braintree fields, Plaid, SSO popups, reCAPTCHA/hCaptcha, 3-D Secure.
**Traits:** cross-origin frames (capture/routing solved — the live smoke already
answers inside Stripe's frame) but these frames exist *specifically to resist
automation*; CAPTCHAs are anti-automation by definition; SSO uses popups
(multi-window, backlog) with anti-bot.
**Verdict:** by-design `waitForUser` territory. Correct product behavior is a clean
pause ("complete payment, then Continue"), never automation. T8's waitForUser is the
whole answer.

### 8. Anti-bot-hardened consumer sites
Banks, airlines, Ticketmaster-class ticketing, sneaker/retail drops, government
*login* front doors (as opposed to their form innards).
**Traits:** DataDome/Kasada/Akamai/PerimeterX gate on `isTrusted`, behavioral
signals, automation fingerprints. The live-smoke suite already hit this wall
(ag-grid/salesforce UA-blocking headless).
**Verdict:** login → `waitForUser`; post-login flows often work (the session is real —
that's the extension wedge); sites that gate *every* click on trust signals are
Tier-4-or-nothing, and Tier 4 (CDP) is itself detectable. Some of this universe is
deliberately unautomatable; say so honestly.

### 9. Restricted surfaces
`chrome://` pages, Chrome Web Store, other extensions' pages, the built-in PDF
viewer, DevTools.
**Verdict:** content scripts cannot run there — a hard platform boundary, no tier
crosses it (even CDP can't touch chrome:// meaningfully). A gov flow that *ends* in
the PDF viewer stops at "downloaded" (T10) — which is the right product boundary
anyway.

### 10. Real-time / media
Video calls (Meet/Zoom web), streaming consoles, WebRTC dashboards, games.
**Verdict:** controls are DOM (clickable); the media surface is not meaningful to
record/replay. Also time-coupled — replay determinism doesn't extend to "the meeting
is happening now". Out of scope, not a gap.

## Worked example — HubSpot, step by step

Flow: *"open Contacts → create contact (name, email) → open the new contact → change
Lifecycle stage → log a note → move its deal one pipeline stage"*.

| Step | Mechanism today | Status |
|---|---|---|
| Navigate Contacts (left-nav click, SPA route) | click records fine; content script survives the soft nav | ✅ record / ⚠️ replay waits on **T7** |
| "Create contact" button (portal-rendered drawer) | portals are still light DOM; click + anchor | ✅ |
| Name/email inputs (React-controlled) | `setNativeValue` exists for exactly this | ✅ |
| Save → row appears in a **virtualized** table | scroll-find + anchor (Tier B) | ✅ shipped |
| Open the new contact | **record/replay identity problem:** the contact didn't exist at record time; its URL/id differ every run | ❌ needs variables/parameterization (M4), *not* a capture fix — flag at compile time |
| Lifecycle-stage dropdown (custom listbox, not `<select>`) | two recorded clicks (open, pick option) — plain DOM | ✅ (anchor disambiguates the option) |
| Log a note (ProseMirror-style composer) | contenteditable | ❌ **T2** |
| Note "Save" | click | ✅ |
| Drag deal card across pipeline columns | drag-and-drop | ❌ backlog dnd task (dnd-kit-style pointer sequence) — or record the click-menu alternative HubSpot offers ("Edit → stage"), which works today |
| Auto-generated ids/classes throughout | Tier-0 selectors mostly useless → Tier-1 anchors carry the load | ✅ by design |

**HubSpot verdict:** after **T7 + T2** (+ T3/T4 for form semantics), the
click/type/select CRUD core — most of what a rev-ops person repeats daily — replays
deterministically. The two structural leftovers are shared across all of category 2:
**(a) drag-board moves** (backlog dnd; often a click-path workaround exists) and
**(b) cross-run entity identity** ("the record I just created") — which is an IR/
compile-time feature (variables + urlPattern wildcards, T7 starts this), and the most
important *new* insight this exercise surfaces: **the next frontier gap isn't an
event type, it's parameterization.**

## Coverage ladder (which work unlocks which universe)

```
today (M0 + Tiers A/B)        → cat 1 single-page; record-side of cat 2/3/4
+ T1–T5 (P0)                  → correctness floor everywhere; composers unlock 2/3/4/6
+ T7 (SPA waits)              → cat 2 replay (rich SaaS) — biggest coverage jump per LOC
+ T8–T10 (M1)                 → cat 1 multi-page (the gov wedge, end-to-end), downloads
+ T6 (assert+runner)          → cat 1/2/6 as a QA product
+ T11–T14 (fuel + IR)         → audit trail; makes Tier 3 possible later
+ backlog dnd/hover/shortcuts → boards (2), calendars (3), grids (6) edge idioms
+ M4 variables/conditions     → cat 4 semantics, cat 2 entity identity
never (by design)             → canvas interiors (5), CAPTCHAs/anti-bot walls (7/8),
                                restricted pages (9) — Tier 3/4 escalation or waitForUser
```

---

# Part 3 — Live, no-login test targets per category (verified 2026-07-03)

Every target below was probed headless with a realistic UA via **`npm run probe`**
(`test/probe-sites.mjs`, the registry lives in the script — keep the two in sync):
loaded with no login and no bot challenge unless noted, and exhibits the structural
signal its test case needs. Live sites rot; re-run the probe before trusting this
table if it's more than a month old. Same discipline as the live smoke suite: a
load failure or fresh bot-block is a **SKIP**, not a FAIL; a FAIL means the site
loaded but the capability regressed.

Probe casualties worth recording: the RealWorld/Conduit demos are **dead** (404/DNS),
the Flutter samples URL 404s (→ wonderous.app), and — a live gift for category 8 —
**w3.org now Cloudflare-challenges headless Chromium** ("Just a moment…", 403), so
the W3C ARIA APG examples moved from the widgets list to the anti-bot list.

| Cat | Target | Verified signal (2026-07-03) |
|---|---|---|
| 1 forms | `selenium.dev/selenium/web/web-form.html` | 15 inputs + 1 native select, every input type on one page |
| 1 forms | `the-internet.herokuapp.com` | stable automation playground; per-widget subpages, real full-page navs |
| 1 forms | `httpbin.org/forms/post` | 12 inputs, form does a **full-document POST nav** |
| 1 forms | `demoqa.com/automation-practice-form` | 16 inputs; 6 cross-origin (ad) iframes as realistic noise |
| 2 SPA | `bsky.app` (logged-out Discover) | rich React SPA, soft-nav routes, virtualized feed, 350+ buttons |
| 2 SPA | `todomvc.com/examples/react/dist/` | canonical React-controlled inputs + hash routing |
| 2 SPA | `saucedemo.com` | SPA store; login wall **by design** with published creds (`standard_user`) |
| 2 widgets | `mui.com/material-ui/react-select/` | 19 live listbox/combobox demos (custom, non-`<select>` dropdowns) |
| 2 widgets | `radix-ui.com/primitives/docs/components/select` | portal-rendered select primitives |
| 2 dnd | `react-dnd.github.io/react-dnd/examples` | HTML5-dnd example set |
| 2 dnd | `atlassian.design/components/pragmatic-drag-and-drop/examples` | pointer-based (non-HTML5) dnd — the other library family |
| 3 editor | `playground.lexical.dev` | 1 contenteditable root, `beforeinput`-driven (the strict editor case) |
| 3 editor | `prosemirror.net/examples/basic/` | contenteditable, transaction-based (rejects naive DOM mutation) |
| 3 editor | `quilljs.com/playground/snow` | contenteditable, Delta-model editor |
| 3 calendar | `fullcalendar.io/demos` | DOM-rendered calendar grid + native selects |
| 4 feed | `news.ycombinator.com` | 30 identical rows w/ stable `item?id=` hrefs — the anchor case, server-rendered |
| 4 feed | `bsky.app/profile/bsky.app` | virtualized feed of similar cards, no login |
| 4 feed | `mastodon.social/explore` | public timeline, SPA feed |
| 5 canvas | `excalidraw.com` / `tldraw.com` | canvas UI (already in live suite / 1 `<canvas>`) |
| 5 canvas | `wonderous.app/web/` | Flutter web: **47 DOM nodes total** — the "nothing to select" tell |
| 6 grid | `ag-grid.com/example/` | windowed slice (~20 rows) over thousands (already in live suite) |
| 6 grid | `handsontable.com/demo` | 38 `role=row` window; dblclick-edit + Enter-commit idioms |
| 7 checkout | `checkout.stripe.dev` + `stripe.dev/elements-examples/` | Stripe playground; true cross-origin field iframes |
| 7 identity | `accounts.hcaptcha.com/demo` | 2 cross-origin captcha iframes (reCAPTCHA demo is same-origin — weaker) |
| 8 anti-bot | `w3.org/WAI/ARIA/apg/...` | served Cloudflare "Just a moment…" 403 to headless — a live challenge page |
| 8 anti-bot | `nowsecure.nl` | Cloudflare demo page; **did not challenge this run** — flaky by nature, SKIP-friendly |
| 9 restricted | `chrome://version`, any `.pdf` URL | no live target needed — platform walls, tested locally |
| 10 media | local fixture `<video controls>` | closed-shadow controls; MDN's live example sits in a cross-origin iframe (worse than a fixture) |

## What each category's test case must cover

Definition of done stays the repo standard: `record → replay → assert correct
effect`, driven through the real `content.js` via the live harness
(`test/live.mjs` / `live-blindspots.mjs` patterns), SKIP on load failure.

1. **Forms (selenium web-form + httpbin).** Record: fill text/textarea, pick a
   native `<select>`, check a checkbox, choose a radio, Enter-submit. Replay on a
   reset page asserts: values present via native-setter path, checkbox ends
   **checked regardless of prior state** (T3's set-vs-toggle), the submit actually
   fired (httpbin's POST result page → also exercises T9's click→nav tagging), and
   no password/SSN-shaped value appears in the serialized steps (T1). the-internet's
   subpages add the per-widget regressions: `dynamic_loading` (waits),
   `upload` (expect **degrade→waitForUser**, not silence), `javascript_alerts`
   (expect clean failure — native dialogs are the known wall).
2. **Rich SPA (bsky.app + TodoMVC).** Record: click through two soft-nav routes,
   type into a controlled input, act on one card among many. Replay from the start
   route asserts: recorder survived the route changes (steps from both routes in one
   trace — works today), replay waited for the route to settle before resolving
   (T7), the anchored card action hit the *same* card. TodoMVC adds the
   controlled-input + hash-route minimal case. mui/radix add: custom listbox =
   two clicks (open, pick option) where the option renders in a **portal** —
   assert the anchor disambiguates the option and replay reselects it.
   saucedemo (published creds) is the multi-step SPA checkout wizard once T7 lands.
3. **Editors (lexical, prosemirror, quill).** Record typing a sentence (T2).
   Replay on a fresh editor asserts the text is present via `innerText` — three
   editors because they accept different synthetic paths (`execCommand` vs
   `beforeinput` vs Delta); the test's job is to pin which path each accepts and
   fail honestly where none does. FullCalendar: click-to-create where offered
   (dialog flow = DOM), and expect **degrade** on drag-to-create until backlog dnd.
4. **Feeds (HN + bsky profile).** HN: record a click on the comments link of row N
   (30 identical rows, stable `item?id=` hrefs) → replay after the front page
   reorders naturally and assert the *same story* opened (href id match) — the
   real-world anchor regression, server-rendered so it isolates anchoring from SPA
   noise. bsky: same assertion on a virtualized feed (anchor + scroll-find under
   recycling). Explicitly out of scope here: "newest item matching X" —
   parameterization (M4), not capture.
5. **Canvas (excalidraw/tldraw/wonderous).** Already half-covered by the live
   suite: assert `reach=canvas` (or wonderous's near-empty DOM → `opaque-custom`)
   + `degraded:true` + bbox captured (T11 fuel), and that replay **refuses** with
   the escalation message rather than clicking coordinates. The wonderous case
   pins the classifier on a Flutter app, not just `<canvas>` tags.
6. **Grids (ag-grid + handsontable).** ag-grid: record a click on a row far below
   the fold → replay scroll-finds it and asserts the row's *data* (not position)
   matches — the recycled-node lie, live. Handsontable: dblclick a cell, type,
   Enter → asserts the committed cell value (regresses backlog-dblclick + T4
   Enter-commit together).
7. **Checkout/identity (stripe + hcaptcha).** Stripe: assert the all_frames script
   answers inside the cross-origin field iframe (shipped) and that recording a
   card-field interaction tags the step with the child `FrameRef`; replay routes it
   to the right frame. hcaptcha: assert capture classifies the widget's
   cross-origin frame and the flow **degrades to waitForUser** at the challenge —
   the correct product behavior is the pause, never solving it.
8. **Anti-bot (w3.org APG / nowsecure).** Inverted expectations: the harness
   asserts its *own* detection — challenge page recognized (title/interstitial),
   run marked SKIP/`waitForUser`-degrade, no retry storm. Flaky by nature (nowsecure
   didn't challenge today's run); that flakiness is the point being tested.
9. **Restricted (chrome:// + PDF).** Popup shows the graceful "no content script on
   this page" message (popup.js already does — pin it with a test); a flow ending in
   a PDF download asserts T10's "downloaded = done" boundary rather than trying to
   drive the viewer.
10. **Media (local `<video controls>` fixture).** Click play via the visible
    controls: asserts the closed-shadow internals classify as degrade while a click
    on the `<video>` element itself still records (bbox fuel), and — with opt-in
    force-open — the control becomes deterministically reachable
    (`test/forceopen.mjs` pattern).

## The honest boundary, restated

Three gaps are *not* on any task list because they are the price of the bet
([[use-cases-and-snapshot-fallback]] §6): pixels (canvas), trust (isTrusted/anti-bot/
native UI), and platform walls (chrome://, OS dialogs). The deterministic engine's
job is to cover categories 1–4 and 6 nearly completely, *classify* the rest at
capture time (already shipped as `reach`/degrade), and hand them to `waitForUser` now
and Tier 3/4 later. The new finding from the HubSpot walkthrough: once T2/T7 land,
the binding constraint on rich SaaS stops being *capture fidelity* and becomes
*parameterization* — worth pulling variables/`urlPattern` forward from M4 into the
IR design conversation earlier than planned.
