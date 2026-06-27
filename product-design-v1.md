# Bao Browser — Product Design v1

> Record a browser workflow once, get human-readable steps, replay it on demand.
> Sibling doc: [[browser-use-vs-skyvern]] (landscape we're differentiating from).

## What it is

A Chrome extension that lets a **non-technical user** record a repetitive browser
task ("log in, open the report, download the CSV"), see it as plain-English steps,
and replay it deterministically whenever they want.

Unlike browser-use / Skyvern, the LLM is **not the runtime**. The durable artifact is
a human-readable, editable **workflow (IR)**. The LLM is a *compiler* (trace → steps)
that runs once at authoring time. Replay is plain deterministic code: free, instant,
offline.

## v1 decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Execution model | **Deterministic now**, self-healing later | IR over-captures so healing drops in without re-recording |
| Form factor | **Chrome MV3 extension only** | Easiest install + runs in the user's real logged-in session |
| Primary user | **Non-technical end users** | Drives trust UX: readable steps, graceful failure |
| v1 wedge | **Record → replay a repetitive task** | The "morning report" shape |
| Auth | **Lean on existing session** + `waitForUser` step; stored secrets later | Sidesteps credential security in v1 |
| LLM compiler | **Hosted backend** holds the key | No setup for non-technical users |
| Failure UX | **Fail with a clear report** (re-record), minimal UI | Honest about brittleness; cheap to build |
| Tabs | **Single tab** in v1 | Multi-tab multiplies state-machine complexity |

## Non-negotiables given the choices

Deterministic replay is brittle, and non-technical users can't repair a broken
selector. Therefore:

1. **Over-capture at record time** — multiple selector candidates + bounding box +
   text + role + screenshot crop per element. v1 only *uses* the top selector, but
   this is exactly the data self-healing needs later, and it's impossible to capture
   retroactively.
2. **Graceful failure** — "couldn't find the **Download** button, the page may have
   changed — re-record this workflow", never a stack trace.

## The IR (the core asset)

```jsonc
Workflow {
  id, name, version, startUrl,
  variables: [],                    // empty in v1; templating drops in here later
  steps: [Step]
}

Step {
  id, index,
  action: "navigate" | "click" | "input" | "select"
        | "waitFor" | "waitForUser" | "extract" | "download" | "keypress",
  label: "Click the 'Download CSV' button",   // LLM-generated, the trust surface
  target?: Target,                  // null for navigate / waitForUser
  value?: string,                   // "{{var}}" later; literal now
  wait?:  { type, value, timeoutMs },
  frame?: FrameRef,                 // iframe path
  meta:   { recordedAt, viewport, goldenScreenshotRef }   // full record-time frame
}

Target {
  // priority-ordered; v1 reads [0..n] top-down, stops at first hit
  selectors: [{ type:"testid"|"aria"|"text"|"id"|"css"|"xpath", value, score }],
  boundingBox,        // store as viewport % (survives resize); also neighbor anchors
  textContent, role   // unused in v1 → fuel for healing (crop derived from frame+bbox)
}
```

**Self-healing upgrade path:** when all selectors miss, hand
`boundingBox + textContent + role + screenshotCrop + label` to the LLM. No
re-recording needed because the data was captured on day one.

`waitForUser` is a general primitive (pause, show a message, resume on click) that
covers login, 2FA, CAPTCHA, and any ambiguous moment. Build once, reuse.

## Architecture

```
Chrome MV3 Extension
├── Content script (per frame)  — capture events; replay actions; highlight overlay
├── Service worker (background) — run state machine (persisted), re-inject content
│                                  script across navigations, capture+crop screenshots
├── Side panel UI               — record/stop, readable steps, run/pause, results
└── chrome.storage              — workflows (IR), run history  (unlimitedStorage)
        │
        ▼
   Backend (thin)               — compiler: raw trace → clean IR + labels (1 LLM call)
```

| Component | Owns |
|---|---|
| Content script | Capture events; build selector candidates + bbox + text + role; replay with **native value setter + real InputEvent**; highlight overlay |
| Service worker | Run **state machine** (persist to `chrome.storage`, survives SW kill); re-inject + resume across navigations; `captureVisibleTab` full viewport per step (golden + actual filmstrips); call backend |
| Side panel | Record/Stop; readable step list (review/edit); Run/Pause; results + failure report; run history |
| Backend | Coalesce keystrokes→one input; drop noise; infer waits from navigations; detect login → insert `waitForUser`; write labels; order selectors by stability |

## Two flows

**Record:** Record → SW injects content script (re-inject on nav) → capture events with
full grounding → Stop → POST raw trace to backend → compiler returns clean IR →
side panel shows steps for review → save to `chrome.storage`.

**Replay:** Load IR → SW state machine steps through → content script resolves
`selectors[0..n]`, acts, waits → on navigation SW re-injects and resumes → on miss →
fail with clear report. Zero LLM tokens, offline, instant.

## What we capture (M0 detail)

Listen in the **capture phase** so app `stopPropagation` can't hide events:

| Event | Listen to | Becomes |
|---|---|---|
| Click | `pointerdown` + `click` | `click` step |
| Text input | `input` / `change` (coalesced) | one `input` step per field |
| Dropdown | `change` on `<select>` | `select` step |
| Enter/submit | `keydown` (Enter), `submit` | `keypress` / implied nav |
| Navigation | `beforeunload`, SW `webNavigation` | `navigate` + `waitFor` |
| Scroll-to | track scroll before a click | folded into the click's `wait` |

For each interaction, snapshot **all** grounding at once:
selector candidates, bounding box, text, aria role, frame path, viewport, screenshot
crop. Capture raw + noisy; the backend compiler cleans it.

### Selector generation (priority order)

Mirror Playwright/Chrome Recorder best practice — prefer user-facing/stable, fall
back to structural:

1. `data-testid` / `data-test` etc.
2. ARIA role + accessible name (`getByRole`-style)
3. Visible text (for buttons/links)
4. `id` — **only if not auto-generated** (skip `#combobox-3123`-style)
5. Scoped CSS path
6. XPath (last resort)

Store the whole ranked list per element (Chrome Recorder's fallback model). Replay
tries each in order.

## Storage

- **Workflows (IR):** `chrome.storage.local`, JSON. Small.
- **Screenshots — full viewport, for the auditable replay (see below).** Store one
  full viewport frame per step + the bbox; **derive self-healing crops on demand**
  (`fullFrame ✂ bbox`) rather than storing crops separately. JPEG q≈75, downscaled
  to ~1000px wide → ~50–150 KB/frame. Blobs in **IndexedDB** + `unlimitedStorage`.
- **Run history:** per-run status, which step failed, and the ordered filmstrip of
  *actual* run-time frames.
- **Privacy:** full screenshots stay **local by default** (this *strengthens* the
  local-only story — sensitive captures never leave the device). To the backend we
  send only the **redacted, input-masked trace** for compile — small, no secrets, no
  full frames. Export/share of an audit is an explicit action with an optional
  redaction pass.

## Auditable replay (full-screenshot trust trail)

Full *screenshots* ≠ full *DOM* — cheap and safe, the right artifact for audit (the
DOM-capture blind spots/privacy concerns do **not** apply here). Two streams:

- **Golden** — captured at *record* time; `Step.meta.goldenScreenshotRef`. "What the
  page looked like when you taught me."
- **Actual** — captured at *replay* time per step; run-history `actualScreenshotRefs[]`.
  "What actually happened this morning."

**Viewer = filmstrip/timeline** (not an rrweb DOM replay): per step show the full
frame with the **targeted element highlighted** (overlay bbox in the viewer, keep the
raw image clean), the plain-English label, timestamp/duration, ✓/✗, and on failure
**golden vs. actual side by side** — instantly legible to a non-technical user.

MV3 capture realities: `captureVisibleTab` grabs the **visible viewport of the active
tab only** (no full-page scroll-stitch without CDP/banner; no background tabs), is
**rate-limited** (~a few/sec, fine per-step). Capture at each step boundary.

## Replay mechanics (the gotchas)

- **React/Vue inputs:** setting `.value` won't register. Use the **native value
  setter** (`Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,
  'value').set`) then dispatch a real `new InputEvent('input', {bubbles:true})`.
  Silent failure otherwise.
- **MV3 service worker gets killed:** never hold run state in memory — persist
  `{workflowId, runId, stepIndex}` to `chrome.storage`, drive a state machine.
- **Content script dies on navigation:** SW must re-inject (`chrome.scripting`) after
  each load and resume at the saved `stepIndex`.
- **Waits:** prefer `waitFor: elementVisible` over fixed timeouts; `urlMatches` /
  load events for navigation.
- **Shadow DOM / iframes:** selector resolution must pierce shadow roots; store frame
  path so replay targets the right frame.

## OSS we lean on vs. build

| Need | Use | Why / tradeoff |
|---|---|---|
| Selector generation | port **Chrome Recorder / Playwright** heuristics | Don't reinvent ranked, resilient selectors |
| Multi-selector fallback | **Chrome Recorder model** | Try selectors in sequence, first hit wins |
| Step JSON format | inspired by **`@puppeteer/replay`** schema | Editable JSON, proven shape; we extend with grounding |
| DOM serialization (for healing crops/context later) | evaluate **rrweb** | Great at *recording* DOM mutations for session replay, but it replays into an iframe — **not** an actuator on the live page. Use as inspiration / for capture fidelity, not as our executor |
| Full agent fallback (later) | **browser-use** patterns; **Midscene.js** (in-browser VLM) | For self-healing / prompt-authoring milestones |

**Why not just fork an existing tool:**
- **Chrome Recorder + @puppeteer/replay** → exports Puppeteer (needs Node/CDP, the
  debugger banner) — wrong runtime for an in-page, no-banner extension. We borrow the
  *selector + JSON ideas*, not the engine.
- **rrweb** → built for *session replay* (watch a recording), not *actuation*
  (re-drive the live site). Different problem.
- **Selenium IDE** → closest analog (record/replay browser extension) but
  developer-oriented and selector-fragile; our edge is the readable-step compiler +
  healing-ready IR + non-technical UX.

## Build order

```
M0  spike: capture + deterministic replay, 1 page, no LLM   ← proves the hard part
M1  cross-navigation (re-inject + state machine), waitForUser, download capture
M2  backend compiler → clean readable steps + labels         ← non-technical-reviewable
M3  side panel polish, failure reporting, run history
M4  (later) self-healing executor • parameterization • prompt-to-author
```

**M0 is make-or-break** — if deterministic capture+replay isn't reliable on real
sites, the LLM polish is lipstick. Build it first as a throwaway spike.

## Permissions (manifest)

`scripting`, `storage`, `unlimitedStorage`, `tabs`, `downloads`, `sidePanel`,
`webNavigation`, and broad `host_permissions` (`<all_urls>` — unavoidable for a
general recorder; expect Chrome Web Store review scrutiny). v1 does **not** request
`debugger` (see execution-mode section) — that's the whole point.

## Competitor teardown: browzer (trybrowzer.com)

The closest direct competitor found (downloaded + read its shipped code). Same
category (record/replay browser workflows, hosted backend, LLM-assisted) but the
**opposite architectural bet** — and that bet is exactly Bao's wedge.

- **Voice-first** record/replay: bundles Silero VAD (`silero_vad_v5.onnx`) + ONNX
  wasm + a mic-iframe. You talk to it. (Not Bao's wedge.)
- **Drives via `chrome.debugger` / CDP** — manifest requests `debugger`; service
  worker is full of `Input.dispatchMouseEvent/KeyEvent`, `Runtime.evaluate`,
  `DOM.describeNode/resolveNode/getBoxModel`, `Page.captureScreenshot/navigate`,
  `DOM.setFileInputFiles`. So it pays the **"browzer started debugging this browser"
  banner** to get trusted input + file uploads.
- **Hybrid perception/actuation:** content script builds selectors (querySelector,
  `aria-label`, `role`, `name`, text, `data-test(id)`, contenteditable, nth-of-type,
  boundingClientRect) and posts them to the SW, which resolves + actuates via CDP.
- Built with **WXT** (Vite extension framework) — good toolchain reference.
- Backend at `services.trybrowzer.com`; account-synced recordings; `externally_
  connectable` to `trybrowzer.com`.
- **Distribution proof point:** their own site says the extension is "currently under
  review by the Chrome Web Store" and ships via **manual unpacked-folder load** in the
  meantime — exactly the `debugger`+broad-perms review friction we predicted.

**Bao's wedge against browzer:** no banner, runs in the user's real session,
non-technical record→replay (not voice). **Honest counter to internalize:** their CDP
path can do two things Bao's content-script path structurally cannot — *trusted input
events* and *file uploads*. That's the cost of no-banner (next section).

## Execution mode: non-debugger (v1) vs. debugger (later)

### Non-debugger / content-script mode — v1 (no banner)

**Can:** read/query DOM in same-origin frames; build selectors; dispatch synthetic
events (`el.click()`, `dispatchEvent`) — but `isTrusted:false`; set form values via
native setter + `InputEvent`; checkboxes (`.checked`+change); `<select>` (`.value`
+change); contenteditable; scroll/focus/read; viewport screenshot via SW
`captureVisibleTab`.

**Cannot (hard limits):**
1. **File inputs** — cannot set `<input type=file>` files. Hard security boundary.
2. **Trusted events / user activation** — synthetic events are `isTrusted:false` and
   grant no transient user activation, so these fail/are blocked: programmatic
   `window.open` (popup-blocked), `navigator.clipboard` read/write, `requestFullscreen`,
   autoplay-with-audio, and any site logic gating on `isTrusted` (anti-bot).
3. **Cross-origin iframes** — can't read/bridge across origins.
4. **Closed shadow DOM** — inaccessible.
5. **Native/OS UI** — file picker, print/basic-auth dialogs, JS `alert/confirm/prompt`,
   permission prompts, native `<select>` option list, `beforeunload`.
6. **HTML5 drag-and-drop** — synthetic DataTransfer is unreliable.
7. **`chrome://` / Web Store / other-extension / PDF-viewer pages** — content scripts
   don't run there.

### Debugger / CDP mode — later (banner)

**Adds:** trusted input (`Input.dispatch*` injected at browser level → satisfies
user-activation + most `isTrusted` checks); **file uploads** (`DOM.setFileInputFiles`);
full-page/off-screen screenshots; cross-origin frame access; network read/intercept;
JS-dialog handling; download control; coordinate-based clicking (`DOM.getBoxModel`).

**Costs:** the **non-suppressible debugging infobar** for the whole attach duration
(Chrome makes it unsuppressable on purpose — trust killer); **one debugger per tab**
(conflicts with DevTools); heavier attach/detach; the scary `debugger` permission =
heavier CWS review (browzer is stuck in it); some enterprise policies block it; more
anti-bot detectable. Still can't touch `chrome://` etc.

### Strategy: v1 non-debugger, extend to debugger via an Executor seam

Put the seam in **now** (cheap), implement only the content-script side:

```ts
interface Executor {                 // IR is identical for both
  click(target); type(target, value); select(...); navigate(url);
  uploadFile(target, file); screenshot(opts); waitFor(...);
}
ContentScriptExecutor implements Executor   // v1 — no banner
DebuggerExecutor       implements Executor   // later — CDP, banner
```

At compile time, tag steps with a capability need:
`step.requires = "trustedInput" | "fileUpload" | "crossOriginFrame" | null`.

- **v1 (ContentScriptExecutor only):** covers ~80–90% of repetitive click/type/extract/
  navigate flows. For a step it can't do, **don't fail silently — `waitForUser`**
  ("choose the file, then click Continue"). Graceful degrade, honest.
- **v2 (add DebuggerExecutor):** opt-in "power mode" for flows needing trusted input /
  uploads / cross-origin. Banner options: (a) whole-run attach (simplest), or
  (b) **transient per-step attach** — content-script by default, attach CDP only for
  the one step that needs it, then detach (banner flashes briefly). Enterprise
  force-install can pre-grant `debugger`.
- **Capability detection** at replay (file input present, or click had no effect)
  becomes the natural upsell to enabling power mode.

This converges toward browzer's hybrid architecture — but as an **opt-in escalation**,
not a **mandatory baseline**. browzer makes the banner compulsory; Bao makes it the
exception. Same seam-first principle as designing the IR for self-healing before
building it.
