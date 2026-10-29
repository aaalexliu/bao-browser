# Accept an installed Bao on a Mac

This is the engineering pass for an installed app. The short human card is [Test Bao on a Mac](mac-test.md). Do not lengthen that card. Build steps stay in [Build Bao on a Mac](mac-build.md). Permission switches stay in [What Bao asks permission for](permissions.md).

Every check in this file needs a Mac with `/Applications/Bao.app` already installed, except `npm run typecheck` and `npm run test:v1` at the end. This Linux checkout cannot open Finder, sign a bundle, or attach to Chrome. Do not rebuild BaoOSHelper, re-sign it, reset privacy permissions, or grant Accessibility or Screen Recording while you run these checks.

Leave `BAO_HOME` and `BAO_PORT` unset for the installed app. Finder starts `src/app/cli.js serve` with `--home` set to `~/Library/Application Support/bao` and `--port` set to `4787`. That `--home` path is the installed server home. `liveSessionDir()` in `desktop/src/cdp-live/audit.ts` defaults to `~/.local/share/bao/live-session` unless `BAO_HOME` is set or a home is passed. `defaultHome()` in `desktop/src/app/cli.ts` is `~/.local/share/bao` when `--home` is omitted. Those are different directories on this checkout. After pull request 133, `resolveHome()` in `desktop/src/home.ts` picks `--home`, then `BAO_HOME`, then `~/Library/Application Support/bao` on darwin, and `liveSessionDir()` uses that home. Do not open `http://127.0.0.1:4787` in a browser.

Set `BAO_HEAL_CURSOR_ACCOUNT` to `0` before a checkout `bao serve`, a replay, or any test `desktop/test/run-v1.mjs` does not spawn. A Finder launch cannot take that variable. If `model.label` is `cursor account`, do not cause a replay miss.

## Open Bao from Finder, then open it again

**Command.** In Finder, double-click `/Applications/Bao.app`. Do not start it from Terminal. Double-click the same app again.

**Expected.** The window title is **Bao**. There is no address bar. The second double-click focuses that window and does not start a second server. `desktop/packaging/macos/bao-main.c` calls `bao_focus_pid` when the instance lock is already held. Record `helper.accessibility` and `helper.screenCapture` from `/api/state`. Stop this pass only when `helper.accessibility` is false. Do not change the grant.

Record `helper.accessibility` and `helper.screenCapture`. Skipping live-session checks when the footer reads **helper ok** was true as of tip `45e30f6`. `desktop/src/cdp-live/session.ts:479` enforces that stop when Screen Recording is granted, and `helper ok` means both grants (`desktop/src/app/server.ts:3364`). Stop this pass only when `helper.accessibility` is false.

**Evidence.** Save the body of this command next to your notes. It is not a file the app writes for you.

```sh
curl -s "http://127.0.0.1:4787/api/state"
lsof -nP -iTCP:4787 -sTCP:LISTEN
lsof -nP "$HOME/Library/Application Support/bao/instance.lock"
```

`helper.label` is `helper ok`, `helper needs permission`, or `helper off`. `helper ok` means both Accessibility and Screen Recording are granted. That is the product-window rule in `helperStatus`. While Bao is open, expect one listener on port 4787 and one `lsof` holder of `instance.lock`. `bao_instance_acquire` creates that file with `O_CREAT`. `bao_instance_release` only closes the fd. The file can remain after quit, so its presence is not evidence that Bao is running.

## Show that the running app is the installed bundle

**Command.** With Bao open from Finder, run these commands.

```sh
curl -s "http://127.0.0.1:4787/api/pids"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/Bao.app/Contents/Info.plist
lsof -a -c node -d cwd -Fn | grep Bao.app
```

