---
name: verify-bao
description: Verify Bao's desktop web UI, workflow recording and replay, and live MCP tools on an isolated local fixture. Use after a Bao change to capture Library and Runs proof without touching daily Chrome, model accounts, or the installed Library.
---

# Verify Bao

Read [the feature map](features/README.md), then pick the entries the change affects. The baseline below proves a local fixture workflow through the real `bao serve`, `bao mcp`, Library, and Runs. It does not prove a real-site run, the extension Capture path, native permissions, packaging, or model healing. Do not claim those from a baseline pass.

## Safety boundary

- Never request or use Screen Recording. Browser screenshots use CDP, not the Mac screen. Keep native replay video off.
- Never enable **Allow JavaScript from Apple Events**, run `osascript` against the owner's apps, click a macOS permission prompt, reset TCC, or change a privacy grant. A permission banner in this isolated app is not a reason to grant anything.
- Never drive or attach to everyday Chrome. Use only the repo's Playwright bundled Chromium, a fresh profile, and `throwaway:<DevToolsActivePort>`. Never use `daily`, `bao`, automatic browser discovery, or the installed Google Chrome as a substitute.
- `--home` and `BAO_HOME` do **not** isolate the native messaging manifest. Every `bao serve` and `bao mcp` child must also get a temp `HOME`. Do not run bare `npm run bao -- serve` in the owner's shell.
- Remove model API keys and inherited `BAO*` settings. Set `BAO_HEAL_CURSOR_ACCOUNT=0` even when no API keys exist: a logged-in `agent` can bill the account. Do not run agent evals.
- Real sites are outside this default path. Only an explicit task may authorize one. Such a run must use `/Applications/Bao.app` and land in that app's own Library, not this checkout's temp Library. The task must name the site, start URL, and allowed actions. A real-site task does not relax the permission and everyday-Chrome bans above; report a block when they prevent the run. A fixture pass is never a real run.

## Launch

Requires Node 24+, npm dependencies from the lockfile, Playwright's bundled Chromium, `lsof`, and `chrome-devtools-axi` on PATH. Run from an isolated checkout. Keep evidence outside it. Resolve `REPO` to that checkout and choose a **new** evidence directory each time:

```bash
REPO="$(git rev-parse --show-toplevel)"
PROOF="$(mktemp -d /tmp/bao-proof.XXXXXX)"
export REPO PROOF
( cd "$REPO" && npm ci && npm --prefix web ci )
( cd "$REPO" && npx playwright install chromium && npm run build:desktop )
node "$REPO/.pi/skills/verify-bao/verify.mjs" run "$PROOF/baseline"
```

`verify.mjs` is executable; `node` also works. It reuses `desktop/test/instacart/lane.ts`, `desktop/test/runtime.ts`, and the production MCP stdio client, rather than reimplementing Bao's protocol or app startup. It sanitizes the environment and pins the browser before launching. Keep its Node event loop free: the local fixture server runs in that process, so synchronous browser-driver subprocess calls can deadlock navigation.

The helper starts a **local HTTPS fixture** and maps only its Instacart host names to loopback in the fixture browser. Other hosts fail DNS in that browser. The visible host name does not make it a real site. A second bundled Chromium with its own temp profile shows the actual served Bao UI, not a component preview.

The app child command is exactly:

```text
node <REPO>/desktop/dist/desktop/src/app/cli.js serve --home <temp>/home --port 0 --live-target throwaway:<fixture-profile>/DevToolsActivePort --live-lock <temp>/live.lock
```

Its env includes `HOME=<temp>/user`, `BAO_HOME=<temp>/home`, `BAO_TEST_BROWSER=<bundled executable>`, `BAO_HEADED=0`, `BAO_REPLAY_VIDEO=0`, and `BAO_HEAL_CURSOR_ACCOUNT=0`. There is no shared port, profile, Library, or live lock. The ready line is `bao <port> home <temp>/home`; the helper waits for it, then requires `/api/state` to answer. `instance.json` records the URL, revision, server PID, profiles, and Library home.

