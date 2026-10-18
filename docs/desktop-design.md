# Bao Desktop — Architecture Pass

> Parent: [[product-design-v1]] (IR, Executor seam, non-debugger vs debugger).
> Blind spots this modality exists to cross: [[use-cases-and-snapshot-fallback]] §5–6,
> [[recording-gaps-and-app-universe]] (file upload, `isTrusted`, multi-tab, closed shadow,
> OS dialogs).
> Status: **architecture only.** No `desktop/` app, no changes to extension behavior,
> no new runtime dependencies. Date: 2026-10-18.

A desktop app is a **second modality**, not a rewrite of the extension and not a
fork of the workflow IR. The extension keeps the wedge it already has: replay inside
the user's real Chrome session, with no `debugger` permission and no infobar. The
desktop app exists for the surfaces that wedge cannot reach.

**Recommendation, up front.** Drive an **owned Chrome** with a **Node sidecar**
(Playwright, which speaks CDP) for the browser plane. Put OS capture and replay
(Linux AT-SPI, macOS Accessibility, Windows UI Automation) in **Rust**. Use
**Tauri 2** as the window, and only after the two spikes below pass — spike 1 is a
CLI with no shell. Extend the shared IR in `src/types.ts`; do not fork it. Do not
automate Electron's Chromium, and do not attach CDP to the user's daily Chrome.

---

## 1. Shell choice

### What the shell has to do

Three planes, and they are different programs:

| Plane | Job | Talks to |
|---|---|---|
| Browser | Record and replay pages: trusted input, file inputs, multi-tab, closed shadow, downloads, JS dialogs | An owned Chromium, over CDP |
| OS | Record and replay native windows: save/open dialogs, and later other apps | macOS AX, Windows UIA, Linux AT-SPI, plus a screenshot |
| Product | Step list, run/stop, failure report. The thing that has to feel better than a side panel | The user |

The browser plane is not "whichever webview paints the UI." Google blocks OAuth in
embedded webviews, Electron's user-agent is not Chrome, and a page running inside
the shell cannot be a native save dialog. The owned browser is a separate process
even when the UI is pretty.

Owned means: we launch Chrome ourselves with an explicit `--user-data-dir` that we
created. CDP is how we talk to our child process. That is not
`chrome.debugger` attached to the user's browser, and Chrome does not show
"started debugging this browser" for it. Attaching to a Chrome the user already
has open reintroduces the banner, the profile lock, and the trust problem the
extension is designed to avoid. That configuration is out of scope.

### Comparison

Sizes are approximate, per OS, before our own assets. They are here to rank
options, not to quote an installer.

| | Electron | Tauri 2 | Node + Playwright CLI, thin UI later | Native messaging host beside the extension |
|---|---|---|---|---|
| Owned Chrome via CDP | Electron *is* a Chromium. `webContents.debugger` is CDP with no infobar, but the page is Electron, not Chrome (OAuth and anti-bot). A second, real Chrome via Playwright means two Chromiums. | Shell has no Chromium (WKWebView / WebView2 / WebKitGTK). The target is a Chrome we launch. One browser, and it is real Chrome. | Same browser story as Tauri. Playwright is already a devDependency of this repo. | No CDP. The extension stays as it is. |
| OS hooks | N-API addon rebuilt per Electron ABI, or a sidecar. `desktopCapturer` is the one thing Electron does well here. | In-process Rust: AX via `objc2`, UIA via the `uiautomation` crate, AT-SPI via `atspi`. Screen capture via `xcap` / ScreenCaptureKit. This is the natural place for it. | Same native code, compiled as a small helper the CLI spawns. No window toolkit required for the spike. | A native host can drive a dialog the extension just opened. It cannot see closed shadow or mint trusted events. |
| Packaging and signing | electron-builder is the trodden path: Developer ID, notarization, Authenticode, auto-update. Hardened runtime is required for notarization. TCC prompts (Accessibility, Screen Recording) are separate from signing and still appear. | `tauri build` produces dmg/msi/deb and notarizes. Same TCC reality. The binary identity must stay stable across updates or macOS forgets the permission grant. | No installer until a shell exists. Easy to put on this VM. A signed bundle is still mandatory before any Mac user hits TCC. | Two installs (CWS + a host registered in the native messaging manifest). Worst of both distribution stories. |
| Bundle size | ~100 MB compressed runtime, ~180–250 MB on disk, **plus** another ~150 MB if Playwright also ships Chrome. | Shell usually under ~15 MB. WebView2 is shared on Windows; WKWebView is on the Mac. Chrome is extra only if we bundle Chrome for Testing instead of using a system Chrome. | Node + our code is small. Chrome for Testing is the big piece, and only if we stop relying on a system Chrome. | Extension size unchanged. Host is a few MB. |
| TypeScript we can reuse | Main process can import a `core/` package directly. | The UI can. The Rust process cannot run the replay planner without a sidecar or a rewrite. | All of it. This is the same language and the same Playwright the tests already drive. | None of the new planes. The extension keeps running unchanged, which is the point, and the ceiling. |

