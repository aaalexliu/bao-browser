# agent-browser trial

Bao keeps its workflow, Capture, Library, replay, MCP, and site-policy layers. The native agent-browser process replaces page actions only. The old engine stays the default. This trial does not remove the capture-only extension or change the daily-Chrome debugging helper.

## Pick an engine and profile

On macOS, in Settings, choose **agent-browser (trial)** and a Chrome profile, then save the engine choice. Both Settings profile choosers list existing `Default` and `Profile N` directories. Chrome's `Local State` supplies display names and account emails; a missing name falls back to the directory name. Metadata for a directory that no longer exists is not listed. The list contains no cookie or storage values. The choice applies to the next live session or recorded live-workflow replay and stays fixed for that whole run.

Bao reads the selected profile and creates a fresh private copy outside the checkout. It does not launch, write to, or lock the original. Chrome runs on the copy with sync disabled. The copy keeps the selected profile's files and Chrome's encryption metadata; disposable cache directories are excluded. Bao excludes saved tab/session files while copying so unrelated tabs do not reopen. The source stays unchanged. The copy has mode `0700`; its files never become run evidence. Copying stops if it exceeds five minutes or 20 GiB. Settings reports bytes copied and elapsed time. Bao removes the copy after Chrome stops and removes marked stale copies on the next start. It refuses an active copy or a symlink rather than deleting or following it.

The copy includes extension files, but copied Chrome starts with `--disable-extensions` by default. **Load my Chrome extensions**, next to the profile chooser, opts back in. Bao remembers that choice per profile on this Mac. Shopping and coupon extensions can cover pages and block the agent. This changes only the copy, not the owner's running Chrome or its extensions.

This route needs no remote-debugging toggle, Accessibility, Automation, or Screen Recording. Chrome still uses its own macOS keychain identity. Only the Chrome child gets the passwd home so it can find the login keychain; Bao keeps its isolated HOME and state. If macOS shows a keychain or other permission prompt, stop. Do not approve it to keep a run going. Starting the server in the GUI session avoids attributing Chrome's prompts to an SSH session.

Start a live session with Bao's `live_*` tools to record a workflow. Replay on this route requires a recorded `cdp-live` workflow. An extension workflow or another ordinary browser workflow is refused while the trial is selected, and guarded live replay refuses secret inputs. It does not run the old engine instead.

Settings is the only product engine selector. Local fixtures pass an explicit engine choice at the live boundary. An explicit throwaway target does not read a real profile. Do not point a throwaway target at daily Chrome.

## Native process contract

