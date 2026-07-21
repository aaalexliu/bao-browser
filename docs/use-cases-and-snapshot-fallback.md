# Bao — Wedge Use Cases, Necessary Functionality, and the Snapshot-Fallback Question

> Siblings: [[product-design-v1]] (architecture, IR, executor seam), [[m1-design]]
> (cross-nav state machine, waitForUser, downloads).
> This doc: which use cases to aim at, what each needs, the simplicity↔coverage
> tradeoff, and a rigorous answer to "can we just snapshot the whole DOM / the screen?"

## 1. The two sharpest wedges

Bao wins where there is **no API, auth lives in the browser, and the task is
repetitive multi-step UI** — and where the page churns between runs (the case the
anchor work in `content.js` exists for). Two beachheads stand out: one prosumer, one
IT. They share a property — they lean *least* on the unsolved structural problems
(shadow DOM, virtualization, cross-origin frames).

### A. Government / bureaucratic forms (prosumer)
Visceral pain, no API, "I did this last year and forgot how" → replay is magic.
Tax/benefits/DMV/immigration/permits/court e-filing.

### B. Record-to-test for QA & synthetic monitoring (IT)
Our fixtures already demonstrate it (`test/list.mjs`, `test/e2e.mjs`). Technical
buyer, easy to validate, the engine is the product.

## 2. Pressure-test against the current engine

### A. Gov forms — *close, with named gaps*
**Works today:** `setNativeValue` (native setter + real `InputEvent`) drives
React/Vue-controlled inputs; `getSelectors` resolves form fields by `name`/`id`/aria;
clicks on buttons/links/labels; single-page forms replay deterministically.

**Gaps (all already on the roadmap):**
- **Native `<select>` not captured.** `onInput` only fires for `isTextField`; there is
  no `change` listener for `<select>`. The IR lists a `select` action but the recorder
  doesn't emit one yet. *First, cheap fix.*
- **Multi-page wizards = cross-navigation.** The #1 blocker. Owned by [[m1-design]]
  (storage-backed SW state machine, re-inject + resume).
- **Login / 2FA / CAPTCHA / file upload.** `waitForUser` pause (designed in
  [[m1-design]] §3) for the first three; file `<input>` is a hard content-script limit
  → `waitForUser`-degrade (per the Executor seam in [[product-design-v1]]).
- **Conditional fields** that appear after an input → needs `waitFor: elementVisible`.

**Verdict:** single-page forms are basically there; the wedge is gated on
select-capture + M1 cross-nav + waitForUser. No new *resolution* tech required.

### B. Record-to-test — *closest to working; missing one primitive*
**Works today:** this is the demo. `replay()` already returns a structured report
(`{ ok, failedAt, results:[{ via, ok }] }`) — the seed of a test reporter. `live.mjs`
drives a real headed profile via Playwright — the seed of a runner.

**Gaps:**
- ~~**Assertions.**~~ **shipped (T6):** `assert` action with
  `textPresent | elementVisible | elementAbsent | urlMatches`, checked at replay and
  non-fatal (all expectations reported, run fails iff any assert fails). Captured at
  record time via the `Alt+Shift+A` chord (click an element → `textPresent`); the other
  kinds are replay/IR features without capture UX yet.
- **Flake control & CI:** element waits (planned) + ~~a headless runner~~ **shipped
  (T6):** `test/run.mjs <steps.json> <url>` prints a per-step ✓/✗ table and exits 0/1
  — the seed of the CI story; + golden/actual screenshot diffing (designed in
  [[product-design-v1]] "auditable replay").

**Verdict:** engine proven; `assert` + the runner/reporter shipped — this is a product.

## 3. Necessary functionality, layered as a resolution ladder

Resolution should walk the **cheapest deterministic tier that works** and escalate
per-step only on miss. The tiers, in order:

