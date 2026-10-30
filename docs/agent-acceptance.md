# Accept an installed Bao on a Mac

This is the engineering pass for an installed app. The short human card is [Test Bao on a Mac](mac-test.md). Do not lengthen that card. Build steps stay in [Build Bao on a Mac](mac-build.md). Permission switches stay in [What Bao asks permission for](permissions.md).

Every check in this file needs a Mac with `/Applications/Bao.app` already installed from this tree, except `npm run typecheck` and `npm run test:v1` at the end. Those two also run on Linux. Do not rebuild BaoOSHelper, re-sign it, reset privacy permissions, or grant Accessibility or Screen Recording while you run these checks.

Leave `BAO_HOME` and `BAO_PORT` unset for the installed app. A Finder launch runs `src/print-home.cjs` inside the bundle to pick the library. It then starts `src/app/cli.js serve` with `--home` set to that library and `--port` set to `4787`. `desktop/src/library-home.cjs` makes that choice for the launcher, the CLI, `bao mcp`, and the live session. With no `--home` and no `BAO_HOME`, the library is `~/Library/Application Support/bao`. When that directory has no workflows or library data and `~/.local/share/bao` has them, Bao uses `~/.local/share/bao`. An explicit `--home` or `BAO_HOME` is used as given, even when it is empty. Do not open `http://127.0.0.1:4787` in a browser.

The checks below call the library `<home>`. With Bao open, read it from `/api/state`:

```sh
LIB=$(curl -s "http://127.0.0.1:4787/api/state" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).home))')
echo "$LIB"
```

Set `BAO_HEAL_CURSOR_ACCOUNT` to `0` before a checkout `bao serve`, a replay, or any test that `desktop/test/run-v1.mjs` or `desktop/test/run-live.mjs` does not spawn. A Finder launch cannot take that variable. If `model.label` is `cursor account`, do not cause a replay miss.

## Open Bao from Finder, then open it again

**Command.** In Finder, double-click `/Applications/Bao.app`. Do not start it from Terminal. Double-click the same app again.

**Expected.** The window title is **Bao**. There is no address bar. The second double-click focuses that window and does not start a second server. `desktop/packaging/macos/bao-main.c` calls `bao_focus_pid` when the instance lock is already held. When the launcher finds a second library with data, it shows one alert that names both directories. `print-home.cjs` records that line in `<home>/shown-notices.json`, so the second double-click and later launches do not show it again.

Record `helper.accessibility` and `helper.screenCapture` from `/api/state`. Stop this pass only when `helper.accessibility` is false. Do not change the grant. Live Chrome needs Accessibility only, so the live-session checks below run with Screen Recording on or off.

**Evidence.** Save the body of these commands next to your notes. They are not files the app writes for you.

```sh
curl -s "http://127.0.0.1:4787/api/state"
lsof -nP -iTCP:4787 -sTCP:LISTEN
lsof -nP "$LIB/instance.lock"
```

`helper.label` is `helper ok`, `helper needs permission`, or `helper off`. `helper ok` means both Accessibility and Screen Recording are granted. `helper.capabilities` has four rows: `ax-press`, `window-capture`, `live-chrome`, and `mcp-ax`. The `live-chrome` row has status `live Chrome ready` when Accessibility is on. `capabilityReport` in `desktop/src/helper-capabilities.ts` sets the label and the rows. While Bao is open, expect one listener on port 4787 and one `lsof` holder of `instance.lock`. `bao_instance_acquire` creates that file with `O_CREAT`. `bao_instance_release` only closes the fd. The file can remain after quit, so its presence is not evidence that Bao is running.

## Show that the running app is the installed bundle

**Command.** With Bao open from Finder, run these commands.

```sh
curl -s "http://127.0.0.1:4787/api/pids"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/Bao.app/Contents/Info.plist
lsof -a -c node -d cwd -Fn | grep Bao.app
/bin/ls /Applications/Bao.app/Contents/Resources/bao/src/print-home.cjs /Applications/Bao.app/Contents/Resources/bao/src/cdp-live/live-host.js
```

**Expected.** `helper` in the JSON is `/Applications/Bao.app/Contents/Resources/BaoOSHelper.app`. That path does not contain the git checkout. The plist prints `dev.bao.desktop`. `lsof` shows cwd `/Applications/Bao.app/Contents/Resources/bao`. `bao-main.c` changes to that directory inside the bundle before it runs `src/app/cli.js`. `desktop/packaging/macos/package-app.sh` stages the server, the public files, and the Node dependencies into the bundle through `desktop/packaging/stage-runtime.sh`. The installed app does not read this checkout. `/bin/ls` prints both paths. If either is missing, the installed app predates this tree, and the library and live-session checks below do not match it.

