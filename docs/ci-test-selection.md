# PR test selection

## Legacy extension retirement

The old standalone root extension is retired. Its source, root manifest, side-panel/dashboard pages, build/watch/package commands, installer, and all legacy fixture/live tools are removed. CI no longer runs the **Legacy extension tests** step or the `legacy` essential group. The desktop extension in `extension/`, its installer, and its tests remain. Shared masking and workflow types live in `shared/mask.ts` and `shared/types.ts`.

The last measured full run is [41996082031](https://github.com/aaalexliu/bao-browser/actions/runs/41996082031). Its legacy step took about 104 s; suite boundaries total 102.40 s. Times include each suite's process startup and browser work through the next suite boundary. These are historical Linux times, not fresh measurements or predicted wall savings.

| Deleted test file | Last measured time | Retired behavior |
| --- | ---: | --- |
| `test/e2e.mjs` | 2.66 s | Root content-script record/replay on a local fixture |
| `test/list.mjs` | 5.77 s | Anchored replay after repeated cards reorder |
| `test/blindspots.mjs` | 2.63 s | Shadow, canvas, and select reachability |
| `test/virtual.mjs` | 3.42 s | Scroll-find replay across recycled DOM nodes |
| `test/frames.mjs` | 2.86 s | Cross-origin frame recording and replay |
| `test/forceopen.mjs` | 1.64 s | Opt-in closed-shadow force-open injection |
| `test/editable.mjs` | 3.32 s | Contenteditable recording and replay |
| `test/spa.mjs` | 3.18 s | Soft-navigation capture and replay |
| `test/nav.mjs` | 5.76 s | Full-navigation resume and user handoff |
| `test/check.mjs` | 3.98 s | Checkbox/radio end-state replay |
| `test/keyboard.mjs` | 3.11 s | Keypress and Enter-submit replay |
| `test/pointerdown.mjs` | 1.16 s | Capture before pointerdown removes a target |
| `test/assert.mjs` | 15.04 s | Recorded assertions and runner exit codes |
| `test/download.mjs` | 3.25 s | Download correlation and completion |
| `test/grounding.mjs` | 1.09 s | Captured element bounds, text, and role |
| `test/golden.mjs` | 4.00 s | Golden screenshot capture and storage |
| `test/snapshot.mjs` | 1.17 s | Bounded DOM snapshots without input values |
| `test/sensitive.mjs` | 2.09 s | Root extension secret masking and empty secret replay |
| `test/workflows.mjs` | 8.24 s | Named workflows, editing, and run history |
| `test/sidepanel.mjs` | 23.80 s | Root side-panel recording, library, import/export, and undo |
| `test/dashboard.mjs` | 4.20 s | Root dashboard editing and audit filmstrip |

The removed public-site tests below did not run in that full check. Their measured times are unavailable; no time saving is claimed.

| Deleted test file | Last measured time | Retired behavior |
| --- | --- | --- |
| `test/live-blindspots-open-shadow.mjs` | Not measured | Root extension open-shadow capture on Shoelace |
| `test/live-blindspots-canvas.mjs` | Not measured | Root extension canvas classification on Excalidraw |
| `test/live-blindspots-frames.mjs` | Not measured | Root extension cross-origin frames on Stripe |
| `test/live-blindspots-virtual.mjs` | Not measured | Root extension windowed-grid detection on AG Grid |
| `test/live-blindspots-closed-shadow.mjs` | Not measured | Root extension closed-shadow boundary on Salesforce |
| `test/live-gaps-forms.mjs` | Not measured | Root extension text/select record and replay |
| `test/live-gaps-spa.mjs` | Not measured | Root extension TodoMVC route replay |
| `test/live-gaps-editors.mjs` | Not measured | Root extension rich-text replay and strict-editor refusal |
| `test/live-gaps-feed.mjs` | Not measured | Root extension repeated-feed anchoring |
| `test/live-notes.mjs` | Not measured | Root extension Substack note identity replay |

Removed support tools are `test/all.mjs`, `test/run.mjs`, `test/live.mjs`, `test/live-helpers.mjs`, and `test/probe-sites.mjs`, plus legacy HTML fixtures. They have no independent measured suite times. Installer-specific cases were removed from mixed `install-scripts.test.ts`; its current installer and stager safety cases remain. That file's last full body time was 2.181 s for the whole file, not the cost of the deleted cases.

## Current rule

[`test/essential.json`](../test/essential.json) controls the essential set and encoder requirements. Its self-test rejects missing files, stale test names, and overlapping selections. The PR workflow repeats group IDs only; its self-test requires them to match the manifest.

Keep tests for active behavior, not removed features. The older live-driver tools, their mode policy, their workflow replay driver, and their private Instacart eval have been retired. Their tests leave both source and manifest. The pass-through still needs sign-in and bot-wall handoffs, redirect handling, profile isolation, recording, Runs, and Library coverage. Bao does not block final clicks; no final-click guard is rebuilt.

`desktop/test/unit/experian-proxy.test.ts` exercises a loopback Experian-shaped site through the real stdio MCP and pinned native pass-through. The required `experian` CI group stages and checksum-checks its native executable. Local runs supply `AGENT_BROWSER_PROXY_BINARY`; without it the case skips, and no test downloads a binary. `mcp.test.ts` checks the emitted tool list and rejects retired tool calls. Shared transport, permission, poster, and run-viewer tests remain, including the surviving cases in `cdp-live.test.ts` and `live-library.test.ts`.

The full check remains opt-in through `full-suite` or manual dispatch. State the choice and reason in every PR body. This retirement needs **full-suite**: it removes a driver and its tests across MCP, app routes, replay, settings, and persisted workflows. Focused local checks do not replace that remote integration check. No CI sharding or cache policy changes belong to this removal.

## Replacement fixture timing

After integrating owner-wait from main `7a4f1c6`, the native Experian case passed in **5.515 s** (5.813 s including the test runner) on local macOS arm64. It used real stdio MCP, the checksum-pinned native executable, test Chromium, a synthetic source profile, and the shared loopback Experian fixture. The owner-wait worker's three unit cases stay intact; this case adds native MCP composition, Imperva, and redirect coverage rather than copying their per-command privacy and lifecycle checks. This local time is not a new CI wall-time measurement.

## Deleted tests and last measured times

Times below come from [the last full run before retirement](https://github.com/aaalexliu/bao-browser/actions/runs/41996082031). They sum top-level TAP records within each file, not parent and child records together, and are not elapsed job time. Parallel work overlaps, so do not sum them as a wall-time saving. The deleted opt-in native fixtures did not run in that CI job and have no measured time there.

Unit paths are relative to `desktop/test/unit/`.

| Deleted test file | Seconds | Retired behavior |
| --- | ---: | --- |
| `live-mode-regressions.test.ts` | 119.275 | Legacy tool keys, selections, navigation policy, redaction, and replay |
| `live-mode.test.ts` | 83.798 | Legacy MCP action policy and mode choices |
| `experian-gaps.test.ts` | 76.007 | Legacy Experian handoffs, redirects, and final-action guards |
| `live-contenteditable.test.ts` | 63.503 | Legacy editor recording and replay across modes |
| `live-covered.test.ts` | 43.862 | Legacy covered-click repair and model-free replay |
| `live-oauth-regressions.test.ts` | 31.539 | Legacy OAuth navigation, control identity, and guards |
| `live-read.test.ts` | 30.535 | Named legacy region reads and fresh replay outputs |
| `instacart-acceptance.test.ts` | 22.018 | Legacy app/MCP cart capture and guarded replay |
| `live-recording.test.ts` | 16.828 | Legacy trail condensation, workflow saving, and replay |
| `live-replay.test.ts` | 15.985 | Legacy workflow replay in the selected live target |
| `live-video.test.ts` | 15.447 | Legacy driver video lifecycle and Library wiring |
| `live-tools.test.ts` | 10.897 | Legacy ref actions, guards, and saved steps |
| `agent-browser.test.ts` | 6.794 | Retired guarded page adapter, not the current CLI pass-through |
| `live-guards.test.ts` | 5.160 | Legacy action and replay policy |
| `live-target.test.ts` | 4.211 | Legacy target selection and session startup |
| `instacart-fixture.test.ts` | 4.090 | Legacy Instacart page reader and driver fixture |
| `imperva-hcaptcha.test.ts` | 3.571 | Legacy driver bot-wall detection and halt |
| `live-video-content.test.ts` | 3.279 | Legacy driver rendered video frames |
| `live-navigation-error.test.ts` | 2.604 | Legacy driver's typed navigation failures |
| `eval-agent-instacart.test.ts` | 0.056 | Retired private live-tool agent eval |
| `live-session.test.ts` | 0.053 | Legacy session controls and policy |
| `live-mode-evidence.test.ts` | 0.050 | Legacy mode screenshot policy |
| `live-capture.test.ts` | 0.011 | Legacy driver capture hooks |
| `live-trail.test.ts` | 0.004 | Legacy trail key identities |

Opt-in paths are relative to `desktop/test/live/`.

| Deleted test file | Seconds | Retired behavior |
| --- | ---: | --- |
| `agent-browser-parity.test.ts` | Not measured | Old/native guarded-driver capture and replay parity |
| `capture-artifacts.test.ts` | Not measured | Legacy driver screenshot veil and clip ownership |
| `live-fixture.test.ts` | Not measured | Legacy live-tool browser and app integration |
| `live-profile.test.ts` | Not measured | Legacy running-Chrome profile selection |
| `live-video-failure.test.ts` | Not measured | Legacy capture save after video failure |
| `relay-books.test.ts` | Not measured | Legacy live-driver replay through relay |

Mixed files lose only legacy-tool and injected-live-replayer cases. Storage, secret stripping, ordinary replay, shared transport, historical workflow decoding, and run display cases remain. Teach repair (`teach-app.test.ts`, 150.18 s), old-extension retirement (104-second full step), and the Capture password timing fix (`auth-login.test.ts`, 69.68 s) belong to sibling PRs, not this removal. Teach and old-extension retirement have already merged. The owner dropped the proposed pass-through password test: saving raw typed passwords locally is allowed.

## Historical selection evidence

The [original successful check](https://github.com/aaalexliu/bao-browser/actions/runs/41887176365) took 898 seconds, including 736 seconds in fixtures. Its 1,180 TAP duration records include parent and child records; they are not 1,180 browser launches.

The [independent per-file measurement](https://github.com/aaalexliu/bao-browser/actions/runs/41894367739) ran 139 desktop files with two workers and source-mapped V8 coverage. The [selected-group measurement](https://github.com/aaalexliu/bao-browser/actions/runs/41898671148) supplied named-case selection data. These are historical measurements of the pre-retirement product, not the current inventory or coverage.

| Historical set | Covered lines | Total lines | Line coverage |
| --- | ---: | ---: | ---: |
| Full fixture baseline | 43,287 | 77,339 | 55.97% |
| Essential selection | 41,621 | 77,339 | 53.82% |

That selection retained 96.14% of observed covered lines. It did not prove equivalent assertions, branch coverage, browser-injected code, or native-helper coverage. Coverage alone does not justify deleting an active feature's tests.

## Repeat measurements

Use a disposable branch and temporary HOME. Never run on a daily profile or model account.

```sh
gh-axi workflow run guardrails.yml --ref <branch> --field measure-coverage=true
gh-axi run download <run-id> --name per-test-coverage --dir <proof-dir>
```

`measure-test-coverage.mjs` runs the source inventory with sanitized environments and pinned Chromium. Report its revision, tool fingerprints, exit codes, and per-file wall times. Source-mapped V8 line counts measure Node code, not browser-page or native-helper coverage. Compare full and essential sets with the same production denominator, including unloaded source. A removed test's historical measurement is not fresh evidence for its replacement.
