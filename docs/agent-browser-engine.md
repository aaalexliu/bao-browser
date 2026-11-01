# agent-browser trial

Bao keeps its workflow, Capture, Library, replay, MCP, and site-policy layers. The native agent-browser process replaces page actions only. The old engine stays the default. This trial does not remove the capture-only extension or change the daily-Chrome debugging helper.

## Pick an engine and profile

In Settings, choose **agent-browser (trial)** and a Chrome profile, then save the engine choice. The profile list comes from Chrome's `Local State`, with each profile's display name, account email, and directory. It contains no cookie or storage values. The choice applies to the next live session or recorded live-workflow replay and stays fixed for that whole run.

Bao reads the selected profile and creates a fresh private copy outside the checkout. It does not launch, write to, or lock the original. Chrome runs on the copy with sync disabled. The copy keeps the selected profile's files and Chrome's encryption metadata; disposable cache directories are excluded. Bao excludes saved tab/session files while copying so unrelated tabs do not reopen. The source stays unchanged. The copy has mode `0700`; its files never become run evidence. Settings reports bytes copied and elapsed time. Bao removes the copy after Chrome stops and removes marked stale copies on the next start. It refuses an active copy or a symlink rather than deleting or following it.

The copy includes extension files, but copied Chrome starts with `--disable-extensions` by default. **Load my Chrome extensions**, next to the profile chooser, opts back in. Bao remembers that choice per profile on this Mac. Shopping and coupon extensions can cover pages and block the agent. This changes only the copy, not the owner's running Chrome or its extensions.

This route needs no remote-debugging toggle, Accessibility, Automation, or Screen Recording. Chrome still uses its own macOS keychain identity. Only the Chrome child gets the passwd home so it can find the login keychain; Bao keeps its isolated HOME and state. If macOS shows a keychain or other permission prompt, stop. Do not approve it to keep a run going. Starting the server in the GUI session avoids attributing Chrome's prompts to an SSH session.

Profile-copy runs currently require a recorded `cdp-live` workflow. Selecting the trial for an extension workflow, a secret-input workflow, or another browser workflow with a selected profile fails with a clear error. It does not run the old engine instead.

A saved UI choice takes precedence over the environment. For local fixture work without a saved choice, `BAO_PAGE_ENGINE=old|agent-browser` selects the engine and `BAO_AGENT_BROWSER` names the staged native executable. An explicit throwaway target does not read a real profile. Do not point a throwaway target at daily Chrome.

## Native process contract

- Version and platform checksums live in `desktop/packaging/agent-browser-pin.json`. The pinned release is **0.41.0**.
- `desktop/packaging/stage-agent-browser.mjs` checks the archive and executable, stages the platform binary, sets its execute bit, and includes its license and skill data. The app signs the bundled executable. The npm launcher is not a runtime dependency.
- Bao starts one native daemon with a private state directory, a fixed loopback CDP endpoint, and one exact pinned tab. It strips model keys, remote-provider settings, proxy settings, config homes, and inherited executable paths from the child environment. WebMCP is off.
- Structured NDJSON travels over a private Unix socket. Page values never enter argv. Raw engine output and upstream error text are not logged because they can contain typed values. Fixed stop-cause codes distinguish deadlines, socket loss, invalid responses, and lifecycle changes without exposing those values.
- Ordinary commands have a 12-second deadline; navigation has 30 seconds. Startup trust/readiness/location evaluation has 35 seconds because upstream CDP can wait 30 seconds before responding. Native startup errors propagate at once rather than polling a stopped engine. These bounds do not retry an action.
- Commands have a response-size bound, and the process has a lifetime bound. A malformed response, uncertain transport outcome, dialog, lost tab, or relaunch warning stops the run. Bao never respawns the engine, retries an uncertain mutation, or switches engines mid-run.
- Bao tracks browser ownership itself. Killing the native child only disconnects it. The adapter never sends `Browser.close`; the owner of a Bao-launched browser handles shutdown. An attached browser survives adapter disposal.
- Live tools keep the host/origin, credential, stale-ref, submit, commit-label, popup, and stop-path guards. The trial does not expose arbitrary evaluation or upstream browser commands through MCP.

## Evidence

Copied-profile sessions save the live workflow, a Library run record, page screenshots for its kept steps, and page video. Recorded live-workflow replays save before/after step screenshots and video through the same run-evidence paths. Screenshots use CDP with field masking. Video uses `Page.startScreencast` on the run's exact page, not an OS capture API. Video capture pauses for human handoff. It has frame, byte, and encoder-time limits and needs `ffmpeg` on the host. A video failure does not discard an already recorded workflow.

Run records state the selected page engine. Operational failures before step 0 return a failed run with pending steps and the reason, so the UI and MCP save them in Library Runs. Request validation and an already-open live session still reject the request. Video encoding failure after replay keeps the completed step results and reports unavailable video in `traceUnavailable`; it does not turn completed actions into pending steps.

Unsupported console/network traces also carry `traceUnavailable`; empty arrays do not claim that tracing succeeded. A real agent's model cost is separate from replay's `modelCalls`, which counts Bao heal calls.

## Capability contract and parity status

The callers are `desktop/src/app/server.ts`, `desktop/src/v1/replay.ts`, and `desktop/src/cdp-live/live-replay.ts`. A status of **gap** blocks a default switch. An implemented operation is not full end-to-end parity until its fixture coverage passes.