The MCP child is `node <REPO>/desktop/dist/desktop/src/app/cli.js mcp` with the same temp `HOME` and `BAO_HOME`. It must complete `initialize`, `notifications/initialized`, and `tools/list` before any tool call.

## Doctor

The helper checks before the first drive, before replay, and before final UI capture. While the instance is alive, run this read-only check if anything looks wrong:

```bash
node "$REPO/.pi/skills/verify-bao/verify.mjs" doctor "$PROOF/baseline/instance.json"
```

Require the recorded server PID to exist, the fixture profile to have a live browser, the recorded port to match `server.json`, `/api/state` to return workflow and run lists, and the checkout revision to match the launch revision. Do not drive a different URL just because it answers. A failed drive needs a new doctor; a wedged UI needs a known state or a fresh run, not repeated clicks. After normal cleanup, doctor is expected to fail because the instance is gone.

## Drive

The baseline helper performs these user paths, serially in one isolated app:

1. Open Bao, read its accessibility snapshot, and save empty Library and Runs screenshots.
2. Through `bao mcp`, call `live_session_start` with `careful: true`, the fixture storefront URL, and the blueberries intent. Call `live_snapshot`. Resolve `Search Costco` from the latest returned refs, type `blueberries`, press Enter, and click `Add 1 ct <TARGET.name>` from the fresh result view. Never retain a ref across a new snapshot.
3. Call `live_stop`. Read the saved workflow from the Library on disk. Require the recorded `type`, `key`, `click` steps and exactly one add in the fixture cart log.
4. Reset **only the fixture cart**, then call `run_workflow` with the saved workflow ID. Require `passed`, zero model calls, no heals, exactly one add of `TARGET.id` at quantity 1, and no checkout/login/account trap hits. This is a fresh effect, not the earlier record effect.
5. Reload Library and wait for the workflow name. Read a snapshot before each screenshot. Click the sidebar's **Runs** button with `page.click('button[data-screen="runs"]')` through `chrome-devtools-axi run`; require the workflow name, `passed`, and `0 model calls`.

For a task-specific path, use the matching map file. The helper is a baseline, not permission to replace the task's acceptance test with a convenient cart test. Extend the recipe in a scratch copy when needed; set that copy's `repo` constant to the absolute checkout path and keep all browser and app ownership rules. Record each entry point covered or not covered. Do not seed a workflow with `Library.save` and call that recording proof.

Browser driving uses `chrome-devtools-axi` connected to the helper-owned UI browser's CDP URL, a unique `CHROME_DEVTOOLS_AXI_SESSION`, and temp `HOME`. Never reuse an existing bridge or `AUTO_CONNECT`. The helper clears inherited driver connection settings. Manual commands within that same owned session are `snapshot`, `click @<fresh-uid>`, `fill @<fresh-uid> <text>`, and `screenshot <absolute-path>`; read the page before capturing it. Bao polls and redraws its sidebar, so a ref can expire between commands. For that surface, use `chrome-devtools-axi run` with a stable selector, for example `await page.click('button[data-screen="runs"]');` on stdin. Do not retry a stale ref.

## Evidence

Keep the directory named by `PROOF` after teardown. Inspect the images, not just their existence. Attach them to the review with their feature and entry point, for example `gh-axi pr create ... --attach "$PROOF/baseline/library-before.png#Local fixture: Library before" --attach "$PROOF/baseline/library-after.png#Local fixture: Library after" --attach "$PROOF/baseline/runs-after.png#Local fixture: Runs after"`.

The helper saves:

- `instance.json`, `doctor-*.json`, `tools.json`, `actions.json`, and `mcp-stderr.txt`: identity, readiness, commands, tool arguments, and replies.
- `workflow.json`, `run.json`, `run-shots/`, `fixture-recorded.json`, and `fixture-replayed.json`: stored state, per-step pictures, and independent cart effects. The fixture is a local site, not a mock of Bao's recorder or replay engine.
- `library-before.png`, `library-after.png`, `runs-before.png`, `runs-after.png`, and matching `.txt` snapshots: the running app's before and after states.
- `result.json` and `cleanup.json`: result and residue checks. A failed attempt keeps `failure.json` and whatever proof it reached. Never report a partial run as passed.