**Evidence.** `/Applications/Bao.app/Contents/Info.plist` and the `/api/pids` JSON.

## Check the signature and the helper identity

**Command.** Run these. Do not pass `--deep` to `codesign`. Do not run `desktop/os-helper-macos/package-app.sh`.

```sh
codesign --verify --strict "/Applications/Bao.app"
codesign --verify --strict "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app"
codesign -dv --verbose=4 "/Applications/Bao.app"
codesign -dv --verbose=4 "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app"
codesign -d -r- "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app/Contents/Info.plist"
```

**Expected.** Both `codesign --verify --strict` commands exit 0. The app identifier is `dev.bao.desktop`. The helper identifier is `dev.bao.oshelper`. The first helper `Authority` line is `bao dev signing`. The helper's designated requirement is `identifier "dev.bao.oshelper" and certificate leaf = H"a522e15d431a2f36ace451dd575a02e9e877fbd1"`, unless the certificate changed and the build set `BAO_HELPER_CERT_HASH`. `codesign` also prints a CDHash. It is not the pass condition. The grant follows the bundle id plus that signer.

`desktop/packaging/macos/package-app.sh` runs `desktop/packaging/helper-identity.js` on `desktop/os-helper-macos/BaoOSHelper.app`, or on `BAO_HELPER_APP` when that is set. It exits before it compiles or signs when the helper is missing, is not a bundle, is ad-hoc, is not `dev.bao.oshelper`, or does not carry the designated requirement above. The helper app is gitignored, so a fresh worktree has no helper. Before packaging, copy the signed helper out of `/Applications/Bao.app/Contents/Resources/BaoOSHelper.app` into `desktop/os-helper-macos/BaoOSHelper.app`. `helperBin` in `desktop/src/cdp-live/ax.ts` ignores a missing `BAO_OS_HELPER` and a value that is not an existing `.app`. An existing `.app` path is used with no signature check.

**Evidence.** The `codesign` stdout. The identity in the tree is `desktop/os-helper-macos/Info.plist`. The pinned hash is `PINNED_CERT_HASH` in `desktop/packaging/helper-identity.js`.

## Check the extension host grant

**Command.** Finder launch runs `src/app/cli.js serve`, and that command installs the native host. `startApp` passes `defaultConfigHome()`, which is the real home directory, to `startExtensionLink`, so the manifest lands under Chrome's NativeMessagingHosts directory even when `BAO_HOME` points somewhere else. On a Mac that already has Bao.app, run a checkout `bao serve` only when asked. Then quit it and reopen Bao from Finder. After the window is up, run these. Do not print the token file.

```sh
/bin/ls -l "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json"
node -e 'const fs=require("fs"); const os=require("os"); const path=require("path"); const p=path.join(os.homedir(),"Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json"); const d=JSON.parse(fs.readFileSync(p,"utf8")); console.log(d.name); console.log(d.path); console.log(d.allowed_origins.join("\n"));'
stat -f '%Lp' "$LIB/extension-host/token"
grep -F '/Applications/Bao.app/Contents/Resources/bao/src/extension/native-host.js' "$LIB/extension-host/bao-native-host.sh"
```

**Expected.** The manifest `name` is `com.bao.desktop`. `d.path` is `<home>/extension-host/bao-native-host.sh`. `allowed_origins` is only `chrome-extension://jcjcpblcjaakcmbgljdjkfgmmdfdbnfj/`. The token mode is `600`. The manifest does not contain the token. The token stays in `extension-host/token` under the library. `desktop/src/extension/link.ts` writes that file with mode `0600`. The `grep` exits 0. The wrapper's host script is the copy inside the installed bundle.

The hello frame is not a Mac check. `link.ts` stores whatever `extensionId` arrives on hello. Only the auth frame is checked against `EXTENSION_ID`. This pass does not look for a hello.

