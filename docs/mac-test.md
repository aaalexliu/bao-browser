# macOS test

Do this on the Mac that will run the build. A clean account differs in the places called out below. The machine in this pass was alex-jxp, macOS 26. The helper and the app are different bundles. Accessibility is granted to `dev.bao.oshelper`.

## Install

```sh
git fetch origin cursor/live-model-mcp-63fc
git checkout cursor/live-model-mcp-63fc
npm install
export BAO_SIGN_IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
export BAO_NODE="$(command -v node)"
bash desktop/os-helper-macos/package-app.sh
bash desktop/packaging/macos/package-app.sh
```

`npm install` has to finish before `tsc`. Without `ajv` and `fast-check` the desktop compile stops.

`desktop/os-helper-macos/package-app.sh` builds `BaoOSHelper.app` (`dev.bao.oshelper`) and signs it with `BAO_SIGN_IDENTITY` and the runtime flag. `desktop/packaging/macos/package-app.sh` builds `desktop/packaging/macos/dist/Bao.app` (`dev.bao.desktop`) and `Bao.dmg` next to it. There is no notarization step.

The desktop executable is a Mach-O arm64 binary compiled from `bao-main.c`, not a shell script. Playwright's mac download is `Google Chrome for Testing.app`. The script copies that bundle to `Contents/Resources/Chromium.app` and the entry point runs `Contents/MacOS/Google Chrome for Testing`. It does not launch `/Applications/Google Chrome.app`. `npx playwright install chromium` runs first if that browser is not already downloaded.

The server also needs `src/mask.js` and the `playwright` package. The script copies both into the app. A copy of `Bao.app` that sits outside the checkout still starts. `Contents/MacOS/bao` is Mach-O. Check it with `file`.

On a clean account, Gatekeeper may say the app is from an unidentified developer. Right-click, then Open, once. Rebuilding the standalone helper with the same certificate kept the designated requirement on this machine, and both privacy checks stayed true for `desktop/os-helper-macos/BaoOSHelper.app`. The copy at `Bao.app/Contents/Resources/BaoOSHelper.app` had the same cdhash and reported Screen Recording false. Accessibility on that copy stayed true. Do not pass `--prompt` to try again.

## Launch

A Finder launch does not see the shell `PATH`. Set `BAO_NODE` to an absolute `node` before starting the app.

The default data directory is `~/Library/Application Support/bao`. On a machine that already has bao data, set `BAO_HOME` to a throwaway directory and do not read the default one. On a clean account that directory starts empty.

```sh
export BAO_HOME=/tmp/bao-mac-home
export BAO_PORT=4787
export BAO_NODE=/absolute/path/to/node
/path/to/Bao.app/Contents/MacOS/bao
```

The packaged entry point sets `BAO_HEADED=1` when it is unset, so the capture and replay windows are visible. It also points `BAO_BROWSER` at the Chromium inside the app. The product window and those browsers are `Contents/Resources/Chromium.app`. Confirm the process command contains that path and does not contain `/Applications/Google Chrome.app`.

Do not `open` the app a second time while that process is already running. LaunchServices starts another instance, and that instance uses the default home.

## Permissions

1. Launch the standalone `BaoOSHelper.app` once so the prompt appears. On a clean account this is the first grant. This pass did not prompt.
2. System Settings, Privacy and Security, Accessibility, enable `BaoOSHelper`.
3. Same pane, Screen Recording, enable `BaoOSHelper`.
4. Quit and relaunch the helper. `BaoOSHelper.app/Contents/MacOS/BaoOSHelper permissions` with no `--prompt` should report both true, `prompted` false, and parent launchd.

The product window does not need Accessibility. The bundled browser is not the daily Chrome profile.

## Record

1. Sessions, Browser, Start capture. The start URL can be the built-in fixture (`http://127.0.0.1:4787/fixture`). That page has a username, a password, a file input, and a drop zone.
2. Type a username. Type a password. The password must not show up later in the trail or the workflow.
3. Choose a throwaway file in the file input. A drag from another app still does not start: `CGEvent` moves the pointer and does not offer the file.
4. Stop and save.
5. Library shows the workflow. Export if you want the JSON. Confirm a `secret` input, a `file` input, and no absolute path.

What this pass found:

- Start capture is an `AXButton` and the press works while the product window is the only `com.google.chrome.for.testing` process.
- Stop and save is the same kind of button, and the helper then reports `expected one process, found 2`. The product window and the capture window share that bundle id, so a bundle-wide command cannot see one of them. A click on the button in the product window still saves. The saved workflow had `username` (text, default `ada`), `password` (secret), and `file`. The secret string and the `/tmp` path were absent.
- The saved start URL is the page URL at stop time. Log in on the fixture does `pushState` to `/secure`, so the workflow's `startUrl` was `/secure`. This server maps `/secure` back to the fixture HTML. On another site, stop on the page that replay should open.

## Replay twice

1. Replay. The form lists every input before Run. Fill a different username and a different file than the capture. The password field is on the form too.
2. Run. Each step goes pass or fail. The fixture page shows `Welcome` plus the new username, and the file name.
3. The replay browser closes when the run returns, so there is no browser window to move between runs. During a run, `move-window` by bundle fails with two processes. `AXSize` on the product window did resize it (`1200x1040` to `1100x760`). `AXPosition` on the replay browser, asked for `48,72` while it was the only test browser, left the origin at `22,55`. Calculator still rejects `AXSize` with `-25200`. That is a calculator limit, not a limit of this browser.
4. Run again with a third username and a third file. Both replays passed all four steps. The press log has no x,y.
5. The file button on the form opens an Open panel (`AXSheet` title `open`). `AXUIElementPostKeyboardEvent` for Go to Folder reported success and did not open the sheet. `CGEvent` was not posted: `AXFrontmost` stayed false, and the helper refuses the key in that case. The replays in this pass sent the file as the upfront file argument.

## Auto-heal

The default policy is auto. With no `OPENAI_API_KEY` and no `ANTHROPIC_API_KEY`, set `BAO_HEAL_CURSOR_RESPONSE` to a JSON file written by the Cursor session that is already running. That path does not call OpenAI or Anthropic and does not open a login. `BAO_HEAL_FIXTURE=1` is a different stand-in. Its model name is `bao-heal-fixture`, not this session.

Breaking only `testId` does not miss. The login step also has `id` `login-btn`, which scores 80, above the accept line of 60. This pass set `testId` to `missing`, `id` to `missing-id`, and the text to `Missing`. The attribute that broke was `testId` (`below-threshold`). Auto applied the cursor-session patch (`testId` `login`, `id` `login-btn`), the postcondition passed, and the app notice was `Bao healed a step`. The heal record has the prompt, the raw response, the patch, the executed identity, and the screenshot bytes. The secret string was not in that record.

Settings, Approve before applying, was not the path under test. Auto is the default and it continued.

## Drift

Page theme (`?theme=dark` and the default light page) does not change the system appearance. Leave System Settings alone. That row is n/a. Font size for this pass was `document.body.style.zoom = "1.6"`. List order was `?order=flip`. Slow network was a 250ms delay on each request. Retina was `deviceScaleFactor` 2 against 1. Content shift was `?shift=1`.

Every replay step passed for those changes. The window resize passed and the four steps passed in the resized window. The window move failed on `AXPosition`.

## Done

Install the build, point `BAO_HOME` and `BAO_NODE` at throwaway values, record a typed input and a file input, save, and replay twice with different upfront inputs. The browser window is a new process per run, and bundle-wide helper commands cannot see it while the product window is open.