### Electron

Fits a team that wants one language and one window. `WebContentsView` can show the
target page beside the step list, which is the closest thing to the side panel.

That single window is the wrong browser. Replay would run in Electron's Chromium:
`navigator.userAgent` says Electron, Google sign-in is routinely blocked in
embedded webviews, and the fingerprint is a known automation shape. Using
Playwright *next to* Electron to get a real Chrome means shipping two browsers and
still writing a native addon for accessibility, rebuilt on every Electron major.

Take Electron only as a later UI experiment if a companion window feels worse than
the side panel. Do not make Electron the automation target.

### Tauri 2

The shell is a small native window plus a system webview. It does not help with
CDP at all, and it should not try. Its job is the product window and the OS plane,
because both want Rust more than they want Node.

The cost is a third runtime: Rust (window + accessibility), Node (Playwright and
the TypeScript planner), TypeScript in the webview (the step list). That is
justified only once spike 1 has proved the browser plane and spike 2 has proved
that accessibility replay is real. Until then Tauri is a dependency we do not have
on this VM (no WebKitGTK in the current image) and do not need.

`accesskit` is for exposing *our* UI to assistive tech. It does not drive other
processes. Driving is AX / UIA / AT-SPI. Different libraries.

### Node / Playwright CLI, then a thin UI

This is spike 1's whole shell: none.

Playwright already launches Chromium in `test/e2e.mjs`. `chromium.launchPersistentContext`
with `channel: "chrome"` and a temp `user-data-dir` is an owned Chrome. `page.mouse`
/ `page.keyboard` are `Input.dispatch*` (trusted). `page.on("filechooser")` is
`Page.fileChooserOpened`. `context.on("page")` is `Target` auto-attach. Drop to
`context.newCDPSession(page)` only for what Playwright hides, in particular
`DOM.getDocument({ pierce: true })` for closed shadow.

A CLI does not satisfy "better product feel." It is the right first artifact
because the feel work is a window around a core that does not exist yet. The thin
UI, when it comes, should call the same library the CLI calls, so the shell stays
replaceable (Tauri now, something else if the companion-window feel fails).

### Native messaging host (not the recommendation)

`chrome.runtime.connectNative` to a signed helper would let the extension keep the
real session and still fill a file dialog by driving the OS dialog Chrome opened.
That preserves the no-debugger wedge and covers goal (1) plus file upload.

It does not cover `isTrusted`, multi-tab, or closed shadow, and the install is an
extension plus a host. Worth remembering if the open question "must desktop keep
the user's live session?" is answered yes. It is not the architecture for the
three goals as stated.

### Recommendation

1. **Browser plane:** Node + Playwright against Chrome we launched. Chrome for
   Testing when we need a pinned browser in a signed installer; system Chrome
   (`channel: "chrome"`) is correct for spikes and for Linux CI. Throwaway
   `user-data-dir` for every test. An app-owned persistent profile is a product
   decision (open question 1), not a spike default.
2. **OS plane:** a Rust helper. Linux AT-SPI first, because that is what CI can
   run. macOS AX and Windows UIA behind the same IR, not behind the same API calls.
3. **Shell:** Tauri 2, after both spikes, as a companion window. The step list is
   not embedded Chrome.
4. **IR:** one schema. Desktop adds optional fields and a handful of actions.
   The extension keeps writing version-1 workflows and does not have to execute
   desktop steps.

### What of the existing TypeScript is reusable

`src/types.ts` is pure types. It moves into a shared folder with no behavior
change and is the contract for every plane.

The ranking, anchoring, shadow-path, and resolution logic in `src/content.ts`
(`getSelectors`, `buildAnchor`, `shadowSegments`, `resolveStep`, `scrollFind`,
`waitForStep`, the native value setter) is the asset. It is browser-DOM code,
currently closed over inside one IIFE that also calls `chrome.runtime`. It runs
**inside the page**, via `Page.addScriptToEvaluateOnNewDocument` or
`page.evaluate`, not in the Node process. Reuse is "extract and inject," not
"import the content script from Node."

