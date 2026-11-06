---
name: verify-bao
description: Verify Bao's pass-through Chrome control, command recording, Runs, and Library on isolated local fixtures without daily profiles, model accounts, or native permission grants.
---

# Verify Bao

Read [the feature map](features/README.md) and choose the affected entry points. The former live-driver baseline helper has been removed with that driver. Do not use historical saved workflows as current recording/replay proof.

## Safety boundary

Use a disposable checkout, temporary HOME and Bao home, a synthetic Chrome source profile, and pinned Playwright Chromium. `BAO_HOME` alone does not isolate native-host writes. Never use the installed or daily Chrome, real profiles, real Library, real sites, model accounts, or shared browser discovery for a fixture test.

Unset vendor API keys and inherited `BAO*` settings. Set `BAO_HEAL_CURSOR_ACCOUNT=0`. Set `BAO_TEST_BROWSER` to Playwright's pinned binary before changing HOME, or preserve the browser-cache path explicitly. The proxy requires `BAO_AGENT_BROWSER_PROFILE_ROOT` to name the synthetic source when a test browser is set.

Do not request Screen Recording, Accessibility, Automation, keychain access, Apple Events JavaScript, helper builds, or TCC changes to make a test pass. Page screenshots use CDP. A permission banner is not a reason to grant anything.

## Focused executable checks

Run `npm run build:desktop`, then the affected tests under `desktop/dist/desktop/test/unit/`. `desktop/test/runtime.ts` exports `laneChildEnv("hermetic", process.env)` for sanitized test environments. Do not run a whole local suite for a focused change.

- Command forwarding: `agent-browser-proxy.test.js` and `mcp.test.js`.
- Browser startup: `agent-browser-startup.test.js`.
- Session teardown: `agent-browser-proxy-close.test.js`.
- Owner handoff: `agent-browser-owner-wait.test.js`.
- Retired workflow refusal: `retired-live-driver.test.js` and `catalog.test.js`.

For real native CLI forwarding on a local fixture, stage the pinned executable with `desktop/packaging/stage-agent-browser.mjs` into a temporary directory. Run `desktop/test/live/agent-browser-proxy.test.js` with `AGENT_BROWSER_PROXY_BINARY` set to that file and `AGENT_BROWSER_PROXY_ARTIFACTS` set outside the checkout. The fixture supplies its own source profile and temp homes. Do not set `AGENT_BROWSER_PROXY_INSTALLED_CHROME` for ordinary fixture work.

## Running-app UI proof

Start only the test-owned app, using `startApp` with an explicit temp home and no extension host, or `bao serve` with a temporary HOME too. Keep native replay video off. Read `/api/state` to confirm the temp Library, expected records, and server identity before driving it.

Use `chrome-devtools-axi` with a unique session, its own temporary UI profile, and the pinned Chromium executable. Never enable automatic connection or reuse a shared browser bridge. Read `snapshot` before each screenshot and open the saved image. Sidebar buttons can redraw; use stable selectors with `chrome-devtools-axi run` when a fresh ref would expire.

Capture before and after on the running app. Check stored command/run effects through an independent read. State whether a workflow came from real recording, import, or a planted historical fixture; a planted workflow proves display/refusal only. Raw pass-through command arguments, native output, and screenshots can contain credentials. Do not claim they are redacted.

After proof, close only the named test-owned MCP, UI bridge, browsers, and app. Verify their PIDs and profile owners are gone and the app URL no longer answers. Remove only this run's temp homes and profiles; keep evidence. Do not kill by process name or sweep directories by prefix.

## Choose remote checks

Every PR runs static gates and `test/essential.json`. Add `full-suite` for shared engine, lifecycle, recording/replay, storage, packaging, or test-infrastructure changes that the essential set does not cover. State the choice and reason in the PR body. Prefer the opt-in remote check over a whole local suite on the shared Mac. See [guardrails](../../../docs/guardrails.md).