**Expected.** `helper` in the JSON is `/Applications/Bao.app/Contents/Resources/BaoOSHelper.app`. That path does not contain the git checkout. The plist prints `dev.bao.desktop`. `lsof` shows cwd `/Applications/Bao.app/Contents/Resources/bao`. `bao-main.c` changes to that directory inside the bundle before it runs `src/app/cli.js`. `desktop/packaging/macos/package-app.sh` copies the server, the public files, and the Node dependencies into the bundle. The installed app does not read this checkout.

**Evidence.** `/Applications/Bao.app/Contents/Info.plist` and the `/api/pids` JSON.

## Check the signature and the helper identity

**Command.** Run these. Do not pass `--deep` to `codesign`. Do not run `desktop/os-helper-macos/package-app.sh`.

```sh
codesign --verify --strict "/Applications/Bao.app"
codesign --verify --strict "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app"
codesign -dv --verbose=4 "/Applications/Bao.app"
codesign -dv --verbose=4 "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app/Contents/Info.plist"
```

**Expected.** Both `codesign --verify --strict` commands exit 0. The app identifier is `dev.bao.desktop`. The helper identifier is `dev.bao.oshelper`. The helper signature names `bao dev signing`. `codesign` may print a CDHash. Do not treat any one CDHash as the pass condition for a grant. The grant follows the bundle id plus that signer. `docs/mac-build.md` records one machine's CDHash as a rebuild note. Match that note before you install a package you just built.

`desktop/packaging/macos/package-app.sh` copies `desktop/os-helper-macos/BaoOSHelper.app` only when that directory is present, and it exits 0 when the directory is missing. The helper app is gitignored, so a fresh worktree builds `Bao.app` with no helper and no error. Before packaging, copy the signed helper out of `/Applications/Bao.app/Contents/Resources/BaoOSHelper.app` into `desktop/os-helper-macos/BaoOSHelper.app`. Do not install that build until the nested helper matches the CDHash note in `docs/mac-build.md`. Pull request 134 fails the script when the helper is missing. Until that lands, a missing helper still exits 0. `helperBin` ignores a missing `BAO_OS_HELPER` and a value that does not end in `.app`. An existing `.app` path is used with no signature check.

**Evidence.** The `codesign` stdout. The identity in the tree is `desktop/os-helper-macos/Info.plist`.

## Check the extension host grant

**Command.** Finder launch runs `src/app/cli.js serve`, and that command installs the native host. `startExtensionLink` passes `defaultConfigHome()`, which is the real home directory, so the manifest lands under Chrome's NativeMessagingHosts directory even when `BAO_HOME` points somewhere else. On a Mac that already has Bao.app, run a checkout `bao serve` only when asked. Then quit it and reopen Bao from Finder. After the window is up, run these. Do not print the token file.

```sh
/bin/ls -l "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json"
node -e 'const fs=require("fs"); const os=require("os"); const path=require("path"); const p=path.join(os.homedir(),"Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json"); const d=JSON.parse(fs.readFileSync(p,"utf8")); console.log(d.name); console.log(d.path); console.log(d.allowed_origins.join("\n"));'
stat -f '%Lp' "$HOME/Library/Application Support/bao/extension-host/token"
grep -F '/Applications/Bao.app/Contents/Resources/bao/src/extension/native-host.js' "$HOME/Library/Application Support/bao/extension-host/bao-native-host.sh"
```

**Expected.** The manifest `name` is `com.bao.desktop`. `d.path` is `$HOME/Library/Application Support/bao/extension-host/bao-native-host.sh`. `allowed_origins` is only `chrome-extension://jcjcpblcjaakcmbgljdjkfgmmdfdbnfj/`. The token mode is `600`. The manifest does not contain the token. The token stays in `extension-host/token` under the installed server home. `desktop/src/extension/link.ts` writes that file with mode `0600`. The `grep` exits 0. The wrapper's host script is the copy inside the installed bundle.

The hello frame is not a Mac check. `link.ts` stores whatever `extensionId` arrives on hello. Only the auth frame is checked against `EXTENSION_ID`. This pass does not look for a hello.

