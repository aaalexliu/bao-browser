# Work in this checkout

This file is the rule for the whole checkout. `web/AGENTS.md` is generated Next.js guidance. Leave that file alone.

## Search this tree

Search this checkout only, unless the person who asked authorizes a wider search. Skip `.git`, `.toolchain`, dependency directories such as `node_modules`, and generated output such as `dist`, `out`, and `web/.next`.

## Load skills by name

Load an applicable skill by its name through the harness. If that load fails, read the vendored file named in `.cursor/third-party/pstack/VENDORED.md`. The vendored poteto-mode skill is `.cursor/skills/poteto-mode/SKILL.md`. Do not search the machine for a skill with a similar name.

`.cursor/rules/pstack.mdc` names three skills to use before a shape decision, and before calling a spike done. They are architect, arena, and principle-prove-it-works.

## Run the checks that match the change

`npm run typecheck` runs four passes: the root `tsc --noEmit`, `typecheck:desktop`, `typecheck:extension`, and the `web` typecheck. `npm run check` runs `npm run typecheck`, then the desktop unit suite.

`npm run test:v1` is the desktop unit suite. It compiles with `tsc -p tsconfig.desktop.json`, then `desktop/test/run-v1.mjs` runs the files in `desktop/test/unit`. A non-zero exit fails this pass. The runner drops `CI`, the vendor model keys, and every inherited name that starts with `BAO`, then sets `BAO_HEAL_CURSOR_ACCOUNT` to `0`. The suite does not request public hosts. The public demos are in `desktop/test/live/files-dates-public.test.ts`. They run only through `desktop/test/run-live.mjs`, which sets `BAO_LIVE_TESTS=1`. `desktop/test/README.md` describes both runners.

`npm test` is the root suite. Its commands are in `docs/TESTING.md`.

Build an installed Mac app from `docs/mac-build.md`. The short human pass is `docs/mac-test.md`. Do not lengthen that card. Live Chrome needs Accessibility only. Screen Recording on or off does not stop a live Chrome start. The engineering pass is `docs/agent-acceptance.md`. It records both helper bits and stops only when `helper.accessibility` is false. Permission switches are in `docs/permissions.md`. Extension install is in `docs/extension.md`. Live Chrome notes are in `docs/cdp-live-chrome.md`.

`desktop/packaging/macos/package-app.sh` runs `desktop/packaging/helper-identity.js` on `desktop/os-helper-macos/BaoOSHelper.app`, or on `BAO_HELPER_APP` when that is set. The script exits before it compiles or signs when the helper is missing, ad-hoc, not `dev.bao.oshelper`, or not signed by the pinned `bao dev signing` certificate. The helper is gitignored, so a fresh worktree has none. Before packaging, copy the signed helper out of the installed app. The script checks the designated requirement, not a CDHash.

## Keep tests off a daily profile

A test uses a throwaway Bao home, a throwaway Chrome profile, and a throwaway native-host config. Unit tests create that home with `mkdtemp`. `desktop/test/run-v1.mjs` sets `BAO_TEST_BROWSER` to Playwright's Chromium and stops when that binary is missing. Run `npx playwright install chromium` to get it. While `BAO_TEST_BROWSER` is set, every owned launch in `desktop/src/launch.ts` starts that binary with `--use-mock-keychain` and `--password-store=basic`, so the suite does not open the installed Google Chrome or the login keychain. `desktop/src/launch.ts` refuses a browser whose user-data directory is the daily Chrome profile. `assertNotDailyChrome` in `desktop/src/profile.ts` compares `path.resolve` and does not follow symlinks. Do not pass a link to the daily profile directory.

Attaching to a Chrome that is already open needs an explicit authorization. For `desktop/src/cdp-live/session.ts`, name the exact host list and the start URL in that authorization. It rejects a host that contains `*` or `/`. For `bao live_session_start`, name the start URL, the preset, and the `DevToolsActivePort` file. Its host list is the start URL's host plus the preset's hosts.

