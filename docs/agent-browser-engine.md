# agent-browser pass-through

## Direct MCP commands

`bao mcp` exposes `agent_browser`. It needs no running Bao app. It accepts a native `command` and an `args` array. Each item is one CLI argument, without shell quoting. Supported commands are `open`, `snapshot`, `click`, `fill`, `press`, `scroll`, `tab`, `screenshot`, `wait_for_owner`, and `close`.

```json
{"command":"open","args":["http://127.0.0.1:8080/"]}
{"command":"snapshot","args":["-i"]}
{"command":"tab","args":["t2"]}
{"command":"fill","args":["@e1","hello"]}
{"command":"click","args":["@e2"]}
{"command":"close","args":[]}
```

Bao fixes one session in a private socket directory, installed Google Chrome, a visible window, and a fresh marked copy of the profile selected in Settings. An unset profile selects `Default`. The page-engine choice does not affect this tool. Extensions stay disabled. Bao launches Chrome itself, then attaches the pinned native agent-browser through `--cdp`.

Bao picks a nonzero debugging port. Port zero makes headed Chrome set `navigator.webdriver` to true. Bao accepts only the WebSocket endpoint its own Chrome child prints to stderr, then writes that endpoint to the copy's `DevToolsActivePort` file. A port-bind race stops startup rather than attaching to another browser.

Pass-through startup connects only to Chrome's browser-level CDP endpoint and discovers targets without attaching Playwright to restored tabs. An unrelated unresponsive renderer does not block startup. Bao leaves those tabs in place without waiting for page readiness or parking startup pages. Successful `open` adds native `tab list` output. The agent selects the signed-in tab with `tab <id>`; Bao does not guess its login state. `tab list --json` exposes CDP target ids.

`desktop/test/unit/agent-browser-startup.test.ts` covers startup with a stalled restored renderer. `desktop/test/unit/chrome-startup.test.ts` covers launch flags, a stale endpoint file, a port-bind race, browser-only startup commands, and headed `navigator.webdriver` before and after a Runtime-domain attach.

Ordinary calls return native stdout and stderr as separate MCP text blocks. Sign-in and human-check handoffs return Bao's wait status instead. A native failure sets `isError` and leaves the session available unless the command is `close`, which attempts cleanup even after a native failure. Bao does not block final clicks. It does not save a replayable workflow. Workflows from the retired live driver fail with `this workflow used the retired live driver`; replay on the pass-through is a later layer.

### Wait for owner input in the same session

When the active tab's URL or title signals sign-in, a verification code, Imperva, or hCaptcha, Bao returns `outcome: "halted"`. It keeps that tab, profile copy, MCP process, and Library run. The page shows a **Bao is waiting for you** banner, and the Library run says **needs you**. The owner signs in or clears the check in that tab.

```json
{"command":"wait_for_owner","args":["60000"]}
```

The optional timeout is 1 to 120000 milliseconds, with a default of 60000. It limits each check, not the whole owner wait. The run viewer labels the step **Wait for you to sign in or clear a check**, with the limit in seconds or minutes. Without an explicit run deadline, the wait status says **no overall timeout**. Each call stays below the 180-second MCP limit. On `waiting`, call it again without ending the agent turn. Temporary metadata or CDP errors keep the handoff open until the call's deadline. On `ready`, take a fresh snapshot and continue in the same session. On `closed`, report that this session cannot continue. Do not start another MCP process to resume this window. Closing during an owner wait finalizes its run as `failed` with reason `session_closed`.

During handoff, Bao polls only the pinned tab's URL and title through browser-level CDP. It does not run native page commands, inspect fields, read text, take snapshots, or save screenshots. Other page commands return the handoff without recording their arguments. `close` stays available. `wait_for_owner` never forwards a native command or saves a page picture.

Readiness means the tab has an HTTP(S) URL and a nonblank title, its URL or title changed, neither matches a sign-in/check marker, and both stayed stable for 750 milliseconds. This is not proof of authentication. An unchanged URL and title keep waiting even if page content changes. An unrecognized check can use `wait_for_owner` to enter the same private wait. Metadata does not identify every sign-in form or embedded challenge.

## Pick an engine and profile