**Evidence.** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json` and the wrapper path above. The token file is evidence of mode only. Do not copy its contents into the report.

## Update a live session

`bao live_session_start`, `live_snapshot`, `live_click`, `live_type`, `live_key`, `live_scroll`, `live_screenshot`, and `live_stop` are CLI verbs. `bao mcp` serves the same eight names as MCP tools. `docs/cdp-live-chrome.md` describes each one, and `LIVE_TOOLS` in `desktop/src/cdp-live/live-ops.ts` defines them. Both post each call to the running app's `POST /api/live`. `serverPort` in `desktop/src/home.ts` finds the app from `server.json` in the library. The host is `desktop/src/cdp-live/live-host.ts`.

**Command.** Run this only when the task names the start URL, the preset, and the Chrome to attach to. Attach to a throwaway Chrome, never the daily profile. `desktop/test/live/live-fixture.test.ts` uses the Chrome for Testing inside the installed app with a temp profile, as here.

```sh
PROFILE=$(mktemp -d)
"/Applications/Bao.app/Contents/Resources/Chromium.app/Contents/MacOS/Google Chrome for Testing" \
  --user-data-dir="$PROFILE" --remote-debugging-port=0 --no-first-run --no-default-browser-check --disable-sync about:blank &
CLI=/Applications/Bao.app/Contents/Resources/bao/src/app/cli.js
node "$CLI" live_session_start --home "$LIB" --intent "<intent>" --url "<start url>" --port-file "$PROFILE/DevToolsActivePort" --preset generic
node "$CLI" live_snapshot --home "$LIB"
node "$CLI" live_scroll --home "$LIB" --direction down
node "$CLI" live_snapshot --home "$LIB" --page 2
node "$CLI" live_screenshot --home "$LIB"
curl -s "http://127.0.0.1:4787/api/live-session/shots/shot-001.png" -o /tmp/bao-shot-001.png
```

**Expected.** Each call prints one JSON reply with `op`, `session`, `outcome`, `view`, and `shot`. `live_session_start` opens one new window in that Chrome and replies with `outcome.kind` `applied` unless the page halts. `view.controls` lists up to 50 controls with refs, in page order. `view.page`, `view.pages`, and `view.controlsTotal` give the paging. `live_snapshot --page 2` returns the second page of the last read without reading the page again, so its refs still work. `live_scroll` replies with a new read plus `scroll`, whose `moved` is false when that edge was already reached. A label that matches the preset's deny or confirm labels is listed in `view.stopBeforeConfirm` and has no ref. Under every preset, so are checkout, place order, pay now, buy now, confirm purchase, submit order, and complete purchase (`COMMIT_FLOOR` in `desktop/src/cdp-live/presets.ts`). A form's submit button is listed there too, unless the form is a search form or the preset allows its label. Credential fields are counted in `view.credentialFields` and have no ref. `shot` names a file such as `shot-001.png`. The CLI exits 1 when the reply is `rejected`, and 2 when it is `refused` or `halted`. With the grant off, the start is `rejected` with `BaoOSHelper accessibility is not granted`. Right after Chrome opens, the start can be `rejected` with `BaoOSHelper cannot see a Chrome window`. `live-fixture.test.ts` waits and starts again. A second start while one is open is `rejected` with `busy`.

After each call except `live_snapshot --page`, `liveSession` in `/api/state` has a new audit row. `GET /api/live-session/shots/shot-001.png` returns the first shot. A name that is not `shot-NNN.png` returns 404. `shotNameOk` in `desktop/src/cdp-live/live-record.ts` is that rule.

**Evidence.** `<home>/live-session/session.json` and `<home>/live-session/shots/shot-NNN.png`. `SessionLog` in `desktop/src/cdp-live/audit.ts` writes both. Each `live_click`, `live_type`, `live_key`, and `live_scroll` that goes through appends a line to `<home>/live-session/trail.jsonl`. When the helper presses Allow, it appends a row to `<home>/live-session/ax.jsonl`.

## Stop a live session and replay it

**Command.** Stop the session, then replay the saved workflow from the app. The workflow id is `wf-` plus a slug of the intent, or the `--workflow-id` you passed when it starts with `wf-`.

```sh
node "$CLI" live_stop --home "$LIB"
node "$CLI" live_stop --home "$LIB"
curl -s -X POST -H 'content-type: application/json' -d '{"id":"<workflow id>","args":{}}' "http://127.0.0.1:4787/api/replay"
```

**Expected.** The first `live_stop` replies `outcome.kind` `stopped` with `already` false. The second replies `stopped` with `already` true and writes nothing. `live_stop` saves the workflow, with driver `cdp-live`, in `<home>/workflows/`. It is built from the session's trail: typed text is an input, except a search box's text, which the workflow types again as recorded. A session with no step saves nothing. `session.json` gets status `passed`, `failed` after a refusal, or `needs_human` after a halt. The stop closes the session's window and socket, then releases `/tmp/bao-cdp-session.lock`. The replay opens its own window in the same live target and runs every step with no approval step. Its reply is the run, with `status` `passed`, `modelCalls` 0, and `id` equal to `runId`. It types the search text the session typed. When the item is already in the cart, the Add step's `reason` is `already done`. A replay while a session is open returns HTTP 409 with an `error`. `bao mcp`'s `run_workflow` replays the same workflow through the app and returns `outcome` `ok`.

While a session or a replay is open, `watchNewTargets` in `live-act.ts` closes any new page target and halts with `new_target`. That covers a tab the page opens and a tab a person opens. Tabs that were open before the session or replay started stay open. The live host and the replay call `Target.closeTarget` only on their own window and on those new page targets.

**Evidence.** `<home>/live-session/session.json`, `<home>/workflows/<workflow id>.json`, and the replay JSON.

## The session script

`desktop/src/cdp-live/session.ts` is a separate runner. It writes its own evidence directory. It also writes `live-session/session.json` in the library `resolveHome` picks, which is normally `<home>`, so it replaces the app's last live record. It attaches to the Chrome that owns the default `DevToolsActivePort` file under `~/Library/Application Support/Google/Chrome`. Never list the Chrome profile directory. Compile with `npm run build:desktop`. Run `node desktop/dist/desktop/src/cdp-live/session.js` from an empty directory, and only when the task names the exact host list and the start URL. Pass `--intent` and either `--preset generic|instacart|books` or all of `--hosts`, `--start`, `--deny`, `--commit`, `--stop-path`, and `--reached`. An explicit flag replaces that field of the preset. Optional flags are `--inbox`, `--attach-path`, `--agent`, `--lock`, and `--workflow-id`. A host must be an exact name. The process writes `.evidence/` under `process.cwd()`. In this checkout, `.gitignore` covers every file it writes there. Never commit `.evidence/` from a live session.

**Command.** For an attached tab, pass `--attach-path` as a pathname on the start URL. `main` truncates `.evidence/session-inbox.txt` after it takes the lock. Append a line `stop` only after the process is in its read loop. That loop has no timeout.

**Expected.** The run finishes with status `needs_human` and exit code 2. `confirmClicked` is assigned false once and the `passed` arm cannot run, so `confirmClicked is false` cannot fail a check. Expect no step label and no audit label that matches `--commit`. `clickAllowed` refuses kind `submit`, `radio`, `check`, and `other`. It refuses a button whose label matches `--commit`. A link stays allowed unless `--deny` matches, including an anchor whose role is `button`. Put the commit words in `--deny` as well. When `--attach-path` is set and the context check after `end` succeeds, `context.attachedStillOpen` is true and `context.closedTarget` is false. `end` on an attached driver calls `Target.detachFromTarget` and does not call `Target.closeTarget`. A window the script itself opened is closed on `end`, because that driver does not preserve the target. Tabs that were already open stay open.

**Evidence.** `.evidence/session-run.json` in the empty working directory. `context` in that file holds `attachedStillOpen` and `closedTarget`. Do not commit that file.

## Redaction and profile leakage

**Command.** After an authorized session, inspect `<home>/live-session/session.json`, and `.evidence/session-run.json` when the session script ran. With no profile, `npm run test:v1` already asserts `redactText`, `redactLabel`, and `shotNameOk` in `desktop/test/unit/cdp-live.test.ts`, and the live guards in `desktop/test/unit/live-guards.test.ts` and `desktop/test/unit/live-session.test.ts`.

**Expected.** An email is removed. A greeting is stored as `[greeting]` in the session-script output. `redactLabel` drops a password word. It also drops `$1.29`. The same pattern leaves `,.56` from `$1,234.56`. Paths in the public session keep a pathname, not a full URL with a query. `readSurface` does not read `document.cookie`. A live reply does not carry cookie or storage keys. `publicLiveResult` in `desktop/src/cdp-live/live-ops.ts` strips them. The report contains no extension token, no Chrome profile listing, and no `DevToolsActivePort` browser-path secret.

The live host and `desktop/src/cdp-live/instacart-run.ts` take each shot with `captureRedacted` in `desktop/src/cdp-live/driver.ts`. That lays the full-page veil `redactOverlay` over the page first. The session script uses `redactForShot` in `desktop/src/cdp-live/attach.ts` instead. It blurs only the nodes it matches, such as an email or a price. A count of 0 still writes the PNG. A plain name and a Place order button stay readable in those shots.

**Evidence.** `<home>/live-session/session.json` and its shots. When the session script ran, also `.evidence/session-run.json` and `.evidence/frames/` in the empty directory. Do not commit any `.evidence/` file from a live session.

## Evidence paths and failure logs

These are the files a run actually writes.

- The Finder instance lock is `<home>/instance.lock`. The file can remain after quit.
- The library-split alert record is `<home>/shown-notices.json`.
- Product state is the body of `curl -s http://127.0.0.1:4787/api/state`.
- The installed helper path is the body of `curl -s http://127.0.0.1:4787/api/pids`.
- With `BAO_RUN_VIDEO=1`, `openReplay` in `desktop/src/app/server.ts` passes `<home>/videos/incoming` to `launchOwnedChrome`, which gives it to Playwright as `recordVideo.dir`. `keepReplayClip` copies that clip to `<home>/videos/<runId>.webm` when it has a `runId`. `close()` calls `keepReplayClip`. `runRecorded` passes the same dest to `openReplayVideo` in `desktop/src/v1/replay-video.ts`. On a Mac with `BAO_HEADED=1`, a `BaoWindowVideo.app`, and a Screen Recording probe that passes, `encodeWebm` writes that dest from the window recorder. It needs an ffmpeg from `FFMPEG`, `which ffmpeg`, `/opt/homebrew/bin/ffmpeg`, or `/usr/local/bin/ffmpeg`, and a file over 1000 bytes. A Finder launch sets `BAO_HEADED=1`. `BaoWindowVideo` is signed as `dev.bao.oshelper`.
- A live session record is `<home>/live-session/session.json`.
- A live session shot is `<home>/live-session/shots/shot-NNN.png`.
- The live host's Allow log is `<home>/live-session/ax.jsonl`.
- A live session trail is `<home>/live-session/trail.jsonl`. A new session empties it.
- A saved live workflow is `<home>/workflows/<workflow id>.json`.
- The live lock is `/tmp/bao-cdp-session.lock`. The live host and the session script share it.
- The session script result is `.evidence/session-run.json` under the process working directory.
- The session script drafts are `.evidence/session-workflow.json` and, when `--attach-path` validates, `.evidence/unfreeze-workflow.json`. A live run writes them again.
- Session script shots are under `.evidence/frames/`.
- The session script's accessibility log is `.evidence/cdp-live-ax.jsonl`.
- The stop inbox is `.evidence/session-inbox.txt`. Startup truncates it.

