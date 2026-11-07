# agent-browser pass-through

## Direct MCP commands

`bao mcp` exposes `agent_browser` and `finish_task`. Call `finish_task` before the final chat reply for every completed, failed, or cancelled browser task. A long-lived MCP connection has no conversation-turn-end event, so a final answer alone cannot release the browser.

```json
{"name":"finish_task","arguments":{"outcome":"passed","reason":"Verified the requested change on the page."}}
{"name":"finish_task","arguments":{"outcome":"failed","reason":"The requested item was unavailable."}}
```

`finish_task` returns the saved run receipt and workflow save result. It ends the browser session without stopping MCP, so the same client can start the next task. The agent's checked outcome and reason set the capture result, even after a recovered command failure. Earlier command failures stay in the receipt; workflow saving keeps its existing harmless-failure rule. An incomplete owner wait still fails with `session_closed`. Failed captures include a reason. Do not finish while waiting for sign-in, `wait_for_owner`, or an owner confirmation. After 10 minutes without an agent command, Bao ends a non-waiting session as failed with a reason that it ended without `finish_task`. Active commands, owner waits, sign-in handoffs, and held replay confirmations do not expire. Idle cleanup honors keep-open for owned windows and only detaches from current Chrome, leaving its task tabs open. Settings Stop remains the replay heal policy; task completion neither heals nor calls a model.

`agent_browser` needs no running Bao app. It accepts a native `command` and an `args` array. Each item is one CLI argument, without shell quoting. Supported commands are `open`, `snapshot`, `click`, `fill`, `press`, `scroll`, `tab`, `screenshot`, `wait_for_owner`, and `close`.

```json
{"command":"open","args":["http://127.0.0.1:8080/"]}
{"command":"snapshot","args":["-i"]}
{"command":"tab","args":["t2"]}
{"command":"fill","args":["@e1","hello"]}
{"command":"click","args":["@e2"]}
{"command":"close","args":[]}
```

Bao fixes one session in a private socket directory, installed Google Chrome, and a visible window. On `open`, `browser: "copy"` (the default) starts a fresh marked copy of the profile selected in Settings. `browser: "bao"` uses Bao's lasting profile and imports missing site sign-ins from that selected Chrome profile. `browser: "current"` explicitly uses the owner's running Chrome as described below. An unset source profile selects `Default`. Close the session before changing browser. The page-engine choice does not affect this tool. For copied and Bao-owned profiles, extensions stay disabled and Bao launches Chrome itself. The current route leaves the running browser's extensions unchanged. Bao attaches the pinned native agent-browser through `--cdp`.

For copied and Bao-owned profiles, Bao picks a nonzero debugging port. Port zero makes headed Chrome set `navigator.webdriver` to true. Bao accepts only the WebSocket endpoint its own Chrome child prints to stderr, then writes that endpoint to the owned profile's `DevToolsActivePort` file. A port-bind race stops startup rather than attaching to another browser. The current route reads the running profile's `DevToolsActivePort` and accepts it only when the listener PID matches the selected Chrome process.

Pass-through startup connects only to Chrome's browser-level CDP endpoint and discovers targets without attaching Playwright to restored tabs. An unrelated unresponsive renderer does not block startup. Bao leaves those tabs in place without waiting for page readiness or parking startup pages. Successful `open` adds native `tab list` output. For `browser: "copy"`, the agent selects the signed-in copied tab with `tab <id>`; Bao does not guess its login state. `tab list --json` exposes CDP target ids.

`desktop/test/unit/agent-browser-startup.test.ts` covers startup with a stalled restored renderer. `desktop/test/unit/chrome-startup.test.ts` covers launch flags, a stale endpoint file, a port-bind race, browser-only startup commands, and headed `navigator.webdriver` before and after a Runtime-domain attach.

Ordinary calls return native stdout and stderr as separate MCP text blocks. Sign-in and human-check handoffs return Bao's wait status instead. [Browser tool cards](mcp-viewer.md#browser-tool-cards) describes the visual result and receipt handoff in MCP Apps hosts. A native failure sets `isError` and leaves the session available unless the command is `close`, which attempts cleanup even after a native failure. Bao does not block final clicks. Closing a successful, representable single-document task saves a replayable workflow. The closing result gives its workflow id or one line explaining why it was not saved. Workflows from the retired live driver still fail with `this workflow used the retired live driver`.

### Workflow reuse

