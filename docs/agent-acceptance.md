# Agent acceptance

Use this engineering pass after a desktop change. Keep the short human pass in [mac-test.md](mac-test.md). Build the installed app from [mac-build.md](mac-build.md). A fixture pass does not prove real-site login survival or authorize a real-site action.

## Isolate every test

Use a temporary Bao home, a temporary Chrome source profile, and a temporary native-host config. Leave vendor model keys unset and set `BAO_HEAL_CURSOR_ACCOUNT=0`. Use Playwright's pinned Chromium, never the owner's daily Chrome or Library. `BAO_HOME` alone does not move native-host manifests; set a temporary HOME too.

Do not rebuild the helper, reset TCC, request Screen Recording, enable Apple Events JavaScript, or approve a permission prompt to make a test pass. The pass-through does not need Accessibility, Automation, or Screen Recording.

## Open the installed app

Open `/Applications/Bao.app` from Finder. The window title is **Bao**, with no address bar. The Dock shows one Bao app, not a second Chrome for Testing app. Opening Bao starts no Chrome or Chromium process; macOS WebKit renders the UI inside Bao's native window. Open it again and check that it focuses the same window without starting another app server. Close the window, then click Bao in the Dock: the same window reopens. Quit Bao: its local server stops. Use `bao status` to confirm the Library home. Do not start a checkout `bao serve` beside the installed app: its native-host write can replace the installed manifest.

Check bundle identity and the running server's checkout:

```sh
codesign --verify --strict /Applications/Bao.app
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/Bao.app/Contents/Info.plist
lsof -a -c node -d cwd -Fn
/bin/ls /Applications/Bao.app/Contents/Resources/bao/src/print-home.cjs /Applications/Bao.app/Contents/Resources/bao/src/engines/agent-browser-proxy.js
```

The app identifier is `dev.bao.desktop`. The server's cwd should point inside Bao.app, not a development checkout. The MCP launcher is `/Applications/Bao.app/Contents/MacOS/bao-mcp`.

## Check the helper only when its feature needs it

The pass-through does not use the helper. Native Accessibility and window-capture features still do. Check both helper permission bits without changing grants. Accessibility blocks those live-helper operations; Screen Recording affects window capture, not page screenshots.

```sh
codesign --verify --strict /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
codesign -d -r- /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
codesign -dv /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
```

The helper identifier is `dev.bao.oshelper`; its first Authority is `bao dev signing`. Its designated requirement is `identifier "dev.bao.oshelper" and certificate leaf = H"a522e15d431a2f36ace451dd575a02e9e877fbd1"`, unless the build explicitly changed `BAO_HELPER_CERT_HASH`. The grant follows that identity, not a CDHash. Packaging checks `desktop/packaging/helper-identity.js` before compiling or signing. The helper is gitignored; a new worktree must copy the signed helper from the installed app before packaging, not rebuild it.

For the existing extension host's separate grant check, use [extension.md](extension.md). Do not change its permissions as a pass-through workaround.

## Drive Chrome through MCP

Follow [Agent quickstart](agent-quickstart.md#mcp). The advertised tools are `search_workflows`, `describe_workflow`, `run_workflow`, `get_run`, and `agent_browser`. The MCP process needs no running Bao.app for those tools.

Against a local fixture and synthetic source profile, call `agent_browser` with `open`, inspect the native tab list, select the task tab, and use `snapshot`, `fill`, `click`, `press`, or `scroll`. Check each response before continuing. On a sign-in or human-check `halted` response, call `wait_for_owner` in the same session. Repeat `waiting`; on `ready`, take a fresh snapshot. A `closed` result ends that session. End normal work with `close`.

Bao returns native output for ordinary commands and owner-wait status for handoffs. It records ordinary commands and page screenshots in Runs, but reads only URL/title and omits page pictures during owner waits. It does not create a replayable workflow or block final clicks. Raw evidence can contain credentials. Do not claim saved-workflow redaction protects pass-through evidence. [Pass-through behavior](agent-browser-engine.md) owns the command, copy, recording, and cleanup contract.

Saved workflows whose driver is `cdp-live` must remain readable. Their Library card and Replay form must say the workflow used the retired live driver. Replay and MCP must refuse before opening a browser with `this workflow used the retired live driver`. No pass-through replay layer exists yet.

## Inspect evidence and cleanup

Open the running app's Library and Runs, not a component preview. Read the page before taking a screenshot, then open the image. Capture before and after for a UI change.

Check the run's saved command arguments, native results, start/end times, and page screenshots under `shots/runs/<runId>/`. Missing pictures must have a reason, not an older picture relabeled as current. Explicit close and closing the owned Chrome window during a live session must finish the run and remove only its marked profile copy. Disconnect or MCP stop must do the same by default. With keep-open on, confirm that disconnect or stop finishes the run but keeps the window and copy until the next session reclaims them. Confirm the source profile and unrelated tabs remain unchanged.

Historical live-driver workflows, runs, pictures, and videos stay local and readable. Their existence is not evidence that replay still works. Do not alter or delete historical records to make a new test pass.

## Run focused checks

Run `npm run check:static`, then only the tests for the changed path. The pass-through has unit coverage in `agent-browser-proxy.test.ts`, `agent-browser-proxy-close.test.ts`, `agent-browser-startup.test.ts`, and `agent-browser-session-end.test.ts`. The native local fixture is `desktop/test/live/agent-browser-proxy.test.ts`; it requires an explicitly staged `AGENT_BROWSER_PROXY_BINARY`. Keep model keys unset and source profiles synthetic.

The PR always runs [essential checks](guardrails.md). Choose `full-suite` when that set does not cover a shared engine, recording, replay, storage, packaging, or test-infrastructure change. State the choice and reason in the PR body. Never run the full suite on a daily profile.
