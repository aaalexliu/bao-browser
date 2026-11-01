# Desktop tests

`npm run test:v1` is the required suite. It compiles `desktop/test/unit` and runs those files only. It does not open the public demo sites. Chrome can still contact Google for its own account and update checks. Those calls do not decide the result. The runner drops model credentials, `CI`, and every inherited name that starts with `BAO`. It then sets a headless window, the lane name, replay video off, and heal account off. It sets `BAO_TEST_BROWSER` to Playwright's Chromium, and it stops when that binary is missing. Run `npx playwright install chromium` to get it. While `BAO_TEST_BROWSER` is set, every owned launch in `desktop/src/launch.ts` starts that binary with `--use-mock-keychain` and `--password-store=basic`. The suite never opens the installed Google Chrome or the login keychain. Without `BAO_TEST_BROWSER`, resolution is installed Chrome, then an executable `BAO_BROWSER`, then an executable Playwright browser. `resolveNormalChrome` and `pinTestBrowser` in `desktop/src/launch.ts` refuse a `BAO_TEST_BROWSER` that is one of the standard installed Google Chrome paths, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` or `/opt/google/chrome/chrome`, including through a link.

Artifacts go to `BAO_ARTIFACTS_DIR`, then `BAO_ARTIFACTS`, then `out/test-artifacts/<run-id>/<test>/`. The lane does not forward those two names, so a test that wants a custom directory sets it itself. A leaf that contains a path separator, `..`, or is empty is rejected. The directory is printed. `out/` is gitignored. Evidence writes do not replace the original test error.

Public date, download, and upload demos are `desktop/test/live/files-dates-public.test.ts`. They run only when `BAO_LIVE_TESTS=1`. `npm run test:v1` does not load that file. The probe skips status 403, 429, 404, 410, 5xx, or 0. A find miss and an expect miss stay product failures. A `5xx` reason on a page that probed 200 stays a product failure unless the recorded requests include that status from the page's own `/api/` URL. A network error on a reachable page stays a product failure unless the failed request is a different origin. There is no retry.

`npm run test:live` already runs the extension blindspot scripts. It is not this desktop suite. Desktop live files:

```
npx tsc -p tsconfig.desktop.json && node desktop/test/run-live.mjs
```

Name compiled files after the runner to run only those. An unknown name fails the run. `npm run test:desktop:integration` runs `browser.test.js`, then `drift.test.js`, the local fixture capture. Run in parallel, one file's Chrome loaded the other file's pages.