Successful tasks using `open`, `click`, `fill`, and `press` save a `WorkflowV2` in Workflows when the session finishes. Bao observes the actual DOM control during each action, saves its identity and locators, and records observed effects through the existing v1 trail contract. Snapshot refs such as `@e280` remain only in the raw capture. Field values become the existing workflow inputs. Snapshots and screenshots remain evidence, not replay actions. A settling-only check is low-confidence, not proof of the task's business result.

A second tab, popup, stateful scroll, unsupported command options, an unaddressable target, a failed action that changed the page, or a failed or unfinished task leaves a capture only. Selecting the active tab, a failed read-only command, a harmless action failure followed by a successful action, and a completed owner handoff do not block saving. Handoffs stay out of the replay steps; replay uses its existing sign-in handling. Bao does not silently remove unsupported actions to save a partial workflow. The final tool result says `Saved workflow` with its id or `Not saved as a workflow` with the reason. Do not claim a workflow exists without that saved result.

Saved workflows run through the current replay engine using app Replay or MCP `run_workflow`, not through native pass-through replay. Capture receipts, raw commands, and pictures stay in their original capture run; saving does not mark that capture as a replay or establish a green replay.

### Lasting Bao profile

```json
{"command":"open","args":["https://claude.ai/"],"browser":"bao"}
```

Bao stores this profile at `<Bao home>/agent-browser-profile`. It keeps cookies and site data after `close` and agent exit. It uses Chrome's mock keychain so a background agent can read Bao's saved cookies without OS Keychain access. The older replay/login-import profile stays separate.

For cookie import, Bao copies the selected Chrome source's cookie database into a temporary browser profile, reads that site's cookies through CDP, and reuses the login importer's cookie and storage helpers. It does not copy or restore source tabs. The temporary Chrome runs with `--no-startup-window`, so it opens no window; on macOS it also launches without activating the app. It stays non-headless to retain OS Keychain access and closes after import. The lasting Bao browser still opens its visible window. Every explicit open checks the selected source again, including startup. Cookies merge by name, domain, path, and partition: a source cookie replaces Bao's cookie only when its last-update time is later. Bao-only cookies stay. Bao protects live cookie changes that have not reached its disk database and keeps existing localStorage values. Empty and storage-only sources skip cookie-extraction Chrome. If that open reaches a recognized sign-in wall on another origin, Bao imports that origin and retries the requested open only when the import changed state. The same open never imports an origin twice. Bot checks, later actions, and screenshot capture never trigger that retry. It never enters credentials or answers a browser or OS prompt.

IndexedDB transfer still has no passing real-browser proof. The initial site's import uses the existing disk-copy helper; later site imports into an open browser transfer cookies and localStorage only. A cookie or storage record alone does not prove the site accepts a login.

Keep-window-open also applies to this profile. The next Bao-profile session closes that kept window before reopening the same saved profile. It also reclaims a window whose owning MCP process has exited or whose explicit close is still finishing. Another active session must close before a second session can use it.

### Use the owner's running Chrome

Set `browser` on the first `open` to choose the route. `"copy"` is the default. `"current"` controls the owner's own running Google Chrome and its actual signed-in profile, not a copy. Use it when a background-launched copy cannot keep the site's sign-in. Later calls inherit that choice; omit `browser` until the session ends. If the owner's Chrome connection ends unexpectedly, Bao names the ended session and requires an explicit `browser: "current"` or `browser: "copy"` on the next `open`, rather than silently starting a copy.

```json
{"command":"open","args":["https://example.com/"],"browser":"current"}
{"command":"snapshot","args":["-i"]}
{"command":"close","args":[]}
```

This Mac-only route uses BaoOSHelper's existing Accessibility grant. The helper opens a new inspect tab, enables Chrome's debugging checkbox if needed, and presses Chrome's native debugging Allow sheets while current-Chrome commands connect, including reconnects. Sheets already present when polling starts may also be approved; Bao does not attribute each sheet to a particular connection. It does not request Automation or Screen Recording. A locked screen, missing Accessibility access, or ambiguous browser process stops startup without asking for a new grant.

Bao creates a new task tab before the first navigation. A native daemon restart also opens a new task tab and loses prior tab selection and refs; navigate that task tab again, then take a fresh snapshot. It keeps one browser-level CDP connection for metadata and page pictures. Stay in the current session's task tab, which shares the owner's sign-ins; use another tab only when the owner asks. The copied-profile setting does not affect this route. Both routes record commands and page screenshots in Runs.