For other changes, capture the action and its result, verify the durable effect through a second read, and include the failure state when relevant. Do not claim a dry-run is side-effect free by name: compare fixture writes and trap hits, saved workflows/runs, and process state. No model invocation, native video, or real-site mutation belongs in this baseline.

## Choose the full-suite check

Every PR runs static gates and the single essential set in `test/essential.json`.
Decide whether that set covers the change before opening the PR. Opt in to the
separate **Full suite** check for shared runtime, engines, live-browser behavior,
recording/replay, sync/storage, packaging, or test infrastructure that the
essential set does not cover. Skip it when the essential set fully covers the
change. Always state the choice and the reason in the PR body.

Use `gh-axi pr edit <number> --add-label full-suite` to start the full check and
keep it on later pushes while the label remains. Use
`gh-axi workflow run guardrails.yml --ref <branch>` for a manual branch run.
The workflow has no schedule, does not run on an unlabeled PR, and is not a
required check. It runs hermetic desktop and web tests, not
public-site tests or billable model evals. Report its actual result; do not call
an essential pass a full-suite pass.

Run focused local checks first. A local full pass is `npm run check` (three
typechecks plus desktop units) and `npm --prefix web test`. Prefer the opt-in remote check to a full pass on
this shared Mac. Do not stack full passes here. Start only when the one-minute load is below 30, acquire the shared mutex, then recheck load after acquiring it:

```bash
(
  set -eu
  until node -e 'process.exit(require("node:os").loadavg()[0] < 30 ? 0 : 1)'; do sleep 30; done
  until mkdir /tmp/bao-full-suite.lock 2>/dev/null; do sleep 30; done
  trap 'rmdir /tmp/bao-full-suite.lock' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  until node -e 'process.exit(require("node:os").loadavg()[0] < 30 ? 0 : 1)'; do sleep 30; done
  unset OPENAI_API_KEY ANTHROPIC_API_KEY GROQ_API_KEY XAI_API_KEY CURSOR_API_KEY
  export BAO_HEAL_CURSOR_ACCOUNT=0
  ( cd "$REPO" && npm run check && npm --prefix web test ) >"$PROOF/full-suite.log" 2>&1
)
```

Read the log and record the exit code. If main adds a lint/CI command, run it too. The mutex's existence is not permission to remove it: do not break another worker's lock. Coordinate a stale lock with its owner. A load-gated or lock-gated wait is not a suite pass. Never invoke public live suites as a substitute for this pass.

## Cleanup

Normal and failed drives run `finally`: close the MCP client, stop only the named browser bridge, close the owned UI Chromium, stop `bao serve`, stop the fixture browser/server, and remove the temp Library, manifest, and profiles. Cleanup never removes `PROOF`.

Require `cleanup.json` to say `passed`: no process owns either recorded profile, the recorded server PID is gone, the app URL no longer answers, and the temp root and fixture profile no longer exist. Confirm the screenshots and JSON evidence still exist after cleanup. Never kill by process name or stop an unowned Bao/Chrome.

Run in the foreground and let it finish; do not abandon a background drive. If the process is forcibly interrupted before `finally`, use `instance.json` to inspect `ps -p <serverPid> -o command=` and the processes whose command lines name the **exact recorded profile paths**. Signal only confirmed run-owned PIDs, wait for exit, and remove only its recorded temp root/profile. If `instance.json` was not written, inspect the run's logs and exact `bao-verify-bao-*`/`bao-instacart-chrome-*` paths from this run; do not guess or sweep a prefix shared by other workers. Report uncertain residue as blocked.

## Helpers and maintenance

- `node "$REPO/.pi/skills/verify-bao/verify.mjs" run "$PROOF/baseline"` runs the complete fixture baseline and teardown.
- `node "$REPO/.pi/skills/verify-bao/verify.mjs" doctor "$PROOF/baseline/instance.json"` checks a still-running instance without changing it.
- Keep recipes in [features/](features/README.md) current through `/skill:maintain-verification-skill`. Its source pass and live pass must cover each feature, not only this baseline's easiest entry point. Report product gaps instead of hiding them with a harness change.