| Capability | Trial status | Boundary |
| --- | --- | --- |
| DOM tree, failure snapshot | Works | Bao identities and guards; reads use native evaluation. |
| Unique match, stale live refs | Works | Count before action; missing, ambiguous, and expired refs refuse. |
| Click, fill, key, navigation | Works | Local two-engine Instacart cart and recorded replay passed. Credentials and off-host/commit actions still refuse. |
| Check and select | Gap | Native page adapter implements both. Guarded live tools retain their stricter checkbox/select policy. Broader fixtures still need proof. |
| Page screenshots | Works | Native CDP PNG, fixed page, field masks, Bao artifact paths. |
| Scoped tabs | Works | Exact target id and pinning; popup guard halts. No active-tab following. |
| Files, uploads, file drops | Refuses clearly | Existing live-driver refusals remain. |
| Downloads | Refuses clearly | Trial replay adapter rejects download capture. |
| Dialogs | Refuses clearly | Trial adapter does not answer dialogs; unexpected dialogs stop the native run. |
| List extraction | Refuses clearly | Trial replay adapter reports unsupported list extraction. |
| Dates and date drag | Refuses clearly | Trial replay adapter rejects date picking and date drag. |
| OS digits and other drag/drop | Refuses clearly | No OS driving or desktop engine is selected. |
| Console/network trace | Refuses clearly | Run metadata reports that trace collection is unavailable. |
| Nested-frame and shadow-root actions | Gap | Not full browser-driver parity; unsupported focus/select targets refuse rather than acting on another element. |
| Human handoff and assertions | Gap | Existing replay logic remains; full interactive parity is not yet proved. |
| Copied-profile chooser and lifecycle | Works | Synthetic/API tests and selected-profile native launch passed. Copies close and delete; extension loading is opt-in per profile. Real-cart proof remains separate. |
| Live capture step shots and CDP video | Works | Expanded local fixture passed: Library step PNGs, replay before/after PNGs, and nonempty CDP videos. The real agent recording also saved its workflow, four step PNGs, and video. |
| Real copied-profile replay | One flow proved | The approved four-step Costco replay passed on a fresh profile copy, extensions off, with zero model calls. This is not full feature parity. |

## Real-site checkpoint

With extensions off, the read-only preflight opened the empty Costco cart. One Opus 5.5 agent run then used only product Bao MCP: 18 tool calls, 55.6 seconds, USD 0.4706854. It added the approved Kirkland Signature Organic Blueberries, 3 lbs, product 19232694, once. The cart screenshot showed exactly one line at quantity 1.

Bao saved `wf-real-kirkland-blueberries`, four kept steps, their PNGs, and the CDP recording. All four recorded steps passed. The capture run's overall status is still `failed` because the agent encountered one stale-ref refusal, refreshed, and continued. That status needs review; it is not a replay pass.

The first model-free replay failed during startup, before step 0, with `agent-browser run stopped: uncertain evaluate`. It added nothing. Restoration removed only the agent's actual addition and returned the cart to empty. That historical failure and the capture's refused status have not been rewritten.

Code review found that post-DOMContentLoaded startup probes used Bao's 12-second ordinary deadline while upstream CDP allowed 30 seconds. The readiness loop also swallowed the first fatal native error. Startup probes now get 35 seconds and propagate the first error. The old report lacks a cause code, so this is a supported explanation, not proof of the historical cause. Startup failures now follow the existing Library save paths through the UI and MCP.

After that fix, one explicitly authorized extra model-free replay passed all four steps through product Bao MCP: `run-mvx3dt73-lo2e`, 44,221 ms, zero model calls, eight before/after PNGs, and an 18.84-second CDP clip. Its fresh profile copy had extensions off. All 68 prompt-monitor samples were clear. A fresh empty-cart baseline preceded it. The replay added exactly the approved single quantity. Restoration verified that line at 1 ct, removed only that replay's actual addition, and checked `cartRestored(0, 1, 0)`. The final screenshot showed zero lines and quantity. Other carts were not opened or changed. All copies, owned Chrome processes, and native processes were gone before the cart handoff. No further cart access is authorized.

Private evidence is under the task's `real-run/` directory: the earlier `claude-main/` and `replay.json`, plus `final-attempt/{baseline/,replay.json,restore/,cleanup.json}`. `agent-replay-library.mp4` contains the actual earlier agent clip, the final replay, running Bao Library/workflow/step-screen stills, and the empty restored-cart still. It is 65.76 seconds at 1920 x 1080. The approved real-cart flow is proved; the other capability gaps still block a default-engine change.

## Local proof

The first old/native Instacart fixture proof passed with the same cart, cart-write count, guarded checkout view, stale-ref refusal, saved workflow, and model-free replay. The external fixture Chrome survived engine shutdown. The native startup failure was an unpacked executable without its execute bit, not a CDP or socket timeout; the staging script fixes that. This local proof is not the owner's real-cart check.

The opt-in test is `desktop/test/live/agent-browser-parity.test.ts`. Set `BAO_LIVE_TESTS=1`, `AGENT_BROWSER_PARITY_BINARY` to the staged executable, and optionally `AGENT_BROWSER_PARITY_ARTIFACTS` to a private evidence directory. Use a throwaway Bao home and test browser, unset vendor keys, and set `BAO_HEAL_CURSOR_ACCOUNT=0`. Run it through the live runner or compile it outside the checkout with the required non-TypeScript runtime files. Do not run it against a daily profile.
