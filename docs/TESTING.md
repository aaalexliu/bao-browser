# Testing Bao

[README](../README.md) is the product entry point. The old standalone root
extension and its test tools are retired. `npm test`, `test/all.mjs`,
`test/run.mjs`, and the old live-site scripts are no longer entry points.
The native-messaging extension in `extension/` is still bundled in Bao.app.

## Choose the PR checks

Every PR runs static gates and the tests in
[`test/essential.json`](../test/essential.json). Two more checks run only when
asked, each by its own PR label or both through manual dispatch. Neither has a
schedule or is a required check. A label starts its check at once and keeps it
running on later pushes while the label remains.

| Label | Runs | Covers |
| --- | --- | --- |
| `full-suite` | `desktop/test/unit` | The first agent run: `agent_browser`, Running Chrome, the run record, the receipt, Chrome profiles, install, the app shell |
| `replay-suite` | `desktop/test/replay`, then `web/` | What the [Replay switch](bao.md#replay-switch) gates: saved-workflow replay, heals, the recorder, the Workflows place, the extension driver, remote relay, sync, the registry, evals |

Add `full-suite` when a change touches shared runtime, engines, live-browser
behavior, packaging, or test infrastructure that the essential set does not
cover. Add `replay-suite` when it touches replay, recording, sync, the
registry, or `web/`. Shared code such as the Library store, the app server, or
the MCP server needs both. Skip them when the essential set fully covers the
change. Always state the choice and reason in the PR body.

```sh
gh-axi pr edit <number> --add-label full-suite
gh-axi pr edit <number> --add-label replay-suite
gh-axi workflow run guardrails.yml --ref <branch>
```

Both checks are hermetic. They never run public-site tests or billable model
evals. Read the actual result; an essential pass is not a full-suite pass, and
a full-suite pass says nothing about replay.
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
node scripts/run-node-test.mjs test/essential-manifest.test.mjs
npm run test:guardrails
```

Use `scripts/test-essential.mjs <group>` for one essential group after building.
For exact desktop test files, name them:

```sh
npm run test:focused -- auth-login.test.js live-view.test.js
```

It builds `desktop/dist` first, so an edited file never runs stale, then runs
only the named files through `desktop/test/run-v1.mjs` with the lane's
environment, timeout, `--test-force-exit` and retry. A name may end in `.js`
or `.ts`. The runner looks for a bare name in `desktop/test/unit` and
`desktop/test/replay`; for a name in both, such as `mcp.test.js`, write
`unit/mcp.test.js` or `replay/mcp.test.js`.
With no name it refuses to run. Pass Node test flags in `--flag=value` form,
such as `--test-name-pattern=login`.

## Run broader checks remotely

`npm run check` checks types and runs desktop units. `npm run test:desktop:replay`
runs the replay lane. `npm --prefix web test` runs the registry tests. Prefer the opt-in remote Full suite to a full local
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
