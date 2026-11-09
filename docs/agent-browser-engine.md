# agent-browser pass-through

## Direct MCP commands

`bao mcp` exposes `agent_browser` and `finish_task`. Call `finish_task` before the final chat reply for every completed, failed, or cancelled browser task. A long-lived MCP connection has no conversation-turn-end event, so a final answer alone cannot release the browser.

```json
{"name":"finish_task","arguments":{"outcome":"passed","reason":"Verified the requested change on the page.","task":"Add milk"}}
{"name":"finish_task","arguments":{"outcome":"failed","reason":"The requested item was unavailable."}}
{"name":"finish_task","arguments":{"outcome":"passed","reason":"Cancelled both subscriptions.","done":["Cancelled Coix Seed","Cancelled Barley Tea"]}}
```

`task` is optional. It is a short name for the run, such as the request you carried out. Omit it when you have no task name. Bao stores a trimmed non-blank value and drops a blank one. [Runs](v1.md#install-and-run) uses that stored name in the list. `done` is optional too: at most 50 short items, one per thing the task did. The finished card lists them; without them it shows the reason and step counts. The result's text is one sentence of the outcome, the run line, then the workflow save result; the receipt is in `structuredContent`.

Use `finish_task`, not `close`, to end a task. It returns a sentence of the result, a `Run <run_id> · <status> · <link>` line, and the workflow save result in words, with the full run receipt in `structuredContent`, without stopping MCP, so the same client can start the next task. If session cleanup is still running, `finish_task` waits and applies the outcome to that same session's run only if it has no outcome yet. Once the session is fully removed, `finish_task` returns `no_session` and leaves earlier runs and saved workflows unchanged. Call `finish_task` before `close`; a late finish cannot change the status that a completed close computed. The agent's checked outcome and reason set the capture result, even after a recovered command failure. Earlier command failures stay in the receipt; workflow saving keeps its existing harmless-failure rule. An incomplete owner wait still fails with `session_closed`. Explicit task outcomes include a reason; a session ended without an outcome keeps its step-derived status without adding an outcome envelope. Do not finish while waiting for sign-in, `wait_for_owner`, or an owner confirmation. After 10 minutes without an agent command, Bao ends a non-waiting session as failed with a reason that it ended without `finish_task`. Active commands, owner waits, sign-in handoffs, and held replay confirmations do not expire. Idle cleanup honors keep-open for owned windows and only detaches from current Chrome, leaving its task tabs open. Settings Stop remains the replay heal policy; task completion neither heals nor calls a model.

`agent_browser` needs no running Bao app. It accepts a native `command` and an `args` array. Each item is one CLI argument, without shell quoting. Supported commands are `open`, `snapshot`, `click`, `fill`, `press`, `scroll`, `tab`, `screenshot`, `wait_for_owner`, and `close`.

```json
{"command":"open","args":["http://127.0.0.1:8080/"]}
{"command":"snapshot","args":["-i"]}
{"command":"tab","args":["t2"]}
{"command":"fill","args":["@e1","hello"]}
{"command":"click","args":["@e2"]}
{"command":"close","args":[]}
```

Bao fixes one session in a private socket directory, installed Google Chrome, and a visible window. On `open`, `browser: "bao"` (the default, **Bao profile**) uses Bao's separate lasting agent profile, imports site sign-ins from the Chrome profile selected in Settings, and keeps sign-ins and site data between runs. `browser: "copy"` (**Fresh Chrome copy**) starts a fresh marked copy of that source profile. `browser: "current"` explicitly uses the owner's running Chrome as described below. An unset source profile selects `Default`. Close the session before changing browser. The page-engine choice does not affect this tool. For copied and Bao-owned profiles, extensions stay disabled and Bao launches Chrome itself. The current route leaves the running browser's extensions unchanged. Bao attaches the pinned native agent-browser through `--cdp`.

For copied and Bao-owned profiles, Bao picks a nonzero debugging port. Port zero makes headed Chrome set `navigator.webdriver` to true. Bao accepts only the WebSocket endpoint its own Chrome child prints to stderr, then writes that endpoint to the owned profile's `DevToolsActivePort` file. A port-bind race stops startup rather than attaching to another browser. The current route uses the Bao app's relay instead, described below.

Pass-through startup connects only to Chrome's browser-level CDP endpoint and discovers targets without attaching Playwright to restored tabs. An unrelated unresponsive renderer does not block startup. Bao leaves those tabs in place without waiting for page readiness or parking startup pages. Successful `open` adds native `tab list` output. For `browser: "copy"`, the agent selects the signed-in copied tab with `tab <id>`; Bao does not guess its login state. `tab list --json` exposes CDP target ids.

`desktop/test/unit/agent-browser-startup.test.ts` covers startup with a stalled restored renderer. `desktop/test/unit/chrome-startup.test.ts` covers launch flags, a stale endpoint file, a port-bind race, browser-only startup commands, and headed `navigator.webdriver` before and after a Runtime-domain attach.

Every call's first text block is one sentence of what the step did, such as `Went to https://example.com/ ("Example")` or `Clicked "Save" (button)`. The quoted name comes from the latest snapshot line for the ref. Native stdout and stderr follow as separate MCP text blocks. Sign-in and human-check handoffs follow the sentence with Bao's wait status instead. Without MCP Apps, that status is a `Run <run_id> · <outcome>` line and the instruction in words, and `structuredContent` carries the `outcome` and `instruction`. [Browser tool cards](mcp-viewer.md#browser-tool-cards) describes the visual result and receipt handoff in MCP Apps hosts. A native failure sets `isError` and leaves the session available unless the command is `close`, which attempts cleanup even after a native failure. Bao does not block final clicks. Closing a successful, representable single-document task saves a replayable workflow. The closing result gives its workflow id or one line explaining why it was not saved. A saved file that is not [schema v4](workflow-schema.md) is not loaded.

### Workflow reuse

Successful tasks using `open`, `click`, `fill`, and `press` save a `WorkflowV2` in Workflows when the session finishes. Bao observes the actual DOM control during each action, saves its identity and locators, and records observed effects through the existing v1 trail contract. Snapshot refs such as `@e280` remain only in the raw capture. Field values become the existing workflow inputs. Snapshots and screenshots remain evidence, not replay actions. A settling-only check is low-confidence, not proof of the task's business result.

A second tab, popup, scroll, unsupported command options, an unaddressable target, a failed action that changed the page, or a failed or unfinished task leaves a capture only. Selecting the active tab, a failed read-only command, a harmless action failure followed by a successful action, and a completed owner handoff do not block saving. Handoffs stay out of the replay steps; replay uses its existing sign-in handling. Bao does not silently remove unsupported actions to save a partial workflow. The final tool result says `Saved workflow` with its id or `Not saved as a workflow` with the reason. Do not claim a workflow exists without that saved result.

Saved workflows run through the current replay engine using app Replay or MCP `run_workflow`, not through native pass-through replay. Both accept the same `browser` choice, with **Bao profile** marked as the default in the app's Run picker. In the app, that choice uses Bao's own `<Bao home>/chrome-profile` with Login sites and the saved-login gate, as do Guide, capture, Sign in, import, and recheck. Agents use the separate lasting agent profile described below. The profiles use different keychains; sign-ins made in one do not appear in the other. **Fresh Chrome copy** starts a new copy for each workflow run. Replay omits only the copy's saved-tab files, keeping cookies and site storage; agent copy sessions still restore saved tabs. **Running Chrome** runs in a background tab in the Bao group and closes that tab when the run ends; a run held for the owner opens the group so he can see that tab, without switching his tab or focusing his window, and keeps the tab until he continues. Replay reaches only its own tabs, so the owner's other tabs stay untouched, and a tab that never answers cannot stall the start. Capture receipts, raw commands, and pictures stay in their original capture run; saving does not mark that capture as a replay or establish a green replay.

### Lasting Bao profile

```json
{"command":"open","args":["https://claude.ai/"],"browser":"bao"}
```

Bao stores the agent profile at `<Bao home>/agent-browser-profile`. It keeps cookies and site data after `close` and agent exit. It uses Chrome's mock keychain so a background agent can read its saved cookies without OS Keychain access. The app keeps `<Bao home>/chrome-profile` on the OS keychain. Bao does not rename, merge, or migrate either profile.

For cookie import, Bao copies the selected Chrome source's cookie database into a temporary browser profile, reads that site's cookies through CDP, and reuses the login importer's cookie and storage helpers. It does not copy or restore source tabs. The temporary Chrome runs with `--no-startup-window`, so it opens no window; on macOS it also launches without activating the app. It stays non-headless to retain OS Keychain access and closes after import. The lasting Bao browser still opens its visible window. Every explicit open checks the selected source again, including startup. Cookies merge by name, domain, path, and partition: a source cookie replaces Bao's cookie only when its last-update time is later. Bao-only cookies stay. Bao protects live cookie changes that have not reached its disk database and keeps existing localStorage values. Empty and storage-only sources skip cookie-extraction Chrome. If that open reaches a recognized sign-in wall on another origin, Bao imports that origin and retries the requested open only when the import changed state. The same open never imports an origin twice. Bot checks, later actions, and screenshot capture never trigger that retry. It never enters credentials or answers a browser or OS prompt.

IndexedDB transfer still has no passing real-browser proof. The initial site's import uses the existing disk-copy helper; later site imports into an open browser transfer cookies and localStorage only. A cookie or storage record alone does not prove the site accepts a login.

Keep-window-open also applies to this profile. The next Bao-profile session closes that kept window before reopening the same saved profile. It also reclaims a window whose owning MCP process has exited or whose explicit close is still finishing. Another active session must close before a second session can use it. Completed app copy runs keep their windows open but mark their leases retained, so the next copy session can reclaim them. App Bao runs use their own profile and do not hold an agent-profile lease.

### Use the owner's running Chrome

Set `browser` on the first `open` to choose the route. `"bao"` is the default. `"current"` (**Running Chrome**) controls the owner's own running Google Chrome and its actual signed-in profile, not a copy. Use it when a background-launched copy cannot keep the site's sign-in. Later calls inherit that choice; omit `browser` until the session ends. If the owner's Chrome connection ends unexpectedly, Bao names the ended session and requires an explicit browser choice on the next `open`, rather than silently switching browsers.

```json
{"command":"open","args":["https://example.com/"],"browser":"current"}
{"command":"snapshot","args":["-i"]}
{"command":"close","args":[]}
```

This route drives Chrome through the [Bao extension](extension.md#running-chrome) with `chrome.debugger`. It needs no macOS permission and no debugging port. The Bao app must be open with the extension linked; Bao finds the app from `server.json` in its home. Without the app, the extension, or the extension's `tabGroups` permission, startup stops with a message that names the missing piece. While Bao drives a tab, Chrome shows '"Bao" started debugging this browser' with a Cancel button. Cancel stops the session, and the next call reports that the owner's Chrome session ended.

Each session is a lease on the app's CDP relay, `ws://127.0.0.1:<app port>/devtools/browser/<lease>`. The extension opens the lease's tabs with `active: false` in the window the owner last focused, in one gray group titled Bao per window. The group sits first in the tab strip, after pinned tabs, and stays collapsed. When the owner clicks the group, Chrome opens it; when he goes back to one of his own tabs, the extension folds it again. The owner's active tab and window focus stay as they were. Each new tab navigates once, even to `about:blank`, before any client command: a background tab that never navigated can leave page commands such as `Page.enable` unanswered. The extension turns focus emulation on for each Bao page once it commits, so the page paints, runs timers, and takes clicks and typing while folded.

The agent sees and acts only in the lease's tabs: the task tab, tabs it opens with `tab new`, and pages those tabs open. A page a Bao tab opens joins the group, and if Chrome put it in front, the owner gets his tab back. The owner's own tabs are not in the lease, so `tab list` never shows them. A tab the owner pins or drags out of the group becomes his and leaves the lease. `Page.bringToFront` and `Target.activateTarget` do not change the owner's active tab. Bao binds the native session to the task tab through agent-browser's session tab binding; a native daemon restart returns to that tab but loses refs, so take a fresh snapshot.

When a sign-in or human check needs the owner, Bao opens the group so he can see the task tab and holds it open until the wait ends. It never switches his tab or focuses his window: the agent's message and the Library's **needs you** tell him, and he clicks the tab when he is ready. Stay in the current session's task tab, which shares the owner's sign-ins. The copied-profile setting does not affect this route. Both routes record commands and page screenshots in Runs.

`finish_task`, `close`, MCP disconnect, and handled stop signals close the lease's tabs, then detach. When the group's last tab closes, the group goes too. Idle cleanup only detaches; the lease's open tabs leave the group and become the owner's. Bao never quits, signals, or relaunches the owner's Chrome or removes its profile. Keep-open applies only to copied windows. [Session end](#session-end) defines native daemon shutdown and state cleanup.

### Session end

For every route, Bao stops only this session's native daemon before removing its private state directory. It waits up to one second after each of two SIGTERM attempts, then up to one second after SIGKILL, and verifies exit. If signaling or exit verification fails, cleanup reports the error and preserves the state directory; current Chrome still detaches without closing the borrowed browser.

For the copied-profile route, `finish_task` closes the browser by default and finalizes the existing capture without adding a native close command. `close` ends only this session and removes its copy after Chrome stops. It succeeds if the owner already closed the marked window or the session already ended. Agent exit, MCP disconnect, and SIGINT/SIGTERM/SIGHUP close the marked window, delete its copy, and finish the run by default. Proxy cleanup starts at once, even when another tool call is still waiting.

In **Settings → Technical details → Agent window**, **Keep window open after agent finishes** leaves the marked window available for a manual final step. This local choice is off by default and does not enable extensions. Bao still finishes the run and removes the native agent's private state. The next copied-profile agent session closes the kept window and deletes its copy before opening a fresh one, even if the setting has since been turned off. A kept copy stays on disk until the next agent session cleans it up, even if the owner closes its window by hand. Keep-open applies when `finish_task` ends a task, the agent disconnects, or Bao MCP stops. An explicit `close`, or closing the window by hand during a live session, still closes Chrome and deletes its copy. Bao never closes the source profile or another Bao home's window.

Kept Chrome has no Bao owner and keeps a local debugging port open, even after you close its window, until you quit that Chrome or the next agent session reclaims its copy. Other local processes, including those run by another OS user, can use that port to read the copy's cookies or control its signed-in pages. Bao has already finished the run and no longer records those actions.

### Wait for owner input in the same session

When the active tab's URL or title signals sign-in, a verification code, Imperva, or hCaptcha, Bao returns `outcome: "halted"`. It keeps that tab, browser session, MCP process, and Library run. The page shows a **Bao is waiting for you** banner, and the Library run says **needs you**. The owner signs in or clears the check in that tab.

```json
{"command":"wait_for_owner","args":["60000"]}
```

The optional timeout is 1 to 120000 milliseconds, with a default of 60000. It limits each check, not the whole owner wait. The run viewer labels the step **Wait for you to sign in or clear a check**, with the limit in seconds or minutes. Without an explicit run deadline, the wait status says **no overall timeout**. Each call stays below the 180-second MCP limit. On `waiting`, call it again without ending the agent turn. Temporary metadata or CDP errors keep the handoff open until the call's deadline. On `ready`, take a fresh snapshot and continue in the same session. On `closed`, report the returned session-ended instruction. If the owner's Chrome session ended unexpectedly, reconnect with `open` and `browser: "current"` or explicitly choose `browser: "bao"` or `browser: "copy"`; do not silently switch browsers. Do not start another MCP process to resume this window. Closing during an owner wait finalizes its run as `failed` with reason `session_closed`.

During handoff, Bao polls only the pinned tab's URL and title through browser-level CDP. It does not run native page commands, inspect fields, read text, take snapshots, or save screenshots. Other page commands return the handoff without recording their arguments. `close` and `finish_task` stay available to end an abandoned task; ending an unfinished handoff records a failed run with reason `session_closed`. `wait_for_owner` never forwards a native command or saves a page picture.

Readiness means the tab has an HTTP(S) URL and a nonblank title, its URL or title changed, neither matches a sign-in/check marker, and both stayed stable for 750 milliseconds. This is not proof of authentication. An unchanged URL and title keep waiting even if page content changes. An unrecognized check can use `wait_for_owner` to enter the same private wait. Metadata does not identify every sign-in form or embedded challenge.

## Pick an engine and profile

The **Settings → Technical details → Page engine** choice remains separate from `agent_browser`. Under **agent-browser (trial)**, saved workflows that explicitly declare `driver: "playwright"`, including supported pass-through tasks, remain searchable and replay through the same browser path as **Current engine (default)**. Other workflows still return `pass-through sessions do not support saved workflow replay`. Historical live workflows remain retired under either choice; see [retirement behavior](cdp-live.md).

Settings → Technical details → Page engine lists existing `Default` and `Profile N` directories. Chrome's `Local State` supplies display names and account emails. Missing names fall back to the directory name; missing directories are omitted. The saved `chromeProfile` choice selects the source for copied-profile and Bao-profile pass-through sessions and MCP workflow runs, and for app **Fresh Chrome copy** runs. App **Bao profile** runs use Login sites instead; see [Workflow reuse](#workflow-reuse). The choice does not affect **Running Chrome**.

The copied-profile route reads the selected source and creates a private copy outside the checkout. It does not launch, write to, or lock the source profile. Only the Chrome child gets the real HOME from the passwd entry so it can use the login keychain. The native command process keeps a private HOME. No remote-debugging toggle, Accessibility, Automation, or Screen Recording grant is needed. If a permission prompt appears, stop rather than approving it to keep a test running.

The copy keeps cookies, saved tabs, session-restore files, Session Storage, and encryption metadata. Cache directories are omitted. Chrome starts with sync off and `--restore-last-session`. Bao changes only the copy's exit marker, profile name, theme, avatar, and new-tab background. The profile name is **Bao copy of <original name>**. Its light orange or blue theme differs from the source; its avatar is the origami fox, or penguin when the source already uses the fox. Extensions stay off, including copied themes. These markers do not prove every site's login survives copying.

The copy has mode `0700`. Copying stops after five minutes or 20 GiB. Bao refuses links and active copies. [Session end](#session-end) defines window and copy cleanup. A released keep-open copy or a copy whose Bao process has exited can be reclaimed: Bao stops only Chrome processes using that exact marked directory before deleting it, never the source profile. The 10-minute inactivity backstop does not close a session during an active command or owner wait.

## Known gaps

Chrome shows '"Bao" started debugging this browser' on every tab while the extension drives a Bao tab, and for a few seconds after. An extension cannot hide it; only a Chrome started with `--silent-debugger-extension-api` does.

A page a Bao tab opens in front shows for a moment before the extension gives the owner his tab back. A popup window a Bao page opens joins the lease but not the group, because Chrome groups only tabs in normal windows, and it can take focus.

While the Bao app runs and the Bao extension is linked, any local program on this Mac, including one run by another macOS user, can open and read tabs in the owner's Chrome through the app's relay. The relay asks for no secret and shows no prompt; the only signs are Chrome's debugging bar and a folded Bao group.

A page a Bao tab opens can commit before the extension attaches to it. On the agent-browser route that page then misses focus emulation until it navigates again, so in a folded group it can stop painting and running timers.

File steps (downloads, uploads, drops) do not run on Running Chrome yet. App Replay and `run_workflow` refuse such a workflow with `browser: "current"` before it starts, and name the Bao profile as the place to run it.

Pinned agent-browser 0.41.0 sends daemon stdout to null and drops its startup stderr pipe on readiness. Firstmate 017 accepted complete CLI stdout/stderr and exposed startup errors, timings, runner events, and PID/config/version sidecars as the available evidence, not full daemon streams. No product or Rust instrumentation was added. Evidence is under `/Users/alexliu/dev/firstmate/data/bao-current-chrome-attach/`: `route-016/result-review.md`, `route-016/capture-summary.json`, `route-016/proof/receipt.json`, and the original `guarded-six/proof-route/events.jsonl`. See the [pinned CLI connection code](https://raw.githubusercontent.com/vercel-labs/agent-browser/v0.41.0/cli/src/connection.rs).

## Evidence

Each session creates one `kind: "capture"` run in the Library home Bao.app reads. See [Runs and Detailed evidence](v1.md#install-and-run) for the desktop controls that expose commands, screenshots, and native output. The capture receipt remains recording-only, with no replay or teaching actions; a separately saved workflow appears in Workflows. The capture omits Identity and Snapshot inspectors. Durable replay identities and observed effects live in the saved workflow's trail. Capture runs do not claim to count the outside agent's model calls or establish replay green status.

Each step stores its exact command and argv, native stdout/stderr and exit codes, error flag, start/end times, and its sentence (`summary`). Bao saves a pending `open` before startup and updates the run atomically as results arrive. Startup failure produces a failed run with its original error and no invented picture. Uncatchable process termination can leave readable partial runs marked `recording`; handled stops finish the run as described in [Session end](#session-end).

Bao takes a separate page screenshot through CDP on the active tab after each ordinary command, with a three-second deadline. Owner handoffs and every `wait_for_owner` call omit page pictures and native screenshot copies. This does not change native refs or screenshot history. Native screenshot files, including relative and default paths, are copied into `shots/runs/<runId>/` before the private state directory disappears. After `close`, the step records the missing page rather than reusing a picture. A recording or screenshot failure logs a warning without changing native command forwarding.

**Raw command arguments, results, and screenshots can contain credentials. This route does not redact them. Do not send data you do not want saved locally.** Saved-workflow input persistence is a separate contract in [permissions](permissions.md#secret-text-in-saved-files).

## Native executable and tests

Version and platform checksums live in `desktop/packaging/agent-browser-pin.json`. [Mac packaging](mac-build.md#fresh-setup) stages and signs the executable. For a checkout, run `node desktop/packaging/stage-agent-browser.mjs <temporary-directory>` and set `BAO_AGENT_BROWSER` to its `agent-browser` file. Installed builds use the bundled file.

`BAO_AGENT_BROWSER_PROFILE_ROOT` supplies a synthetic source root for fixtures. With `BAO_TEST_BROWSER`, copy tests require that explicit source and launch only the pinned test browser, with mock-keychain and media-denial flags. Current-Chrome tests use Chrome for Testing on a throwaway profile with the unpacked Bao extension and a Bao app on a throwaway home. Never supply a real profile to a fixture test.

`bao-profile.test.ts` covers selected-site cookie/localStorage import, cookie freshness, sign-in redirects, signed-out visits, concurrent startup, renewed Bao logins across clean exits, kept-window reclaim, and the explicit browser choice. It does not prove IndexedDB login reuse or real-site authentication.

Focused coverage lives in `running-chrome.test.ts` (the relay and extension in Chrome for Testing), `current-chrome.test.ts`, `agent-browser-proxy.test.ts`, `agent-browser-proxy-close.test.ts`, `agent-browser-startup.test.ts`, and `agent-browser-session-end.test.ts` under `desktop/test/unit/`. The native `agent-browser-workflow.test.ts`, `current-chrome-background.test.ts`, and `experian-proxy.test.ts` cases use loopback fixtures and run in the required Experian lane with a staged binary and xvfb; local runs need `AGENT_BROWSER_PROXY_BINARY`. The three replay cases in `current-chrome-background.test.ts` need no binary and run only on macOS, locally or in the pipeline's Mac test step. They skip on Linux CI because Linux Chromium does not answer `Page.captureScreenshot` for a background tab. The separate opt-in native fixture is `desktop/test/live/agent-browser-proxy.test.ts`. Set `AGENT_BROWSER_PROXY_BINARY` to the staged executable. `AGENT_BROWSER_PROXY_ARTIFACTS` retains its output comparison and recording receipts. The fixture checks native output, durable page screenshots, partial/final runs, and cleanup on close, disconnect, and SIGTERM. It does not prove real-site login survival.
