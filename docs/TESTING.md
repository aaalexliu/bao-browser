# Testing Bao

[README](../README.md) is the product entry point. The old standalone root
extension and its test tools are retired. `npm test`, `test/all.mjs`,
`test/run.mjs`, and the old live-site scripts are no longer entry points.
The native-messaging extension in `extension/` is still bundled in Bao.app.

## Choose the PR checks

Every PR runs static gates and the tests in
[`test/essential.json`](../test/essential.json). The separate **Full suite**
check runs only on a PR with the `full-suite` label or through manual dispatch.
It has no schedule and is not a required check. A label starts it at once and
keeps it running on later pushes while the label remains.

Opt in when a change touches shared runtime, engines, live-browser behavior,
recording/replay, sync/storage, packaging, or test infrastructure that the
essential set does not cover. Skip it when the essential set fully covers the
change. Always state the choice and reason in the PR body.

```sh
gh-axi pr edit <number> --add-label full-suite
gh-axi workflow run guardrails.yml --ref <branch>
```

The full check runs hermetic desktop and web tests. It no longer builds or
tests the legacy extension. It never runs public-site tests or billable model
evals. Read its actual result; an essential pass is not a full-suite pass.
[Selection evidence](ci-test-selection.md) records the retired suites and their
last measured times.

## Run focused local checks

`npm ci` installs the root lockfile and `web/`.

```sh
npm ci
npx playwright install chromium
npm run check:static
npm run build:desktop
npm run build:extension
node --test test/essential-manifest.test.mjs
npm run test:guardrails
```

Use `scripts/test-essential.mjs <group>` for one essential group after building.
For an exact desktop file, run its compiled path with Node's test runner in an
isolated environment. Do not pass a filename to `desktop/test/run-v1.mjs` to
select it: that runner still appends the full suite. The shared environment
helper pins Playwright Chromium, keeps the real browser cache across a temp `HOME`, and strips model keys and inherited Bao settings:

```sh
node --input-type=module <<'JS'
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { laneChildEnv } from './desktop/dist/desktop/test/runtime.js';
const home = mkdtempSync(path.join(tmpdir(), 'bao-focused-'));
try {
  const env = laneChildEnv('hermetic', { ...process.env, HOME: home });
  const result = spawnSync(process.execPath, [
    '--test', '--test-force-exit',
    'desktop/dist/desktop/test/unit/install-scripts.test.js',
  ], { env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
JS
```

## Run broader checks remotely

`npm run check` checks types and runs desktop units. `npm --prefix web test`
runs the registry tests. Prefer the opt-in remote Full suite to a full local
pass on the shared Mac. Local browser integration uses
`npm run test:desktop:integration`.

[Desktop test guidance](../desktop/test/README.md) owns the hermetic/live lane
rules, media isolation, concurrency, and stale-output checks. Tests use temp
homes, Libraries, native-host config, and profiles. Never use the owner's Chrome
profile or Library. `BAO_HOME` alone does not isolate native-messaging writes;
set a temp `HOME` too. A temp `HOME` does not move Chrome's profile folder:
`laneChildEnv` points `BAO_CHROME_USER_DATA` at a fixture. Keep model keys unset
and `BAO_HEAL_CURSOR_ACCOUNT=0`.

## Verify the desktop extension and package

Build with `npm run build:extension`. `install-extension.sh` stages
`extension/dist` by default; set `BAO_EXTENSION_DIR` to a temp directory for
checks. Load that directory unpacked in a fresh Playwright Chromium profile,
not a daily Chrome profile. Confirm its service worker and popup load without
JavaScript errors. Native-host connectivity needs its own temp config and is
not proven just by an unpacked load.

`npm run package:mac` must also pass for packaging changes. Follow
[Rebuild with an existing grant](mac-build.md#rebuild-with-an-existing-grant) and inspect the bundled
`Bao.app/Contents/Resources/extension/dist/manifest.json`. Do not install the
test build over `/Applications/Bao.app` or change system permissions.