The service worker does not transfer. `chrome.storage` run state,
`chrome.webNavigation`, `chrome.downloads`, `captureVisibleTab`, and the side
panel are extension machinery. The desktop runner has its own loop. The *shape*
of `RunState` / `StepResult` is worth keeping so a run report looks the same.

Rough split:

| Piece | Reuse |
|---|---|
| `Step`, `Target`, `Workflow`, `StepResult`, selector scores, anchor / within | Direct. This is the IR. |
| Selector ranking, anchor, open-shadow path, scroll-find, mask-on-the-step | Direct, once extracted, injected into the owned page. |
| Content-script actuator (`el.click`, native setter) | Keep for the extension. Desktop replay of the same `click` / `input` steps goes through CDP so the event is trusted. Same step, other executor. This is the seam already drawn in [[product-design-v1]]. |
| `background.ts` state machine | Rewrite the I/O, keep the phases (`executing`, `awaiting_nav`, `awaiting_download`, `paused_for_user`, `done`, `failed`). |
| Side panel, dashboard, `chrome.*` messages | Extension only. |

Do not rewrite ranking in Rust. A closed-shadow or OS target is a different
*resolver*, called when the DOM resolver returns `degraded` or when `surface` is
`"os"`. The ranked-selector list stays the source of truth for everything the DOM
can see.

---

## 2. IR mapping

### Principle

Prefer extending the shared IR over a desktop-only schema. A workflow recorded on
the desktop should still open in the extension as a list of readable steps. The
extension's replayer is not ready for the new actions, and it does not behave
uniformly today (`src/content.ts` `replay()`):

- `navigate` and `waitForUser` are special-cased and succeed as no-ops (the service
  worker owns them).
- Any other step **without** a DOM `target` fails the run: `Needs escalation`.
  A future `osClick` or `switchTab` that carries only `os` / `tab` hits this path.
  The run stops; it does not skip the step.
- A step **with** a DOM `target` whose `action` is not one of the known branches
  falls through the `if / else if` chain and is reported `ok: true` without doing
  anything new. An `uploadFile` that also points at the file input would hit this
  and look like a successful click-that-wasn't.

So a mixed workflow opened in the extension either aborts at the first OS step or,
worse, greens a browser step it did not perform. Teaching it a single rule
("desktop steps are visible and not runnable here") belongs with the type change,
not with this pass. See §5.

Record DOM the way we already do: inject the capture core and listen in the page.
CDP is a poor recorder of clicks. The Input domain dispatches events; it does not
describe the user's. Chrome Recorder and Playwright codegen both inject a script
for DOM events and use the protocol for browser-level events. We should too. The
content script's capture (pointerdown-before-unmount, coalesced input, checkbox
end-state, submit cause, sensitive-field masking) is the part that was expensive
to get right.

CDP adds the events the page is not allowed to see, and it replaces the actuator
at replay.

### Existing steps, and where CDP shows up

`FrameRef.frameId` is a Chrome-extension id. It is meaningless under CDP. Routing
for tabs and OOPIFs moves to the new `tab` hint below. `origin` / `url` / `top`
stay.

| Existing `action` | Recorded by | CDP at record (supplement, not a second trace) | Replay on desktop |
|---|---|---|---|
| `click` | Injected capture (`pointerdown` + `click`), as today | Nothing, unless we are confirming a closed-shadow target | `Input.dispatchMouseEvent` pressed/released at `DOM.getBoxModel` center, so `isTrusted` is true. Do not also `el.click()`. |
| `input` | Coalesced `input` / `change`, as today | — | `Input.insertText` or per-key `Input.dispatchKeyEvent`. Native setter stays the extension path. |
| `select` | `change` on `<select>` | — | Setting the value in the page is enough; trust is not the failure mode. |
| `setChecked` | Recorded end-state | — | Trusted click, then read `.checked`. Fall back to setting the property only if the click did not take, same as today. |
| `keypress` | Whitelist `Enter` / `Escape` / `Tab` | — | `Input.dispatchKeyEvent` keyDown/keyUp with `key`, `code`, `windowsVirtualKeyCode`. A `submits` key still needs the submit confirmed. |
| `submit` | `submit` listener | — | `requestSubmit()` via `Runtime.evaluate`. |
| `navigate` | Page load | `Page.frameNavigated` + `Page.loadEventFired` | `Page.navigate` or a click that navigates; wait for load. Same step. |
| `softNav` | In-page URL change | `Page.navigatedWithinDocument` | Same wait as today. |
| `assert` | User-armed expectation | — | Same checks, evaluated in the page. Non-fatal, as today. |
| `waitForUser` | Authoring | — | Same pause. Still the right step for CAPTCHA and for any OS surface we do not record. |
| `download` flag on a click | `chrome.downloads` in the extension | `Page.downloadWillBegin` after `Browser.setDownloadBehavior` | Same flag. Desktop sets the download directory on the owned profile so a save dialog does not appear. A dialog the user actually has to handle is an `os*` step, not a download flag. |