**Evidence.** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json` and the wrapper path above. The token file is evidence of mode only. Do not copy its contents into the report.

## Update a live session

**Pending the live-session PR.** `desktop/src/mcp/live-server.ts` is not in this checkout. `desktop/src/app/cli.ts` has no live-session command. Do not invent an MCP tool name or a CLI subcommand.

**Expected.** When that PR lands, a step, an audit row, and a screenshot update the files below. Until then, the only caller of `SessionLog` in this tree is `desktop/src/cdp-live/instacart-run.ts`. Do not run that script as this check. On this checkout those files are under `liveSessionDir()`, which is not the Finder `--home` unless `BAO_HOME` or an explicit home makes them the same. After pull request 133, a Mac with neither set uses `~/Library/Application Support/bao/live-session`.

**Evidence.** `live-session/session.json` and `live-session/shots/shot-NNN.png` under the directory `liveSessionDir()` returns. `desktop/src/cdp-live/audit.ts` defines those paths. `shot-001.png` is a legal name. `../session.json` is not. The app serves the JSON on `GET /api/state` as `liveSession`, and a legal shot on `GET /api/live-session/shots/shot-001.png`.

The script that already writes a separate evidence directory is `desktop/src/cdp-live/session.ts`. It has no profile flag. It attaches to the Chrome that owns the default `DevToolsActivePort` file. Never list the Chrome profile directory. Compile with `tsc -p tsconfig.desktop.json`. Run `node desktop/dist/desktop/src/cdp-live/session.js` from an empty directory, and only when the task names the exact host list and the start URL. Required flags are `--hosts`, `--start`, `--deny`, `--commit`, `--stop-path`, `--reached`, and `--intent`. Optional flags are `--inbox`, `--attach-path`, `--agent`, and `--lock`. A host must be an exact name. The process writes `.evidence/` under `process.cwd()`. Tracked drafts `.evidence/session-workflow.json` and `.evidence/unfreeze-workflow.json` would be overwritten. `.evidence/session-run.json` is not gitignored. Never commit `.evidence/` from a live session.

## Stop, detach, and leave existing tabs

**Pending the live-session PR.** This checkout has no MCP or CLI stop tool. The behavior in `desktop/src/cdp-live/driver.ts` is the condition to check once a session is authorized.

**Command.** For an attached tab, pass `--attach-path` as a pathname on the start URL. `main` truncates `.evidence/session-inbox.txt` at startup. Append a line `stop` only after the process is in its read loop. That loop has no timeout.

**Expected.** The run finishes with status `needs_human` and exit code 2. `confirmClicked` is assigned false once and the `passed` arm cannot run, so `confirmClicked is false` cannot fail a check. Expect no step label and no audit label that matches `--commit`. `clickAllowed` refuses kind `submit`, `radio`, `check`, and `other`. It refuses a button whose label matches `--commit`. A link stays allowed unless `--deny` matches, including an anchor whose role is `button`. Put the commit words in `--deny` as well. When `--attach-path` is set and the context check after `end` succeeds, `context.attachedStillOpen` is true and `context.closedTarget` is false. `end` on an attached driver calls `Target.detachFromTarget` and does not call `Target.closeTarget`. A window the script itself opened is closed on `end`, because that driver does not preserve the target. Tabs that were already open stay open.

**Evidence.** `.evidence/session-run.json` in the empty working directory. `context` in that file holds `attachedStillOpen` and `closedTarget`. Do not commit that file.

## Redaction and profile leakage

**Command.** After an authorized session, inspect `.evidence/session-run.json`. On Linux, with no profile, `npm run test:v1` already asserts `redactText`, `redactLabel`, and `shotNameOk` in `desktop/test/unit/cdp-live.test.ts`.

**Expected.** An email is removed. A greeting is stored as `[greeting]` in the session-script output. `redactLabel` drops a password word. It also drops `$1.29`. The same pattern leaves `,.56` from `$1,234.56`. Paths in the public session keep a pathname, not a full URL with a query. `readSurface` does not read `document.cookie`. The report contains no extension token, no Chrome profile listing, and no `DevToolsActivePort` browser-path secret.

`redactForShot` in `desktop/src/cdp-live/attach.ts` blurs only the nodes it matches, such as an email or a price. A count of 0 still writes the PNG. A plain name and a Place order button stay readable. The full-page veil is `redactOverlay`. `captureRedacted` in `desktop/src/cdp-live/driver.ts` applies that veil. `instacart-run.ts` calls `captureRedacted`. The session script does not.

**Evidence.** `.evidence/session-run.json` and `.evidence/frames/` in the empty directory, and, when `SessionLog` has run, the `session.json` under `liveSessionDir()`. `.evidence/frames/` is gitignored. Do not commit any `.evidence/` file from a live session.

## Evidence paths and failure logs

These are the files a run actually writes.

- The Finder instance lock is `~/Library/Application Support/bao/instance.lock`. The file can remain after quit.
- Product state is the body of `curl -s http://127.0.0.1:4787/api/state`.
- The installed helper path is the body of `curl -s http://127.0.0.1:4787/api/pids`.
- The Playwright recorder writes `<library.root>/videos/incoming` when `BAO_RUN_VIDEO=1` (`desktop/src/app/server.ts:2843`, `recordVideo.dir` at `desktop/src/launch.ts:474`). `keepReplayClip` copies that clip to `<library.root>/videos/<runId>.webm` when it has a `runId` (`desktop/src/app/server.ts:2451`). `close()` calls `keepReplayClip` (`desktop/src/app/server.ts:2429`). `encodeWebm` writes the dest passed at `desktop/src/app/server.ts:2768`. It needs an ffmpeg from `FFMPEG`, `which ffmpeg`, `/opt/homebrew/bin/ffmpeg`, or `/usr/local/bin/ffmpeg`, and a file over 1000 bytes (`desktop/src/v1/replay-video.ts:127`). `BaoWindowVideo` is signed as `dev.bao.oshelper`. For a Finder launch `library.root` is `~/Library/Application Support/bao`.
- A live session record is `<liveSessionDir()>/session.json`.
- A live session shot is `<liveSessionDir()>/shots/shot-NNN.png`.
- The session script result is `.evidence/session-run.json` under the process working directory. It is not gitignored.
- The session script drafts are `.evidence/session-workflow.json` and, when `--attach-path` validates, `.evidence/unfreeze-workflow.json`. Both drafts are tracked. A live run overwrites them.
- Session script shots are under `.evidence/frames/`.
- The accessibility log is `.evidence/cdp-live-ax.jsonl`.
- The stop inbox is `.evidence/session-inbox.txt`. Startup truncates it.

**Failure log.** The session script writes progress to stderr. A thrown error is one stderr line from `safeError`, with URLs replaced by `[url]`, then exit code 1. An `AxUnavailable` error also prints its summary JSON on stderr. A finished run whose `status` is not `passed` still writes `.evidence/session-run.json` and exits 2. A stop takes that path with status `needs_human`. There is no other failure log file.

## Desktop unit suite

This does not replace the Mac checks. A non-zero `npm run test:v1` fails this pass.

```sh
npm run typecheck
npm run test:v1
```

`npm run test:v1` is the desktop unit suite. It uses throwaway homes. The runner sets `BAO_HEAL_CURSOR_ACCOUNT` to `0` and deletes vendor model keys. The required suite on this checkout requests three public demos, `automationintesting.online`, `www.irs.gov`, and `the-internet.herokuapp.com`, from `desktop/test/unit/files-dates-demo.test.ts`. After pull request 132 those requests move to `desktop/test/live/files-dates-public.test.ts` and run only when `BAO_LIVE_TESTS=1`. A later infrastructure skip on that live file does not waive a failure of this checkout's required suite.
