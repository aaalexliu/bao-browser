# Desktop tests

## Required local fixtures

`npm run test:v1` compiles and runs `desktop/test/unit` only. It does not open public demo sites or spend model tokens. Chrome can still contact Google for account and update checks; those calls do not decide the result.

The runner drops model keys, `CI`, and every inherited name that starts with `BAO`. It sets headless mode, the lane name, replay video off, and `BAO_HEAL_CURSOR_ACCOUNT=0`. It pins `BAO_TEST_BROWSER` to Playwright's Chromium and stops if that binary is missing. Run `npx playwright install chromium` first. Resolve that binary before changing HOME, or preserve its cache path explicitly.

`laneChildEnv` adds `--require desktop/test/connection-guard.cjs` to `NODE_OPTIONS`, so every node process a runner starts loads the guard. The guard refuses a connection to loopback port 9222, where the owner's Chrome listens for remote debugging, and a read of a `DevToolsActivePort` file in the real home's Chrome folders. A refusal prints the call stack and fails the test process, even when the code under test swallows the error. Fake Chrome endpoints take their port from `trapPort()` in `desktop/test/support/trap-port.ts`, never 9222; a connection to that port fails the test process too. A focused run must take its env from `laneChildEnv` so the guard loads.

Owned test launches use `--use-mock-keychain` and `--password-store=basic`. They never launch installed Google Chrome or read its login keychain. `resolveNormalChrome` and `pinTestBrowser` refuse standard installed Chrome paths, including links to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and `/opt/google/chrome/chrome`. Test homes, source profiles, native-host configs, and browser profiles must all be temporary. A temporary `BAO_HOME` alone does not move native-host writes; use a temporary HOME too.

The runner defaults to two files at a time, matching CI. Node's CPU-based default can stall fixture browsers on a shared Mac. Pass `--test-concurrency=N` to override the limit. Any test or cleanup hook without its own timeout fails after 120 seconds, so a stuck cleanup reports a failure. The run ends after that failure only with `--test-force-exit`, which CI passes; without it, handles the stuck hook left open can keep the run waiting. Do not run the whole local suite for a focused change.

Artifacts use `BAO_ARTIFACTS_DIR`, then `BAO_ARTIFACTS`, then `out/test-artifacts/<run-id>/<test>/`. The runner drops the first two names, so a test sets them itself if needed. A leaf cannot be empty or contain a path separator or `..`. The test prints its artifact directory. Evidence errors do not replace the original test error.

## Pass-through fixtures