Sensitive steps stay sensitive. Masking happens before the step is written.
Desktop does not get a new copy of the secret just because CDP can read the DOM.

### Browser-plane events that need new step kinds

These have no honest encoding in the current union.

| Protocol event | New step | Replay |
|---|---|---|
| `Page.fileChooserOpened` (Playwright `filechooser`) | `uploadFile` | `DOM.setFileInputFiles` or `Page.handleFileChooser` accept. Do not click the file input if the next step is `uploadFile`; clicking opens a dialog this step exists to avoid. |
| `Target.attachedToTarget` with `type: "page"`, or the user activated another target | `switchTab` | `Target.activateTarget` on the page whose index / url pattern matches. |
| `Page.javascriptDialogOpening` | `handleDialog` | `Page.handleJavaScriptDialog`. `alert` / `confirm` / `prompt` / `beforeunload` are browser UI, not OS UI. |
| `DOM.getDocument({ pierce: true })` shows a closed shadow root the injected script classified as `opaque-custom` | Keep the original `click` / `input`. Set `reach: "closed-shadow"` and add an `ax` selector. | Resolve through the Accessibility domain (`Accessibility.getPartialAXTree`), not through `element.shadowRoot` (it is null in the page). |

`Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true })`
is how one recording sees every new tab and OOPIF. `targetId` changes every run.
Do not persist it as identity. Identity is opener order plus a URL pattern, the
same idea as `softNav`'s `urlPattern`.

Closed shadow is **not** part of spike 1's pass bar. The type sketch is here so
the spike does not paint us into a second schema. `backendNodeId` is
document-lifetime only; it is a replay handle, never an IR field.

### OS-plane steps

An OS action is not a `click` with a missing target. Different resolver, different
coordinate space, different permissions, and a screenshot that can contain other
apps.

| Kind | Examples | Primary replay | Fallback |
|---|---|---|---|
| `osClick` | Activate a button in a save dialog | AXPress / UIA Invoke / AT-SPI Action | Screen bbox, recorded but not the pass path |
| `osType` | Filename field | Focus the accessible text entry, then type | — |
| `osKey` | Return to confirm, Escape to cancel | A real OS key event | — |
| `osSetValue` | Set the filename in one shot | AXValue / UIA ValuePattern / AT-SPI EditableText | `osType` if the control has no value pattern |
| `osConfirm` | The Save / Open / Allow button that dismisses the dialog | Invoke by role + name | — |

Store the accessible name and role the platform gives us (`AXButton` + `"Save"`,
UIA `Button` + `"Save"`, AT-SPI `push button` + `"Save"`). Do not normalize them
into one fake cross-platform role in v1. A workflow recorded on Linux does not
replay on macOS until someone maps the names, and pretending otherwise will fail
in a confusing place.

### TypeScript sketch

Proposed additions only. Every new field is optional. A workflow the extension
saves today has none of them. **This pass does not land these types.**

