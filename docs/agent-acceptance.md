# Agent acceptance

Use this engineering pass after a desktop change. Keep the short human pass in [mac-test.md](mac-test.md). Build the installed app from [mac-build.md](mac-build.md). A fixture pass does not prove real-site login survival or authorize a real-site action.

## Isolate every test

Use a temporary Bao home, a temporary Chrome source profile, and a temporary native-host config. Leave vendor model keys unset and set `BAO_HEAL_CURSOR_ACCOUNT=0`. Use Playwright's pinned Chromium, never the owner's daily Chrome or Library. `BAO_HOME` alone does not move native-host manifests; set a temporary HOME too.

Do not rebuild the helper, reset TCC, request Screen Recording, enable Apple Events JavaScript, or approve a permission prompt to make a test pass. The pass-through does not need Accessibility, Automation, or Screen Recording.

## Open the installed app

Open `/Applications/Bao.app` from Finder. Check the native window against [Mac launch](mac-build.md#launch), including the drag strip and title-bar double-click setting. The Dock shows one Bao app, not a second Chrome for Testing app. Opening Bao starts no Chrome or Chromium process; macOS WebKit renders the UI inside Bao's native window. Open it again and check that it focuses the same window without starting another app server. Close the window, then click Bao in the Dock: the same window reopens. Quit Bao: its local server stops. Use `bao status` to confirm the Library home. Do not start a checkout `bao serve` beside the installed app: its native-host write can replace the installed manifest.

Check bundle identity and the running server's checkout:

```sh
codesign --verify --strict /Applications/Bao.app
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/Bao.app/Contents/Info.plist
lsof -a -c node -d cwd -Fn
/bin/ls /Applications/Bao.app/Contents/Resources/bao/src/print-home.cjs /Applications/Bao.app/Contents/Resources/bao/src/engines/agent-browser-proxy.js
```

The app identifier is `dev.bao.desktop`. The server's cwd should point inside Bao.app, not a development checkout. The MCP launcher is `/Applications/Bao.app/Contents/MacOS/bao-mcp`.

## Check the three places and Runs

Check the running app in light and dark at the default window size, 720 px, 320 px, and 200% zoom. Runs opens first. The sidebar contains exactly Runs, Workflows, and Settings. At narrow widths, Show sidebar opens Places; Escape closes it and returns focus.

Workflows opens a full-width list beside the sidebar, with no middle pane. Record opens Capture. Capture’s Teach button and the command list keep Teach reachable; the command list also opens Replay. Other screens retain the second-pane screens: Runs, Live, and Heals under Runs; Library, Capture, Teach, and Replay under Workflows; Settings and Logins under Settings. Every screen remains reachable by keyboard and the command list. Opening a workflow or run keeps its place selected and moves focus to the content pane.

Use isolated historical fixtures for display checks, not as proof of recording or replay:

- **Empty Runs:** Needs you shows 0 and History says No runs yet. Open Workflows reaches Library.
- **Needs you:** Paused runs, pending heals, and failures appear above history. The count matches the items. Keeping or reverting a heal removes that item after refresh. The receipt links to Heals for review.
- **Run history:** Several local days appear newest first, with rows sorted by time within each day. Unknown dates appear last. Each row’s accessible name is its workflow name, never its raw run id. Long names wrap and stay leading-aligned. Model calls appear only when recorded, including a known zero.
- **Open receipt:** Open a saved-workflow run and a browser session without a saved workflow. Check the workflow name, status, time, step results, and paged receipts beyond 20 steps. Edit or remove the saved workflow, then reopen its run: stored reasons, read-backs, owner requests, and available step pictures must remain readable. Detailed evidence still exposes the existing local picture, video, input, and debug controls. A failed receipt read offers Retry and allows another run to open.
- **Connection recovery:** Fail the first state request. Check the connection-error card and Retry. Restore the server and retry without reloading; Runs and history appear instead of a silent empty screen.
- **Access and layout:** Tab through rows and receipt controls, check visible focus, then open a row with Enter. Check reduced motion, non-color status text, full long names, no horizontal overflow, and reachable scrollers at every width and zoom. Read the page, take before and after screenshots, and open each image.

## Check the Workflows list

Use isolated saved workflows in light and dark at the default window size, 720 px, 320 px, and 200% zoom.

- **List layout:** Check the title, count, Record button, search icon, and Name / Last run / When columns against the Inbox mock. There is no middle pane, input-chip wall, placeholder picture, or Schedule column. Bao does not store workflow schedules.
- **Long names:** Read the full name in the list, including long unbroken names. Tab to it, check visible focus, then press Enter to open the existing workflow detail. Run remains on that detail.
- **Last run:** Check newest-run order, status text with a glyph, local time with its zone, Not run yet, and Time not saved for a run without a timestamp.
- **Name search:** Open search with its header button or `/`. Filter names, try a name with no matches, then use Clear search. Focus returns to search and the list returns.
- **Damaged file:** Keep good workflows visible. Check the red warning glyph on Workflows, its text description, the banner, and the Can’t open row. Show in Finder opens this Library’s workflow folder. Open a damaged file’s name to show File details and recovery, then read the reason, path, and recovery steps. If the folder cannot open, check the plain error, the recovery control, and the path. Record again opens Capture. Restore the fixture file and check that the warning disappears after refresh.
- **Empty list:** Check No workflows yet with Record a task. With only damaged files, check No workflows can open instead. Check that Record reaches Capture and Teach remains reachable there.

## Check the helper only when its feature needs it

The pass-through does not use the helper. The optional `bao mcp-ax` driver uses Accessibility and window capture for Calculator and TextEdit. The separate remote-debugging CLI uses Accessibility and Automation for Chrome's debugging switch. Check only the relevant permission bits without changing grants. Screen Recording affects native window capture, not page screenshots.

```sh
codesign --verify --strict /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
codesign -d -r- /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
codesign -dv /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
```

The helper identifier is `dev.bao.oshelper`; its first Authority is `bao dev signing`. Its designated requirement is `identifier "dev.bao.oshelper" and certificate leaf = H"a522e15d431a2f36ace451dd575a02e9e877fbd1"`, unless the build explicitly changed `BAO_HELPER_CERT_HASH`. The grant follows that identity, not a CDHash. Packaging checks `desktop/packaging/helper-identity.js` before compiling or signing. The helper is gitignored; a new worktree must copy the signed helper from the installed app before packaging, not rebuild it.

For the existing extension host's separate grant check, use [extension.md](extension.md). Do not change its permissions as a pass-through workaround.

## Drive Chrome through MCP

Follow [Agent quickstart](agent-quickstart.md#mcp) using the [standard MCP tools](bao.md#mcp).

Against a local fixture and synthetic source profile, call `agent_browser` with `open`, inspect the native tab list, select the task tab, and use `snapshot`, `fill`, `click`, `press`, or `scroll`. Check each response before continuing. On a sign-in or human-check `halted` response, call `wait_for_owner` in the same session. Repeat `waiting`; on `ready`, take a fresh snapshot. A `closed` result ends that session. End normal work with `close`.

Bao returns native output for ordinary commands and owner-wait status for handoffs. It records ordinary commands and page screenshots in Runs, but reads only URL/title and omits page pictures during owner waits. It does not create a replayable workflow or block final clicks. Raw evidence can contain credentials. Do not claim saved-workflow redaction protects pass-through evidence. [Pass-through behavior](agent-browser-engine.md) owns the command, copy, recording, and cleanup contract.

Saved workflows whose driver is `cdp-live` must remain readable. Their Workflows row and Replay form must say the workflow used the retired live driver. Replay and MCP must refuse before opening a browser with `this workflow used the retired live driver`. No pass-through replay layer exists yet.

## Inspect evidence and cleanup

Open the running app's Library and Runs, not a component preview. Read the page before taking a screenshot, then open the image. Capture before and after for a UI change.

Check the run's saved command arguments, native results, start/end times, and page screenshots under `shots/runs/<runId>/`. Missing pictures must have a reason, not an older picture relabeled as current. Explicit close and closing the owned Chrome window during a live session must finish the run and remove only its marked profile copy. Disconnect or MCP stop must do the same by default. With keep-open on, confirm that disconnect or stop finishes the run but keeps the window and copy until the next session reclaims them. Confirm the source profile and unrelated tabs remain unchanged.

Historical live-driver workflows, runs, pictures, and videos stay local and readable. Their existence is not evidence that replay still works. Do not alter or delete historical records to make a new test pass.

## Run focused checks

Run `npm run check:static`, then only the tests for the changed path. The pass-through has unit coverage in `agent-browser-proxy.test.ts`, `agent-browser-proxy-close.test.ts`, `agent-browser-startup.test.ts`, and `agent-browser-session-end.test.ts`. The native local fixture is `desktop/test/live/agent-browser-proxy.test.ts`; it requires an explicitly staged `AGENT_BROWSER_PROXY_BINARY`. Keep model keys unset and source profiles synthetic.

The PR always runs [essential checks](guardrails.md). Choose `full-suite` when that set does not cover a shared engine, recording, replay, storage, packaging, or test-infrastructure change. State the choice and reason in the PR body. Never run the full suite on a daily profile.