[Native executable and tests](../../docs/agent-browser-engine.md#native-executable-and-tests) lists the focused pass-through suites, including session-end coverage. `agent-browser-owner-wait.test.ts` covers metadata-only private waiting, same-session resumption, and owner-window close. `mcp.test.ts` checks the exact [standard MCP tool surface](../../docs/bao.md#mcp) and refuses removed tools.

`desktop/test/unit/experian-proxy.test.ts` uses real native `agent-browser`, a synthetic source profile, test Chromium, and a loopback Experian-shaped site. It covers sign-in handoff, Imperva/hCaptcha halt, resumption after owner action, and redirects. Set `AGENT_BROWSER_PROXY_BINARY` to a staged native executable to run it. Without that explicit binary it skips locally; the required `experian` CI group stages and checksum-checks the pinned executable, so that group runs the case. The test never downloads a binary itself, touches Experian, or rebuilds final-click guards.

`desktop/test/unit/current-chrome-background.test.ts` drives the current-Chrome route over remote debugging with the same real native `agent-browser` against test Chromium. It checks that the owner's tab stays in front with no blur or visibility change, that the background task tab still paints and takes a fill and a click, and that close removes only the task tab. The `run_workflow` case also checks that the run's tab closes when the run ends. That case needs `AGENT_BROWSER_PROXY_BINARY` too. A second case replays a saved workflow with `run_workflow` on the same route and checks that the owner's tab stays in front, and that a run held for the owner brings its tab to the front. A third case does the same through app Replay (`/api/replay`). A fourth case replays next to an owner tab whose page never answers and checks that the replay finishes and attaches none of the owner's tabs. The `experian` CI group runs the first case. The three replay cases need no `AGENT_BROWSER_PROXY_BINARY` and run only on macOS, locally or in the pipeline's Mac test step. They skip on Linux CI because Linux Chromium does not answer `Page.captureScreenshot` for a background tab.

`desktop/test/unit/running-chrome-background.test.ts` and `desktop/test/unit/running-chrome.test.ts` cover the gated extension route for `browser: "current"`: Chrome for Testing with the unpacked Bao extension, a Bao app on a throwaway home, and `runningChromeExtension` on. The first needs `AGENT_BROWSER_PROXY_BINARY` for its agent case. `desktop/test/unit/process-list.test.ts` puts a `ps` on `PATH` whose full listing is 1,074,450 bytes of fake Chrome renderer rows, then checks that `bao mcp` opens, closes, and finishes a Bao-profile session, and that close and `finish_task` still succeed while `pgrep` fails. The `experian` CI group runs all three.

`desktop/test/live/agent-browser-proxy.test.ts` separately checks raw native output parity, stored screenshots, partial/final runs, and cleanup. Set `AGENT_BROWSER_PROXY_ARTIFACTS` to keep evidence. Its installed-Chrome proof requires the separate explicit `AGENT_BROWSER_PROXY_INSTALLED_CHROME=1` opt-in and still uses a synthetic source profile and `chrome://` pages. Do not use that opt-in for ordinary fixture work. [Native executable and tests](../../docs/agent-browser-engine.md#native-executable-and-tests) describes staging.

The old guarded live-driver recording, mode, replay, and private Instacart evaluator fixtures have been removed. [CI selection](../../docs/ci-test-selection.md) records their last measured times and behaviors. A saved file that is not [schema v4](../../docs/workflow-schema.md) is not loaded.

## Public and live files

The old root extension and its `test:live` scripts are retired. Run desktop live files with:

```sh
npx tsc -p tsconfig.desktop.json && node desktop/test/run-live.mjs
```

Name compiled files after the runner to select them; an unknown name fails. The live runner applies the same sanitized test environment, adds `BAO_LIVE_TESTS=1`, and pins Playwright Chromium. Direct live files call `pinTestBrowser()` too. Linux-only files still need tools such as `xdotool` for `extension-host.test.ts`.

`npm run test:desktop:integration` runs `browser.test.js`, then `drift.test.js`. Keep those local browser fixtures sequential: in parallel, one Chrome can load the other fixture's pages.

`desktop/test/live/files-dates-public.test.ts` runs only with `BAO_LIVE_TESTS=1`. Probes skip 403, 429, 404, 410, 5xx, or status 0. A find or expect miss stays a product failure. A `5xx` reason on a page that probed 200 stays a failure unless its own `/api/` request recorded that status. A network failure on a reachable page stays a failure unless it came from another origin. There is no retry.

The login-import live test decrypts only cookies written by the test browser. `cookieKeys` in `runtime.ts` uses the mock keychain's fixed key on macOS and the Linux `peanuts` key elsewhere. IndexedDB copy tests disable `IdbSqliteBackingStore,IdbSqliteOnDiskRollout` because import supports the LevelDB layout, not Chromium's SQLite field trial.

Browser evals pin the test browser too: `bao eval drivers`, `bao eval heldout`, `bao eval heldout capture`, and `bao eval nightly`. `bao eval heldout --judge` starts no browser. The separate `BAO_MCP_LIVE=1` pixel evaluator pins its browser; it is not the removed live-driver tool set.

A Linux fixture pass does not prove macOS keychain relaunch. Product Chrome launches omit mock-keychain/password-store flags and default to headed on macOS. Tests must not remove the browser pin or use installed Chrome without an explicit authorization. Shutdown logs report browser close, child exit, and killed profile PIDs.

## Camera and microphone isolation

Test browsers use `--deny-permission-prompts` and `--use-fake-device-for-media-stream`. Requests fail with `NotAllowedError` without asking macOS. Never use `--use-fake-ui-for-media-stream`: it accepts requests instead of denying them.

`desktop/src/test-browser.js` shares these flags across desktop tests, extension fixtures, public probes, and asset scripts. Use its `testChromium` methods for Playwright contexts or spread `TEST_MEDIA_ARGS` into manual test launches. The CommonJS module works in build tools and compiled desktop code. `allowJs` copies it into desktop output; `// @ts-check` checks it.

Owned replay, eval, and copied-profile launches add those flags only with `BAO_TEST_BROWSER`. Product launches without the pin keep their media settings.

`desktop/test/unit/test-media.test.ts` checks audio, video, both together, permission queries, devices, new tabs, separate contexts, two origins, replay video, and a manual spawn. Every media request must fail with `NotAllowedError`. `BAO_MEDIA_HEADED=1` shows test windows. `BAO_MEDIA_PUBLIC=1` also opens CreepJS and sannysoft; the required suite skips public hosts. Both switches apply to a direct compiled test run, since the lane runners strip inherited `BAO` names. Keep HOME temporary, model keys unset, and `BAO_HEAL_CURSOR_ACCOUNT=0`.

On macOS, a `tccd` Camera or Microphone check with `preflight=yes` only reads status. A request with `preflight=no` from Chrome for Testing is a failure. Do not load an unguarded browser to recreate an OS prompt. Fake UI plus fake devices has still caused real microphone requests; the deny-prompt pair prevents them.