```ts
// --- add to the shared IR. Absent means "what the extension already writes". ---

export type StepSurface = "dom" | "browser" | "os";

export type StepAction =
  | "click" | "input" | "select" | "setChecked" | "keypress" | "submit"
  | "assert" | "navigate" | "softNav" | "waitForUser"
  | "uploadFile" | "switchTab" | "handleDialog"
  | "osClick" | "osType" | "osKey" | "osSetValue" | "osConfirm";

export type SelectorType =
  | "testid" | "aria" | "text" | "id" | "css" | "shadowpath"
  | "ax"; // { role, name } from the CDP accessibility tree. Closed-shadow resolver.

export type Reach =
  | "light" | "open-shadow" | "canvas" | "opaque-custom"
  | "closed-shadow" | "os";

/** Identity of a tab across replay. CDP targetId is intentionally not here. */
export interface TabHint {
  index: number;            // creation order within the recording
  openerIndex?: number;
  urlPattern?: string;      // same tolerance idea as Step.urlPattern
}

export interface FrameRef {
  url?: string;
  origin?: string;
  top?: boolean;
  frameId?: number;         // extension-only; desktop leaves it unset
  tab?: TabHint;
}

/** A file the workflow carries. Never an absolute path on the author's machine. */
export interface UploadRef {
  name: string;
  names?: string[];         // selectMultiple
  accept?: string;          // the input's accept= at record time, for the failure text
}

export interface BrowserDialog {
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  action: "accept" | "dismiss";
  promptText?: string;
}

export type OsPlatform = "macos" | "windows" | "linux";
export type OsDialogKind = "open" | "save" | "print" | "auth" | "permission" | "other";

export interface OsTarget {
  platform: OsPlatform;
  app: string;              // macOS bundle id, Windows exe, AT-SPI application name
  role: string;
  name: string;
  path: { role: string; name?: string }[]; // window → parent
  bbox?: { x: number; y: number; w: number; h: number; sw: number; sh: number };
  dialog?: OsDialogKind;
}

// New optional fields on Step. Existing fields unchanged.
interface StepDesktopFields {
  surface?: StepSurface;    // absent === "dom"
  // Set when a dom step is known to need the CDP actuator (file inputs set
  // surface "browser" instead; they have their own action).
  requires?: "trustedInput" | "fileUpload" | "closedShadow" | null;
  upload?: UploadRef;
  dialog?: BrowserDialog;
  os?: { target: OsTarget; value?: string; key?: string };
}
```

`click` stays `click` when the only change is trusted dispatch. `requires:
"trustedInput"` records that we learned the page checks, so the extension can
degrade to `waitForUser` instead of failing confused. Desktop replay may dispatch
*every* click through CDP and ignore `requires`; the flag is for the other
executor.

`Workflow.version` is already a number. Extension continues to write `1`. A
workflow that contains any `surface: "browser" | "os"` step is version `2`.
Version 2 is still the same JSON object; it is not a parallel file format.

Executor shape, matching the seam in the parent doc. One router picks by
`step.surface` (and by `requires` when the desktop runner is feeling helpful):

```ts
interface DomExecutor {
  click(step: Step): Promise<StepResult>;
  type(step: Step): Promise<StepResult>;
  select(step: Step): Promise<StepResult>;
  setChecked(step: Step): Promise<StepResult>;
  keypress(step: Step): Promise<StepResult>;
  submit(step: Step): Promise<StepResult>;
}

interface BrowserExecutor {
  dispatchClick(step: Step): Promise<StepResult>; // Input.dispatchMouseEvent
  dispatchType(step: Step): Promise<StepResult>;
  dispatchKey(step: Step): Promise<StepResult>;
  uploadFile(step: Step): Promise<StepResult>;
  switchTab(step: Step): Promise<StepResult>;
  handleDialog(step: Step): Promise<StepResult>;
  resolveClosedShadow(step: Step): Promise<StepResult>;
}

interface OsExecutor {
  osClick(step: Step): Promise<StepResult>;
  osType(step: Step): Promise<StepResult>;
  osKey(step: Step): Promise<StepResult>;
  osSetValue(step: Step): Promise<StepResult>;
  osConfirm(step: Step): Promise<StepResult>;
}
```

### What we will not put in the IR

- Absolute filesystem paths, profile directories, or CDP `targetId` / `backendNodeId`.
- Raw OS event streams. The compiler, when it exists, still wants steps.
- A screenshot as the resolver. `OsTarget.bbox` and `Target.bbox` stay fuel and
  audit, the same rule as Tier 2 in the parent doc.
- Credentials. `waitForUser` or a masked step. The owned profile does not make a
  password safe to store.

---

## 3. Code layout

### Constraints

- `build.mjs` bundles five extension entries to IIFE in `dist/`. Content scripts
  cannot import at runtime; esbuild inlines whatever they import. That is how
  sharing works without changing the manifest.
- `npm run typecheck` is `tsc --noEmit` with `include: ["src"]` and `types:
  ["chrome"]`. A desktop file that imports `playwright` or `@tauri-apps/api` must
  not be in that program, or the extension typecheck grows a second runtime.
- `npm test` builds the extension and loads **the repo root** as an unpacked
  extension (`test/e2e.mjs`). Moving `manifest.json` or `src/` breaks that. Do not
  turn the repo into a workspace that relocates the extension.