| Tier | Mechanism | Determinism | Cost | Buys you |
|---|---|---|---|---|
| 0 | Unique robust selector (testid/id/aria) — `getSelectors` | full | ~0 | static, light-DOM, single-page |
| 1 | **Content anchor + within-descriptor** (this branch) + M1 cross-nav | full | low | repeated lists/feeds; multi-page |
| 2 | **Capture-only** whole-DOM + screenshot snapshots (fuel/audit, *not* a resolver) | n/a | storage + privacy | offline re-derivation, audit trail, healing fuel |
| 3 | **VLM self-heal on miss** (locate by description), write the fix back to the IR | probabilistic → re-cached as deterministic | latency + $ | the hard apps (shadow/iframe/canvas) when DOM matching fails |
| 4 | **Debugger/CDP executor** | full | trust banner | trusted input, file upload, closed shadow, cross-origin |

The discipline: **escalate per-step, never globally; and cache an escalation's result
back down to a deterministic artifact** so the *next* run is Tier 0–1 again.

## 4. Simplicity vs. comprehensiveness — the real tradeoff

Each tier up **buys app coverage and resilience** and **costs** determinism,
debuggability, privacy surface, latency, and money.

- **Stay simple (Tier 0–1).** Small, deterministic, debuggable ("why did it click
  there" has an answer), free, offline, no model dependency. This is the whole product
  thesis in [[product-design-v1]]: *the LLM is a compiler at authoring time, not the
  runtime.* It fails *cleanly* (graceful report) on the blind spots rather than
  guessing.
- **Go comprehensive (Tier 3–4).** Covers Salesforce-class apps, but every added tier
  introduces a new failure mode and erodes the "deterministic, free, instant" promise.
  A VLM resolver that's right 95% of the time is *worse* than a clean failure for a
  non-technical user who can't tell the 5% from the 95%.

**Recommendation:** build Tiers 0–1 to production (the two wedges need nothing more),
keep Tier 2 as cheap *capture-only* insurance, and put Tiers 3–4 **behind the seams
that already exist** (the Executor interface and the self-healing IR fields) so they
drop in per-step without re-architecting. Resist making any probabilistic tier the
baseline.

## 5. The snapshot question, answered precisely

People conflate three different ideas under "just snapshot it." They have very
different value because of one fact:

> **A snapshot is a *record-time* artifact. Replay acts on a *live, different* DOM. A
> snapshot never tells you how to act *now* — you still need a function that maps the
> recorded target onto a live element.** So no snapshot is, by itself, a fallback
> *resolver*. The question is only whether it's good *fuel* for one.

### (a) Whole-DOM snapshot (outerHTML / rrweb-style serialization)
- **As a replay resolver (diff record-DOM → live-DOM, find the matching node): weak.**
  This is the structural-fingerprint trap from the engine review — re-renders,
  virtualization, and shadow boundaries all break tree alignment, the match is fuzzy
  (needs a tree-diff scorer that's hard to tune and gives false confidence), and it
  *still* doesn't pierce the blind spots. Don't make DOM-diff the resolver.
- **As captured fuel: strong, cheap insurance.** It lets us (1) **re-derive better
  anchors offline** without re-recording — directly serving the "over-capture" rule in
  [[product-design-v1]]; (2) mine the *whole* subtree for ids/attrs our record-time
  heuristic missed; (3) debug capture decisions. Keep it — as Tier 2, not as a resolver.
- **Privacy caveat (sharper than for screenshots).** For the gov/finance/health wedges
  the DOM contains *raw* values (SSNs, balances, full form state), not just rendered
  pixels. Whole-DOM capture must be **local-only + input-masked**, stricter than the
  screenshot stance in [[product-design-v1]]. This is a real liability; prefer
  capturing the **target's subtree** over the whole document.

### (b) Visual snapshot (screenshot) + pixel/template/OCR matching
- **Universal reach** — everything renders to pixels, so it crosses shadow DOM,
  iframes, `<canvas>` grids (Salesforce), even PDFs.
- **But brittle as a resolver:** sensitive to zoom/resolution/theme/responsive
  layout/scroll; coordinate clicks hit the wrong thing after a layout shift;
  virtualized off-screen content still isn't in the frame; template/OCR is finicky.
- **Best role:** the audit filmstrip it already plays in [[product-design-v1]], **plus**
  grounding input to a vision model — not a standalone deterministic resolver.

### (c) Visual + vision model (VLM) self-heal — the actual fallback
- This is the robust way to *locate semantically* across the blind spots ("find the
  Download button"), Midscene/computer-use style. It's the real answer for the hard
  apps — and it's already anticipated as M4 self-healing.
- **Costs cut against the thesis:** nondeterministic, slow, $ per step, latency. So it
  must be a **last-resort heal that runs only on a Tier 0–1 miss**, proposes a
  candidate the **user confirms**, and — the key move — **writes a fresh
  anchor/selector back into the IR** so every subsequent run is deterministic again.
  *Heal once probabilistically; cache the fix as a deterministic selector.* That
  converts a recurring cost into a one-time repair and keeps replay free/instant.

### Bottom line
- **No** to whole-DOM or screenshot snapshots as the *replay-resolution* fallback —
  they're record-time artifacts and the structural/pixel match is brittle.
- **Yes** to capturing both as **Tier-2 fuel and audit** (cheap, but local-only +
  masked for our wedges).
- The true fallback is a **per-step VLM self-heal that writes a deterministic selector
  back to the IR** — escalation, not baseline.

## 6. Blind spots vs. the landscape

Every blind spot below is one place where the v1 bet —
*find a live element by selector, from a same-origin content script, using untrusted
events* — breaks down. They aren't bugs to patch; they're the **price of the
no-banner, deterministic, LLM-as-compiler design**. See [[browser-use-vs-skyvern]] for
the two tools we contrast against, and [[product-design-v1]] §"Cannot" for the raw list.

### Why each is hard for the v1 engine

A useful framing: **§"can't *see* the element"** (shadow / virtualization / cross-origin
/ canvas), **§"can't *act* trustingly on it"** (trusted events / file upload / native UI
/ drag-drop), **§"can't *run* there or *persist* across it"** (restricted pages /
cross-nav).

- **Shadow DOM.** Components render internals inside a shadow root that
  `querySelector` doesn't cross. *Open* roots are reachable only if the selector engine
  recurses `element.shadowRoot` per boundary (fragile, path-dependent). *Closed* roots
  return `null` — **structurally inaccessible** from a content script.
  *Examples:* open — **YouTube** (Polymer), **Salesforce Lightning** (LWC), SAP/Ionic
  design systems. Closed — Chrome's own `<video>`/`<input type=date>` internals, the PDF
  viewer, some bank anti-fraud widgets.
- **Virtualization (windowed lists).** Big lists/grids/feeds (React-Window, ag-Grid,
  Salesforce, Gmail) render only the ~20 on-screen rows; the rest **aren't in the DOM**.
  A recorded click on row 4,000 has no live node until scrolled in, and wrapper nodes
  get *recycled* (the element for "row 12" is reused for "row 4,000") — so structural
  selectors point at the wrong data. This is why whole-DOM diffing fails as a resolver
  (§5a): off-screen content "still isn't in the frame."
  *Examples:* **Gmail/Outlook** inboxes, **Google Sheets / Airtable / ag-Grid** tables,
  **Slack/Discord/X** feeds. QA sting: "click the 500th order" replays against a recycled
  node showing different data.
- **Cross-origin iframes.** Same-origin policy blocks a parent content script from
  reading into a different-origin frame. Same-origin frames are fine (store the frame
  path); cross-origin is a hard wall.
  *Examples:* **Stripe/Braintree** card fields, **Plaid** bank-link, **reCAPTCHA/
  hCaptcha**, "Sign in with Google/Apple" SSO popups. Gov sting: tax/DMV/permit sites
  hand payment off to a third-party processor in a cross-origin frame.
- **Canvas / WebGL UIs.** Some apps paint the UI as pixels on a `<canvas>`. There are
  **no DOM elements** to select — the "Salesforce-class" case.
  *Examples:* **Figma/Miro/Excalidraw**, **Google Docs** body + Sheets cells, **Google
  Maps**, **Flutter Web** apps, TradingView charts.
- **Trusted events / user activation.** Synthetic events are `isTrusted:false` with no
  transient activation, so popups, clipboard, fullscreen, autoplay, and **anti-bot
  `isTrusted` checks** all fail/block.
  *Examples:* Cloudflare/DataDome-protected logins (banks, **Ticketmaster**, airlines),
  popup-blocked `window.open`, "Copy to clipboard" buttons. Gov sting: portals run bot
  detection on login precisely to stop automation.
- **File uploads, native/OS UI, drag-and-drop, restricted pages.** Hard content-script
  limits per [[product-design-v1]] (file `<input>.files`, OS file picker / dialogs /
  native `<select>` list, synthetic `DataTransfer`, `chrome://` & PDF viewer).
  *Examples:* upload — passport/W-2/court-filing PDFs on gov forms (common → degrades to
  `waitForUser`), resume uploads. Native UI — OS file picker, native `<select>` list (the
  recorder doesn't even emit a `select` step yet, §5 item 1), `alert/confirm/print`,
  permission prompts. Drag-drop — **Trello/Jira/Linear** card moves. Restricted —
  `chrome://settings`, Web Store, the built-in PDF viewer (a gov flow that ends in a
  generated PDF can't be driven further).

The unifying point from §5: **no snapshot rescues these** — shadow/virtualization/iframe
boundaries break tree alignment and canvas has no tree at all. Snapshots are Tier-2 fuel
and audit, never the resolver.

### How browser-use and Skyvern handle them

The architectural difference: both put the **LLM in the runtime loop** and drive via
**Playwright/CDP**, which changes what's reachable. Bao does neither by design (LLM =
compile-time; executor = content-script). That's the trade.

| Blind spot | Bao v1 (content-script, deterministic) | browser-use (DOM+screenshot, LLM-in-loop, CDP) | Skyvern (pure-vision VLM, CDP) |
|---|---|---|---|
| Open shadow DOM | possible but fragile | DOM handles; screenshot backs it | trivial — pixels |
| Closed shadow DOM | **impossible** | falls back to vision | trivial — pixels |
| Virtualization | **off-screen rows absent** | scroll-and-retry in loop | partial — must scroll into frame |
| Cross-origin iframe | **hard wall** | CDP frame access | vision crosses any origin |
| Canvas / WebGL | **nothing to select** | leans on screenshot+vision | **its sweet spot** |
| Trusted events / anti-bot | `isTrusted:false`, blocked | CDP `Input.dispatch*` = trusted | CDP trusted input |
| File upload | **cannot** (→ `waitForUser`) | `DOM.setFileInputFiles` | CDP file set |
| Cost / determinism | **free, instant, deterministic** | $ + latency, probabilistic | **$$ per element**, layout-resilient |

- **browser-use** pierces the blind spots because CDP gives trusted input + cross-origin
  + file access, and falls back to the screenshot when the DOM is opaque (closed shadow,
  canvas). Cost: tokens + latency every step, nondeterministic.
- **Skyvern** is screenshot-only, so shadow DOM, cross-origin frames, and canvas are all
  *just pixels* — it crosses every rendering boundary uniformly (the answer for
  canvas/Salesforce). Cost: most expensive, slower, layout/zoom-sensitive, and **still
  can't see virtualized off-screen content** until scrolled.

### The wager

Everything Bao structurally can't do, these tools already do — by putting the LLM in the
loop and accepting the CDP banner + per-step cost. The two wedges (§1) were chosen
*because they lean least* on shadow/virtualization/canvas/cross-origin. Where the hard
cases appear, the answer is **escalation, not baseline**: Tier-3 VLM self-heal runs only
on a Tier 0–1 miss and **writes a deterministic selector back to the IR** (pay once, then
free again); Tier-4 CDP is an **opt-in power mode** behind the Executor seam, not a
mandatory banner. The honest one-liner: *for repetitive, light-DOM, single-origin tasks,
"free + deterministic + fails cleanly" beats "probabilistic + expensive + 95% right."*
The blind spots are the explicit boundary of that wager — with the seams pre-built to
cross it per-step when a flow demands it.

## 7. Suggested near-term order

1. Capture `<select>` change → `select` step (unblocks gov forms; trivial).
2. `assert` primitive + a thin headless runner over `replay()`'s existing report
   (unblocks the QA wedge).
3. Land M1 cross-nav (the gating dependency for any multi-page real flow).
4. Tier-2 capture-only snapshots (subtree DOM + viewport screenshot), local + masked.
5. Only then prototype the Tier-3 self-heal behind the Executor/healing seams.

## 8. Capture roadmap & test fixtures

Capturing is the *easier* half — at capture time you hold the live event and the real
element; replay re-finds it blind. So most blind spots are **capturable without CDP**
(see [[product-design-v1]] "Capturing across the blind spots"). Order the work by
**leverage = (wedge coverage × prevalence) ÷ (cost × invasiveness)**, which sorts the
exotic cases to the bottom.

### Tier A — foundational, cheap, M0 (both wedges)
1. **`composedPath()` capture-phase rewrite (open shadow).** Not a feature — a
   *correctness* fix. Without it the recorder silently captures the **host instead of the
   real element** on any component app (YouTube, Salesforce, design systems) and you don't
   notice until replay misfires. Zero risk. Table stakes; must land in the M0 spike.
2. **Native `<select>` capture** (= §7 item 1). Trivial; gov forms are full of selects.
3. **Ride-along (≈free):** a capture-time **reachability classifier** tagging each target
   `light-DOM | open-shadow | cross-frame | closed-shadow | canvas`. On closed-shadow /
   canvas it captures **coords + bbox + crop** and marks the step "no clean selector →
   degrade," instead of a confidently-wrong selector. Graceful-failure thesis, applied to
   capture.

### Tier B — the structural investment, M1 (mainly the QA wedge)
4. **Harden content-anchor + scroll-context for virtualization** (extends this branch).
   *Shipped:* capture records the scrollable viewport (`target.scroll.container`);
   replay **scroll-finds** the off-screen row by its content anchor, then **re-resolves
   after the final scroll** so node recycling can't swap the data out from under the
   click. Anchored targets refuse a unique-but-positional css fallback (the recycled-row
   lie). Regression: `test/virtual.mjs` (10k rows, ~14 in DOM).
5. **`all_frames:true` + `frameId`/`FrameRef` cross-origin capture.** Per-frame content
   scripts + SW coordination. Mostly justified by QA (for gov forms, cross-origin
   payment/login degrades to `waitForUser`) — don't pull ahead of Tier A on gov grounds.
   *Shipped:* manifest injects `all_frames` (+ `match_origin_as_fallback`); each step is
   tagged with its `frame` (origin/url/top); on stop, every frame reports its steps to
   the SW, which merges by `sender.frameId`; replay resolves each recorded `FrameRef` to
   a live `frameId` via `webNavigation.getAllFrames` and routes the step there. Regression:
   `test/frames.mjs` (two-port parent/child = genuine cross-origin).

### Tier C — opt-in / fuel-only, later (neither wedge needs it)
6. **MAIN-world `attachShadow` force-open (closed shadow)** — invasive, behind a flag.
   *Shipped (opt-in):* `forceopen.js` patches `Element.prototype.attachShadow` to force
   `mode:open`, registered by the SW (`baoSetForceOpen`) as a MAIN-world,
   `document_start` content script only in aggressive mode. Once open, the **deterministic
   Tier-A piercing** captures + replays the once-closed element — no VLM, no CDP. Verified
   live: salesforce.com's closed `<cs-native-frame-holder>` (`shadowRoot` null → reachable
   under the patch). Regression: `test/forceopen.mjs` (degrade → enable → reload →
   deterministic replay → disable).
7. **Tier-3 coordinate/VLM heal** consuming the Tier-A ride-along fuel (canvas, closed
   shadow). *Still unbuilt — the only genuinely probabilistic tier; the seams (degrade
   markers + bbox) are in place.*

Shape: Tier A is shared must-have core, Tier B is the QA-wedge bet, Tier C is escalation
behind flags — mapping onto the existing M0/M1/M4 order.

### Test fixtures — verified bot-accessible (2026-06-28)

Local fixtures (deterministic regression, in `test/`) reproduce each boundary; live
targets are smoke tests. **All live targets below were driven headless via Chromium and
returned 200 with no auth wall and no bot challenge** (no Cloudflare/captcha
interstitial) — safe for the Playwright harness.

| Capability | Local fixture (created) | Live smoke target | Verified signal |
|---|---|---|---|
| Open / nested / closed shadow | `test/fixture-shadow.html` | `shoelace.style/components/button` | **344 open shadow roots**; fixture proves `composedPath` retarget trap + closed-shadow stops at host |
| Native `<select>` | `test/fixture-select.html` | (any gov form) | `change` → `select` step |
| Virtualization | `test/fixture-virtual.html` | `ag-grid.com/example/` | **22 rows rendered, `virtualized=true`**; fixture proves node recycling + scroll-find |
| Cross-origin iframe | `test/fixture-frame-{parent,child}.html` (two-port) | `stripe.dev/elements-examples/` | cross-origin iframes `js.stripe.com`, `b.stripecdn.com` |
| Canvas (graceful degrade) | `test/fixture-canvas.html` | `excalidraw.com` (or `tldraw.com`) | **2 / 1 `<canvas>`**; fixture proves 0 DOM buttons, pixel hit-test |

Notes from verification: **reCAPTCHA's demo iframe is same-origin** (`www.google.com`
hosts both) → it tests frame-path, *not* the cross-origin boundary; use Stripe (or the
two-port local fixture) for true cross-origin. **YouTube is flaky headless** (consent
redirect, 0 shadow roots before hydration) → shoelace is the canonical open-shadow target.
Definition of done per capability: `record → replay → assert correct element` passes on
its fixture.

### Live smoke suite (`npm run test:live`, opt-in)

The `test/live-blindspots-*.mjs` suite (one runnable file per site, sharing
`test/live-helpers.mjs`; `npm run test:live` runs them all, or `npm run
test:live:open-shadow` / `:canvas` / `:frames` / `:virtual` / `:closed-shadow`
individually) drives the **real extension on the real sites** — kept out of the default
`npm test` because live sites flake/change (a load failure is a SKIP, not a FAIL). It
exercises the extension where robust and falls back to a structural check otherwise:

| Site | Asserts |
|---|---|
| shoelace.style | extension captures `reach=open-shadow` + a `shadowpath` on a real `<sl-button>` |
| excalidraw.com | extension classifies a canvas click `reach=canvas` + degraded |
| stripe.dev | the `all_frames` content script answers **inside** the cross-origin `b.stripecdn.com` frame |
| ag-grid.com | windowed grid: only ~18 of thousands of rows in the DOM |
| salesforce.com | real `<cs-native-frame-holder>` has a **closed** root (`shadowRoot===null`) |

**Anti-bot finding (a live demo of §6's blind spot):** ag-grid (CloudFront) and
salesforce (Akamai) **bot-block the automated session outright** unless a realistic
`User-Agent` is set — exactly the `isTrusted`/automation-detection wall the design flags.
With a real UA the suite passes 9/9, 0 skipped.