`finish_task`, `close`, MCP disconnect, and handled stop signals close only task tabs Bao created, then detach from current Chrome. Bao tracks their target ids, including task tabs created after native daemon restarts. Pre-existing owner tabs stay open, even if the agent selected one during the task. Bao never quits, signals, or relaunches the borrowed Chrome or removes its profile. Keep-open applies only to copied windows. [Session end](#session-end) defines native daemon shutdown and state cleanup. Bao leaves the debugging checkbox enabled; this route does not restore the old preference or revive retired live-driver workflows.

### Session end

For every route, Bao stops only this session's native daemon before removing its private state directory. It waits up to one second after each of two SIGTERM attempts, then up to one second after SIGKILL, and verifies exit. If signaling or exit verification fails, cleanup reports the error and preserves the state directory; current Chrome still detaches without closing the borrowed browser.

For the default copied-profile route, `finish_task` closes the browser by default and finalizes the existing capture without adding a native close command. `close` ends only this session and removes its copy after Chrome stops. It succeeds if the owner already closed the marked window or the session already ended. Agent exit, MCP disconnect, and SIGINT/SIGTERM/SIGHUP close the marked window, delete its copy, and finish the run by default. Proxy cleanup starts at once, even when another tool call is still waiting.

In **Settings → Technical details → Agent window**, **Keep window open after agent finishes** leaves the marked window available for a manual final step. This local choice is off by default and does not enable extensions. Bao still finishes the run and removes the native agent's private state. The next copied-profile agent session closes the kept window and deletes its copy before opening a fresh one, even if the setting has since been turned off. A kept copy stays on disk until the next agent session cleans it up, even if the owner closes its window by hand. Keep-open applies when `finish_task` ends a task, the agent disconnects, or Bao MCP stops. An explicit `close`, or closing the window by hand during a live session, still closes Chrome and deletes its copy. Bao never closes the source profile or another Bao home's window.

Kept Chrome has no Bao owner and keeps a local debugging port open, even after you close its window, until you quit that Chrome or the next agent session reclaims its copy. Other local processes, including those run by another OS user, can use that port to read the copy's cookies or control its signed-in pages. Bao has already finished the run and no longer records those actions.

### Wait for owner input in the same session

When the active tab's URL or title signals sign-in, a verification code, Imperva, or hCaptcha, Bao returns `outcome: "halted"`. It keeps that tab, browser session, MCP process, and Library run. The page shows a **Bao is waiting for you** banner, and the Library run says **needs you**. The owner signs in or clears the check in that tab.

```json
{"command":"wait_for_owner","args":["60000"]}
```

The optional timeout is 1 to 120000 milliseconds, with a default of 60000. It limits each check, not the whole owner wait. The run viewer labels the step **Wait for you to sign in or clear a check**, with the limit in seconds or minutes. Without an explicit run deadline, the wait status says **no overall timeout**. Each call stays below the 180-second MCP limit. On `waiting`, call it again without ending the agent turn. Temporary metadata or CDP errors keep the handoff open until the call's deadline. On `ready`, take a fresh snapshot and continue in the same session. On `closed`, report the returned session-ended instruction. If the owner's Chrome session ended unexpectedly, reconnect with `open` and `browser: "current"` or explicitly choose `browser: "copy"`; do not silently start a copy. Do not start another MCP process to resume this window. Closing during an owner wait finalizes its run as `failed` with reason `session_closed`.

During handoff, Bao polls only the pinned tab's URL and title through browser-level CDP. It does not run native page commands, inspect fields, read text, take snapshots, or save screenshots. Other page commands return the handoff without recording their arguments. `close` and `finish_task` stay available to end an abandoned task; ending an unfinished handoff records a failed run with reason `session_closed`. `wait_for_owner` never forwards a native command or saves a page picture.

Readiness means the tab has an HTTP(S) URL and a nonblank title, its URL or title changed, neither matches a sign-in/check marker, and both stayed stable for 750 milliseconds. This is not proof of authentication. An unchanged URL and title keep waiting even if page content changes. An unrecognized check can use `wait_for_owner` to enter the same private wait. Metadata does not identify every sign-in form or embedded challenge.

## Pick an engine and profile

The **Settings → Technical details → Page engine** choice remains separate from `agent_browser`. Under **agent-browser (trial)**, saved workflows that explicitly declare `driver: "playwright"`, including supported pass-through tasks, remain searchable and replay through the same browser path as **Current engine (default)**. Other workflows still return `pass-through sessions do not support saved workflow replay`. Historical live workflows remain retired under either choice; see [retirement behavior](cdp-live.md).

Settings → Technical details → Page engine lists existing `Default` and `Profile N` directories. Chrome's `Local State` supplies display names and account emails. Missing names fall back to the directory name; missing directories are omitted. The saved `chromeProfile` choice applies to the next copied-profile or Bao-profile pass-through session, not current Chrome.

The default copied-profile route reads the selected source and creates a private copy outside the checkout. It does not launch, write to, or lock the source profile. Only the Chrome child gets the real HOME from the passwd entry so it can use the login keychain. The native command process keeps a private HOME. No remote-debugging toggle, Accessibility, Automation, or Screen Recording grant is needed. If a permission prompt appears, stop rather than approving it to keep a test running.

The copy keeps cookies, saved tabs, session-restore files, Session Storage, and encryption metadata. Cache directories are omitted. Chrome starts with sync off and `--restore-last-session`. Bao changes only the copy's exit marker, profile name, theme, avatar, and new-tab background. The profile name is **Bao copy of <original name>**. Its light orange or blue theme differs from the source; its avatar is the origami fox, or penguin when the source already uses the fox. Extensions stay off, including copied themes. These markers do not prove every site's login survives copying.

The copy has mode `0700`. Copying stops after five minutes or 20 GiB. Bao refuses links and active copies. [Session end](#session-end) defines window and copy cleanup. A released keep-open copy or a copy whose Bao process has exited can be reclaimed: Bao stops only Chrome processes using that exact marked directory before deleting it, never the source profile. The 10-minute inactivity backstop does not close a session during an active command or owner wait.

## Known gaps

During current-route connections and native commands, `debug-allow` polling calls `app_from_pid(pid, true)` and `child_list`, which set `AXManualAccessibility` and `AXEnhancedUserInterface` on Chrome's accessibility elements. This enables full accessibility in Chrome's renderers, including during reconnects and later sessions that reuse the persisted debugging preference and skip the inspect/checkbox startup step. This is Chrome's internal accessibility state, not a new macOS privacy (TCC) grant. The helper does not clear the flags on detach; full renderer accessibility stays enabled until Chrome restarts. Firstmate owns filing the narrower native-sheet walk follow-up.

Current-Chrome startup failed once at head `9f644125b37c1aa2f0c41ce255ae7f4198f06fae`: after the helper reported a debugging-checkbox press, the 10-second port wait ended with `Chrome did not open its debugging port`, before the delayed initial native command began. A fresh retry passed with the real 27-second native delay, followed by three passing instrumented startup runs and a passing late reconnect. Those passes do not explain or fix the failure. The cause remains unresolved; Firstmate owns the deferred follow-up. A failed startup can leave the inspect tab open. This change does not add a re-press, off/on toggle, longer deadline, or inspector cleanup.

Route validation at head `5bfb8ed172435aca387bc5bc8bfeca5ae99d096b` exposed a fixture lifecycle gap. The original six-case batch remains five passes and one route failure, aggregate exit 1. The fixture pre-started a native daemon outside the CLI's compatibility/config path, then started a replacement when its retained child exited, competing with CLI restart. The first daemon exited normally after 1.064 seconds. The pinned CLI waits one second for missing config before gracefully shutting down that daemon. `/task` loaded, but post-open metadata selected a new `about:blank` target and snapshot was empty: Bao's unchanged PID guard creates a fresh task target when the native PID changes. The original failure remains preserved.

Firstmate 016/017 accepted a runner-only repair that removed fixture daemon starts and replacements and left lifecycle ownership to the native CLI. Node-fake checks passed. Exactly one authorized isolated route-only rerun at the same source head passed: synthetic sign-in remained present, the page showed Saved Ada, the seed target stayed unchanged, real native approval succeeded with zero webpage imitation clicks, and explicit close, disconnect, and reconnect passed. The two Runs passed with 9 and 5 steps; both before/after JPEGs were opened. All 69 captured native CLI calls exited 0. Each MCP session kept one stable daemon PID/config, and both native state directories were removed. Directory removal did not prove daemon exit; Firstmate 021 later found and stopped nine orphaned fixture daemons. Product code and Rust did not change for this result. This rerun does not turn the original six-case batch into a pass or prove the owner's current browser state.

Pinned agent-browser 0.41.0 sends daemon stdout to null and drops its startup stderr pipe on readiness. Firstmate 017 accepted complete CLI stdout/stderr and exposed startup errors, timings, runner events, and PID/config/version sidecars as the available evidence, not full daemon streams. No product or Rust instrumentation was added. Evidence is under `/Users/alexliu/dev/firstmate/data/bao-current-chrome-attach/`: `route-016/result-review.md`, `route-016/capture-summary.json`, `route-016/proof/receipt.json`, and the original `guarded-six/proof-route/events.jsonl`. See the [pinned CLI connection code](https://raw.githubusercontent.com/vercel-labs/agent-browser/v0.41.0/cli/src/connection.rs).

Current-Chrome startup assumes a U.S. keyboard layout when the helper opens `chrome://inspect/#remote-debugging`. Other layouts can type the wrong omnibox text and perform a search in the owner's signed-in profile. The owner's Mac uses U.S. layout; the native fix is deferred. The remedy is `CGEventKeyboardSetUnicodeString` for text plus layout-resolved `cmd+t`. Firstmate owns that follow-up.

The Settings Mac card still says "Chrome agents need no Accessibility, Automation, or Screen Recording permission." That blanket sentence is stale. It fits the copied and Bao-owned profile routes, but `browser: "current"` requires BaoOSHelper's existing Accessibility grant. A separate browser-choice UI follow-up owns the correction; this route does not change Settings.

## Evidence

Each session creates one `kind: "capture"` run in the Library home Bao.app reads. See [Runs and Detailed evidence](v1.md#install-and-run) for the desktop controls that expose commands, screenshots, and native output. The capture receipt remains recording-only, with no replay or teaching actions; a separately saved workflow appears in Workflows. The capture omits Identity and Snapshot inspectors. Durable replay identities and observed effects live in the saved workflow's trail. Capture runs do not claim to count the outside agent's model calls or establish replay green status.

Each step stores its exact command and argv, native stdout/stderr and exit codes, error flag, and start/end times. Bao saves a pending `open` before startup and updates the run atomically as results arrive. Startup failure produces a failed run with its original error and no invented picture. Uncatchable process termination can leave readable partial runs marked `recording`; handled stops finish the run as described in [Session end](#session-end).

Bao takes a separate page screenshot through CDP on the active tab after each ordinary command, with a three-second deadline. Owner handoffs and every `wait_for_owner` call omit page pictures and native screenshot copies. This does not change native refs or screenshot history. Native screenshot files, including relative and default paths, are copied into `shots/runs/<runId>/` before the private state directory disappears. After `close`, the step records the missing page rather than reusing a picture. A recording or screenshot failure logs a warning without changing native command forwarding.

**Raw command arguments, results, and screenshots can contain credentials. This route does not redact them. Do not send data you do not want saved locally.** Saved-workflow input persistence is a separate contract in [permissions](permissions.md#secret-text-in-saved-files).

## Native executable and tests

Version and platform checksums live in `desktop/packaging/agent-browser-pin.json`. [Mac packaging](mac-build.md#fresh-setup) stages and signs the executable. For a checkout, run `node desktop/packaging/stage-agent-browser.mjs <temporary-directory>` and set `BAO_AGENT_BROWSER` to its `agent-browser` file. Installed builds use the bundled file.

`BAO_AGENT_BROWSER_PROFILE_ROOT` supplies a synthetic source root for fixtures. With `BAO_TEST_BROWSER`, copy tests require that explicit source and launch only the pinned test browser, with mock-keychain and media-denial flags. Current-Chrome GUI tests use a throwaway Chrome profile and the signed helper. Never supply a real profile to a fixture test.

`bao-profile.test.ts` covers selected-site cookie/localStorage import, cookie freshness, sign-in redirects, signed-out visits, concurrent startup, renewed Bao logins across clean exits, kept-window reclaim, and the explicit browser choice. It does not prove IndexedDB login reuse or real-site authentication.

Focused coverage lives in `current-chrome.test.ts`, `agent-browser-proxy.test.ts`, `agent-browser-proxy-close.test.ts`, `agent-browser-startup.test.ts`, and `agent-browser-session-end.test.ts` under `desktop/test/unit/`. The native `agent-browser-workflow.test.ts` and `experian-proxy.test.ts` cases use loopback fixtures and run in the required Experian lane with a staged binary and xvfb; local runs need `AGENT_BROWSER_PROXY_BINARY`. The separate opt-in native fixture is `desktop/test/live/agent-browser-proxy.test.ts`. Set `AGENT_BROWSER_PROXY_BINARY` to the staged executable. `AGENT_BROWSER_PROXY_ARTIFACTS` retains its output comparison and recording receipts. The fixture checks native output, durable page screenshots, partial/final runs, and cleanup on close, disconnect, and SIGTERM. It does not prove real-site login survival.
