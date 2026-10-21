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

The helper Bao launches is `Bao.app/Contents/Resources/BaoOSHelper.app` (`dev.bao.oshelper`). `package-app.sh` copies the built helper there and the entry point sets `BAO_OS_HELPER` to that path. There is not a second helper to grant.

On a clean account the first launch shows these dialogs, in order:

1. Gatekeeper, from Finder: "Bao.app" cannot be opened because the developer cannot be verified. Right-click `Bao.app`, choose Open, then Open on "macOS cannot verify the developer of Bao.app. Are you sure you want to open it?"
2. Accessibility, the first time Bao launches the nested helper: BaoOSHelper would like to control this computer using accessibility features. Open System Settings and enable BaoOSHelper. The usage string is "BaoOSHelper reads accessibility elements in throwaway apps so a computer-use click can be replayed by role and name."
3. Screen Recording, same launch: BaoOSHelper would like to record this computer's screen. Enable BaoOSHelper, then quit and relaunch Bao so the grant applies. The usage string is "BaoOSHelper captures one throwaway window so the spike can show the control it pressed."

Do not pass `--prompt` on a machine that already has a grant. This pass did not show a dialog. Accessibility for the nested helper was true (`prompted` false, parent launchd). Screen Recording for that same nested path was false. The standalone helper at `desktop/os-helper-macos/BaoOSHelper.app` reported Screen Recording true with the same cdhash (`e2ad7477d8f989484c3d0ef8a2598561844127bf`). The grant on this Mac is tied to that path. A clean account grants the nested copy when Bao launches it the first time. Do not pass `--prompt` to move the grant.

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

1. Launch `Bao.app`. That starts `Contents/Resources/BaoOSHelper.app`. On a clean account the two prompts above appear. This pass did not prompt.
2. System Settings, Privacy and Security, Accessibility, enable `BaoOSHelper` if the dialog did not already send you there.
3. Same pane, Screen Recording, enable `BaoOSHelper`.
4. Quit Bao and launch it again. `GET /api/pids` reports the helper path inside `Bao.app`. A permissions check of that bundle with no `--prompt` reports Accessibility true. Screen Recording stays false on a Mac whose grant was recorded for a different path of the same cdhash. On a clean account, after the Screen Recording toggle and a relaunch, both are true, `prompted` is false, and the parent is launchd.

The product window does not need Accessibility. The bundled browser is not the daily Chrome profile.

## Record

1. Sessions, Browser, Start capture. The start URL can be the built-in fixture (`http://127.0.0.1:4787/fixture`). That page has a username, a password, a file input, and a drop zone.
2. Type a username. Type a password. The password must not show up later in the trail or the workflow.
3. Choose a throwaway file in the file input. A drag from another app still does not start: `CGEvent` moves the pointer and does not offer the file.
4. Stop and save.
5. Library shows the workflow. Export if you want the JSON. Confirm a `secret` input, a `file` input, and no absolute path.

What this pass found:

- Start capture is an `AXButton` and the press works while the product window is the only `com.google.chrome.for.testing` process.
- Stop and save is the same kind of button. `GET /api/pids` returns the product pid and the capture pid. `press --pid <product> --role AXButton --name "Stop and save"` targets that process. A bundle-wide press still reports `expected one process, found 2` while both windows are `com.google.chrome.for.testing`. The saved workflow has a typed input and a file input. The secret string and the `/tmp` path are absent. The file step's postcondition is the filename template, and the fixture shows `Received file:` or `Dropped file:` plus that name.
- The saved start URL is the page URL at stop time. Log in on the fixture does `pushState` to `/secure`, so the workflow's `startUrl` was `/secure`. This server maps `/secure` back to the fixture HTML. On another site, stop on the page that replay should open.

## Replay twice

1. Replay. The form lists every input before Run. Fill a different username and a different file than the capture. The password field is on the form too.
2. Run. Each step goes pass or fail. The fixture page shows `Welcome` plus the new username, and the file name.
3. The replay window stays open after the run. Move and resize it before the second run (`POST /api/replay/place`, or drag the window). The next run reuses that window, and the bounds are stored per workflow so a later launch opens at the same place. Chrome for Testing is moved with CDP `Browser.setWindowBounds`. The helper is also tried with `--pid` and `--frontmost`. If neither one changes the origin, the drift row is `n/a-harness` and the replay steps are not counted as failures. A step failure counts only after the requested bounds landed. Calculator still rejects `AXSize` with `-25200`.
4. Run again with a third username and a third file. The fixture line `Received file:` or `Dropped file:` shows the new name. The press log has no x,y.
5. Dropping a file from Finder onto the replay form is a normal web drop. The form keeps that file for Run. A synthetic `DataTransfer` drop is the automated check. The file button can also open an Open panel. `AXUIElementPostKeyboardEvent` for Go to Folder reports success and does not open the sheet. Native `NSDraggingSession` onto another Mac app is out of v1 scope (`docs/files-and-drag.md`).

## Auto-heal

The default policy is auto. With no `OPENAI_API_KEY` and no `ANTHROPIC_API_KEY`, set `BAO_HEAL_CURSOR_RESPONSE` to a JSON file written by the Cursor session that is already running. That path does not call OpenAI or Anthropic and does not open a login. `BAO_HEAL_FIXTURE=1` is a different stand-in. Its model name is `bao-heal-fixture`, not this session.

Breaking only `testId` does not miss. The login step also has `id` `login-btn`, which scores 80, above the accept line of 60. This pass set `testId` to `missing`, `id` to `missing-id`, and the text to `Missing`. The attribute that broke was `testId` (`below-threshold`). Auto applied the cursor-session patch (`testId` `login`, `id` `login-btn`), the postcondition passed, and the app notice was `Bao healed a step`. The heal record has the prompt, the raw response, the patch, the executed identity, and the screenshot bytes. The secret string was not in that record.

Settings, Approve before applying, was not the path under test. Auto is the default and it continued.

## Drift

Page theme (`?theme=dark` and the default light page) does not change the system appearance. Leave System Settings alone. That row is n/a. Font size for this pass was `document.body.style.zoom = "1.6"`. List order was `?order=flip`. Slow network was a 250ms delay on each request. Retina was `deviceScaleFactor` 2 against 1. Content shift was `?shift=1`.

Every replay step passed for those page changes. Window resize counts when the bounds change and the steps pass. Window move counts the same way. A move that stays put is `n/a-harness`, not a failed step.

## Done

Install the build, point `BAO_HOME` and `BAO_NODE` at throwaway values, record a typed input and a dragged-in file, save, and replay twice with different upfront inputs. Move and resize the replay window between the two runs. Helper commands that must see one Chrome for Testing window take `--pid` from `GET /api/pids`.
