# Bao

**Record a browser workflow once, get human-readable steps, replay it deterministically
whenever you want.** A Chrome MV3 extension for non-technical users with a repetitive
browser task ("log in, open the report, download the CSV").

Unlike browser-use / Skyvern, **the LLM is not the runtime.** The durable artifact is a
readable, editable **workflow (IR)**. An LLM is a *compiler* (raw trace → clean steps)
that runs once at authoring time. Replay is plain deterministic code: free, instant,
offline, and it fails *cleanly* (a clear "the page changed, re-record" report) instead of
guessing.

> This README is the single entry point. It states where the project is, links every
> design doc in reading order, and lays out the path to a public launch. Deep design
> lives in the docs mapped below; how to run the tests lives in [TESTING.md](docs/TESTING.md).

---

## Install

**Chrome Web Store (one-click): _coming soon._** The listing is packaged and staged
(`store/`) but not yet submitted - track [blocker #5](#blockers-in-priority-order). Once
it's live, this line becomes the install button.

**Beta (available now): download + load unpacked.** Until the store listing is live, grab
the packaged build from the [latest release](https://github.com/aaalexliu/bao-browser/releases/latest):

1. Download `bao-extension.zip` from the release and **unzip** it.
2. Open `chrome://extensions`, toggle **Developer mode** (top-right).
3. **Load unpacked** → select the unzipped folder.
4. Pin Bao, open any normal `http(s)` page, click the toolbar icon - the side panel opens.

> This is a beta distribution mode: Developer-mode unpacked load is fine for early users
> but is not the intended path for non-technical users (see the thesis in
> [blocker #5](#blockers-in-priority-order)) - the Chrome Web Store listing is. Building
> from source instead? See **[Quickstart](#quickstart)** below.

---

## Status at a glance

The risky core is **built and green** (`npm run typecheck` + `npm test` pass): capture →
deterministic replay, across full-document navigations, with a side panel, a full-page
dashboard, run history, and an audit filmstrip. The engine covers the two target wedges.

| Area | State |
|---|---|
| M0 — capture + deterministic replay, ranked multi-selector fallback, native input actuator | ✅ shipped |
| P0 recorder correctness — checkbox *set* (T3), keyboard/Enter-submit (T4), pointerdown-timing (T5) | ✅ shipped |
| **T1 — mask sensitive inputs (passwords / SSNs / cards / CVV / OTP)** | ✅ shipped |
| contenteditable / rich-text (T2), assert + headless CI runner (T6) | ✅ shipped |
| SPA soft-nav (T7), M1 cross-navigation state machine + `waitForUser` (T8), downloads (T10) | ✅ shipped |
| Over-capture fuel — grounding (T11), golden screenshots (T12), subtree snapshot (T13) | ✅ shipped |
| IR + named workflows (T14), side panel (T15), dashboard + light editing + run history + filmstrip (T16) | ✅ shipped |
| Structural coverage — open-shadow piercing, `<select>`, reachability classifier, virtualization scroll-find, cross-origin frames, opt-in closed-shadow force-open | ✅ shipped |
| **M2 — hosted LLM compiler** (raw trace → readable labels; the non-technical trust surface) | ⬜ not started |
| **M4 — Tier-3 VLM self-heal • parameterization / variables** (the "record I just created" gap) | ⬜ future |
| Backlog — hover, drag-and-drop, clipboard, dblclick, odd input types, multi-tab | ⬜ deferred |

Full task-by-task history and acceptance criteria: `docs/recording-gaps-and-app-universe.md`
§Part 1.

---

## The strategy, in brief

**Where Bao wins:** no API, auth lives in the browser, the task is repetitive multi-step
UI, and the page churns between runs. Two beachheads, chosen because they lean *least* on
the unsolved structural problems (shadow DOM, virtualization, cross-origin, canvas):

- **A. Government / bureaucratic forms (prosumer).** Visceral pain, no API, "I did this
  last year and forgot how." Gated on: T1 masking, M1 cross-nav (✅), `waitForUser` (✅),
  and — for the readable-steps promise to a non-technical user — the M2 compiler.
- **B. Record-to-test for QA / synthetic monitoring (IT).** Technical buyer, the engine
  *is* the product, **no backend required**. Assert + headless runner already shipped
  (T6). This wedge is closest to launchable today.

**The resolution ladder** (walk the cheapest deterministic tier that works; escalate
per-step, never globally; cache any escalation back down to a deterministic selector):

| Tier | Mechanism | Determinism | Status |
|---|---|---|---|
| 0 | Unique robust selector (testid/id/aria) | full | ✅ |
| 1 | Content anchor + within-descriptor + M1 cross-nav | full | ✅ |
| 2 | Capture-only DOM subtree + screenshot (fuel / audit, **not** a resolver) | n/a | ✅ |
| 3 | VLM self-heal on miss → writes a fresh selector back to the IR | probabilistic → re-cached | ⬜ M4 |
| 4 | Debugger / CDP executor (trusted input, file upload, closed shadow) | full | ⬜ opt-in, behind the Executor seam |

**The bet, stated honestly:** for repetitive, light-DOM, single-origin tasks,
*"free + deterministic + fails cleanly"* beats *"probabilistic + expensive + 95% right."*
The blind spots (canvas interiors, `isTrusted`/anti-bot walls, `chrome://` & OS dialogs)
are the explicit boundary of that wager — the seams to cross it per-step are pre-built,
never the baseline. This is the wedge against **browzer** (the closest competitor):
Bao requests **no `debugger` permission**, so no trust banner and — critically for
distribution — far lighter Chrome Web Store review.

---

## Documentation map (read in this order)

1. **`docs/product-design-v1.md`** — the master design: architecture, the IR, storage &
   privacy, auditable replay, the Executor seam, non-debugger vs debugger execution, and
   the browzer teardown. Start here.
2. **`docs/use-cases-and-snapshot-fallback.md`** — which use cases to aim at, the resolution
   ladder in depth, the "can we just snapshot the DOM/screen?" question answered, and the
   blind-spot comparison vs browser-use / Skyvern.
3. **`docs/recording-gaps-and-app-universe.md`** — every capability specced as an executable
   task (T1–T14 + backlog, with shipped-status annotations), the taxonomy of all
   browser-app categories and what each layer of work unlocks, and the live no-login test
   targets per category.
4. **`docs/m1-design.md`** — the cross-navigation milestone: the storage-backed SW state
   machine, re-inject/resume, `waitForUser`, downloads, and the genuinely hard races.
5. **`docs/t15-sidepanel-design.md`** — the side panel (live capture + quick-run surface).
6. **`docs/t16-dashboard-design.md`** — the full-page dashboard: library, light step editing,
   durable run history, and the record-vs-replay filmstrip.
7. **`docs/backend-webapp-design.md`** — launch #2: the hosted compiler (M2), accounts + sync,
   and **workflow sharing** — designed local-first so the backend stays additive.

Docs cross-link with `[[wikilinks]]` by basename.

---

## Quickstart

```sh
npm install && npm run build   # TypeScript in src/ → esbuild bundles to dist/ (npm run watch to iterate)
```

1. `chrome://extensions` → toggle **Developer mode** → **Load unpacked** → select this folder.
2. Pin the extension, open any normal `http(s)` page (not `chrome://`), click the toolbar
   icon — the **side panel** opens.
3. **● Record**, click / type on the page (steps appear live), **■ Stop** — auto-saved
   with a generated name, focused for an inline rename.
4. **▶ Run** from a card or the detail view — the step list shows live ✓/✗ progress and
   pauses inline with a **Continue** button when a step needs you.
5. Open the **dashboard** (⤢ in the panel header, or right-click → Options) for the
   full-page home: browse the library, **edit** steps (reorder / delete / edit
   value+assert, no re-record), and re-watch **run history** as a record-vs-replay
   filmstrip.

Testing (unit e2e, the headless CI runner, live-site suites): **[TESTING.md](docs/TESTING.md)**.

---

## Path to launch: "a web app + install the extension"

The product *is* the extension. "Deploy as a web app" means a **landing site** (what it
is, a demo, install CTA, docs) that points users at the extension — plus getting the
extension itself distributable. Two audiences, two very different readiness levels:

- **QA / dev wedge (B):** pure client-side, **no backend**. Closest to shippable today.
- **Non-technical / gov wedge (A):** the readable-steps promise implies the **M2 hosted
  compiler** — a real backend service (LLM key, infra, and privacy handling of the
  redacted trace). Bigger lift; decide whether launch #1 targets this at all.

### Blockers, in priority order

1. ✅ **T1 — plaintext secrets (done).** Sensitive fields (password / SSN / card / CVV /
   OTP, by type / autocomplete / name / value-shape) are masked at capture: the value is
   never written, the target's text/snapshot fuel and the golden screenshot are dropped,
   and replay focuses the field but leaves it empty. Regression `test/sensitive.mjs`
   asserts no secret substring survives in the returned steps or in SW storage. Full spec:
   `docs/recording-gaps-and-app-universe.md` §T1.
2. ✅ **Extension icons (done).** `icons/` holds 16/32/48/128 PNGs (a steamed-bao mark),
   wired into `manifest.icons` + `action.default_icon`; source SVG + a deps-free
   Playwright rasterizer live in `assets/`. Store screenshots / promo tiles still TODO for
   the listing itself.
3. **Chrome Web Store review risk (partly mitigated).** `<all_urls>` host permissions +
   `scripting` / `webNavigation` / `downloads` still trigger heavy review and a
   per-permission justification form. Mitigants in place: Bao requests **no `debugger`**
   (the thing keeping browzer stuck in review), the redundant **`activeTab`** is now
   removed, and the data story is simple (local-first today). Budget for review
   back-and-forth; the `<all_urls>` justification ("a general-purpose recorder must run on
   the page the user chooses") is the crux.
4. **Privacy-policy URL (only if CWS asks).** No privacy doc is maintained in-repo. If the
   store requires a policy URL for the `<all_urls>` permission, host a short statement at
   submission time (local-first today; cloud features opt-in and coming).
5. **Distribution mode (beta shipped, store pending).** A **beta unpacked build** is now
   published as a [GitHub release](https://github.com/aaalexliu/bao-browser/releases/latest)
   (download `bao-extension.zip` → load unpacked; see [Install](#install)). That's fine for
   early/design-partner users but stays hostile to the non-technical primary user (it
   contradicts the thesis). The real answer is still a **CWS listing** (one-click install),
   which is packaged and awaiting submission.
6. **M2 backend — only if launch #1 targets the non-technical wedge.** No backend exists.
   Standing up the thin compiler service (host the LLM key, coalesce/label the trace,
   handle the redacted trace privately) is the largest single item, and it's a *product
   decision*, not a bug: the QA wedge can launch without it.
7. **Housekeeping.** Version is `0.1.0` (bumped off `0.0.1` for the first beta release);
   the design docs still carry per-task "not yet
   landed" notes that are now stale (T1 excepted) — this README's status table is the
   source of truth. `docs/product-design-v1.md` still references a `[[browser-use-vs-skyvern]]`
   sibling doc that isn't in the repo.

### Shortest credible path to a public beta

**T1 (✅) → icons + manifest cleanup (✅) → CWS submission (next)**,
in parallel with a static landing page (`site/index.html` — what it is, a replay demo,
install CTA, docs). Target the **QA/dev wedge** for launch #1 (no backend, engine already
proven), and treat the M2 compiler + gov-forms wedge as launch #2 once the backend exists.

What's left before a listing goes live is now mostly *your* action, not code: create the
CWS developer account, bump the `version`, capture store screenshots + a promo tile, and
submit with the `<all_urls>` justification.
