# Bao

## Agent quickstart

This branch has four deliverables.

1. **Bao.app and the desktop service.** Source is `desktop/`. `npm run bao` serves the app after `npm run build:desktop`.
2. **Native-messaging extension.** Source is `extension/`. It drives the Chrome already installed on the machine.
3. **Legacy root extension.** Source is `src/`, built to `dist/`.
4. **Optional registry.** Source is `web/`.

Run the commands from the repo root. Node is the major version in `.nvmrc` and `mise.toml`. `nvm use` can print that version while an older `node` stays first on PATH. Prepend the bin directory from `nvm which node`.

```sh
export PATH="$(dirname "$(nvm which node)"):$PATH"
node scripts/check-node.mjs
```

`node scripts/check-node.mjs` exits 1 when the running Node is older than `.nvmrc`. MCP setup, the extension load, and `cdp-live` are in [docs/agent-quickstart.md](docs/agent-quickstart.md).

| Step | Command |
| --- | --- |
| Prerequisites | `node scripts/check-node.mjs`, then `npm install` and `npm --prefix web install`, then `npx playwright install chromium` before `npm test`. |
| Desktop dev | `npm run build:desktop`, then `npm run bao`. |
| Page engine | Settings → Page engine. Profile selection, trial limits, and evidence are in [agent-browser trial](docs/agent-browser-engine.md). |
| Legacy extension dev | `npm run watch` |
| Registry dev | `npm --prefix web run dev` |
| Typecheck | `npm run typecheck` checks `src`, `desktop`, `extension`, and `web`. |
| Unit tests | `npm run test:desktop:unit` for desktop. `npm test` for the root extension. `npm --prefix web test` for the registry. |
| Aggregate | `npm run check` runs the typecheck and the desktop unit suite. |
| Local browser integration | `npm run test:desktop:integration` runs the local fixture capture in `browser.test` and `drift.test`. |
| Mac acceptance | On a Mac, follow [docs/mac-test.md](docs/mac-test.md). `npm run package:mac` writes `Bao.app`. |
| Install the desktop extension | `./install-extension.sh` |
| Install the legacy extension | `./install-dev-legacy.sh` |
| MCP | Agents run `/Applications/Bao.app/Contents/MacOS/bao-mcp`. After `npm run build:desktop`, `node desktop/dist/desktop/src/app/cli.js agent config claude --write` (or `codex`) adds it to that agent and pre-approves Bao's tools there, so the agent runs them without asking. [docs/agent-quickstart.md](docs/agent-quickstart.md#mcp) has the entries and the checkout form. |

`./install-dev.sh` prints the two installer names and exits 2.

`npm run bao` runs the compiled CLI. It does not compile. Run `npm run build:desktop` again after desktop TypeScript changes. `npm run test:v1` still runs the desktop unit suite.

The sections below describe the legacy root extension. Its test layout is [TESTING.md](docs/TESTING.md).

## Root extension

**Record a browser workflow once, get human-readable steps, replay it deterministically
whenever you want.** A Chrome MV3 extension for non-technical users with a repetitive
browser task ("log in, open the report, download the CSV").