- Version and platform checksums live in [`desktop/packaging/agent-browser-pin.json`](../desktop/packaging/agent-browser-pin.json). [Mac packaging](mac-build.md#fresh-setup) stages and signs the native executable; the npm launcher is not a runtime dependency.
- For a checkout, run `node desktop/packaging/stage-agent-browser.mjs "$PWD/.toolchain/agent-browser"`, then set `BAO_AGENT_BROWSER` to `$PWD/.toolchain/agent-browser/agent-browser` in the Bao server's environment. Installed builds use the bundled executable without this variable. This selects the executable, not the engine.
- Bao starts one native daemon with a private state directory, a fixed loopback CDP endpoint, and one exact pinned tab. It strips model keys, remote-provider settings, proxy settings, config homes, and inherited executable paths from the child environment. WebMCP is off.
- Structured NDJSON travels over a private Unix socket. Page values never enter argv. Raw engine output and upstream error text are not logged because they can contain typed values. Fixed stop-cause codes distinguish deadlines, socket loss, invalid responses, and lifecycle changes without exposing those values.
- Ordinary commands have a 12-second deadline; navigation has 30 seconds. Startup trust/readiness/location evaluation has 35 seconds because upstream CDP can wait 30 seconds before responding. Native startup errors propagate at once rather than polling a stopped engine. These bounds do not retry an action.
- Commands have a response-size bound. The process stops after 10 idle minutes, reset by every live operation, or after an absolute two-hour safety cap. A malformed response, uncertain transport outcome, dialog, lost tab, or relaunch warning stops the run. Bao never respawns the engine, retries an uncertain mutation, or switches engines mid-run.
- Bao tracks browser ownership itself. Killing the native child only disconnects it. The adapter never sends `Browser.close`; the owner of a Bao-launched browser handles shutdown. An attached browser survives adapter disposal.
- Live tools keep the host/origin, credential, stale-ref, submit, commit-label, popup, and stop-path guards. The trial does not expose arbitrary evaluation or upstream browser commands through MCP.

## Evidence

Copied-profile sessions save the live workflow, a Library run record with `kind: "capture"`, page screenshots for its kept steps, and page video. The Library labels these runs as recordings. They do not count toward local last-green, sync run uploads, or replay failure/heal history. Only passed replays establish green status. Condensed steps use the last shot in their original trail interval, including merged typing and digit clicks.

Recorded live-workflow replays follow the [Library run-picture contract](v1.md#install-and-run). Both engines apply the full-page `redactOverlay` veil only while taking a live screenshot. The transient veil blocks clicks and exposes its caption to accessibility, matching the base behavior. Cleanup removes it in `finally` through the exact CDP session, even when native screenshot transport stops. The live page stays readable between shots and after navigation. The shared recorder, `startCdpVideo` in `desktop/src/engines/cdp-video.ts`, applies an 18-pixel Gaussian blur and an 82% light tint to each accepted frame in memory before writing it, including temporary JPEGs. [Video privacy](permissions.md#what-stays-on-this-mac) defines the private eval app's exception. The recorder does not install a persistent page overlay or depend on page scripts preserving one. Video uses `Page.startScreencast` on the run's exact page through the same CDP connection, not an OS capture API. Capture pauses for human handoff and audit screenshot veils. Nested pauses keep capture paused until every caller resumes it. At 6000 frames or 512 MiB it finalizes the clip recorded so far and marks it `videoTruncated`; reaching a capture limit is not a rejected run. Each frame transform accepts at most 16 MiB of compressed input, decodes at most 1920 x 1080 pixels, limits output to 16 MiB, and has a 10-second deadline. One frame processes at a time; extra frames are dropped, not queued. Before closing an unpaused recording that has not failed or reached a cap, the recorder lets the last action paint and requests a final screencast frame. A failed or timed-out final sample leaves no clip rather than saving startup-only footage. The final encoder uses VFR timing and realtime VP9 for WebM, with a 120-second deadline. Blur or encoder failure has no clear-frame fallback. Video needs `ffmpeg` on the host; missing ffmpeg prevents a recorded run from starting. A video failure does not discard an already recorded workflow: the capture retains its action status and `kind: "capture"`, saves the video-unavailable reason in `traceUnavailable`, and returns a stopped reply that distinguishes a saved workflow from a missing video. Only a workflow-save error rejects the save. Temporary native screenshots live in the engine's private state directory and disappear with it.

Capture and replay teardown stop recording and end the driver, close the CDP socket, restore remote debugging if Bao turned it on, and release the CDP lock before waiting for video encoding. `CdpLiveDriver.end()` ends capture; `finishVideo()` waits for the encoded clip. After encoding, capture removes only its `<artifactRoot>/videos/<runId>.webm` when no saved capture run adopts it. This includes empty captures, workflow/run-save failure, and startup failure after recording begins. Saved normal, refused, and halted capture clips remain. Cleanup never removes the videos directory, other runs, or profile data. Replay's failed-start clip adoption stays separate and unchanged.

Run records state the selected page engine. Startup failures other than [guard halts](cdp-live-chrome.md#agent-entry-point) return a failed run with pending steps and the reason, so the UI and MCP save them in Library Runs. Request validation and an already-open live session still reject the request. Video encoding failure after replay keeps the completed step results and reports unavailable video in `traceUnavailable`; it does not turn completed actions into pending steps. The Library shows this reason for capture and replay runs.

Unsupported console/network traces also carry `traceUnavailable`; empty arrays do not claim that tracing succeeded. A real agent's model cost is separate from replay's `modelCalls`, which counts Bao heal calls.

Successful guarded-live steps do not retain identity-score tables, DOM snapshots, or accessibility snapshots with either engine. The local old/native comparison runs the same five steps with evidence enabled and verifies that both lack all three fields. The trial leaves this shared limit unchanged. This result applies to guarded-live replay, not ordinary `BrowserDriver` replay, which has a separate step-capture implementation. Adding successful-step diagnostics to guarded-live capture is follow-up work.

The Library step image uses its captured aspect ratio at the full pane width. This fits both full-viewport screenshots and old-engine target crops without grey side bands, stretching, or discarding page content. Before/after switching preserves each image's own dimensions. A pane without a picture keeps its fixed height.

## Capability contract and parity status

The callers are `desktop/src/app/server.ts`, `desktop/src/v1/replay.ts`, and `desktop/src/cdp-live/live-replay.ts`. A status of **gap** blocks a default switch. An implemented operation is not full end-to-end parity until its fixture coverage passes.

| Capability | Trial status | Boundary |
| --- | --- | --- |
| DOM tree, failure snapshot | Works | Bao identities and guards; reads use native evaluation. |
| Unique match, stale live refs | Works | Count before action; missing, ambiguous, and expired refs refuse. |
| Click, fill, key, navigation | Works | Local two-engine Instacart cart and recorded replay passed. Credentials and off-host/commit actions still refuse. |
| Check and select | Gap | Guarded live tools retain their stricter checkbox/select policy. Broader support and fixtures still need proof. |
| Page screenshots | Works | Native CDP PNG, fixed page, full-page veil, Bao artifact paths. Local fixture PNGs were saved and opened. |
| Scoped tabs | Works | Exact target id and pinning; popup guard halts. No active-tab following. |
| Files, uploads, file drops | Refuses clearly | Existing live-driver refusals remain. |
| Downloads | Refuses clearly | Guarded live replay has no download capture. |
| Dialogs | Refuses clearly | Unexpected dialogs stop the native run. |
| List extraction | Refuses clearly | Guarded live replay has no list extraction. |
| Dates and date drag | Refuses clearly | Guarded live replay has no date picking or date drag. |
| OS digits and other drag/drop | Refuses clearly | No OS driving or desktop engine is selected. |
| Console/network trace | Refuses clearly | Run metadata reports that trace collection is unavailable. |
| Nested-frame and shadow-root actions | Gap | Not full browser-driver parity; broader fixtures still need proof. |
| Human handoff and assertions | Gap | Existing replay logic remains; full interactive parity is not yet proved. |
| Copied-profile chooser and lifecycle | Works | Synthetic/API tests and selected-profile native launch passed. Copies close and delete; extension loading is opt-in per profile. Real-cart proof remains separate. |
| Live capture step shots and CDP video | Works on the local fixture | Screenshots use a transient page veil; video veils every accepted frame before persistence. The live page has no persistent overlay. Merged typing uses the final event's shot. The historical private clear film stays unchanged. |
| Session lifetime | Implemented | Ten-minute idle timeout resets on live operations; absolute native-process cap is two hours. |
| Video capture limits | Implemented | Frame/byte limits finalize a retained clip marked truncated; encoder failures still report unavailable evidence. |
| Recording versus replay status | Implemented | Capture-kind records stay visible as recordings but never establish green or upload as replays. |
| Successful guarded-live identity scores, DOM, and AX snapshots | Shared limit | The same five local steps lack all three fields with old and native engines. No scores or snapshots are invented. Ordinary browser replay uses a separate capture path. |
| Library step-image fit | Works | The frame follows the captured viewport or target-crop ratio at full pane width. Before/after switching keeps the full image visible. |
| Real copied-profile replay | One flow proved | The approved four-step Costco replay passed on a fresh profile copy, extensions off, with zero model calls. This is not full feature parity. |

## Real-site checkpoint

The accepted real-run summary is cart start **0**, add **1**, end **0**. Agent cost rounded to cents is **USD 0.47**. The final replay passed **4/4** steps with **0 model calls**.

With extensions off, the read-only preflight opened the empty Costco cart. One Opus 5.5 agent run then used only product Bao MCP: 18 tool calls, 55.6 seconds, USD 0.4706854. It added the approved Kirkland Signature Organic Blueberries, 3 lbs, product 19232694, once. The cart screenshot showed exactly one line at quantity 1.

Bao saved `wf-real-kirkland-blueberries`, four kept steps, their PNGs, and the CDP recording. All four recorded steps passed. The capture run's overall status is still `failed` because the agent encountered one stale-ref refusal, refreshed, and continued. That status needs review; it is not a replay pass.

The first model-free replay failed during startup, before step 0, with `agent-browser run stopped: uncertain evaluate`. It added nothing. Restoration removed only the agent's actual addition and returned the cart to empty. That historical failure and the capture's refused status have not been rewritten.

Code review found that post-DOMContentLoaded startup probes used Bao's 12-second ordinary deadline while upstream CDP allowed 30 seconds. The readiness loop also swallowed the first fatal native error. Startup probes now get 35 seconds and propagate the first error. The old report lacks a cause code, so this is a supported explanation, not proof of the historical cause. Startup failures now follow the existing Library save paths through the UI and MCP.

After that fix, one explicitly authorized extra model-free replay passed all four steps through product Bao MCP: `run-mvx3dt73-lo2e`, 44,221 ms, zero model calls, eight before/after PNGs, and an 18.84-second CDP clip. Its fresh profile copy had extensions off. All 68 prompt-monitor samples were clear. A fresh empty-cart baseline preceded it. The replay added exactly the approved single quantity. Restoration verified that line at 1 ct, removed only that replay's actual addition, and checked `cartRestored(0, 1, 0)`. The final screenshot showed zero lines and quantity. Other carts were not opened or changed. All copies, owned Chrome processes, and native processes were gone before the cart handoff. No further cart access is authorized.

Private evidence is under the task's `real-run/` directory: the earlier `claude-main/` and `replay.json`, plus `final-attempt/{baseline/,replay.json,restore/,cleanup.json}`. `agent-replay-library.mp4` contains the actual earlier agent clip, the final replay, running Bao Library/workflow/step-screen stills, and the empty restored-cart still. It is 65.76 seconds at 1920 x 1080. The approved real-cart flow is proved; the other capability gaps still block a default-engine change.

## Follow-ups before a default switch

- Prove nested-frame and shadow-root actions, broader check/select operations, and interactive handoff/assertion parity.
- Review overall capture status after a recoverable stale-ref refusal. Preserve the historical failed capture until that policy is settled.
- Diagnose the black Library video surface separately. The raw replay clip decodes; the cause could be playback or screenshot rendering.
- Add successful-step identity, DOM, and accessibility evidence to guarded-live capture for both engines if the product needs it. These fields are absent with the old engine too.
- Prove parity before adding ordinary native browser replay or widening supported copied-profile workflow types. The unused environment-only replay adapter has been removed.
- A user-facing clear-evidence setting needs separate approval. [Video privacy](permissions.md#what-stays-on-this-mac) defines the eval-only exception. The accepted historical private clear film is not relabelled.

## Local proof

The first old/native Instacart fixture proof passed with the same cart, cart-write count, guarded checkout view, stale-ref refusal, saved workflow, and model-free replay. The external fixture Chrome survived engine shutdown. The native startup failure was an unpacked executable without its execute bit, not a CDP or socket timeout; the staging script fixes that. This local proof is not the owner's real-cart check.

The earlier 008 review fix pass compiled the desktop package and passed 42 focused tests in `agent-browser`, `cdp-video`, `engine-review`, `catalog`, `chrome-profile-copy`, `startup-nav`, and `shot-stage`, then passed the old/native local fixture serially. This was not another full desktop suite or the pipeline's Test gate. The frame-limit unit test uses a fake encoder to test finalization and retained metadata; the local fixture uses real ffmpeg to record and decode media. Shortened timer tests cover idle reset and the absolute cap.

Private review proof is under `/Users/alexliu/.no-mistakes/evidence/01M6ACG20XJG5KR1Q1XXP554SQ/review-008/`: `agent-browser-cart.png`, `agent-browser-recording.webm`, `agent-browser-recording-frame.png`, `agent-browser-replay.webm`, `agent-browser-replay-frame.png`, `library-recording-{before,after}.png`, and both fixture libraries. The opened screenshot and decoded frames show the full-page veil. The running-app UI comparison shows the same synthetic capture before and after its kind marker, not a component preview or a change to historical real evidence.

### Review 009: readable live page, veiled saved media

The isolated local fixture reproduced all three reported defects before edits: old-engine Guide rejected an unlinked extension workflow, encoder failure returned a rejected stop despite saving a passed capture without a video-error receipt, and `#bao-redact` stayed in the live page between shots.

The desktop compile and 36 focused tests passed in `agent-browser`, `cdp-video`, `cdp-video-privacy`, `engine-review`, `chrome-profile-copy`, `live-replay`, and `teach-guide`. Executable route checks cover old-engine Guide for ordinary and extension workflows, the unchanged non-guide extension-link check, and native refusal with Guide on or off. Real ffmpeg tests decode a persisted temporary JPEG and the final clip, check the tint and blur, drop paused frames, and verify that malformed input writes neither a raw frame nor a clip. Fake-encoder tests separately cover retained clips and metadata at both frame and byte limits, including larger transformed frames.

Both local fixture tests passed: old/native capture and replay parity, and forced final-encoder failure for manual stop, disconnect, idle, refused capture, halted capture, and genuine workflow-save failure. Saved captures keep their action status, step evidence, zero model calls, and video-error receipt; workflow-save failure still rejects. The native screenshot-failure case closes the transport, checks one screenshot attempt and an empty shot under the existing route contract, and confirms CDP cleanup removes the veil. The external fixture Chrome survives. The first compile caught a nullable mock result; two parity retries corrected test-only assumptions about the empty-shot reply and the stop helper. No product changes followed the passing focused tests. This was not a full desktop suite or the pipeline's Test gate.

Resource gates passed 311 seconds apart before reproduction (loads 13.22 and 2.96) and 300 seconds apart before verification (loads 6.51 and 2.11), with no `xcodebuild` at those checks. Tests ran serially with an isolated HOME/library, the pinned throwaway Chromium, vendor keys unset, and account healing disabled. No real profile, cart, workflow replay, or paid agent was used.

New private proof is under `/Users/alexliu/.no-mistakes/evidence/01M6ACG20XJG5KR1Q1XXP554SQ/review-009/`: `persistent-veil-before.png`, `reproduction.json`, `agent-browser-cart.png`, `agent-browser-recording.webm`, `agent-browser-recording-frame.png`, `agent-browser-replay.webm`, `agent-browser-replay-frame.png`, `agent-browser-live-page.png`, `agent-browser-live-after-navigation.png`, `missing-video-{before,after}.png`, `capture-video-failure.json`, `parity.json`, and both fixture libraries. The opened step PNG and frames decoded from the actual videos are veiled. The opened live-page images show readable content between shots and after navigation, with no `#bao-redact`. The running Bao UI shows the missing-video reason without changing the capture status.

These sampled images do not prove privacy for every page or failure path. The bounded-memory frame transform is the shared write boundary; it does not rely on the sampled page preserving an overlay. Real encoder hangs, output-buffer exhaustion, and every renderer, scale, or page combination were not exercised in this pass. The prior 008 and historical real-run artifacts remain unchanged.

### Review 010: transient veil and capture clip ownership

Before the fix, `capture-artifacts.test.ts` reproduced click-through and hidden AX captions with both engines. It also proved that real ffmpeg had created a clip before empty stop, workflow-save failure, run-save failure, startup failure, disconnect, and idle left it unreferenced. The normal/refused/halted adoption cases already passed. Node reported 3 passes and 10 expected failures, including the two failed parent tests. No compile or fixture retries were needed in this round.

After both fixes, `npm run build:desktop` and one serial focused run passed all 23 reported tests, with none skipped. The exact compiled files were unit `{cdp-video,cdp-video-privacy,live-replay}.test.js` and live `{capture-artifacts,agent-browser-parity,live-video-failure}.test.js` under `desktop/dist/desktop/test/`. The new fixture checks live DOM hit targeting and AX caption visibility during old/native screenshots; readable pages with no veil between shots and after navigation; veiled saved PNGs; and cleanup after success and stopped native transport. It verifies clip removal only after successful real encoding for the six orphan cases and host close, while normal/refused/halted saved clips, another run's referenced sentinel, and a caller-owned file survive. Existing checks cover old/native guarded capture/replay, video-error receipts, startup-failure persistence, zero model calls, pause privacy, and frame/byte truncation. Replay's failed-start clip adoption was traced unchanged, not separately forced with a new clip in this pass.

A load spike reset the resource gate before reproduction. Renewed checks at 04:26:25Z and 04:31:25Z were 300 seconds apart, loads 6.60 and 2.22, with no `xcodebuild`; the pre-verification check was also quiet at 2.88. All runs used the isolated `.toolchain/review-010-home`, explicit pinned test Chromium, no vendor keys, and `BAO_HEAL_CURSOR_ACCOUNT=0`. No full suite, real profile/cart/replay, paid agent, helper change, or publication ran.

Private proof is under `/Users/alexliu/.no-mistakes/evidence/01M6ACG20XJG5KR1Q1XXP554SQ/review-010/`: `veil-{before,after}-{old,agent-browser}.json`, matching `-step.png`, `-live.png`, and `-navigation.png` images, `ownership-{before,after}-<case>.json`, and `clip-{before,after}-<case>.webm`. The native before/after step, live-page, and navigation images were opened: the saved shot keeps the same veil and the live page stays readable. DOM/AX receipts show hit blocking and caption access changing from false to true. Ownership receipts show an encoded clip existed before cleanup and only the sentinel remains for unadopted captures. `before.log` preserves the expected failures; `after.log` records the passing focused run.

This pass does not cover deletion denied by the filesystem, process death during teardown, or every compositor/accessibility implementation. It does not claim a new real-profile check. Earlier private evidence, the accepted real-run summary, and failed history remain unchanged.

The opt-in parity test is `desktop/test/live/agent-browser-parity.test.ts`; capture failure coverage is `desktop/test/live/live-video-failure.test.ts`; transient veil and ownership coverage is `desktop/test/live/capture-artifacts.test.ts`. Set `BAO_LIVE_TESTS=1`, `AGENT_BROWSER_PARITY_BINARY` to the staged executable, and optionally `AGENT_BROWSER_PARITY_ARTIFACTS` to a private evidence directory. Use a throwaway Bao home and test browser, unset vendor keys, and set `BAO_HEAL_CURSOR_ACCOUNT=0`. Compile with `npm run build:desktop`, then run the compiled live test directly or through the live runner. Do not run it against a daily profile.