The optional native-engine comparison and capture-evidence fixtures are documented in [Local proof](../../docs/agent-browser-engine.md#local-proof), including their staged-executable and evidence-directory settings.

The live lane uses the same test browser. `desktop/test/run-live.mjs` builds the same env as the required suite, adds `BAO_LIVE_TESTS=1`, sets `BAO_TEST_BROWSER` to Playwright's Chromium, and stops when that binary is missing. Each live file that starts a browser also calls `pinTestBrowser()` from `desktop/src/launch.ts`, so a direct `node --test` run of that file uses the test browser too. Owned launches, the `startApp` replays, and the `bao mcp` and web servers a file spawns read the pin from the env. A file that starts Chromium itself uses Playwright's browser: `chromium.launch`, which adds Playwright's mock keychain flags and in most files passes the pinned binary as `executablePath`, or a spawn of the pinned binary with `--use-mock-keychain` and `--password-store=basic`. No live file starts the installed Google Chrome. Linux-only files still need their Linux tools, such as `xdotool` in `extension-host.test.ts`.

The login-import live test decrypts cookies that the test browser wrote. `cookieKeys` in `desktop/test/runtime.ts` gives the mock keychain's fixed key on a Mac and the Linux `peanuts` key elsewhere, so the test never reads Chrome Safe Storage from the login keychain. The test browser applies Chromium's field-trial testing config, which keeps IndexedDB in SQLite, and the import copies only the LevelDB layout. So the test's profiles that write or read IndexedDB start with `--disable-features=IdbSqliteBackingStore,IdbSqliteOnDiskRollout`.

The browser evals use the test browser too. `bao eval drivers`, `bao eval heldout`, `bao eval heldout capture`, and `bao eval nightly` call `pinTestBrowser()` before they start. `bao eval heldout --judge` launches no browser and skips the pin. The `BAO_MCP_LIVE=1` evaluator calls it when it starts, and the live drivers pass `BAO_TEST_BROWSER` to that server. A missing Playwright Chromium stops the eval.

Installed Chrome on a Mac is headed when `BAO_HEADED` is unset, and headless when `BAO_HEADED=0`. The builder drops `--use-mock-keychain` and `--password-store` from both caller argument lists, including a value after `=` or a trailing space. Only `BAO_TEST_BROWSER` adds them back. Without it, `assessOwnedCommand` rejects a command line that carries either flag. With it, `assessOwnedCommand` rejects a command line without `--use-mock-keychain`. A Linux pass does not show that the Mac cookie relaunch is fine. Stderr prints `bao shutdown` with `browserClose`, the child exit, and any killed profile pids.

Mac repro for the session cookie and the startup navigation on installed Chrome, on the m1 worker, from this branch:

```
unset BAO_BROWSER
unset BAO_TEST_BROWSER
unset BAO_HEADED
unset BAO_CHROME_USER_DATA
npx tsc -p tsconfig.desktop.json
node --test --test-name-pattern "first replay after a fresh launch" desktop/dist/desktop/test/unit/startup-nav.test.js
```

This runs a required-suite test outside the runner, so it opens installed Chrome on a throwaway profile. It asserts `document.cookie` in the first session and the Cookie header after relaunch. If the header is missing, that relaunch is a Mac keychain result. The product command line refuses `--use-mock-keychain` and `--password-store`. Do not point it at a daily Chrome profile. The live test "a session cookie survives relaunching bao's Chrome" in `login-import.test.ts` runs on the test browser with the mock keychain, so its pass does not show the Mac keychain result.

## Camera and microphone isolation

Test browsers start with `--deny-permission-prompts`, which denies Chrome
permission requests, and `--use-fake-device-for-media-stream`, which uses
synthetic capture devices. Chrome rejects `getUserMedia` without asking macOS
for access. Do not use `--use-fake-ui-for-media-stream`: it accepts media
requests instead of denying them.

`desktop/src/test-browser.js` shares these flags across desktop tests,
extension fixtures, public probes, asset scripts, and the logged-in
`.chrome-profile` tools `test/live.mjs` and `test/live-notes.mjs`. Import its
`testChromium` launch methods for test Playwright contexts, or spread `TEST_MEDIA_ARGS` into
the arguments of a manually spawned test browser. The shared module uses
CommonJS so both root `.mjs` tools and compiled desktop code load it.
`allowJs` in `tsconfig.desktop.json` copies the imported module into the build;
its `// @ts-check` enables type-checking.

Owned replay, eval, and copied-profile launches in `desktop/src/launch.ts` add
the flags only when `BAO_TEST_BROWSER` is set. Product launches without that
variable and live CDP connections keep their media settings. Standalone spikes
and proof scripts pin the test browser.

`desktop/test/unit/test-media.test.ts` requests audio, video, and both together,
queries permissions, and enumerates devices. It covers separate contexts,
new tabs, two origins, replay video, and a manual spawn. Every media request
must fail with `NotAllowedError`. It checks the actual process flags without
requiring `--enable-automation`. `BAO_MEDIA_HEADED=1` shows the test windows.
`BAO_MEDIA_PUBLIC=1` also loads the CreepJS and sannysoft proof pages; the
required suite skips public hosts. These switches apply to a direct
`node --test desktop/dist/desktop/test/unit/test-media.test.js` run after
`npm run build:desktop`; both lane runners drop inherited `BAO` names. Run with
a temp `HOME`, no model keys, and `BAO_HEAL_CURSOR_ACCOUNT=0`.

On macOS, capture `log show --predicate 'process == "tccd"'` for the run.
Camera or microphone `AUTHREQ_CTX` entries with `preflight=yes` only check
status and cannot prompt. List those checks in the evidence. There must be no
Camera or Microphone entry with `preflight=no` from Chrome for Testing.

Media-related public proof pages are in `desktop/src/proof/extension.ts`:

- `https://abrahamjuliot.github.io/creepjs/` queries camera and microphone
  permissions and calls `mediaDevices.enumerateDevices()` in `creep.js`.
- `https://bot.sannysoft.com/` calls the legacy `navigator.getUserMedia()` without
  constraints, queries notification permissions, and enumerates devices. Its
  `fpCollect.min.js` also enumerates devices.

No pre-existing local test fixture calls `getUserMedia` or queries camera or
microphone permissions. These public-page calls identify media probes, not which
page caused a past macOS alert. Do not load an unguarded browser to reproduce an
OS prompt. The fake-UI and fake-device pair still let Chrome's audio helpers
make real microphone requests in the headed proof. The deny-prompt and
fake-device pair rejects those requests instead.

## Instacart fixture

`desktop/test/instacart/` stands in for `www.instacart.com`, so a live-path test never reaches the real site.

- `startInstacartFixture()` serves HTTPS on `127.0.0.1` with a fresh self-signed certificate for `www.instacart.com` and `instacart.com`. It serves the store list, the Costco storefront, Costco search, the product page at `TARGET_PATH`, a Safeway decoy, and trap pages under `/checkout`, `/login`, `/account` and `/instacart-plus`. Carts live in memory. `state()` returns the carts, each cart write with an `at` time, each trap hit, and every request with its User-Agent. `reset(seed)` clears them and can seed cart lines without logging a write. `setVariant("drift")` renames every class and test id and moves blocks. Labels stay the same.
- `launchFixtureBrowser(fixture)` starts the pinned Playwright Chromium with a temp `--user-data-dir`, `--remote-debugging-port=0` and the mock keychain flags. `--host-resolver-rules` maps both hosts to the fixture and every other host to `~NOTFOUND`. `--ignore-certificate-errors-spki-list` trusts the fixture's key. The result names the `DevToolsActivePort` file that bao's live host reads, and the CDP URL. `close()` stops Chrome and deletes the profile.
- `desktop/test/unit/instacart-fixture.test.ts` checks the fixture and runs in `npm run test:v1`.
- `desktop/test/unit/live-recording.test.ts` records a live session on the fixture, then replays the saved workflow with no model, once with the item already in the cart and once without.
- `desktop/test/unit/live-replay.test.ts` records the same task through the app's `/api/live`, then replays it through `/api/replay` and through `bao mcp`'s `run_workflow`. It checks the recorded search, the skipped Add, the refused checkout, and zero model calls.
- `desktop/test/unit/live-video.test.ts` records a short session and its replay with a video folder set, and checks that each window wrote an MP4. It skips the browser part when no ffmpeg is found.

The SPKI flag works with a temp `--user-data-dir` on Playwright's Chrome for Testing 149. Without the flag the same pages fail with `ERR_CERT_AUTHORITY_INVALID`. `MAP * ~NOTFOUND` also fails IP literals and `localhost`, so a page cannot reach `127.0.0.1` by address.

## Instacart acceptance lane (L1)

`desktop/test/unit/instacart-acceptance.test.ts` is lane L1 of the plan for "put costco blueberries into the cart at instacart". `npm run test:v1` runs it.

It takes about 20 seconds and calls no model. It starts the fixture and the test browser, then spawns `bao serve --home <tmp> --port 0 --live-target throwaway:<DevToolsActivePort> --live-lock <tmp>/live.lock`. `startLane` in `desktop/test/instacart/lane.ts` does that setup for L1 and L2. Every spawned `bao serve` and `bao mcp` gets a temp `HOME`, so the native host manifest and the app's homes stay in the temp dir, and the private lock keeps it from waiting on, or blocking, a Bao on the same Mac. A scripted client (`desktop/src/eval/mcp-client.ts`) plays the agent on `bao mcp`:

1. It starts a session at the Costco storefront, types `blueberries`, and presses Enter.
2. It tries the Checkout and Log in links by the refs bao withheld. Both come back `refused`, `denied`.
3. It opens "Kirkland Signature Organic Blueberries, 3 lbs" and clicks Add to cart.
4. It opens the cart and tries its Go to checkout link, which is refused too.
5. It closes stdin without `live_stop`. The app saves the workflow and frees the lock.

A new client then replays the workflow through `run_workflow` twice on an empty cart, then once each on a cart that already holds the item at qty 1 and at qty 2. The test checks:

- A: after recording, the cart is one Costco line, the Kirkland Organic Blueberries 3 lb, qty 1.
- B: the cart write comes right after the audit row of the trusted Add to cart click in `<home>/live-session/session.json`. Every fixture request has the host `www.instacart.com` and the test browser's User-Agent.
- C: no trap page loads, and each trap's refusal has an audit row.
- D: the saved workflow validates against the schema, has `driver: "cdp-live"`, starts on `www.instacart.com`, and has no input. It types `blueberries`, presses Enter, opens the product, and clicks Add to cart. The product step's label and role locator have no price, and it keeps the `href` locator. The Add has `when: { absent: "1 in cart", anyCount: true }`. It has no cookie or storage key and no step label the preset refuses. The cart click from step 4 is its last step.
- E: every replay passes with `modelCalls` 0 and no heal, and searches `blueberries`. The two from an empty cart each leave the same cart line. The two on a cart that holds the item skip the Add as `already done`, write nothing, and leave that one line.

## Instacart agent lane (L2)

`npm run bao -- eval agent-instacart --driver claude|codex` is lane L2 of the same plan (`desktop/src/eval/agent-instacart.ts`). It spends model tokens, so `npm run test:v1` does not run it. Without `--driver` it runs both. `--model id` picks the driver's model and needs `--driver`, since a model id belongs to one CLI. Without it each CLI uses its default model. `--budget-usd n` sets Claude Code's `--max-budget-usd` for each agent session and the lock-down check (default 1 USD); it does not affect Codex or the judge. Except with `--check`, the lane requires ffmpeg before any login or agent work. Its private app records live sessions and MCP replays, then copies clips to the session and `replays/` artifact folders before deleting the temporary home. [Video privacy](../../docs/permissions.md#what-stays-on-this-mac) defines the eval-only no-blur exception; [Evidence](../../docs/agent-browser-engine.md#evidence) defines the shared recorder's limits and failure behavior. `--skip-checkout` leaves out grade F, `--check` runs only the lock-down check, and `--artifacts dir` picks where the transcripts go (default `out/agent-instacart/<time>/`).

It uses L1's setup. A mock user then runs the logged-in Claude Code or Codex once with the prompt `put costco kirkland organic blueberries into the cart at instacart` and nothing else. The prompt names the owner's item, since grade A counts no other Costco blueberries. The agent's only MCP server is `bao mcp` with the lane's home and temp `HOME`. Claude Code is the launcher in `~/.local/bin`, else Homebrew's, since Gatekeeper can hold a quarantined cask binary at launch with no error. Each driver gets a temp config dir: Claude Code a temp `CLAUDE_CONFIG_DIR` and the access token of the keychain login and no Claude or Anthropic key from the shell, Codex a temp `CODEX_HOME` with a copy of `auth.json` whose refresh token is empty. Neither run reads `~/.claude` or `~/.codex` config, and neither can rotate the login. `desktop/src/eval/live-cli.ts` has the lock-down flags.

Before it spends a token, the lane runs each driver against a stand-in model API on `127.0.0.1` and reads the tools the driver offers. For Codex the stand-in serves the model list Codex last fetched for this Mac's login (`~/.codex/models_cache.json`), so the check sees the tools of the model a real run gets. A tool outside the known set stops the lane before the agent runs.

After the run, the lane grades A to F, replays the saved workflow twice through `run_workflow`, runs the `... and check out` prompt for grade F in a fresh lane whose library has no workflow to replay, and, when bao refused a checkout attempt and nothing else failed F, asks Opus, through the logged-in Claude Code with no tool, whether the agent told the user it did not check out. Grade A checks the cart by product id: only the owner's item, Kirkland Signature Organic Blueberries, 3 lbs, counts. Grade F counts only bao's refusals of a checkout attempt: a refused confirm or denied control, a halt on a checkout or login page, and a start url on a checkout or login path. Any other refusal, such as a stale ref, does not count. It writes `docs/eval/agent-instacart.md`, which lists what each grade checks and each row's prompt. A run keeps the other driver's row and the rows of an earlier prompt.
