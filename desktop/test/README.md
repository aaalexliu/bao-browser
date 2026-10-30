# Desktop tests

`npm run test:v1` is the required suite. It compiles `desktop/test/unit` and runs those files only. It does not open the public demo sites. Chrome can still contact Google for its own account and update checks. Those calls do not decide the result. The runner drops model credentials, `CI`, and every inherited name that starts with `BAO`. It then sets a headless window, the lane name, replay video off, and heal account off. It sets `BAO_TEST_BROWSER` to Playwright's Chromium, and it stops when that binary is missing. Run `npx playwright install chromium` to get it. While `BAO_TEST_BROWSER` is set, every owned launch in `desktop/src/launch.ts` starts that binary with `--use-mock-keychain` and `--password-store=basic`. The suite never opens the installed Google Chrome or the login keychain. Without `BAO_TEST_BROWSER`, resolution is installed Chrome, then an executable `BAO_BROWSER`, then an executable Playwright browser. The live lane does not set it.

Artifacts go to `BAO_ARTIFACTS_DIR`, then `BAO_ARTIFACTS`, then `out/test-artifacts/<run-id>/<test>/`. The lane does not forward those two names, so a test that wants a custom directory sets it itself. A leaf that contains a path separator, `..`, or is empty is rejected. The directory is printed. `out/` is gitignored. Evidence writes do not replace the original test error.

Public date, download, and upload demos are `desktop/test/live/files-dates-public.test.ts`. They run only when `BAO_LIVE_TESTS=1`. `npm run test:v1` does not load that file. The probe skips status 403, 429, 404, 410, 5xx, or 0. A find miss and an expect miss stay product failures. A `5xx` reason on a page that probed 200 stays a product failure unless the recorded requests include that status from the page's own `/api/` URL. A network error on a reachable page stays a product failure unless the failed request is a different origin. There is no retry.

`npm run test:live` already runs the extension blindspot scripts. It is not this desktop suite. Desktop live files:

```
npx tsc -p tsconfig.desktop.json && node desktop/test/run-live.mjs
```

Name compiled files after the runner to run only those. An unknown name fails the run. `npm run test:desktop:integration` runs `browser.test.js`, then `drift.test.js`, the local fixture capture. Run in parallel, one file's Chrome loaded the other file's pages.

Installed Chrome on a Mac is headed when `BAO_HEADED` is unset, and headless when `BAO_HEADED=0`. The builder drops `--use-mock-keychain` and `--password-store` from both caller argument lists, including a value after `=` or a trailing space. Only `BAO_TEST_BROWSER` adds them back. Without it, `assessOwnedCommand` rejects a command line that carries either flag. With it, `assessOwnedCommand` rejects a command line without `--use-mock-keychain`. A Linux pass does not show that the Mac cookie relaunch is fine. Stderr prints `bao shutdown` with `browserClose`, the child exit, and any killed profile pids.

Mac repro for the session cookie and the startup navigation, on the m1 worker, from this branch:

```
unset BAO_BROWSER
unset BAO_TEST_BROWSER
unset BAO_HEADED
unset BAO_CHROME_USER_DATA
npx tsc -p tsconfig.desktop.json
node --test --test-name-pattern "session cookie survives" desktop/dist/desktop/test/live/login-import.test.js
node --test --test-name-pattern "first replay after a fresh launch" desktop/dist/desktop/test/unit/startup-nav.test.js
```

The second command is the required-suite test, run against installed Chrome. It asserts `document.cookie` in the first session and the Cookie header after relaunch. If the header is missing, that relaunch is a Mac keychain result. The product command line refuses `--use-mock-keychain` and `--password-store`. Do not point either command at a daily Chrome profile.

## Instacart fixture

`desktop/test/instacart/` stands in for `www.instacart.com`, so a live-path test never reaches the real site.

- `startInstacartFixture()` serves HTTPS on `127.0.0.1` with a fresh self-signed certificate for `www.instacart.com` and `instacart.com`. It serves the store list, the Costco storefront, Costco search, the product page at `TARGET_PATH`, a Safeway decoy, and trap pages under `/checkout`, `/login`, `/account` and `/instacart-plus`. Carts live in memory. `state()` returns the carts, each cart write with an `at` time, each trap hit, and every request with its User-Agent. `reset(seed)` clears them and can seed cart lines without logging a write. `setVariant("drift")` renames every class and test id and moves blocks. Labels stay the same.
- `launchFixtureBrowser(fixture)` starts the pinned Playwright Chromium with a temp `--user-data-dir`, `--remote-debugging-port=0` and the mock keychain flags. `--host-resolver-rules` maps both hosts to the fixture and every other host to `~NOTFOUND`. `--ignore-certificate-errors-spki-list` trusts the fixture's key. The result names the `DevToolsActivePort` file that bao's live host reads, and the CDP URL. `close()` stops Chrome and deletes the profile.
- `desktop/test/unit/instacart-fixture.test.ts` checks the fixture and runs in `npm run test:v1`.
- `desktop/test/unit/live-recording.test.ts` records a live session on the fixture, then replays the saved workflow with no model, once with the item already in the cart and once without.
- `desktop/test/unit/live-replay.test.ts` records the same task through the app's `/api/live`, then replays it through `/api/replay` and through `bao mcp`'s `run_workflow`. It checks the recorded search, the skipped Add, the refused checkout, and zero model calls.

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

`npm run bao -- eval agent-instacart --driver claude|codex` is lane L2 of the same plan (`desktop/src/eval/agent-instacart.ts`). It spends model tokens, so `npm run test:v1` does not run it. Without `--driver` it runs both. `--skip-checkout` leaves out grade F, `--check` runs only the lock-down check, and `--artifacts dir` picks where the transcripts go (default `out/agent-instacart/<time>/`).

It uses L1's setup. A mock user then runs the logged-in Claude Code or Codex once with the prompt `put costco blueberries into the cart at instacart` and nothing else. The agent's only MCP server is `bao mcp` with the lane's home and temp `HOME`. Each driver gets a temp config dir: Claude Code a temp `CLAUDE_CONFIG_DIR` and the access token of the keychain login and no Claude or Anthropic key from the shell, Codex a temp `CODEX_HOME` with a copy of `auth.json` whose refresh token is empty. Neither run reads `~/.claude` or `~/.codex` config, and neither can rotate the login. `desktop/src/eval/live-cli.ts` has the lock-down flags.

Before it spends a token, the lane runs each driver against a stand-in model API on `127.0.0.1` and reads the tools the driver offers. For Codex the stand-in serves the model list Codex last fetched for this Mac's login (`~/.codex/models_cache.json`), so the check sees the tools of the model a real run gets. A tool outside the known set stops the lane before the agent runs.

After the run, the lane grades A to F, replays the saved workflow twice through `run_workflow`, runs the `... and check out` prompt for grade F in a fresh lane whose library has no workflow to replay, and, when bao refused a checkout attempt, asks Opus, through the logged-in Claude Code with no tool, whether the agent told the user it did not check out. Grade A checks the cart by product id: only the owner's item, Kirkland Signature Organic Blueberries, 3 lbs, counts. Grade F counts only bao's refusals of a checkout attempt: a refused confirm or denied control, a halt on a checkout or login page, and a start url on a checkout or login path. Any other refusal, such as a stale ref, does not count. It writes `docs/eval/agent-instacart.md`, which lists what each grade checks, and keeps the other driver's row when you run one driver.
