# Work in this checkout

This file is the rule for the whole checkout. `web/AGENTS.md` is generated Next.js guidance. Leave that file alone.

## Search this tree

Search this checkout only, unless the person who asked authorizes a wider search. Skip `.git`, `.toolchain`, dependency directories such as `node_modules`, and generated output such as `dist`, `out`, and `web/.next`.

## Load skills by name

Load an applicable skill by its name through the harness. If that load fails, read the vendored file named in `.cursor/third-party/pstack/VENDORED.md`. The vendored poteto-mode skill is `.cursor/skills/poteto-mode/SKILL.md`. Do not search the machine for a skill with a similar name.

`.cursor/rules/pstack.mdc` names three skills to use before a shape decision, and before calling a spike done. They are architect, arena, and principle-prove-it-works.

## Run the checks that match the change

`npm run typecheck` runs three passes: `typecheck:desktop` (including shared code), `typecheck:extension`, and the `web` typecheck. `npm run check` runs `npm run typecheck`, then the desktop unit suite.

`npm run test:v1` is the desktop unit suite. It compiles with `tsc -p tsconfig.desktop.json`, then `desktop/test/run-v1.mjs` runs the files in `desktop/test/unit`. A non-zero exit fails this pass. The runner drops `CI`, the vendor model keys, and every inherited name that starts with `BAO`, then sets `BAO_HEAL_CURSOR_ACCOUNT` to `0`. The suite does not request public hosts. The public demos are in `desktop/test/live/files-dates-public.test.ts`. They run only through `desktop/test/run-live.mjs`, which sets `BAO_LIVE_TESTS=1`. `desktop/test/README.md` describes both runners.

The old root extension and `npm test` entry point are retired. Current test commands are in `docs/TESTING.md`.

Build an installed Mac app from `docs/mac-build.md`. The short human pass is `docs/mac-test.md`. Do not lengthen that card. The `agent_browser` pass-through defaults to a lasting Bao profile with no Mac privacy grants; `docs/agent-browser-engine.md` owns browser selection. Explicit `browser: "current"` uses the helper's existing Accessibility grant to drive running Chrome; it needs neither Automation nor Screen Recording. The engineering pass is `docs/agent-acceptance.md`. Record helper permission bits when testing a helper feature or the current-Chrome route; copy-route proof needs no grants. Permission switches are in `docs/permissions.md`. Extension install is in `docs/extension.md`. Live Chrome notes are in `docs/cdp-live-chrome.md`.

`desktop/packaging/macos/package-app.sh` runs `desktop/packaging/helper-identity.js` on `desktop/os-helper-macos/BaoOSHelper.app`, or on `BAO_HELPER_APP` when that is set. The script exits before it compiles or signs when the helper is missing, ad-hoc, not `dev.bao.oshelper`, or not signed by the pinned `bao dev signing` certificate. The helper is gitignored, so a fresh worktree has none. Before packaging, copy the signed helper out of the installed app. The script checks the designated requirement, not a CDHash.

## Keep tests off a daily profile

A test uses a throwaway Bao home, a throwaway Chrome profile, and a throwaway native-host config. Unit tests create that home with `mkdtemp`. `desktop/test/run-v1.mjs` sets `BAO_TEST_BROWSER` to Playwright's Chromium and stops when that binary is missing. Run `npx playwright install chromium` to get it. While `BAO_TEST_BROWSER` is set, every owned launch in `desktop/src/launch.ts` starts that binary with `--use-mock-keychain` and `--password-store=basic`, so the suite does not open the installed Google Chrome or the login keychain. `desktop/src/launch.ts` refuses a browser whose user-data directory is the daily Chrome profile. `assertNotDailyChrome` in `desktop/src/profile.ts` compares `path.resolve` and does not follow symlinks. Do not pass a link to the daily profile directory.

The older live tools and their workflow replay driver are retired. Use `agent_browser` for agent Chrome control. Tests must pass a synthetic `BAO_AGENT_BROWSER_PROFILE_ROOT`; never point it at a daily profile. Saved `cdp-live` workflows stay readable but replay fails with `this workflow used the retired live driver`.