In this checkout, `.gitignore` covers every `.evidence/` path above. `.evidence/README.md` lists them.

**Failure log.** A `bao live_*` call prints its reply JSON on stdout. When the app is not running, it prints `Bao is not running. Open the Bao app, or run: <serve command>` on stderr and exits 1. The session script writes progress to stderr. A thrown error is one stderr line from `safeError`, with URLs replaced by `[url]`, then exit code 1. An `AxUnavailable` error also prints its summary JSON on stderr. A finished run whose `status` is not `passed` still writes `.evidence/session-run.json` and exits 2. A stop takes that path with status `needs_human`. There is no other failure log file.

## Desktop unit suite

This does not replace the Mac checks. A non-zero `npm run test:v1` fails this pass.

```sh
npm run typecheck
npm run test:v1
```

`npm run typecheck` runs the root, desktop, extension, and `web` typechecks. `npm run test:v1` is the desktop unit suite. It compiles the desktop tree, runs `desktop/test/unit`, uses throwaway homes, and does not request public hosts. The runner drops `CI`, the vendor model keys, and every inherited `BAO` name, then sets `BAO_HEAL_CURSOR_ACCOUNT` to `0`. It sets `BAO_TEST_BROWSER` to Playwright's Chromium and stops when that binary is missing. Run `npx playwright install chromium` to get it. Every owned launch then starts that binary with the mock keychain flags, so the suite does not open the installed Google Chrome or the login keychain. The public demos, `automationintesting.online`, `www.irs.gov`, and `the-internet.herokuapp.com`, are in `desktop/test/live/files-dates-public.test.ts`. They run only through `desktop/test/run-live.mjs`, which sets `BAO_LIVE_TESTS=1`. A skip in that live lane does not waive a failure of the required suite.