The Settings page-engine choice remains separate from `agent_browser`. Selecting **agent-browser (trial)** does not enable saved-workflow replay: app Replay and MCP `run_workflow` refuse ordinary workflows with `pass-through sessions do not support saved workflow replay`. Select **Current engine (default)** for ordinary saved-workflow replay. Historical live workflows remain retired under either choice; see [retirement behavior](cdp-live.md).

Settings lists existing `Default` and `Profile N` directories. Chrome's `Local State` supplies display names and account emails. Missing names fall back to the directory name; missing directories are omitted. The saved `chromeProfile` choice applies to the next pass-through session.

Bao reads the selected source and creates a private copy outside the checkout. It does not launch, write to, or lock the source profile. Only the Chrome child gets the real HOME from the passwd entry so it can use the login keychain. The native command process keeps a private HOME. No remote-debugging toggle, Accessibility, Automation, or Screen Recording grant is needed. If a permission prompt appears, stop rather than approving it to keep a test running.

The copy keeps cookies, saved tabs, session-restore files, Session Storage, and encryption metadata. Cache directories are omitted. Chrome starts with sync off and `--restore-last-session`. Bao changes only the copy's exit marker, profile name, theme, avatar, and new-tab background. The profile name is **Bao copy of <original name>**. Its light orange or blue theme differs from the source; its avatar is the origami fox, or penguin when the source already uses the fox. Extensions stay off, including copied themes. These markers do not prove every site's login survives copying.

The copy has mode `0700`. Copying stops after five minutes or 20 GiB. Bao refuses links and active copies. `close`, MCP disconnect, or closing the owned Chrome window finalizes the run and removes its copy after Chrome stops. The next start removes marked stale copies, never the source profile. No idle timeout closes an active session.

## Evidence

Each session creates one `kind: "capture"` run in the Library home Bao.app reads. Open **Runs** for commands, screenshots, and native output under **Console**. A recording-only run has no workflow, replay, or teaching actions. It omits Identity and Snapshot inspectors because it does not collect those records. Capture runs do not claim to count the outside agent's model calls or establish replay green status.

Each step stores its exact command and argv, native stdout/stderr and exit codes, error flag, and start/end times. Bao saves a pending `open` before startup and updates the run atomically as results arrive. Startup failure produces a failed run with its original error and no invented picture. Interrupted processes leave readable partial runs marked `recording`.

Bao takes a separate page screenshot through CDP on the active tab after each ordinary command, with a three-second deadline. Owner handoffs and every `wait_for_owner` call omit page pictures and native screenshot copies. This does not change native refs or screenshot history. Native screenshot files, including relative and default paths, are copied into `shots/runs/<runId>/` before the private state directory disappears. After `close`, the step records the missing page rather than reusing a picture. A recording or screenshot failure logs a warning without changing native command forwarding.

**Raw command arguments, results, and screenshots can contain credentials. This route does not redact them. Do not send data you do not want saved locally.** Saved-workflow secret stripping is a separate contract in [permissions](permissions.md#secret-text-in-saved-files).

## Native executable and tests

Version and platform checksums live in `desktop/packaging/agent-browser-pin.json`. [Mac packaging](mac-build.md#fresh-setup) stages and signs the executable. For a checkout, run `node desktop/packaging/stage-agent-browser.mjs <temporary-directory>` and set `BAO_AGENT_BROWSER` to its `agent-browser` file. Installed builds use the bundled file.

`BAO_AGENT_BROWSER_PROFILE_ROOT` supplies a synthetic source root for fixtures. With `BAO_TEST_BROWSER`, the proxy requires that explicit source and launches only the pinned test browser, with mock-keychain and media-denial flags. Never supply a real profile to a test.

Focused coverage lives in `agent-browser-proxy.test.ts`, `agent-browser-proxy-close.test.ts`, and `agent-browser-startup.test.ts` under `desktop/test/unit/`. The native `experian-proxy.test.ts` case uses a loopback Experian-shaped fixture and runs in required CI with a staged binary; local runs need `AGENT_BROWSER_PROXY_BINARY`. The separate opt-in native fixture is `desktop/test/live/agent-browser-proxy.test.ts`. Set `AGENT_BROWSER_PROXY_BINARY` to the staged executable. `AGENT_BROWSER_PROXY_ARTIFACTS` retains its output comparison and recording receipts. The fixture checks native output, durable page screenshots, partial/final runs, and cleanup on close, disconnect, and SIGTERM. It does not prove real-site login survival.