`bao serve` writes `com.bao.desktop.json` under the real home's Chrome NativeMessagingHosts directories. `defaultConfigHome` in `desktop/src/extension/install-host.ts` returns `homedir()`. `BAO_HOME` does not move that write. The write replaces the installed app's manifest. On a Mac with Bao.app installed, run a checkout `bao serve` only when asked. Then quit it and reopen Bao from Finder.

## Use the signed helper

The helper is the signed app BaoOSHelper. Its bundle id is `dev.bao.oshelper`, from `desktop/os-helper-macos/Info.plist`. The installed copy is `/Applications/Bao.app/Contents/Resources/BaoOSHelper.app`. `helperBin` in `desktop/src/cdp-live/ax.ts` ignores a missing `BAO_OS_HELPER` and a value that is not an existing `.app`. It then uses the installed helper. An existing `.app` path is used with no signature check. The signer for the grant is `bao dev signing`, from `docs/mac-build.md`.

Do not rebuild BaoOSHelper unless the task explicitly authorizes it. When it does, re-sign only with the existing `bao dev signing` identity so the designated requirement and the existing grants survive. Do not pass `--deep` to `codesign`. Do not reset its privacy permissions. Do not grant Accessibility or Screen Recording to see whether a different failure goes away.

`remoteDebuggingBlock` in `desktop/src/helper-capabilities.ts` stops the helper's remote-debugging toggle when the helper asked for a permission prompt or Accessibility is off. Screen Recording does not stop it. Bao-profile and copied-profile pass-through do not call this helper path. `chromeHelper` in `desktop/src/cdp-live/ax.ts` refuses the helper's `shot` command, so that Chrome wrapper never uses Screen Recording. Window capture and the MCP driver (`bao mcp-ax`) still need Screen Recording. `helper available` reports helper presence, not permission readiness. Optional grants do not affect the label, and app status does not check Automation. `capabilityReport` in `desktop/src/helper-capabilities.ts` sets that label.

## Do not bill a model from a test

Leave `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, and `CURSOR_API_KEY` unset. Set `BAO_HEAL_CURSOR_ACCOUNT` to `0` before `bao serve`, before a replay, and before any test the two test runners do not spawn. `desktop/test/run-v1.mjs` and `desktop/test/run-live.mjs` set that variable for the suites they spawn. Leaving `BAO_HEAL_CURSOR` unset is not enough. With a logged-in `agent` on `PATH`, `readCursorAccount` returns authenticated, and a replay miss can run `agent --print`. That call bills the account. A Finder launch cannot take the variable. Do not cause a replay miss while `model.label` is `cursor account`.

## Show the running app

A UI change needs before and after evidence from the running app. With `BAO_RUN_VIDEO=1`, `openReplay` in `desktop/src/app/server.ts` passes `<library.root>/videos/incoming` to `launchOwnedChrome` in `desktop/src/launch.ts`, which gives it to Playwright as `recordVideo.dir`. `keepReplayClip` in `server.ts` copies the clip to `<library.root>/videos/<runId>.webm` when it has a `runId`. `close()` calls it. `runRecorded` in `server.ts` passes the same dest to `openReplayVideo` in `desktop/src/v1/replay-video.ts`. Only with the explicit native-window opt-in `BAO_REPLAY_VIDEO=1`, on a Mac with `BAO_HEADED=1`, a `BaoWindowVideo.app`, and a Screen Recording probe that passes, `encodeWebm` writes that dest from the window recorder. It needs an ffmpeg from `FFMPEG`, `which ffmpeg`, `/opt/homebrew/bin/ffmpeg`, or `/usr/local/bin/ffmpeg`, and a file over 1000 bytes. A Finder launch sets `BAO_HEADED=1`. `desktop/packaging/macos/build-window-video.sh` signs `BaoWindowVideo` as `dev.bao.oshelper`.

A test on a real site does not make a write that cannot be undone. Bao does not block final clicks in `agent_browser`; the test must stay within the owner's explicit authorization. The pass-through records raw commands, results, and page screenshots locally, without credential redaction. Do not send real credentials to a fixture run.
