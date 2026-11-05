# PR test selection

## Legacy extension retirement

The old standalone root extension is retired. Its source, root manifest,
side-panel/dashboard pages, build/watch/package commands, installer, and all
legacy fixture/live tools are removed. CI no longer runs the **Legacy extension
tests** step or the `legacy` essential group. No remaining desktop or web test
was dropped for speed. The desktop extension in `extension/`, its installer,
and its tests remain. Desktop imports of root masking and workflow types moved
to `shared/mask.ts` and `shared/types.ts`; packaging now stages those shared
files without a root `src` runtime tree.

The last measured full run is
[41996082031](https://github.com/aaalexliu/bao-browser/actions/runs/41996082031).
Its legacy step took about 104 s; suite boundaries total 102.40 s. Times below
include each suite's process startup and browser work, ending at the next
suite boundary (or the final success line). These are historical Linux times,
not fresh measurements or predicted wall savings for a different CI layout.

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

The removed public-site tests below never ran in that full check. Their last
measured times are unavailable; no time saving is claimed for them.

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

Removed support tools are `test/all.mjs`, `test/run.mjs`, `test/live.mjs`,
`test/live-helpers.mjs`, and `test/probe-sites.mjs`, plus legacy HTML fixtures.
They have no independent measured suite times. Installer-specific assertions
were removed from the mixed `install-scripts.test.ts`; current installer and
stager safety assertions remain. That file's last full body time was 2.181 s
for the whole mixed file, not a measured cost of the deleted cases.

**PR check choice: use `full-suite`.** Moving shared runtime imports and changing
package staging and CI/test entry points reaches beyond a pure source deletion.
Focused local checks plus the remote full inventory protect retained desktop,
extension, and web paths. Do not run the full suite locally for this removal.

## Historical selection: 2026-11-04

The remaining sections are the original pre-retirement coverage snapshot.
They describe the old inventory, not today's test counts or coverage. Do not
reuse that denominator after deleting the root extension. Current membership
comes only from `test/essential.json`.

## Evidence and scope

The measurements below describe `16b7351`, before merging repaired main at
`c043bb4`. The current manifest also keeps main's new
`imperva-hcaptcha.test.ts` and `desktop-runner.test.ts`: they guard the bot-wall
boundary and the runner's concurrency bound. Coverage percentages below remain
historical measurements; the PR body records fresh post-merge check timings.

The original [successful PR check](https://github.com/aaalexliu/bao-browser/actions/runs/41887176365)
took 898 seconds. Its fixture step took 736 seconds. The parsed TAP log has
1,180 test/suite duration records. The largest records included the taught
interstitial branch (133.72 s), live-mode regressions (118.78 s), real MCP mode
boundaries (84.97 s), password-slot recording (61.60 s), and covered clicks
(47.24 s). Nested suite durations overlap their child durations; do not sum them.

The [per-file measurement](https://github.com/aaalexliu/bao-browser/actions/runs/41894367739)
ran all 139 desktop test files independently, with two workers. Each file and
its descendant Node processes wrote separate `NODE_V8_COVERAGE` data. c8 11
mapped compiled JavaScript back to source with TypeScript source maps. The
`per-test-coverage` artifact contains each file's TAP log, raw V8 data, wall time,
and exit code. This historic measurement retained the then-existing single
teach-a-page exclusion. The final opt-in workflow has no exclusions.

The [selected-group measurement](https://github.com/aaalexliu/bao-browser/actions/runs/41898671148)
passed every static gate and essential group. Its V8 artifacts supply the exact
named safety selections and both web boundary tests. The three later retained
whole files use their independent per-file measurements. Group placement does
not change Node's per-file process isolation.

Coverage uses one fixed denominator: all production `.ts`/`.tsx` lines in
`desktop/src`, `shared`, `src`, `extension/src`, and `web/src`. Test files,
dependencies, and generated output are excluded; unloaded source stays in the
denominator. These are observed **Node V8 line counts**, not browser-page or
native-helper coverage. Browser-only source therefore contributes uncovered
lines. The full and essential runs use the same scope and c8 settings.
The web group runs in both sets; its observed runtime coverage contributes to
both totals. The desktop/shared-only full baseline is 61.06% (39,654/64,938).

| Set | Covered lines | Total lines | Line coverage |
| --- | ---: | ---: | ---: |
| Full fixture baseline | 43,287 | 77,339 | 55.97% |
| Essential selection | 41,621 | 77,339 | 53.82% |

The selection retains 96.14% of the full baseline's observed covered lines.
It retains 99 of 139 desktop files (one by named safety cases), both web files,
and two of 21 legacy suites. The PR body records two final, uninstrumented
job-start-to-job-end timings and the opt-in full-check result.

## Selection rule

Keep every secret-stripping/secret-slot, final Experian click, bot-wall/human-check,
and permission-boundary test, regardless of yield. Keep all other desktop test
files with at least 100 exclusive covered source lines per measured second.
"Exclusive" means a line no other desktop test file covered in this measurement;
shared startup code does not count as unique coverage. Safety cases in the large
mixed `live-mode-regressions.test.ts` use exact registration names in the manifest.

[`test/essential.json`](../test/essential.json) alone controls membership and
encoder requirements. The workflow repeats only group IDs to start all jobs
without a planning-job delay; a self-test requires those IDs to match the
manifest exactly. The runner never changes the full-suite inventory.

The full check is opt-in through `full-suite` or manual dispatch, not scheduled
and not required. No test was deleted in that original selection change. See [testing guidance](TESTING.md#choose-the-pr-checks)
for the decision an agent must state in its PR body.

## Per-file measurements

Paths below are relative to `desktop/test/unit/`. Seconds include process startup
and V8 collection. Exclusive counts compare the 139 desktop files, using the
production scope above. A file may have zero exclusive lines and still guard a
required safety boundary. The `PR` column is a snapshot, not another selector.

| Test file | Seconds | Exclusive lines | Lines/s | PR |
| --- | ---: | ---: | ---: | --- |
| `eval-intent.test.ts` | 0.19 | 402 | 2122.1 | kept |
| `eval-agent-instacart.test.ts` | 0.48 | 932 | 1948.2 | kept |
| `extension-driver.test.ts` | 0.16 | 267 | 1672.2 | kept |
| `nightly-diff.test.ts` | 0.08 | 122 | 1542.7 | kept |
| `revise-decision.test.ts` | 0.10 | 148 | 1494.7 | kept |
| `cdp-live.test.ts` | 0.21 | 308 | 1459.2 | kept |
| `remote-debugging.test.ts` | 0.12 | 173 | 1411.6 | kept |
| `spike-workdir.test.ts` | 0.17 | 221 | 1292.4 | kept |
| `interpret-os.test.ts` | 0.09 | 113 | 1256.2 | kept |
| `login-import.test.ts` | 0.99 | 1219 | 1231.0 | kept |
| `files-dates.test.ts` | 0.27 | 275 | 1002.1 | kept |
| `teach.test.ts` | 0.25 | 216 | 881.0 | kept |
| `effect-replay-lint.test.ts` | 0.13 | 113 | 869.5 | kept |
| `guide.test.ts` | 0.48 | 393 | 825.8 | kept |
| `helper-capabilities.test.ts` | 0.11 | 80 | 748.1 | kept |
| `state-poll.test.ts` | 0.11 | 76 | 704.0 | kept |
| `owner-auth.test.ts` | 0.09 | 59 | 623.5 | kept |
| `proof-expect.test.ts` | 0.08 | 46 | 576.9 | kept |
| `save-workflow.test.ts` | 0.26 | 143 | 554.7 | kept |
| `automation.test.ts` | 0.09 | 48 | 517.6 | kept |
| `ax-fixtures.test.ts` | 0.11 | 55 | 509.0 | kept |
| `page-class.test.ts` | 0.13 | 62 | 495.5 | kept |
| `chrome-login.test.ts` | 0.46 | 222 | 480.5 | kept |
| `backup-schedule.test.ts` | 0.11 | 51 | 472.0 | kept |
| `live-session.test.ts` | 0.18 | 75 | 408.4 | kept |
| `locators.test.ts` | 0.25 | 99 | 403.5 | kept |
| `data-steps.test.ts` | 0.49 | 186 | 380.1 | kept |
| `schema-replay.test.ts` | 0.30 | 111 | 366.0 | kept |
| `invalid-fixture.test.ts` | 0.42 | 142 | 340.0 | kept |
| `artifact-dir.test.ts` | 0.09 | 26 | 283.9 | kept |
| `input-token.test.ts` | 0.10 | 28 | 276.6 | kept |
| `permissions.test.ts` | 0.37 | 98 | 266.8 | kept |
| `saved-secrets-sync.test.ts` | 0.29 | 77 | 266.2 | kept |
| `heal-cursor.test.ts` | 0.09 | 21 | 244.6 | kept |
| `run-pass.test.ts` | 0.14 | 32 | 237.0 | kept |
| `eval-drivers.test.ts` | 0.33 | 76 | 228.2 | kept |
| `identity.test.ts` | 0.09 | 18 | 211.4 | kept |
| `try-step.test.ts` | 0.09 | 19 | 202.8 | kept |
| `helper-pid-keys.test.ts` | 0.09 | 18 | 200.8 | kept |
| `element-history.test.ts` | 0.22 | 44 | 197.9 | kept |
| `checks.test.ts` | 0.13 | 24 | 185.9 | kept |
| `sync-catchup.test.ts` | 0.48 | 77 | 160.2 | kept |
| `relay-singleton.test.ts` | 0.10 | 15 | 144.7 | kept |
| `sync-panel.test.ts` | 0.09 | 12 | 137.8 | kept |
| `site-trust.test.ts` | 0.13 | 17 | 132.1 | kept |
| `url-oracle.test.ts` | 0.08 | 10 | 128.6 | kept |
| `listing-stat.test.ts` | 0.10 | 13 | 127.4 | kept |
| `guide-me.test.ts` | 0.12 | 15 | 121.7 | kept |
| `versions.test.ts` | 0.23 | 25 | 107.2 | kept |
| `import-deeplink.test.ts` | 1.64 | 170 | 103.7 | kept |
| `extension-shots.test.ts` | 1.78 | 182 | 102.2 | kept |
| `ui-views.test.ts` | 1.62 | 163 | 100.9 | kept |
| `driver-fixes.test.ts` | 5.12 | 504 | 98.4 | kept |
| `sync-guard.test.ts` | 0.14 | 14 | 98.0 | kept |
| `pending-prompt.test.ts` | 0.54 | 50 | 91.9 | opt-in only |
| `file-capture.test.ts` | 0.14 | 11 | 80.8 | opt-in only |
| `relay.test.ts` | 4.09 | 324 | 79.2 | kept |
| `live-mode-evidence.test.ts` | 0.11 | 9 | 78.5 | opt-in only |
| `visible-copy.test.ts` | 0.13 | 10 | 75.3 | opt-in only |
| `saved-secrets-bindings.test.ts` | 2.84 | 192 | 67.6 | kept |
| `expect.test.ts` | 0.11 | 7 | 64.2 | opt-in only |
| `saved-secrets-sealed.test.ts` | 18.04 | 1062 | 58.9 | kept |
| `time.test.ts` | 0.33 | 18 | 54.2 | opt-in only |
| `agent-config.test.ts` | 11.09 | 493 | 44.5 | opt-in only |
| `chrome-profile-copy.test.ts` | 0.65 | 27 | 41.6 | kept |
| `sync-refuse.test.ts` | 0.14 | 5 | 36.2 | kept |
| `agent-browser.test.ts` | 6.65 | 209 | 31.4 | kept |
| `teach-guide.test.ts` | 3.77 | 118 | 31.3 | opt-in only |
| `human-envelope.test.ts` | 3.91 | 114 | 29.1 | kept |
| `saved-secrets-writers.test.ts` | 2.59 | 74 | 28.6 | kept |
| `trace-viewer.test.ts` | 0.46 | 13 | 28.3 | opt-in only |
| `repair-promote.test.ts` | 2.84 | 73 | 25.7 | opt-in only |
| `cursor-account.test.ts` | 0.87 | 21 | 24.1 | kept |
| `optional-dismiss.test.ts` | 0.18 | 4 | 22.8 | opt-in only |
| `run-lookup.test.ts` | 1.99 | 44 | 22.1 | opt-in only |
| `act-copy.test.ts` | 0.11 | 2 | 18.3 | opt-in only |
| `capture.test.ts` | 1.96 | 35 | 17.9 | kept |
| `live-library.test.ts` | 2.65 | 43 | 16.2 | opt-in only |
| `datepicker-replay.test.ts` | 1.55 | 24 | 15.5 | opt-in only |
| `live-navigation-error.test.ts` | 2.19 | 29 | 13.2 | opt-in only |
| `calendar-drive.test.ts` | 2.24 | 27 | 12.0 | opt-in only |
| `replay-video.test.ts` | 0.09 | 1 | 11.5 | opt-in only |
| `realworld-basics.test.ts` | 0.81 | 8 | 9.9 | kept |
| `live-target.test.ts` | 17.96 | 156 | 8.7 | kept |
| `cdp-video.test.ts` | 1.00 | 8 | 8.0 | opt-in only |
| `test-media.test.ts` | 6.43 | 44 | 6.8 | kept |
| `ui-app.test.ts` | 7.82 | 47 | 6.0 | opt-in only |
| `viewer-depth.test.ts` | 1.37 | 6 | 4.4 | kept |
| `dialog-recorder.test.ts` | 1.15 | 5 | 4.4 | kept |
| `live-guards.test.ts` | 5.21 | 22 | 4.2 | kept |
| `catalog.test.ts` | 1.43 | 6 | 4.2 | kept |
| `replay-shots.test.ts` | 0.57 | 2 | 3.5 | opt-in only |
| `live-replay.test.ts` | 12.55 | 44 | 3.5 | kept |
| `saved-secrets-context.test.ts` | 4.12 | 14 | 3.4 | kept |
| `auth-login.test.ts` | 71.20 | 241 | 3.4 | kept |
| `files-dates-demo.test.ts` | 31.76 | 105 | 3.3 | opt-in only |
| `remote-flag.test.ts` | 6.58 | 21 | 3.2 | opt-in only |
| `install-scripts.test.ts` | 1.84 | 5 | 2.7 | kept |
| `saved-secret-regressions.test.ts` | 1.93 | 5 | 2.6 | kept |
| `live-read.test.ts` | 22.80 | 50 | 2.2 | kept |
| `saved-secrets-model.test.ts` | 0.46 | 1 | 2.2 | kept |
| `ui-polish.test.ts` | 2.39 | 4 | 1.7 | opt-in only |
| `home.test.ts` | 29.96 | 50 | 1.7 | kept |
| `live-recording.test.ts` | 11.53 | 19 | 1.6 | kept |
| `launch.test.ts` | 27.97 | 39 | 1.4 | kept |
| `owned-port.test.ts` | 2.20 | 3 | 1.4 | kept |
| `saved-secrets.test.ts` | 11.03 | 15 | 1.4 | kept |
| `shot-stage.test.ts` | 3.65 | 3 | 0.8 | opt-in only |
| `teach-app.test.ts` | 139.64 | 110 | 0.8 | opt-in only |
| `live-tools.test.ts` | 10.52 | 8 | 0.8 | kept |
| `live-video.test.ts` | 13.08 | 9 | 0.7 | opt-in only |
| `experian-gaps.test.ts` | 55.42 | 38 | 0.7 | kept |
| `mcp.test.ts` | 22.36 | 11 | 0.5 | opt-in only |
| `instacart-acceptance.test.ts` | 18.60 | 8 | 0.4 | kept |
| `mac-launch.test.ts` | 7.03 | 3 | 0.4 | opt-in only |
| `live-mode-regressions.test.ts` | 110.76 | 29 | 0.3 | named safety cases |
| `cdp-video-privacy.test.ts` | 4.21 | 1 | 0.2 | kept |
| `live-oauth-regressions.test.ts` | 29.79 | 7 | 0.2 | kept |
| `live-covered.test.ts` | 42.37 | 6 | 0.1 | opt-in only |
| `live-mode.test.ts` | 52.10 | 3 | 0.1 | kept |
| `alerts-v2.test.ts` | 0.10 | 0 | 0.0 | opt-in only |
| `app-permissions.test.ts` | 0.43 | 0 | 0.0 | kept |
| `ax-dump-guard.test.ts` | 0.23 | 0 | 0.0 | kept |
| `engine-review.test.ts` | 0.17 | 0 | 0.0 | opt-in only |
| `heal-hermetic.test.ts` | 0.09 | 0 | 0.0 | opt-in only |
| `instacart-fixture.test.ts` | 3.65 | 0 | 0.0 | opt-in only |
| `installed-bundle.test.ts` | 31.00 | 0 | 0.0 | kept |
| `live-capture.test.ts` | 0.09 | 0 | 0.0 | kept |
| `live-contenteditable.test.ts` | 50.83 | 0 | 0.0 | opt-in only |
| `live-trail.test.ts` | 0.32 | 0 | 0.0 | kept |
| `live-video-content.test.ts` | 3.37 | 0 | 0.0 | opt-in only |
| `recording-page-boundary.test.ts` | 0.12 | 0 | 0.0 | opt-in only |
| `remote-policy.test.ts` | 0.09 | 0 | 0.0 | kept |
| `saved-secrets-allowlist.test.ts` | 2.19 | 0 | 0.0 | kept |
| `saved-secrets-capture.test.ts` | 0.65 | 0 | 0.0 | kept |
| `saved-secrets-eval.test.ts` | 3.14 | 0 | 0.0 | kept |
| `startup-nav.test.ts` | 2.38 | 0 | 0.0 | opt-in only |
| `suite-hygiene.test.ts` | 0.66 | 0 | 0.0 | opt-in only |
| `viewer-links.test.ts` | 0.98 | 0 | 0.0 | opt-in only |

## Desktop files moved to opt-in only

- `act-copy.test.ts`
- `agent-config.test.ts`
- `alerts-v2.test.ts`
- `calendar-drive.test.ts`
- `cdp-video.test.ts`
- `datepicker-replay.test.ts`
- `engine-review.test.ts`
- `expect.test.ts`
- `file-capture.test.ts`
- `files-dates-demo.test.ts`
- `heal-hermetic.test.ts`
- `instacart-fixture.test.ts`
- `live-contenteditable.test.ts`
- `live-covered.test.ts`
- `live-library.test.ts`
- `live-mode-evidence.test.ts`
- `live-navigation-error.test.ts`
- `live-video-content.test.ts`
- `live-video.test.ts`
- `mac-launch.test.ts`
- `mcp.test.ts`
- `optional-dismiss.test.ts`
- `pending-prompt.test.ts`
- `recording-page-boundary.test.ts`
- `remote-flag.test.ts`
- `repair-promote.test.ts`
- `replay-shots.test.ts`
- `replay-video.test.ts`
- `run-lookup.test.ts`
- `shot-stage.test.ts`
- `startup-nav.test.ts`
- `suite-hygiene.test.ts`
- `teach-app.test.ts`
- `teach-guide.test.ts`
- `time.test.ts`
- `trace-viewer.test.ts`
- `ui-app.test.ts`
- `ui-polish.test.ts`
- `viewer-links.test.ts`
- `visible-copy.test.ts`

## Mixed-file cases moved to opt-in only

These cases remain in `desktop/test/unit/live-mode-regressions.test.ts`:

- CDP select-all commands use only the platform modifier and keep other chords intact
- named keys dispatch canonical CDP events and text modifiers stay distinct from shortcuts
- YOLO ignores configured driver stop paths during navigation
- invalid selections recover, never click, and recorded selections replay guarded
- exact option labels select and replay the matched element despite duplicate values
- normalized labels precede values, ambiguity refuses, and exact options replay in both modes
- Shift inserts shifted characters while shortcuts insert no text
- MCP select-all deletes and replaces input, textarea, and editable text
- switching an owned popup allows a cross-host navigation during adoption

## Repeat the measurements

Use a disposable branch and opt in; do not run the full suite on a daily profile:

```sh
gh-axi workflow run guardrails.yml --ref <branch> --field measure-coverage=true
gh-axi run download <run-id> --name per-test-coverage --dir <proof-dir>
```

`measure-test-coverage.mjs` runs the full source inventory with a fresh `HOME`
supplied by the workflow, sanitized environments, pinned Chromium, and no model
accounts. For each file, feed its raw directory to `c8 report --reporter=json`
with the source-map build and the production scope above. Use `--all` for the
fixed denominator. For each source line, count the test-file reports with a
positive hit count; a count of one is exclusive coverage. Divide that file's
exclusive count by its `results.json` time. Merge selected line sets for the
essential numerator, using named-case measurements for mixed files.