- `src/content.ts` is one IIFE. Extracting helpers is a behavior-preserving
  refactor with the fixture suite as the gate. It is not part of this pass, and it
  should land on its own, before any desktop code imports those helpers.

### Proposed tree (not created yet)

```
core/                         # pure TS. No chrome.*, no fs, no playwright.
  ir.ts                       # Step, Workflow, and the additions in §2
  selectors.ts                # ranking, anchor, shadow path, grounding
  resolve.ts                  # matchesOf, resolveStep, scrollFind
  mask.ts                     # step masking (element sniffing stays next to capture)
  actuate-dom.ts              # native setter, the extension executor
src/
  types.ts                    # export type * from "../core/ir"  (import path stays)
  content.ts                  # chrome.runtime listener; calls core inside the page
  background.ts               # unchanged responsibilities
  ...
desktop/                      # excluded from build.mjs and from the root tsconfig
  package.json                # its own deps, when a spike starts
  src/cli.ts                  # spike 1 entry
  src/browser/                # Playwright session, CDP supplement, replay router
  src/os/                     # client of the Rust helper
  src-tauri/                  # after the spikes, not before
tsconfig.json                 # include grows to ["src", "core"] at extract time
tsconfig.desktop.json         # include ["desktop", "core"], types node. Not the
                              # script `npm run typecheck` runs.
```

`desktop/package.json` is a separate package so Tauri and a pinned Playwright do
not change the extension's install. Spike 1 may instead be a single script under
`desktop/` run with the repo's existing Playwright, as long as `npm test` does not
invoke it. Prefer that until the spike needs a dependency the repo does not have.

### Rules for the extraction, when it happens

- Move code out of the IIFE without changing decisions. The fixture suite
  (`npm test`) is the comparison. No selector-score tweaks in that PR.
- `core/` may use DOM lib types. It may not reference `chrome`, `process`, or
  `window.location` except through arguments the caller passes. `frameInfo()`
  stays in the content script.
- esbuild entry points stay the five extension files. After extraction,
  `dist/content.js` is still one script, still named in `manifest.json`.
- The extension's `StepAction` union gains new members only in the same change
  that teaches the replayer what to do with them. A desktop action that still has
  a DOM `target` currently falls through `replay()` and is reported successful;
  one without a `target` aborts the run (`Needs escalation`). Neither is the
  product rule we want. See §2.

Until that extraction, desktop spike code may duplicate a tiny reader for the
JSON it produces. It should not copy `getSelectors`. If spike 1 needs ranking, that
is the signal to do the extraction first, not to paste `content.ts` into
`desktop/`.

---

## 4. Spike plan

### Standing rules

- Throwaway browser profile every run: a new temp `user-data-dir`, deleted in a
  `finally`. Never the default Chrome profile, never a directory we did not create
  in this run.
- Public sites and files we just wrote under `/tmp` (or the temp dir). No personal
  accounts, no real documents, no attaching to a Chrome someone is using.
- Pass/fail is a script a second person can re-run. A screenshot of a window is
  not a pass.

### Spike 1 — owned Chrome, CDP, one public session

**Where:** this cloud VM. Confirmed on 2026-10-18: Linux x86_64, `DISPLAY=:1`
(X11), Google Chrome at `/usr/local/bin/google-chrome`, Playwright already in
devDependencies. No Mac features required. Headless is acceptable; CDP file-chooser
interception and multiple pages work headless.

**Session, about 30 seconds, all on a public site:**

1. Launch Chrome via Playwright, `channel: "chrome"`, temp `user-data-dir`.
2. Record on `https://the-internet.herokuapp.com/`:
   - Checkboxes: toggle one box.
   - Inputs: type a fixed string.
   - Open a second tab via `/windows` ("Click Here" opens a new page).
   - Upload on `/upload` using a file this spike just wrote (for example
     `/tmp/bao-spike-<run>/hello.txt` with fixed contents). Not a file from the
     home directory.
3. Stop. Write one workflow JSON.
4. Replay from a **second** temp profile (so success is not a warm cookie jar)
   against the same URLs.

Pacing should be a real session (navigation, more than one page, on the order of
half a minute), not a tight burst of three clicks. The assertion is the DOM, not
the clock.

**Pass, all of these:**

- The JSON is a `Workflow` whose DOM steps use the existing actions and a ranked
  `target.selectors` list. Labels are the plain capture labels; no LLM.
