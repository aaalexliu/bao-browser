# Work in this checkout

This file is the rule for the whole checkout. `web/AGENTS.md` is generated Next.js guidance. Leave that file alone.

## Search this tree

Search this checkout only, unless the person who asked authorizes a wider search. Skip `.git`, `.toolchain`, dependency directories such as `node_modules`, and generated output such as `dist`, `out`, and `web/.next`.

## Load skills by name

Load an applicable skill by its name through the harness. If that load fails, read the vendored file named in `.cursor/third-party/pstack/VENDORED.md`. The vendored poteto-mode skill is `.cursor/skills/poteto-mode/SKILL.md`. Do not search the machine for a skill with a similar name.

`.cursor/rules/pstack.mdc` names three skills to use before a shape decision, and before calling a spike done. They are architect, arena, and principle-prove-it-works.

## Run the checks that match the change

`npm run typecheck` runs `tsc --noEmit`.

`npm run test:v1` is the desktop unit suite. `desktop/test/run-v1.mjs` runs it after `tsc -p tsconfig.desktop.json`. The runner removes vendor model keys and sets `BAO_HEAL_CURSOR_ACCOUNT` to `0`.

`npm test` is the root suite. Its commands are in `docs/TESTING.md`.

Build an installed Mac app from `docs/mac-build.md`. The short human pass is `docs/mac-test.md`. Do not lengthen that card. The engineering pass is `docs/agent-acceptance.md`. Permission switches are in `docs/permissions.md`. Extension install is in `docs/extension.md`. Live Chrome notes are in `docs/cdp-live-chrome.md`.

## Keep tests off a daily profile

A test uses a throwaway Bao home, a throwaway Chrome profile, and a throwaway native-host config. Unit tests create that home with `mkdtemp`. `desktop/src/launch.ts` refuses a browser whose user-data directory is the daily Chrome profile.

Attaching to a Chrome that is already open needs an explicit authorization. Name the exact host list and the start URL in that authorization. `desktop/src/cdp-live/session.ts` rejects a host that contains `*` or `/`.

## Use the signed helper

The helper is the signed app BaoOSHelper. Its bundle id is `dev.bao.oshelper`, from `desktop/os-helper-macos/Info.plist`. The installed copy is `/Applications/Bao.app/Contents/Resources/BaoOSHelper.app`, from `desktop/src/cdp-live/ax.ts`. `chromeHelper` in that file refuses a path that is not an `.app` bundle. The signer for the grant is `bao dev signing`, from `docs/mac-build.md`.

Do not rebuild BaoOSHelper. Do not re-sign it. Do not pass `--deep` to `codesign`. Do not reset its privacy permissions. Do not grant Accessibility or Screen Recording to see whether a different failure goes away.

A live Chrome run stops if the helper raises a permission prompt. The same run stops if Screen Recording is already granted for the helper. Both stops are in `desktop/src/cdp-live/session.ts`.

## Do not bill a model from a test

Leave `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, and `CURSOR_API_KEY` unset. Leave `BAO_HEAL_CURSOR` unset. `docs/v1.md` describes the heal that bills a vendor key or a logged-in Cursor account. The desktop unit runner deletes those variables before it starts.

## Show the running app

A UI change needs before and after evidence from the running app. A headed replay writes `videos/<runId>.webm` under the Bao home. `desktop/src/app/server.ts` writes that file.

A test on a real site does not make a write that cannot be undone. The live session refuses a commit control through `clickAllowed` in `desktop/src/cdp-live/session.ts`. Place order and Reserve pause on **needs you**. That pause is in `docs/mac-test.md`.
