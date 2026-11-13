# Agent acceptance

Use this engineering pass after a desktop change. Keep the short human pass in [mac-test.md](mac-test.md). Build the installed app from [mac-build.md](mac-build.md). A fixture pass does not prove real-site login survival or authorize a real-site action.

## Isolate every test

Use a temporary Bao home, a temporary Chrome source profile, and a temporary native-host config. Leave vendor model keys unset and set `BAO_HEAL_CURSOR_ACCOUNT=0`. Use Playwright's pinned Chromium, never the owner's daily Chrome or Library. `BAO_HOME` alone does not move native-host manifests; set a temporary HOME too.

Do not rebuild the helper, reset TCC, request Screen Recording, enable Apple Events JavaScript, or approve a permission prompt to make a test pass. Check the selected route against the [permission requirements](permissions.md#which-grant-each-job-needs).

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

Workflows opens a full-width list beside the sidebar, with no middle pane. For Capture navigation and access to Teach and Replay, check [Bao desktop v1](v1.md#install-and-run). Other screens retain the second-pane screens: Runs, Live, and Heals under Runs; Teach and Replay under Workflows. Settings shows a section index for Runs and heals, Mac permissions, Remote access, Logins, and AI help. Open Logins with Import a login… or the command list. Every screen remains reachable by keyboard and the command list. Opening a workflow or run keeps its place selected and moves focus to the content pane.

Use isolated historical fixtures for display checks, not as proof of recording or replay:

- **Empty Runs:** Needs you shows 0 and History says No runs yet. Open Workflows reaches Library.
- **Needs you:** Paused runs, pending heals, and failures appear above history. A failed pass-through capture does not; it stays in history. The count matches the items. Keeping or reverting a heal removes that item after refresh. The receipt links to Heals for review. The [Runs contract](v1.md#install-and-run) owns the pass-through exception.
- **Open receipt:** Open a saved-workflow run and a browser session without a saved workflow. Check the row name against the [Runs contract](v1.md#install-and-run), plus status, time, the browser lines that contract names, and the receipt body that contract names, including a run longer than 20 steps. Edit or remove the saved workflow, then reopen its run: stored reasons, read-backs, owner requests, and available step pictures must remain readable. Detailed evidence still exposes the existing local picture, video, input, and debug controls. A failed receipt read offers Retry and allows another run to open.
- **Run history:** Check selection, grouping, row details, long names, and Record against the [Runs contract](v1.md#install-and-run). Unknown dates appear last. Each row’s accessible name is the name in the [Runs contract](v1.md#install-and-run), never its raw run id.
- **Connection recovery:** Fail the first state request. Check the connection-error card and Retry. Restore the server and retry without reloading; Runs and history appear instead of a silent empty screen.
- **Access and layout:** Tab through rows and receipt controls, check visible focus, then open a row with Enter. Check reduced motion, non-color status text, full accessible names, no horizontal overflow, and reachable scrollers at every width and zoom. Read the page, take before and after screenshots, and open each image.

## Check the Workflows list

Use isolated saved workflows in light and dark at the default window size, 720 px, 320 px, and 200% zoom.

- **List layout:** Check the title, count, Record button, search icon, and Name / Last run / When columns against the Inbox mock. There is no middle pane, input-chip wall, placeholder picture, or Schedule column. Bao does not store workflow schedules.
- **Long names:** Read the full name in the list, including long unbroken names. Tab to it, check visible focus, then press Enter to open the existing workflow detail. Run remains on that detail.
- **Last run:** Check newest-run order, status text with a glyph, local time with its zone, Not run yet, and Time not saved for a run without a timestamp.
- **Name search:** Open search with its header button or `/`. Filter names, try a name with no matches, then use Clear search. Focus returns to search and the list returns.
- **Damaged file:** Keep good workflows visible. Check the red warning glyph on Workflows, its text description, the banner, and the Can’t open row. Show in Finder opens this Library’s workflow folder. Open a damaged file’s name to show File details and recovery, then read the reason, path, and recovery steps. If the folder cannot open, check the plain error, the recovery control, and the path. Record again opens Capture. Restore the fixture file and check that the warning disappears after refresh.
- **Empty list:** Check No workflows yet with Record a task. With only damaged files, check No workflows can open instead. Check that Record reaches Capture and Teach remains reachable there.
- **Detail layout:** Open a workflow and compare its full, wrapping title, summary, site, numbered steps, input column, and inspector with the Inbox workflow mock. The middle screens pane is gone. Below 821 px the inspector follows the steps; selecting a step scrolls it into view. In the narrow native window, the 52-point band above the Workflows list matches the list surface in light and dark.
- **Step selection:** Tab to a step and press Enter or Space. Check its pressed state, highlighted row, inspector heading, target, input, check, and missed-step control. Show step help once. Show a real saved page picture only when it loads; missing pictures leave no placeholder. Try this step keeps its result on that step. Run from here opens the input form at that step without running earlier steps.
- **Inputs and actions:** Check the input count and saved defaults in the inspector, without a header full of chips. Edit inputs focuses the input list. Open an input, edit it, save it, then check that Run reads the new default. Check Guide me, Run, and Record. Open More actions for this workflow, then Share, Versions, and Edit workflow; check rename, export, and the JSON editor without deleting the fixture.
- **History and recovery:** Check newest-first recent runs and open a receipt. An empty workflow offers Record a task and says No runs yet. A failed workflow read offers Try again and Open Workflows. Retry must recover when the read works again; Back must reach the list.

## Check the helper only when its feature needs it

A Bao profile or a marked copy does not use the helper. Running Chrome, the default, does. For that route, the optional `bao mcp-ax` driver, and the separate remote-debugging CLI, see [Which grant each job needs](permissions.md#which-grant-each-job-needs). Check only the relevant permission bits without changing grants. Screen Recording affects native window capture, not page screenshots.

```sh
codesign --verify --strict /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
codesign -d -r- /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
codesign -dv /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
```

Compare the helper's identity with [Rebuild with an existing grant](mac-build.md#rebuild-with-an-existing-grant), or [Release Bao](release.md#signing) for Developer ID. The grant follows that identity, not a CDHash. Packaging checks `desktop/packaging/helper-identity.js` before compiling or signing. The helper is gitignored. This Bao needs a rebuilt BaoOSHelper that respawns itself with the disclaim spawn attribute. Do not copy the helper from an older installed app before packaging: that build does not disclaim.

For the existing extension host's separate grant check, use [extension.md](extension.md). Do not change its permissions as a pass-through workaround.

## Drive Chrome through MCP

Follow [Agent quickstart](agent-quickstart.md#mcp) using the [standard MCP tools](bao.md#mcp).

Against a local fixture and synthetic source profile, call `agent_browser` with `open`, inspect the native tab list, select the task tab, and use `snapshot`, `fill`, `click`, `press`, or `scroll`. Pass the latest result's `run_id` on every later command, including a continuation `open`, not only on `wait_for_owner`. Check each response before continuing. On a sign-in or human-check `halted` response, call `wait_for_owner` with that `run_id`, as [Wait for owner input in the same session](agent-browser-engine.md#wait-for-owner-input-in-the-same-session) says. Repeat `waiting`; on `ready`, take a fresh snapshot. A `closed` result ends that session. End normal work using the [task completion contract](agent-browser-engine.md#direct-mcp-commands).

Bao returns native output for ordinary commands and owner-wait status for handoffs. It records ordinary commands, page screenshots, and the Running Chrome tab video in Runs, but reads only URL/title and omits page pictures during owner waits. Successful single-document tasks save a replayable workflow at session end; unsupported tasks report why they remain capture-only. It does not block final clicks. Raw evidence can contain credentials. Do not claim saved-workflow redaction protects pass-through evidence. [Pass-through behavior](agent-browser-engine.md) owns the command, copy, recording, and cleanup contract.

A saved file that is not [schema v4](workflow-schema.md) is not loaded. Do not expect a retired-driver row. Workflows saved from pass-through tasks use the current replay engine, not native pass-through replay.

## Inspect evidence and cleanup

Open the running app's Library and Runs, not a component preview. Read the page before taking a screenshot, then open the image. Capture before and after for a UI change.

Check the run's saved command arguments, native results, start/end times, and page screenshots under `shots/runs/<runId>/`. Missing pictures must have a reason, not an older picture relabeled as current. For copied and Bao-owned profiles, check explicit close, closing the owned Chrome window during a live session, disconnect, MCP stop, and keep-open against the [profile lifecycle and cleanup contract](agent-browser-engine.md#session-end). Confirm the source profile and unrelated tabs remain unchanged.

For `browser: "current"`, start a separate GUI Chrome with a throwaway profile, no debugging launch flag, and mock-keychain flags. Seed only a synthetic local sign-in before connecting. Use the signed helper with its existing Accessibility grant; record `permissions-ax` without prompting. On the first MCP `open`, select `current`. Confirm the helper enables debugging and presses Allow, the first navigation opens a new tab, native form actions work, and the synthetic sign-in remains. Check Runs for command output and screenshots. Test both explicit `close` and MCP disconnect: the browser, its profile, and existing tabs must remain. Stop only the test-owned Chrome afterward. Never point this fixture pass at daily Chrome.

Historical live-driver workflows, runs, pictures, and videos stay local and readable. Their existence is not evidence that replay still works. Do not alter or delete historical records to make a new test pass.

## Run focused checks

Run `npm run check:static`, then only the tests for the changed path. The pass-through has unit coverage in `agent-browser-proxy.test.ts`, `agent-browser-proxy-close.test.ts`, `agent-browser-startup.test.ts`, and `agent-browser-session-end.test.ts`. The native local fixture is `desktop/test/live/agent-browser-proxy.test.ts`; it requires an explicitly staged `AGENT_BROWSER_PROXY_BINARY`. Keep model keys unset and source profiles synthetic.

The PR always runs [essential checks](guardrails.md). Choose `full-suite` when that set does not cover a shared engine, recording, replay, storage, packaging, or test-infrastructure change. State the choice and reason in the PR body. Never run the full suite on a daily profile.
