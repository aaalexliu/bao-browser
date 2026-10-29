# Work in this checkout

This file is the rule for the whole checkout. `web/AGENTS.md` is generated Next.js guidance. Leave that file alone.

## Search this tree

Search this checkout only, unless the person who asked authorizes a wider search. Skip `.git`, `.toolchain`, dependency directories such as `node_modules`, and generated output such as `dist`, `out`, and `web/.next`.

## Load skills by name

Load an applicable skill by its name through the harness. If that load fails, read the vendored file named in `.cursor/third-party/pstack/VENDORED.md`. The vendored poteto-mode skill is `.cursor/skills/poteto-mode/SKILL.md`. Do not search the machine for a skill with a similar name.

`.cursor/rules/pstack.mdc` names three skills to use before a shape decision, and before calling a spike done. They are architect, arena, and principle-prove-it-works.

## Run the checks that match the change

`npm run typecheck` runs `tsc --noEmit`.

`npm run test:v1` is the desktop unit suite. `desktop/test/run-v1.mjs` runs it after `tsc -p tsconfig.desktop.json`. A non-zero exit fails this pass. The runner sets `BAO_HEAL_CURSOR_ACCOUNT` to `0` and deletes vendor model keys. This checkout's suite requests `automationintesting.online`, `www.irs.gov`, and `the-internet.herokuapp.com`. After pull request 132, those hosts leave `test:v1`.

`npm test` is the root suite. Its commands are in `docs/TESTING.md`.

Build an installed Mac app from `docs/mac-build.md`. The short human pass is `docs/mac-test.md`. Do not lengthen that card. A Screen Recording grant stopping a live Chrome start was true as of tip `45e30f6`. `desktop/src/cdp-live/session.ts:479` enforces that stop. The engineering pass is `docs/agent-acceptance.md`. It records both helper bits and stops only when `helper.accessibility` is false. Permission switches are in `docs/permissions.md`. Extension install is in `docs/extension.md`. Live Chrome notes are in `docs/cdp-live-chrome.md`.

`desktop/packaging/macos/package-app.sh` copies `desktop/os-helper-macos/BaoOSHelper.app` only when that directory exists. A missing directory still exits 0. A fresh worktree can build `Bao.app` with no helper and no error. Before packaging, copy the signed helper out of the installed app. Do not install that build until the nested helper matches the CDHash note in `docs/mac-build.md`. Pull request 134 checks the helper before signing. Until that lands, a missing helper still exits 0.

## Keep tests off a daily profile

A test uses a throwaway Bao home, a throwaway Chrome profile, and a throwaway native-host config. Unit tests create that home with `mkdtemp`. `desktop/src/launch.ts` refuses a browser whose user-data directory is the daily Chrome profile. `assertNotDailyChrome` in `desktop/src/profile.ts` compares `path.resolve` and does not follow symlinks. Do not pass a link to the daily profile directory.

Attaching to a Chrome that is already open needs an explicit authorization. Name the exact host list and the start URL in that authorization. `desktop/src/cdp-live/session.ts` rejects a host that contains `*` or `/`.

`bao serve` writes `com.bao.desktop.json` under the real home's Chrome NativeMessagingHosts directories. `defaultConfigHome` in `desktop/src/extension/install-host.ts` returns `homedir()`. `BAO_HOME` does not move that write. The write replaces the installed app's manifest. On a Mac with Bao.app installed, run a checkout `bao serve` only when asked. Then quit it and reopen Bao from Finder.

## Use the signed helper

The helper is the signed app BaoOSHelper. Its bundle id is `dev.bao.oshelper`, from `desktop/os-helper-macos/Info.plist`. The installed copy is `/Applications/Bao.app/Contents/Resources/BaoOSHelper.app`. `helperBin` in `desktop/src/cdp-live/ax.ts` ignores a missing `BAO_OS_HELPER` and a value that is not an `.app`. It then uses the installed helper. An existing `.app` path is used with no signature check. The signer for the grant is `bao dev signing`, from `docs/mac-build.md`.

Do not rebuild BaoOSHelper. Do not re-sign it. Do not pass `--deep` to `codesign`. Do not reset its privacy permissions. Do not grant Accessibility or Screen Recording to see whether a different failure goes away.

A granted Screen Recording permission stopping a live Chrome start was true as of tip `45e30f6`. `desktop/src/cdp-live/session.ts:479` enforces it. The same throw is at `desktop/src/cdp-live/instacart-run.ts:198` and `desktop/src/cdp-live/login-diff.ts:84`. `desktop/src/cdp-live/run.ts:114` records the flag and continues. A permission prompt still stops the run. `helper ok` means both grants in `desktop/src/app/server.ts:3364`.

## Do not bill a model from a test

Leave `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, and `CURSOR_API_KEY` unset. Set `BAO_HEAL_CURSOR_ACCOUNT` to `0` before `bao serve`, before a replay, and before any test the unit runner does not spawn. `desktop/test/run-v1.mjs` sets that variable for the suite it spawns. Leaving `BAO_HEAL_CURSOR` unset is not enough. With a logged-in `agent` on `PATH`, `readCursorAccount` returns authenticated, and a replay miss can run `agent --print`. That call bills the account. A Finder launch cannot take the variable. Do not cause a replay miss while `model.label` is `cursor account`.

## Show the running app

A UI change needs before and after evidence from the running app. The Playwright recorder writes `<library.root>/videos/incoming` when `BAO_RUN_VIDEO=1` (`desktop/src/app/server.ts:2843`). `launchOwnedChrome` passes that directory as `recordVideo.dir` (`desktop/src/launch.ts:474`). `keepReplayClip` copies the clip to `<library.root>/videos/<runId>.webm` when it has a `runId` (`desktop/src/app/server.ts:2451`). `close()` calls it (`desktop/src/app/server.ts:2429`). `encodeWebm` is a second writer to the dest at `desktop/src/app/server.ts:2768`. It needs an ffmpeg from `FFMPEG`, `which ffmpeg`, `/opt/homebrew/bin/ffmpeg`, or `/usr/local/bin/ffmpeg`, and a file over 1000 bytes (`desktop/src/v1/replay-video.ts:127`). `BaoWindowVideo` is signed as `dev.bao.oshelper`.

A test on a real site does not make a write that cannot be undone. `clickAllowed` in `desktop/src/cdp-live/session.ts` refuses kind `submit`, `radio`, `check`, and `other`. It refuses a button whose label matches `--commit`. A link is allowed unless `--deny` matches. An anchor is a link even when its role is `button`. Put commit words in `--deny` as well. Place order and Reserve pause on **needs you**. That pause is in `docs/mac-test.md`.