Unlike browser-use / Skyvern, **the LLM is not the runtime.** The durable artifact is a
readable, editable **workflow (IR)**. An LLM is a *compiler* (raw trace → clean steps)
that runs once at authoring time. Replay is plain deterministic code: free, instant,
offline, and it fails *cleanly* (a clear "the page changed, re-record" report) instead of
guessing.

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
> from source instead? See the **[Agent quickstart](#agent-quickstart)**.

---

## Status at a glance

The root extension covers capture →
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
8. **`docs/desktop-design.md`**. Architecture pass for the desktop service. The command map is the [Agent quickstart](#agent-quickstart). Spike notes stay in the log below.
9. **`docs/proxy-design.md`** — design for the desktop app as the harness computer-use
   agents drive. The first spike (`npm run spike-proxy`) is a scripted OpenAI
   computer-call adapter over a vendor-neutral executor.

Docs cross-link with `[[wikilinks]]` by basename.

---

## Spike log

Short notes for explorations that are not on the launch path. The status table above
is still the source of truth for the extension.

- **2026-10-18 — Desktop architecture pass.** Recommendation in
  [`docs/desktop-design.md`](docs/desktop-design.md): a second modality, not a rewrite.
  Node + Playwright drives an owned Chrome over CDP (file upload, trusted input,
  multi-tab); OS hooks (AT-SPI / AX / UIA) live in Rust; Tauri 2 is the window only
  after two spikes pass. The shared IR is extended, not forked. No app code, extension
  behavior unchanged.
- **2026-10-18 — Desktop spike 1 (pass).** `npm run spike1` launches an owned Chrome
  with a fresh temp profile (the app-owned persistent path is
  `desktop/src/profile.ts`; demos do not use it), records the-internet.herokuapp.com
  (checkbox, input, second tab, intercepted file upload), writes a version-2
  workflow, and replays it from a second temp profile. DOM matches, `isTrusted`
  is true, both profiles are deleted. Selector ranking in the spike is a small
  page-side list, not an extraction of `src/content.ts`. Extension behavior is
  unchanged.
- **2026-10-18 — pstack vendored.** Cursor agents in this repo get poteto's
  public skill pack under `.cursor/skills/` (architect, arena, how, interrogate,
  four principle leaves, poteto-mode, technical-writing, unslop) plus
  `.cursor/agents/poteto-agent.md`. Upstream commit
  `75fabace38ce507ee044546eaca64167c8c1e21b`, MIT, attribution in
  [`.cursor/third-party/pstack/VENDORED.md`](.cursor/third-party/pstack/VENDORED.md).
  Sibling skills that poteto-mode names but this tree does not include are
  listed there. `.cursor/rules/pstack.mdc` says to use architect before a big
  shape decision, arena when one attempt would lock in the wrong design, and
  principle-prove-it-works before calling a spike done.
- **2026-10-18 — Desktop spike 2 (pass).** `npm run spike2` opens zenity 4's
  save dialog in a throwaway Xvfb + dbus + AT-SPI session, enumerates the tree,
  writes a version-2 workflow (`osSetValue` on the Name text box,
  `osConfirm` on OK), and replays it from a second helper process. Both runs
  print `$WORKDIR/bao-spike2-note.txt` and the dialog exits because
  `Action.doAction("click")` ran. Extents are stored and not used as a click.
  GTK 4's `GetRoleName` is `text box` / `button`, not the libatspi enum strings.
  `Text.getText` stays empty. Details in
  [`desktop/os-helper/NOTES.md`](desktop/os-helper/NOTES.md).
- **2026-10-18 — Proxy design.** [`docs/proxy-design.md`](docs/proxy-design.md)
  compares two integration shapes. The base is a screenshot/action shim that
  speaks the published OpenAI computer tool and Claude computer toolset, and
  stores a semantic workflow. A semantic MCP door is the later path for
  function-calling models. Grok Bot publishes no action schema to shim.
  Recommended first spike: a scripted OpenAI `computer_call` (screenshot, then
  one click) against a throwaway Chrome, resolved to a selector at capture,
  replayed without coordinates and without a model.
- **2026-10-18 — Proxy spike, OpenAI computer tool (pass).** `npm run spike-proxy`
  drives a throwaway Chrome on the-internet's checkboxes page with scripted
  `computer_call`s (screenshot, one measured click, one blank click, one
  `type` of the T1 test card). The OpenAI adapter only translates that schema.
  The executor hit-tests and appends an audit event; the version-2 workflow is
  derived from the trail, not written beside it. `trimTrail` drops duplicate
  screenshot reads (6 → 2) and the same three steps fall out again. The
  checkbox step's selector is `#checkboxes > input:nth-of-type(1)`; the pixel
  stays on `provenance`. Replay shifts the page 220px and clicks the live
  element (y 195 → 415). A blank click is an unresolved act with no target.
  The typed card is withheld by `src/mask.ts` (the extension's T1 rule) and
  is absent from the trail. Capture writes a HAR linked to the open audit
  event, with cookies and auth headers removed. No call to the OpenAI API.
  Claude, on that branch, is a type sketch in `desktop/src/proxy/claude.ts`.
- **2026-10-19 — Proxy focus (pass).** `npm run spike-proxy-focus` logs into
  the-internet (`tomsmith`) with scripted `computer_call`s. The executor tracks
  `document.activeElement` and the CDP partial AX tree of that node after each
  action (role `textbox`). Type, Tab, and Enter become selector steps
  (`#username`, `#password`). Escape with nothing focused is a page-level key.
  A letter with nothing focused stays unresolved. The public test password is
  withheld (`sensitive`, no value) from the workflow, trail, and transcript.
  Replay shifts the page 220px (y 350 → 570) and the flash reads
  "You logged into a secure area!" from the DOM. No call to the OpenAI API.
- **2026-10-19 — Proxy Claude adapter (pass).** `npm run spike-proxy-claude`
  runs that same login through `computer_toolset_20260801` and through the
  OpenAI computer tool. Screenshots returned to Claude are half the viewport
  (640×360 of 1280×720). The click coordinate is that image pixel (y 175);
  the adapter scales it back to the field (y 350) before the executor acts.
  `key` text `Return` becomes `Enter`. The two workflows are the same 7 steps
  apart from provenance (`image` vs `viewport`). Both replays shift the page
  and land on the secure-area flash without clicking the stored coordinate.
  All 17 members map onto the neutral core. No call to Anthropic or OpenAI.
- **2026-10-19 — Proxy native AT-SPI (pass).** `npm run spike-proxy-native`
  clicks a GTK 3 calculator (`desktop/os-helper/baocalc.py`), not a browser.
  The helper resolves each pixel to the smallest accessible whose screen
  extents contain it, and records an `osClick` (app `baocalc.py`, role
  `push button`, name `7` / `+` / `5` / `=`). The coordinate is provenance
  (Claude image y 42, OpenAI screen y 84). Replay launches a new window at
  a different position and size and calls `Action.doAction` with role and
  name only. The label reads `12` from AT-SPI, and the live button is at
  y 187. A drawing area and an empty desktop point are unresolved and keep
  a screenshot crop. GTK 4 `gnome-calculator` is the poor-accessibility
  case: its buttons are named, but every extent is origin `(0, 0)`, so the
  helper does not store a button. An image template match of the crop is
  the documented last resort, not implemented. No call to Anthropic or OpenAI.
- **2026-10-19 — macOS Accessibility spike (blocked on privacy permission).**
  `npm run spike-macos` adds `desktop/os-helper-macos` (`bao-os-macos`) and a
  macOS executor. A scripted OpenAI `computer_call` click and a scripted Claude
  `left_click` are meant to resolve to an AX element (bundle, role, name, path).
  Replay calls `AXPress` or `AXValue` by that identity. The coordinate stays on
  `provenance`. On macOS 26.6.2 (25G83) Screen Recording for the existing ad-hoc binary later
  reported true, with no rebuild and no second prompt. The Calculator window
  was visible to CoreGraphics, but the AX walk contained only nested
  `AXApplication` and `AXMenuBar` nodes, and point hit-testing returned no
  element. The run stopped at `no AX button for 7`. TextEdit was not opened.
  Details are in [`desktop/os-helper-macos/NOTES.md`](desktop/os-helper-macos/NOTES.md).
- **2026-10-20 — BaoOSHelper.app prompted once.** The walker follows
  `AXWindows` before children and stops an `AXApplication` loop. `package-app.sh`
  ad-hoc signs `desktop/os-helper-macos/BaoOSHelper.app` as `dev.bao.oshelper`
  (no keychain identity existed). One LaunchServices launch asked for
  Accessibility and Screen Recording. Both checks were still false. System
  Settings was open on the Accessibility pane. The Calculator button check waits
  until that bundle is granted. Do not rebuild the app before then.
- **2026-10-20 — grant on, replay still blocked.** Both privacy checks are true
  for the existing `BaoOSHelper.app`. A point inside Calculator resolves to
  `AXButton` `7`, `Add`, `5`, and `Equals`. The tree walk does not include those
  buttons, so `press` misses and will not fall back to a coordinate. The
  OpenAI and Claude loops were not run. TextEdit was not opened. Fixing the
  walk means a Rust rebuild, which was not done.
- **2026-10-20 - BaoOSHelper signed with bao dev signing.** One login-keychain
  certificate, SHA-1 `A5:22:E1:5D:43:1A:2F:36:AC:E4:51:DD:57:5A:02:E9:E8:77:FB:D1`,
  signs `dev.bao.oshelper`. The designated requirement is the bundle id plus
  that certificate, so a later rebuild with the same cert keeps the grant.
  The walker also follows navigation-order, contents, and visible children,
  and the depth cap is 30. One prompt after this rebuild reported Accessibility
  and Screen Recording true. The demo was not run.
- **2026-10-20 - macOS Calculator replay passed.** Rebuilds signed with
  `bao dev signing` kept the same designated requirement. Accessibility and
  Screen Recording stayed true, and nothing prompted again. The walker samples
  the window with `AXUIElementCopyElementAtPosition` because Calculator's keypad
  is not in `AXChildren`. Scripted OpenAI and Claude loops each pressed
  `AXButton` `7`, `Add`, `5`, and `Equals`. Replay after a relaunch and an
  `AXPosition` move read `12` from the display. `AXSize` is rejected (`-25200`),
  so the window moved and did not resize. One click outside the window stayed
  unresolved. TextEdit opens an Open panel on launch; `New Document` creates
  the untitled window, and `bao mac spike` was set and replayed by `AXValue`.
  Window-cropped pngs and the two replay mp4s are under the agent artifact
  store `bao-mac-spike/`.
- **2026-10-20 - live Codex runs through bao.** A stdio MCP server exposes
  `screenshot`, `click`, `type`, `key`, and `read_tree` for Calculator and
  TextEdit only. Clicks are pixels in the window image and are mapped onto the
  window before the accessibility lookup. Claude Code at
  `/opt/homebrew/bin/claude` reported `loggedIn: false` (`authMethod: none`),
  so that vendor was skipped and no browser login was opened. The Homebrew
  Codex 0.151.0 rejected `gpt-6-astra`. The ChatGPT.app CLI 0.162.0-alpha.17.2
  was logged in and ran both tasks with `approval_policy` `never`, sandbox
  `read-only`, and `mcp_servers.bao.default_tools_approval_mode` `approve`.
  `~/.codex/config.toml` was not edited. Codex Calculator clicked through to
  display `12`. Interpret kept `{{a}}`, `Add`, `{{b}}`, `Equals`. Replay of
  `3+4` and `8+1` read `7` and `9` with no coordinate flags. The window moved.
  `AXSize` still returns `-25200`. Codex TextEdit set `hello from bao`.
  Interpret kept one `osSetValue` of `{{text}}`. Replay wrote `alpha one` and
  `beta two`. TextEdit's width changed. Its origin did not.
- **2026-10-20 - macOS 26 accessibility fixtures.** Raw trees for Calculator,
  TextEdit, a Finder window on a `/tmp` folder, a Safari private window on
  `the-internet.herokuapp.com`, and a throwaway Electron app are in
  `fixtures/ax/macos-26/`. Calculator keys are in the tree: description is the
  visible label, identifier is the stable token. TextEdit's text area
  identifier is `First Text View`. Safari navigated by `AXValue` plus
  `AXConfirm` on the private address field. AX keyboard posting is accepted
  and ignored. CGEvent posting opens TextEdit's Open panel when that app is
  frontmost, and a CGEvent drag moves the pointer without starting a file drag.
  Electron exposes `bao-button` only after `accessibilitySupportEnabled` is
  set once the app is ready.
- **2026-10-20 - v1 desktop mac build.** `origin/v1/desktop` at `4153139`
  produced `Bao.app` and `Bao.dmg`, signed with `bao dev signing`. The app
  identifier is `dev.bao.desktop`. The nested helper stays `dev.bao.oshelper`
  with the same certificate leaf. `codesign --verify --deep --strict` passed.
  A no-prompt permissions check on that helper copy stayed true for
  Accessibility and Screen Recording. Copies are in the agent store under
  `bao-mac-spike/v1/` and are not in git. `Bao.app` was not launched.
  `docs/mac-test.md` is a clean-account pass and was not run. The live drift
  test failed in 914ms because `desktop/src/launch.ts` confirms the owned
  Chrome process by reading `/proc`, which macOS does not have. No drift
  variant ran. The throwaway Chrome profile was deleted.
- **2026-10-21 — Desktop v1 (in progress on `v1/desktop`).** One local app
  (`npm run bao -- serve`) records a browser session into workflow schema v2
  and replays it without a model. Identity scoring refuses a tie or a weak
  match (`docs/element-identity.md`). Secrets and file paths are inputs.
  Healing is off unless a model key is set; the default policy is then auto,
  with a per-workflow switch to approve. Linux evidence: fixture login plus
  file upload and drop, replayed twice; a broken test id stops with a
  snapshot; the GTK calculator replays `{{a}}+{{b}}` after a move; drift is
  24/24 (`docs/drift-linux.md`); a scripted MCP client writes a click into
  the trail. macOS build steps are `docs/mac-build.md`. The pass is `docs/mac-test.md`.
- **2026-10-21 — macOS 26 fixtures scored, owned browser check fixed.**
  `fixtures/ax/macos-26/` is the alex-jxp dump set. The scorer treats Calculator
  descriptions as the visible labels, strips a leading LRM on the display,
  and treats `Untitled` and `Untitled.rtf` as one window. Calculator resize
  stays n/a (`AXSize` `-25200`). `launch.ts` reads the launcher pid and
  `ps -o command=` on macOS, and matches `--user-data-dir` rather than the
  `Google Chrome.app` binary path. A failed check closes the context.
  `Bao.app`'s entry is `bao-main.c` plus Playwright's Chromium, not a bash
  script and not the user's Chrome. `bao mcp` on macOS is `mcp-bao.ts`.
  `drag-file` reports that a pointer drag is not a file drag and falls back
  to the Open panel.
- **2026-10-21 — Linux evidence for the browser path, drift, and a live MCP run.**
  The product window's replay form takes a typed value, a masked secret, and
  a dropped file, then runs twice. A broken test id auto-heals (fixture
  healer, audit event, OS notification) and the approve setting pauses.
  Drift (`docs/drift-linux.md`) is 24/24, with a pass rate per change and
  per step; the failures table is empty. A cursor-driven MCP session labeled
  `live-model` logged into the-internet and uploaded a file; interpret
  dropped the screenshots and the unresolved file click; replay had no model.
  The GTK calculator capture of 7+5 replayed 7+7 and 5+7 on a moved window.
- **2026-10-21 — Expect, cheap repair, and provisional heal.** A step can
  declare `expect` (text, state, or URL). A trailing `verify` step re-reads
  it. A miss names the phase: locate, act, or expect. The local credit-freeze
  fixture (`/freeze`) has Frozen and Open radios and Apply. The saved workflow
  checks the radio and verifies `Status: Frozen`. Before any model call,
  replay tries label similarity, an anchor, closing a known overlay, and a
  wait, and logs which one ran. A model heal stays provisional until the
  drift suite and the next two replays pass, and reverts if either fails.
  Those states are promotion events on the trail. Drift stayed 24/24
  (`docs/drift-linux.md`). A Cursor-billed heal, not a vendor API call,
  patched the renamed Apply button from the failure screenshot and was
  promoted. `BAO_HEAL_FIXTURE` is still the canned stand-in and was not used
  for that run.
- **2026-10-21 — Desktop window: sidebar, act bar, run viewer, heal review.**
  First UI pass. The five top tabs are a left rail (Library, Capture, Runs,
  Heals, Settings) with recording, helper, model, and a count of items waiting
  on the person. Trail is a tab on Capture and on a run. A confirm step shows
  an act bar that names the site button and the window and counts down; Bao
  does not press that button. On the fixture page, pressing Apply satisfies
  the postcondition and the run passes with `0 model calls`. A drifted Upload
  button stops as `click Upload` with scores 80 and 70 (lead 10) and the name
  change `Upload` → `Upload file`. Keep and Revert append decisions and leave
  the heal JSON unchanged. Import failures render `code`, `cause`, and `hint`
  (`ImportLoginError` in `desktop/src/v1/import-login-error.ts`); the import
  backend is unchanged. Linux: desktop unit tests 61 pass, and the live
  browser capture, replay, heal, and replay drop zone passed. One MCP
  `tools/list` wait of 300ms missed once under load and passed on the next run.
- **2026-10-22 — Desktop window, second pass.** Merged onto
  `cursor/logged-out-masked-login-28c2` so the window covers expect, cheap
  repairs, provisional heals, read-back receipts, trajectory diffs, auth
  stops, masked secrets, and the Chrome import card. Two static directions
  were shot first (native macOS light, and a dense dark list). The native
  light layout won: bao is a workflow a person runs, and the calm spec fits
  a system sidebar better than a debugger skin. Dark mode is the same layout
  with inverted tokens. Borrowed the step cards from Shortcuts, the command
  list and status color from Raycast and Linear, the filmstrip scrubber from
  the Playwright trace viewer and rrweb-player, the pass grid and plain
  failure line from Momentic and Skyvern, and the floating record bar from
  Screen Studio and Loom. The step list stayed a list; a node canvas was the
  worse fit for short human steps. A heal row is named from that heal's
  workflow id, so a login heal no longer picks up a sibling named
  `textedit write`. OpenAdapt and Simular did not have public app screens
  worth copying. A follow-up replaced empty thumbnails with per-step PNGs
  from capture and replay, gave the workflow its own page, and drew one
  sparkline cell per recent run. A missing picture is an icon and the target
  text. Red is reserved for a failed step. A later polish shows every saved
  step on the workflow page, turns the heal notice into a dismissible toast,
  and crops each thumbnail around the target instead of shrinking the page.
  Step rows stay about one line tall, and a healed step keeps a crop of the
  control it actually used.

---

## Legacy extension load

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

## Host the sync registry on Vercel

The registry is the Next.js app in `web/`. Its project settings are [`web/vercel.json`](web/vercel.json). Import and deploy it yourself. This repository does not create the Vercel project, the database, or the blob store.

1. Open [vercel.com/new](https://vercel.com/new) and import this git repository.
2. Framework preset: Next.js. Root Directory: `web`.
3. Generate an invite secret with `openssl rand -hex 32`. Do not commit it. Set `BAO_OWNER_EMAIL` to the one email that may sign in, and `BAO_INVITE_SECRET` to that secret (Sensitive). Do not set `BAO_AUTH_STUB`. Production refuses to start if it is set.
4. Deploy. Leave Standard Protection on. Copy the production domain, not a preview URL and not the generated deployment URL. All Deployments would block the Mac, which sends only its device token.
5. In the project, Storage → Create → Blob. Choose Private and connect it to the project. That sets `BLOB_STORE_ID` for the redacted PNGs. Do not create a public store.
6. Marketplace → Neon → the free plan. Read the plan, then accept. Neon injects `DATABASE_URL`. Do not install Vercel Postgres or KV. Those products are sunset.
7. Redeploy so the functions see `DATABASE_URL`, `BLOB_STORE_ID`, and the owner variables.
8. Sign in on the site with the owner email and the invite secret. In Settings → Sync, paste the production domain, the Devices pairing code, and the invite secret once. Pair, then Sync.

Variable names, with empty values, are in [`web/.env.example`](web/.env.example). The same click-through, with the click names, is [web/README.md](web/README.md).

Locally, from `web/`, `npx vercel dev --local` leaves `DATABASE_URL` and `BLOB_STORE_ID` unset. The app then uses PGlite under `BAO_PG_DIR` (or `web/.data/pglite`) and files under `BAO_BLOB_DIR` (or `web/.data/blobs`). Pair, push, and pull against that server the same way as a hosted registry.

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
