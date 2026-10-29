# Accept an installed Bao on a Mac

This is the engineering pass for an installed app. The short human card is [Test Bao on a Mac](mac-test.md). Do not lengthen that card. Build steps stay in [Build Bao on a Mac](mac-build.md). Permission switches stay in [What Bao asks permission for](permissions.md).

Every check in this file needs a Mac with `/Applications/Bao.app` already installed, except the hermetic suite named at the end. This Linux checkout cannot open Finder, sign a bundle, or attach to Chrome. Do not rebuild BaoOSHelper, re-sign it, reset privacy permissions, or grant Accessibility or Screen Recording while you run these checks.

Leave `BAO_HOME` and `BAO_PORT` unset for the installed app. The home is `~/Library/Application Support/bao`. The port is `4787`. Do not open `http://127.0.0.1:4787` in a browser.

## Open Bao from Finder, then open it again

**Command.** In Finder, double-click `/Applications/Bao.app`. Do not start it from Terminal. Double-click the same app again.

**Expected.** The window title is **Bao**. There is no address bar. The second double-click focuses that window and does not start a second server. `desktop/packaging/macos/bao-main.c` calls `bao_focus_pid` when the instance lock is already held. If the footer reads **helper needs permission**, record that and stop. Do not change the grant.

**Evidence.** `~/Library/Application Support/bao/instance.lock` exists while the first instance is running. Save the body of this command next to your notes. It is not a file the app writes for you.

```sh
curl -s "http://127.0.0.1:4787/api/state"
```

`helper.label` is `helper ok`, `helper needs permission`, or `helper off`. `helper ok` means both Accessibility and Screen Recording are granted. That is the product-window rule in `helperStatus`. It is not the live Chrome rule below.

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

**Expected.** Both `codesign --verify --strict` commands exit 0. The app identifier is `dev.bao.desktop`. The helper identifier is `dev.bao.oshelper`. The helper signature names `bao dev signing`. `codesign` may print a CDHash. Do not treat any one CDHash as the pass condition. The grant follows the bundle id plus that signer. `docs/mac-build.md` records one machine's CDHash as a rebuild note. That value is not the general condition.

**Evidence.** The `codesign` stdout. The identity in the tree is `desktop/os-helper-macos/Info.plist`.

## Check the extension host grant

**Command.** Finder launch runs `src/app/cli.js serve`, and that command installs the native host. After the window is up, run these. Do not print the token file.

```sh
/bin/ls -l "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json"
node -e 'const fs=require("fs"); const os=require("os"); const path=require("path"); const p=path.join(os.homedir(),"Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json"); const d=JSON.parse(fs.readFileSync(p,"utf8")); console.log(d.name); console.log(d.allowed_origins.join("\n"));'
stat -f '%Lp' "$HOME/Library/Application Support/bao/extension-host/token"
```

**Expected.** The manifest `name` is `com.bao.desktop`. `allowed_origins` is only `chrome-extension://jcjcpblcjaakcmbgljdjkfgmmdfdbnfj/`. The token mode is `600`. The manifest does not contain the token. The token stays in `extension-host/token` under the Bao home. `desktop/src/extension/link.ts` writes that file with mode `0600`. The extension hello is a frame whose `extensionId` is that same id. This checkout does not write that frame to a file. `desktop/test/unit/extension-driver.test.ts` asserts the hello. Do not read a Chrome profile to go looking for it.

