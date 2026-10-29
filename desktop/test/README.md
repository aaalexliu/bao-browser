# Desktop tests

`npm run test:v1` is the required suite. It compiles `desktop/test/unit` and runs those files only. It does not open the public demo sites. Chrome can still contact Google for its own account and update checks. Those calls do not decide the result. The runner forces a headless window, drops model credentials, and leaves a real helper, a real Chrome profile, and video mode unset. It also drops an inherited `BAO_BROWSER`. Product resolution stays installed Chrome, then `BAO_BROWSER`, then Playwright. The runner sets `BAO_TEST_BROWSER` to Playwright's Chromium when that binary exists. A test passes that path into its own launch. The product resolver does not read it.

Artifacts go to `BAO_ARTIFACTS_DIR`, then `BAO_ARTIFACTS`, then `out/test-artifacts/<run-id>/<test>/`. The directory is printed. `out/` is gitignored. Evidence writes do not replace the original test error.

Public date, download, and upload demos are `desktop/test/live/files-dates-public.test.ts`. They run only when `BAO_LIVE_TESTS=1`. One request records the HTTP status. The skip is the probe status 403, 429, 404, 410, or 5xx, or a navigation that failed on the network. A find miss, an expect miss, and a 5xx inside the replay of a page that probed 200 are product failures. There is no retry.

`npm run test:live` already runs the extension blindspot scripts. It is not this desktop suite. Desktop live files:

```
npx tsc -p tsconfig.desktop.json && node desktop/test/run-live.mjs
```

Installed Chrome on a Mac uses the product default (headed unless `BAO_HEADED` is set). The required suite does not set `BAO_TEST_MOCK_KEYCHAIN`. When a test sets that flag, the test appends `--use-mock-keychain` and `--password-store=basic` after the product arg builder. The product builder always drops those flags. The flag is a hypothesis for a locked Apple keychain, not a confirmed fix. A Linux pass does not show that the Mac cookie relaunch is fine. Stderr prints `bao shutdown` with `browserClose`, the child exit, and any killed profile pids.

Mac repro for the session cookie and the startup navigation, on the m1 worker, from this branch:

```
unset BAO_BROWSER
unset BAO_TEST_BROWSER
unset BAO_HEADED
unset BAO_TEST_MOCK_KEYCHAIN
unset BAO_CHROME_USER_DATA
npx tsc -p tsconfig.desktop.json
node --test --test-name-pattern "session cookie survives" desktop/dist/desktop/test/live/login-import.test.js
node --test --test-name-pattern "first replay after a fresh launch" desktop/dist/desktop/test/unit/startup-nav.test.js
```

The second command is the required-suite case. It asserts `document.cookie` in the first session and the Cookie header after relaunch. If the header is missing, rerun that file once with `BAO_TEST_MOCK_KEYCHAIN=1` and compare `bao shutdown`. Do not point either command at a daily Chrome profile.