`bao serve` writes `com.bao.desktop.json` under the real home's Chrome NativeMessagingHosts directories. `defaultConfigHome` in `desktop/src/extension/install-host.ts` returns `homedir()`. `BAO_HOME` does not move that write. The write replaces the installed app's manifest. On a Mac with Bao.app installed, run a checkout `bao serve` only when asked. Then quit it and reopen Bao from Finder.

## Use the signed helper

The helper is the signed app BaoOSHelper. Its bundle id is `dev.bao.oshelper`, from `desktop/os-helper-macos/Info.plist`. The installed copy is `/Applications/Bao.app/Contents/Resources/BaoOSHelper.app`. `helperBin` in `desktop/src/cdp-live/ax.ts` ignores a missing `BAO_OS_HELPER` and a value that is not an existing `.app`. It then uses the installed helper. An existing `.app` path is used with no signature check. The signer for the grant is `bao dev signing`, from `docs/mac-build.md`.

Do not rebuild BaoOSHelper. Do not re-sign it. Do not pass `--deep` to `codesign`. Do not reset its privacy permissions. Do not grant Accessibility or Screen Recording to see whether a different failure goes away.

`liveChromeBlock` in `desktop/src/helper-capabilities.ts` stops a live Chrome start when the helper asked for a permission prompt or Accessibility is off. Screen Recording does not stop it. `session.ts`, `run.ts`, `instacart-run.ts`, `login-diff.ts`, and `live-host.ts` in `desktop/src/cdp-live/` call it before they connect. `chromeHelper` in `desktop/src/cdp-live/ax.ts` refuses the helper's `shot` command, so a live session never uses Screen Recording. Window capture and the MCP driver (`bao mcp-ax`) still need Screen Recording. `helper ok` means both grants. `capabilityReport` in `desktop/src/helper-capabilities.ts` sets that label.

## Do not bill a model from a test

Leave `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, and `CURSOR_API_KEY` unset. Set `BAO_HEAL_CURSOR_ACCOUNT` to `0` before `bao serve`, before a replay, and before any test the two test runners do not spawn. `desktop/test/run-v1.mjs` and `desktop/test/run-live.mjs` set that variable for the suites they spawn. Leaving `BAO_HEAL_CURSOR` unset is not enough. With a logged-in `agent` on `PATH`, `readCursorAccount` returns authenticated, and a replay miss can run `agent --print`. That call bills the account. A Finder launch cannot take the variable. Do not cause a replay miss while `model.label` is `cursor account`.

## Show the running app

A UI change needs before and after evidence from the running app. With `BAO_RUN_VIDEO=1`, `openReplay` in `desktop/src/app/server.ts` passes `<library.root>/videos/incoming` to `launchOwnedChrome` in `desktop/src/launch.ts`, which gives it to Playwright as `recordVideo.dir`. `keepReplayClip` in `server.ts` copies the clip to `<library.root>/videos/<runId>.webm` when it has a `runId`. `close()` calls it. `runRecorded` in `server.ts` passes the same dest to `openReplayVideo` in `desktop/src/v1/replay-video.ts`. On a Mac with `BAO_HEADED=1`, a `BaoWindowVideo.app`, and a Screen Recording probe that passes, `encodeWebm` writes that dest from the window recorder. It needs an ffmpeg from `FFMPEG`, `which ffmpeg`, `/opt/homebrew/bin/ffmpeg`, or `/usr/local/bin/ffmpeg`, and a file over 1000 bytes. A Finder launch sets `BAO_HEADED=1`. `desktop/packaging/macos/build-window-video.sh` signs `BaoWindowVideo` as `dev.bao.oshelper`.

A test on a real site does not make a write that cannot be undone. `clickAllowed` in `desktop/src/cdp-live/session.ts` refuses kind `submit`, `radio`, `check`, and `other`. It refuses a button whose label matches `--commit`. A link is allowed unless `--deny` matches. An anchor is a link even when its role is `button`. Put commit words in `--deny` as well. `planClick` in `desktop/src/cdp-live/live-ops.ts` refuses a `live_click` on a control whose label matches the preset's deny or commit pattern, on a submit control outside a search form, and on a credential field. Place order and Reserve pause on **needs you**. That pause is in `docs/mac-test.md`.