- At least one `uploadFile` step whose `upload.name` is the fixture basename, and
  at least one `switchTab` (or an equivalent `frame.tab.index` change) for the
  second page.
- After replay, without a human: the checkbox matches the recorded end-state, the
  input's value matches, the second page's URL is the new-window URL, and the
  upload page shows the fixture filename.
- An injected listener on one replay click observes `isTrusted === true`.
- Both profile directories are gone after the process exits. The run never
  connected to port 9222 of an already-running Chrome.

**Fail, any of these:**

- A DOM assertion mismatches, or replay blocked on a person.
- The file chooser escaped to an OS dialog the spike did not record (interception
  missed).
- Steps from the second tab were stored as if they happened on the first.
- The run used a non-empty `user-data-dir` or the default profile.

**Explicitly not required for this pass:** closed shadow, a login, Tauri, a
window of our own, the Rust helper. Those are how spike 1 gets mistaken for a
product.

### Spike 2 — one native dialog, accessibility plus a screenshot

**Product target:** a native save dialog. macOS `NSSavePanel` via AX, Windows
common item dialog via UIA. CDP must not be the thing that dismisses it. If
`Browser.setDownloadBehavior` or `Page.handleFileChooser` can do the job, that
job is spike 1.

**Linux stand-in, which is the only one this VM can ever run:** a real GTK save
dialog (zenity `--file-selection --save`, or a tiny GTK program we compile in the
spike), driven through AT-SPI. Record role + name + ancestor path into `osSetValue`
(the filename entry) and `osConfirm` (the Save button). Take one screenshot of the
dialog before confirm. Replay launches the dialog again and sets the same
filename.

The VM today has the AT-SPI2 D-Bus libraries (`at-spi2-core`) and X11, plus
`xdotool`. It does **not** have GTK, zenity, the PyGObject `Atspi` typelib, or a
screenshot tool (`import` / `scrot`). Spike 2 starts by installing that fixture
stack. `xdotool` is a useful negative test: a pass that only works as coordinate
clicks is a fail.

**Pass (Linux):**

- Dialog closes because an AT-SPI action ran, and the chosen filename equals the
  one in the IR.
- The IR contains `osSetValue` and `osConfirm` with `os.target.platform: "linux"`,
  a role, a name, and a path.
- A screenshot file from before confirm exists and is a non-trivial image.
- Primary strategy is the accessible action. Bbox may be stored. The run fails if
  the accessible lookup missed and coordinates were what actually hit the button.
- The file goes to the temp dir.

