# Desktop tests

`npm run test:v1` is the required suite. It compiles `desktop/test/unit` and runs those files only. It does not open the public demo sites. Chrome can still contact Google for its own account and update checks. Those calls do not decide the result. The runner drops model credentials, `CI`, and every inherited name that starts with `BAO`. It then sets a headless window, the lane name, replay video off, and heal account off. It sets `BAO_TEST_BROWSER` to Playwright's Chromium, and it stops when that binary is missing. Run `npx playwright install chromium` to get it. While `BAO_TEST_BROWSER` is set, every owned launch in `desktop/src/launch.ts` starts that binary with `--use-mock-keychain` and `--password-store=basic`. The suite never opens the installed Google Chrome or the login keychain. Without `BAO_TEST_BROWSER`, resolution is installed Chrome, then an executable `BAO_BROWSER`, then an executable Playwright browser. The live lane does not set it.

Artifacts go to `BAO_ARTIFACTS_DIR`, then `BAO_ARTIFACTS`, then `out/test-artifacts/<run-id>/<test>/`. The lane does not forward those two names, so a test that wants a custom directory sets it itself. A leaf that contains a path separator, `..`, or is empty is rejected. The directory is printed. `out/` is gitignored. Evidence writes do not replace the original test error.

Public date, download, and upload demos are `desktop/test/live/files-dates-public.test.ts`. They run only when `BAO_LIVE_TESTS=1`. `npm run test:v1` does not load that file. The probe skips status 403, 429, 404, 410, 5xx, or 0. A find miss and an expect miss stay product failures. A `5xx` reason on a page that probed 200 stays a product failure unless the recorded requests include that status from the page's own `/api/` URL. A network error on a reachable page stays a product failure unless the failed request is a different origin. There is no retry.

`npm run test:live` already runs the extension blindspot scripts. It is not this desktop suite. Desktop live files:

```
npx tsc -p tsconfig.desktop.json && node desktop/test/run-live.mjs
```

Name compiled files after the runner to run only those. An unknown name fails the run. `npm run test:desktop:integration` runs `browser.test.js` and `drift.test.js`, the local fixture capture.

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

- `startInstacartFixture()` serves HTTPS on `127.0.0.1` with a fresh self-signed certificate for `www.instacart.com` and `instacart.com`. It serves the store list, the Costco storefront, Costco search, the product page at `TARGET_PATH`, a Safeway decoy, and trap pages under `/checkout`, `/login`, `/account` and `/instacart-plus`. Carts live in memory. `state()` returns the carts, each cart write with an `at` time, each trap hit, and every request. `reset(seed)` clears them and can seed cart lines without logging a write. `setVariant("drift")` renames every class and test id and moves blocks. Labels stay the same.
- `launchFixtureBrowser(fixture)` starts the pinned Playwright Chromium with a temp `--user-data-dir`, `--remote-debugging-port=0` and the mock keychain flags. `--host-resolver-rules` maps both hosts to the fixture and every other host to `~NOTFOUND`. `--ignore-certificate-errors-spki-list` trusts the fixture's key. The result names the `DevToolsActivePort` file that bao's live host reads, and the CDP URL. `close()` stops Chrome and deletes the profile.
- `desktop/test/unit/instacart-fixture.test.ts` checks the fixture and runs in `npm run test:v1`.

The SPKI flag works with a temp `--user-data-dir` on Playwright's Chrome for Testing 149. Without the flag the same pages fail with `ERR_CERT_AUTHORITY_INVALID`. `MAP * ~NOTFOUND` also fails IP literals and `localhost`, so a page cannot reach `127.0.0.1` by address.