**Evidence.** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json`. The token file is evidence of mode only. Do not copy its contents into the report.

## Update a live session

**Pending the live-session PR.** `desktop/src/mcp/live-server.ts` is not in this checkout. `desktop/src/app/cli.ts` has no live-session command. Do not invent an MCP tool name or a CLI subcommand.

**Expected.** When that PR lands, a step, an audit row, and a screenshot update the files below. Until then, the only writer of `SessionLog` in this tree is `desktop/src/cdp-live/instacart-run.ts`. Do not run that script as this check.

**Evidence.** Under the Bao home, `live-session/session.json` and `live-session/shots/shot-NNN.png`. `desktop/src/cdp-live/audit.ts` defines those paths. `shot-001.png` is a legal name. `../session.json` is not. The app serves the JSON on `GET /api/state` as `liveSession`, and a legal shot on `GET /api/live-session/shots/shot-001.png`.

The script that already writes a separate evidence directory is `desktop/src/cdp-live/session.ts`. Compile with `tsc -p tsconfig.desktop.json`, then run `node desktop/dist/desktop/src/cdp-live/session.js` only when the task names the exact host list and the start URL. Required flags are `--hosts`, `--start`, `--deny`, `--commit`, `--stop-path`, `--reached`, and `--intent`. A host must be an exact name. Do not pass a daily profile, and do not list the Chrome profile directory.

## Stop, detach, and leave existing tabs

**Pending the live-session PR.** This checkout has no MCP or CLI stop tool. The behavior in `desktop/src/cdp-live/driver.ts` is the condition to check once a session is authorized.

**Command.** For an attached tab, pass `--attach-path` as a pathname on the start URL. To stop, append a line `stop` to the inbox. The default inbox is `.evidence/session-inbox.txt` in the process working directory.

**Expected.** `confirmClicked` is false. The session does not activate a commit control. `clickAllowed` refuses that control. When `--attach-path` is set and the context check after `end` succeeds, `context.attachedStillOpen` is true and `context.closedTarget` is false. `end` on an attached driver calls `Target.detachFromTarget` and does not call `Target.closeTarget`. A window the script itself opened is closed on `end`, because that driver does not preserve the target. Tabs that were already open stay open.

**Evidence.** `.evidence/session-run.json` in the working directory. `context` in that file holds `attachedStillOpen` and `closedTarget`.

## Redaction and profile leakage

**Command.** After an authorized session, inspect `.evidence/session-run.json`. On Linux, with no profile, `npm run test:v1` already asserts `redactText`, `redactLabel`, and `shotNameOk` in `desktop/test/unit/cdp-live.test.ts`.

**Expected.** An email is removed. A greeting is stored as `[greeting]` in the session-script output. `redactLabel` drops a password word and a dollar amount. Paths in the public session keep a pathname, not a full URL with a query. `readSurface` does not read `document.cookie`. The report contains no extension token, no Chrome profile listing, and no `DevToolsActivePort` browser-path secret. Screenshot files are blurred before they are written. `redactForShot` in `desktop/src/cdp-live/attach.ts` is that step for the session script.

**Evidence.** `.evidence/session-run.json`, `.evidence/frames/`, and, when `SessionLog` has run, `<Bao home>/live-session/session.json`. `.evidence/frames/` is gitignored. Do not commit it.

## Evidence paths and failure logs

These are the files a run actually writes.

- The Finder instance lock is `~/Library/Application Support/bao/instance.lock`.
- Product state is the body of `curl -s http://127.0.0.1:4787/api/state`.
- The installed helper path is the body of `curl -s http://127.0.0.1:4787/api/pids`.
- A replay video is `~/Library/Application Support/bao/videos/<runId>.webm`.
- A live session record is `<Bao home>/live-session/session.json`.
- A live session shot is `<Bao home>/live-session/shots/shot-NNN.png`.
- The session script result is `.evidence/session-run.json`.
- The session script draft is `.evidence/session-workflow.json`.
- Session script shots are under `.evidence/frames/`.
- The accessibility log is `.evidence/cdp-live-ax.jsonl`.
- The stop inbox is `.evidence/session-inbox.txt`.

**Failure log.** The session script writes progress to stderr. A thrown error is one stderr line from `safeError`, with URLs replaced by `[url]`, then exit code 1. An `AxUnavailable` error also prints its summary JSON on stderr. A finished run whose `status` is not `passed` still writes `.evidence/session-run.json` and exits 2. There is no other failure log file.

## Hermetic suite, on any machine

This does not replace the Mac checks.

```sh
npm run typecheck
npm run test:v1
```

`npm run test:v1` is the desktop unit suite. It uses throwaway homes and clears model keys. A failure in `restful-booker` against `automationintesting.online` that is an external HTTP 500 is unrelated to this pass.