**Fail (Linux):** coordinate-only hit, missing screenshot, the dialog was Chrome's
own picker (spike 1's problem), or the spike touched files outside the temp dir.

**Mac bar, not runnable here and not implied by a Linux pass.** A signed helper
with Accessibility permission already granted. Open a fixture app's `NSSavePanel`
(TextEdit is acceptable only with a throwaway document in `/tmp`, never an
existing user file). Set the name via `AXValue`, confirm via `AXPress` on the Save
button. Screenshot via ScreenCaptureKit. Same pass shape. Role strings, Retina
coordinate space, and TCC make this a separate demo. A green AT-SPI run does not
count as a Mac result.

Windows UIA is the same shape again (`ValuePattern` + `InvokePattern`) and needs
a Windows runner. Not this VM.

### Order

Spike 1 first, on this VM, no Rust and no Tauri. Spike 2's Linux half next, still
with no Tauri. A Mac is a third demo, scheduled when a signed binary and a human
TCC grant exist. The shell PR is after those, and it should be a thin window over
the CLI's library.

---

## 5. Open questions and risks

### What we give up from "no debugger permission"

The extension's advantage was never "we don't know what CDP is." It is five
concrete things ([[product-design-v1]] execution-mode section):

1. No `debugger` permission in the Chrome Web Store review (the thing that has
   stuck comparable products in manual install).
2. No non-suppressible "started debugging this browser" infobar.
3. Replay runs in the user's real profile: cookies, SSO, extensions, password
   manager.
4. Enterprise policies that disable the debugger API do not disable the extension.
5. The trust story is "this extension does not hold a CDP pipe to your whole
   browser."

An owned-Chrome desktop app **keeps 1, 2, and 4**, because it never asks Chrome
for that permission and never attaches to a browser it did not start. It **spends
3**. Logins happen inside Bao's profile, a second time, unless we later make an
explicit import. It **replaces 5** with "this window is Bao's browser," which is
easier to explain than an extension with `<all_urls>` and also a bigger, more
malware-shaped install until it is signed, notarized, and SmartScreen-warm.

Anti-bot does not flip to our side. Playwright's Chrome still exposes
`navigator.webdriver` unless we start an arms race (`--disable-blink-features=AutomationControlled`
and friends). Sites that only check `isTrusted` start working. Sites that look
for an automation-controlled browser keep blocking, and an owned Chrome is *more*
detectable than the extension running in a normal profile. Desktop fixes the
extension's synthetic-event blind spot and gives up the extension's "this is a
real user profile" camouflage. Say that in any QA pitch.

The failure mode to refuse: pointing the desktop app at the user's already-running
Chrome "so they don't have to log in again." That gives away 2, 3's safety, and 5
in one flag, and it locks the profile if Chrome is open. If keeping the live
session is a requirement, the answer is the native-messaging complement in §1,
not remote debugging.

### Questions that block a build

1. **Whose session does desktop replay run in?** Throwaway profiles prove the
   engine and cannot serve "log in, download the morning report." An app-owned
   persistent profile can, at the cost of a second login and a directory we are
   now responsible for encrypting and excluding from workflow export. Attaching
   to the user's Chrome is the option this doc rejects by default. This choice
   decides whether desktop is a product or a power-user tool.
2. **What does the extension do with a version-2 workflow?** Shared IR means a
   mixed recording (DOM steps + one save dialog) will show up in the side panel.
   Today that run either aborts at the first target-less OS step (`Needs
   escalation`) or reports success for a new action that still carries a DOM
   target, without performing it (`uploadFile` is the dangerous case). We need a
   product rule: render those steps as "runs in the desktop app" and refuse to
   start the run, or split the workflow. That rule is a small extension change
   and should land with the types, not after users have files.
3. **Is the macOS permission prompt acceptable for the audience?** Accessibility
   plus Screen Recording are TCC dialogs we cannot pre-grant, they do not stick
   on an ad-hoc signature, and they scare the same non-technical user the infobar
   would have scared. If desktop is only the QA/IT wedge, the prompt is fine. If
   it is the gov-forms wedge, it may be a worse trust story than the extension.
   Linux CI cannot answer this.

### Other risks

- **OS screenshots see other apps.** `captureVisibleTab` is one tab. A screen grab
  during a save dialog can include a chat window behind it. Golden frames for
  `os*` steps need a crop to the dialog bounds, and a default of not uploading
  them anywhere. This is a stricter case of the local-only screenshot rule.
- **Accessible names are localized and unstable.** "Save" vs "Guardar", or a GTK
  dialog whose name includes the filename. Replay fails cleanly ("couldn't find
  the Save button"), same thesis as a missing selector, but the authoring UX has
  to show the role and name we stored or the user cannot fix it.
- **Wayland.** This VM is X11. AT-SPI mostly works on Wayland; screenshots and
  global key injection do not, without a portal. Do not let an X11 spike 2 define
  the Linux packaging story.
- **Focus and modality.** An OS replay that clicks the wrong window because the
  dialog was not focused is a destructive bug (confirming a dialog the user
  opened). The replayer should refuse to act unless the front window's app and
  role match `OsTarget`.
- **Three runtimes stall the work.** If the Node sidecar feels like a permanent
  tax, the temptation will be to rewrite the planner in Rust (`chromiumoxide`)
  and fork the IR logic. Resist that until the extracted `core/` is the boring
  middle. The sidecar is the thing that keeps one selector implementation.
- **Extraction risk.** `content.ts` is load-bearing and un-split. A casual move
  into `core/` can change capture timing. The extraction PR should be allowed to
  do nothing else, and `npm test` is the bar.
- **Bundle and signing cost shows up before product feel does.** An unsigned dmg
  is a worse install than "load unpacked." Schedule signing with the shell, not
  as a launch polish item after people have the binary.
- **Determinism.** OS fallback-to-pixels is Tier 3 in disguise. Keep bbox as
  audit unless a later decision explicitly promotes it.

### What this pass decided, and what it left on the table

Decided: second modality, owned Chrome, Playwright as the CDP client, shared IR
with the additions in §2, `core/` extracted in place rather than an npm workspace
move, Tauri only after the spikes, extension behavior untouched.

Not decided: persistent profile vs throwaway-only, how version-2 workflows render
in the side panel, whether the non-technical wedge is ever asked to approve TCC,
and which public-site flows are worth a desktop recording once login is in the
app's own profile.
