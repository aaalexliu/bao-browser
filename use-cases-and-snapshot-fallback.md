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
- **Assertions.** QA needs *expectations*, not just actions: "expect text X", "expect
  element gone", "expect url matches". The IR has `extract` but no `assert`. This is
  the one genuinely missing primitive — capture it at record time (select an element →
  "assert visible / assert text").
- **Flake control & CI:** element waits (planned) + a headless runner + golden/actual
  screenshot diffing (designed in [[product-design-v1]] "auditable replay").

**Verdict:** engine proven; ship `assert` + a runner/reporter and this is a product.

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

## 6. Suggested near-term order

1. Capture `<select>` change → `select` step (unblocks gov forms; trivial).
2. `assert` primitive + a thin headless runner over `replay()`'s existing report
   (unblocks the QA wedge).
3. Land M1 cross-nav (the gating dependency for any multi-page real flow).
4. Tier-2 capture-only snapshots (subtree DOM + viewport screenshot), local + masked.
5. Only then prototype the Tier-3 self-heal behind the Executor/healing seams.
