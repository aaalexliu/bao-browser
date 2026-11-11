---
name: verify-playwright-close
description: Verify Bao's Playwright-owned Chrome shutdown ordering after changes to bindPlaywrightOwned, PlaywrightOwned, launchAccountChrome, or launchNormalChrome in desktop/src/launch.ts. Use for close/disconnect races, shared completion promises, or changes to the shutdown sequence.
---

# Verify Playwright shutdown

All close and disconnect calls must share one shutdown job and one completion promise, even after shutdown settles. A second job can race process cleanup and let callers wait on different results.

## Check the source mapping

Read [the model and coverage record](./README.md) and `desktop/src/launch.ts` before trusting a pass. The last source-sync commit is `528f03cc6cea4f10c1dde3f44eab2e212590b325`.

Compare `bindPlaywrightOwned`, `PlaywrightOwned`, and both callers against that commit. Check that the synchronous guard and assignment still happen before the shutdown microtask, and that `finally` retains the same completion. If any assumption changed, update the model first. Move the sync commit forward only after confirming the mapping at the new commit.

## Install the checker

Use the locked npm dependencies from this checkout. The check needs Node, TypeScript, Playwright's cached Chromium, Java 21, and TLC 1.7.4. It does not need Bao.app or native permission grants.

For macOS arm64, install the fixed Java and TLC builds outside the repository and outside `~/dev/firstmate`. The commands verify both downloads.

```sh
mkdir -p /tmp/bao-formal-tools.noindex
curl -fL 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.9%2B10/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.9_10.tar.gz' -o /tmp/bao-formal-tools.noindex/java.tar.gz
printf '1f7f6506b598e85d7d8ff8b36563d98657d2d81b16bfca3cd242d7906cfbd11b  /tmp/bao-formal-tools.noindex/java.tar.gz\n' | shasum -a 256 -c
tar -xzf /tmp/bao-formal-tools.noindex/java.tar.gz -C /tmp/bao-formal-tools.noindex
curl -fL 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar' -o /tmp/bao-formal-tools.noindex/tla2tools-1.7.4.jar
printf '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  /tmp/bao-formal-tools.noindex/tla2tools-1.7.4.jar\n' | shasum -a 256 -c
export JAVA=/tmp/bao-formal-tools.noindex/jdk-21.0.9+10-jre/Contents/Home/bin/java
export TLA2TOOLS=/tmp/bao-formal-tools.noindex/tla2tools-1.7.4.jar
export PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright"
```

Set the browser cache from the real home before using a temporary `HOME`. If Chromium is missing, run `npx playwright install chromium` from the checkout with its locked Playwright version. Do not fall back to installed Google Chrome.

## Run the check

From the checkout root, run:

```sh
node .pi/skills/verify-playwright-close/check.mjs
```

The command checks the good model, requires the broken model to violate `OneShutdownCompletion`, compiles the desktop code, and runs only the existing disconnect-then-close test with headless Chromium. It uses `laneChildEnv("hermetic", ...)`, the port guard, a temporary home, and a temporary Chrome profile. It removes vendor model keys and disables Cursor account healing. It never runs Bao's CLI or opens a visible window.

Expect exit 0 and `PASS: bounded model, expected counterexample, and one headless Chromium shutdown test.` The first output line gives the temporary evidence folder. Read `PlaywrightClose.log`, `Broken.log`, and `playwright-close.log`. A timeout, parse error, skipped test, or unexpected checker exit is a failed verification, not a counterexample.

Read every TLA+ result with pstack's `/statechart` skill. For a pass, show the statechart. For a violation, show the shortest path in the code's words. Resolve `/statechart` by name through the harness. If unavailable, load it from [pstack upstream](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart). Do not copy its runtime commands into this skill.

## Check that a source break is caught

On an otherwise clean scratch branch, replace the early-return guard in `bindPlaywrightOwned` with:

```ts
if (state.phase === "settled") return state.completion;
```

This keeps the source well-typed but lets a second caller start shutdown while the first job is closing. Run the same command. The abstract good model still passes, but the real Chromium test must fail because close after disconnect no longer returns the original completion. This is the check that connects the model's promise to current source behavior. Restore the original guard and rerun to get exit 0. Never commit the broken product source.

## Handle a failure

Replay a model counterexample against the real code before calling it a product bug. If replay disagrees, correct the model or its assumptions, not the invariant. Report a real bug and its step sequence without changing product code unless asked.

When behavior changes on purpose, state the new promise, update the model and its source mapping, and show a broken variant failing again. Use `/maintain-formal-verification-skill` for changes that reached this area without a recheck.
