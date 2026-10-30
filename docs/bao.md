# Bao spike log

Earlier desktop notes are in [v1.md](v1.md) and the fixture drift report is [drift-linux.md](drift-linux.md). This file is the log for spikes after that.

Goal: You just want your personal agent to use your own computer, because all the bot-blocking on cloud VMs is so annoying. Cloud-VM agents get bot-walled and payment-blocked, so bao drives the user's real Chrome and real session (#117 installed-Chrome launch, #116 extension driver) instead of a streamed VM. See Riley Brown, [the VM is overrated](https://x.com/rileybrown/status/2113773696863064377).

## 2026-10-27 — Outbound WebSocket relay

A paired Mac dials out to the registry over a WebSocket. A cloud agent calls the same `/mcp` endpoint. The relay forwards workflow tools only (`search_workflows`, `describe_workflow`, `run_workflow`, `resume_workflow`, `get_run`) and streams status back. This is not deployed. `BAO_REMOTE_MCP` stays off, and `npm start` in `web/` is still `next start`.

### Pairing and the flag

Settings → Remote agent is still off until this Mac checks it, or this Bao process has `BAO_REMOTE_MCP=1`. The registry needs that same variable. Without it, `POST /mcp`, `GET /mcp`, `/api/agent/*` (including pair, claim, revoke, the relay URL, and the job stream), and the WebSocket upgrade all return 404 `{ "error": "remote_disabled" }`.

Pairing is a separate token from the sync device token. A signed-in session calls `POST /api/agent/pair` and gets an 8-character code that lasts 2 minutes and works once. The Mac claims it from Settings (the code field, Pair, Revoke). The token is `bao_rt_…`, stored in `relay.json` mode `0600`, and is not copied into `/api/state` or synced settings. Revoke from Settings marks it revoked and drops the socket. The next call is `device_offline`. A Mac with no `relay.json` dials nothing. `POST /api/agent/poll` and `POST /api/agent/jobs/:id/result` return 404 even when the flag is on.

The registry route uses the signed-in session. Tests stand in for that session outside `relay.ts`. Claim requires the Mac's existing sync device id. Desktop pair returns 400 when that id is missing and does not call claim. A code for one account cannot claim another account's device. That claim is rejected before the code is used, so the same code can still pair the right device.

### What the relay is allowed to see

The relay does not get a CDP socket, a cookie jar, or a client-chosen permission. `prepareCall` strips `permissionMode`, `permission_mode`, `autoApprove`, `skipPermissions`, `skip_all_permission_checks`, `remoteMayApproveConfirm`, and `policy`. A CDP method (`Runtime.evaluate`, `Network.*`, and the other DevTools domains) is rejected and no job is written. Keys named cookie, password, authorization, or secret are removed from the arguments before they are stored or sent. The device runs with what remains. If a workflow needs a secret, the cloud call does not carry it; the Mac asks locally (`needs_human`). Results are masked the same way. A screenshot may be returned to the MCP caller in that Node process. It is not written on the job row and it is not sent on the event stream.

Permission is `ask` (the default) or `deny`, stored as `remotePermission` on this Mac only. Deny answers `run_workflow` with `denied` and does not start a browser. `resume_workflow` returns `needs_human` and does not click, including while a local confirm is still open. Search, describe, and `get_run` still run and do not prompt. A `run_workflow` that arrives during that confirm stays queued until this Mac sends ready. The Mac checks the fixed remote policy again before a run. A confirm still cannot be approved from the cloud.

### Drivers

`workflowDriver` is unchanged. Absent, unknown, and `cdp-live` still mean Playwright there. The remote path picks a driver with `remoteDriverKind`. Extension runs only when the workflow says `extension`, and a missing extension link returns "extension is not connected" instead of falling through. `cdp-live` runs only when the workflow says `cdp-live`. It attaches to an already-open Chrome and does not launch Bao's browser. The default remote run is still the Playwright catalog replay, on the library's throwaway `chrome-profile`.

### Jobs

`JobStore` is the small interface. `MemoryJobStore` is the in-process impl. `PgJobStore` is the durable impl on the registry database that already exists: PGlite when `DATABASE_URL` is unset, Postgres when it is set. No new service. Rows are `agent_jobs`, plus `relay_tokens` and `relay_pair_codes`. A redelivery uses `delivery: "again"`. If the Mac already wrote the result file, it sends that file and does not start the browser. If the process died before the file existed, the job runs again.

The socket lives in the Node process that accepted the upgrade. `instrumentation.ts` patches `http.Server.prototype.emit` so `next start` can upgrade `/api/agent/relay` without a custom server. The pathname has to be exactly `/api/agent/relay`. A second instance does not see that socket. The process that holds it sends a job when the Mac says ready, or sends the same running job again. There is no poll pump. The MCP waiter that returns a screenshot is still memory in the process that took the HTTP call. Durable state is the row. `POST /api/agent/poll` does not claim jobs.

### WebSocket and long-poll

Measured on this machine, in one process, with no external service. The device answered `run_workflow` immediately. Five trials, medians:

| path | delivery | round trip |
| --- | --- | --- |
| WebSocket, same process | 1 ms | 1 ms |
| Long-poll already inside its 200 ms sleep | 187 ms | 188 ms |

The poll number is the rest of that 200 ms sleep plus the result POST, measured before the long-poll was removed. A WebSocket on the same process skips the sleep. The long-poll routes now return 404. A Mac without `relay.json` does not dial.

A throwaway library profile replayed `https://books.toscrape.com/` through the relay. The workflow driver was absent, so the run used Playwright. Round trip 1168 ms, outcome ok. A second pass set the workflow to `cdp-live` and pointed `BAO_CDP_PORT_FILE` at a copy of `DevToolsActivePort` under the temp directory, from a Chrome started with its own user-data dir. Round trip 469 ms, outcome ok. `workflowDriver` still reported Playwright for that document. The test did not read a profile under the home directory. No captcha solving and no fingerprint spoofing.

Hermetic coverage is `desktop/test/unit/relay.test.ts` (pairing, revoke, cross-account isolation, reconnect resume, secret masking, flag-off 404, the latency line). The durable store check is `web/src/lib/relay-job.test.ts` (two `PgJobStore` objects, one PGlite directory). The books replay is `desktop/test/live/relay-books.test.ts` and is not part of `npm run test:v1`.

## 2026-10-24 — Remote MCP for a cloud agent

The long-poll in this section was removed. What follows is the record of that path.

A cloud agent runs a saved workflow in the user's local Chrome by calling the registry. Bao desktop dialed out with its device token and long-polled `/api/agent/poll`. The 2026-10-27 section adds `get_run` and a WebSocket for a Mac that has paired a relay token. Without that token, the Mac long-polled. The Chrome extension stays behind the native-messaging bridge and never calls the registry.

Remote MCP stays off unless the registry process has `BAO_REMOTE_MCP=1`. Without that, `POST /mcp`, `GET /mcp`, and `/api/agent/*` (mint, revoke, audit, poll, result) return 404 `{ "error": "remote_disabled" }`. This Mac has a matching switch, off by default: Settings → Remote agent, stored as `remoteMcp` in `settings.json`. `BAO_REMOTE_MCP=1` on the Bao process turned the long-poll on as well. The switch is not synced to other devices. While it is off, Bao does not dial the registry and does not show Allow, Deny, Kill, or the remote-running line. With the registry flag and the Mac switch both on, the behavior below is unchanged. Job arguments and the screenshot waiter live in memory in one Node process, so a production deploy needs a long-lived server before the flag is turned on.

The registry serves `POST /mcp` (streamable HTTP, JSON responses). The tools at this date were `search_workflows`, `describe_workflow`, `run_workflow`, and `resume_workflow`. `get_run` was added with the relay spike. Auth is `Authorization: Bearer bao_at_…` or `X-Bao-Agent-Token`. Minting is `POST /api/agent/tokens` with a signed-in session and `{ deviceId, label }`. The token is shown once, stored as a sha256 hash, bound to that one device, and revoked with `POST /api/agent/tokens/:id/revoke`. A job is inserted for that device only. `deviceId` or `X-Bao-Device` for a different device is HTTP 403 and an audit row `forbidden`. It is not queued, so the other Mac's poll never sees it.

A device counted as online while `agent_poll_at` was inside the last 2 seconds. The poll loop and a heartbeat during a job keep that fresh. A paired WebSocket also counts as online. Anything else returns `{ outcome: "device_offline" }` immediately.

The server attaches a fixed policy: local approval required, confirm steps local-only, the remote agent may not approve a confirm. The Mac checks that object again and refuses anything else before it runs. `run_workflow` shows Allow / Deny. Search and describe do not. Deny runs nothing. A confirm, payment, send, or Place Order pauses, and `resume_workflow` returns `needs_human` without clicking. The Mac's Approve button is the only way through. A bot wall or a login wall returns `needs_human`. Nothing solves a captcha or spoofs a fingerprint.

While a remote run is in progress the window says "Remote agent running" and Kill cancels it. Each job writes an audit row (agent token id, workflow, device, outcome, timestamps). The row drops cookie, password, and secret fields, resume tokens, and screenshot bytes.

`bao mcp` now writes newline-delimited JSON, which is what the MCP stdio spec requires. A Content-Length request is still read, so an older client is not stuck. Replies are JSON lines only.

Cursor can point a cloud agent at a running registry with:

```json
{
  "mcpServers": {
    "bao": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer bao_at_…" }
    }
  }
}
```

The mint response includes that object as `mcp`, with the real origin and token. This spike runs the registry locally (`npm --prefix web run build && npm --prefix web run start`) on PGlite. It does not deploy. The in-memory job waiter that returns a screenshot lives in one Node process, so a multi-instance serverless deploy would need a follow-up before `/mcp` can wait on a Mac.

## 2026-10-23 — Extension driver

A workflow can run on `driver: extension` or `driver: playwright`. Absent stays Playwright, so an old workflow is unchanged. `validateWorkflow` rejects any other driver string. How to load it is [extension.md](extension.md).

The link is native messaging, host name `com.bao.desktop`. `bao serve` writes the per-user host manifest and a `0600` token. The extension id is the only `allowed_origins` entry. The extension never sees the token. Replay opens a new window and drives that tab. Record and replay ask at runtime. Allow all sites is the default and requests `http://*/*` and `https://*/*`. Only this site requests one origin. The manifest keeps those as optional host permissions and has no install-time `<all_urls>`. Settings shows all sites, per site, or none. Revoke removes the grant. A secret is typed only on the origin the workflow opened.

The spike used a throwaway Chrome for Testing profile and public pages. It did not open a real Chrome profile.

### What passed

The unpacked extension loaded, the native host completed hello, and a click on Chrome's Allow button granted 14 origins. `navigator.webdriver` was false. On bot.sannysoft, WebDriver was "missing (passed)" for a human navigation and for the extension in that same profile. A local page importing BotD from `https://openfpcdn.io/botd/v2` (the fingerprintjs GitHub Pages demo returns 404) printed `bot: false kind: none` for both. CreepJS reported webdriver false for both.

`https://nowsecure.nl/` cleared to "NOWSECURE BY NODRIVER" for the human navigation and for the extension. Across 10 runs the challenge counts were human 0/10, extension 0/10, Playwright 10/10 on the Turnstile. The widget was not clicked. `https://bluefish.impvdemo.com/abp/` challenged none of the three (0/10). That URL is an Imperva demo form, not a wall.

A content-script `element.click()` is `isTrusted: false`. The same click through `Input.dispatchMouseEvent`, and typing through `Input.insertText`, are `isTrusted: true`. With the debugger attached, `navigator.webdriver` stayed false and the viewport did not shrink (`innerHeight` delta 0). This Chrome for Testing build did not paint a "started debugging this browser" bar. The toolbar badge still says REC or RUN. The debugger detaches when the action finishes.

automationexercise replayed 2/2 on the extension and passed on Playwright, with zero model calls: ACCOUNT CREATED, the contact-form success line, the uploaded file name, and ACCOUNT DELETED. Books to Scrape replayed 2/2 and passed on Playwright: 11 Travel rows and 26 Historical Fiction rows, each scored against a books CSV. The polymer shop replayed 2/2 and passed on Playwright, with zero model calls: the YouTube Organic Cotton shirt at $29.50, paused at Place Order (`pausedKind: confirm`).

A native `<select>` is set from the page and held on that option, because the shop writes the quantity back to 1 when the product data arrives. A click waits for an in-flight XHR on that tab. The shop cart is stored in the page, so a replay zeros that storage after the page loads and loads once more; otherwise the recorded cart is added a second time.

### What stayed out

Spoofing `navigator` or the TLS handshake is out of scope, and so is clicking a challenge widget. `captureVisibleTab` still throws without an install-time host permission, so the proof's window shots are the ones that count.

## 2026-10-21 — Real-app drift and multi-locator

Recorded three public login-free pages and two stock Linux apps into schema-v2 workflows, then replayed them with no model. A second pass tried every stored locator before the repair tiers. Profiles and app homes were throwaway directories. Nothing here is a person's real session.

Targets: English Wikipedia search (Spanish portal for language), Python 3 docs search (Spanish docs for language), the-internet dynamic loading, GNOME Calculator 7+5=, gedit typing into a throwaway `note.txt`. A fourth page, the-internet add/remove elements, is the stale-name repair and the live heal, not a visual mutation of the site.

### What passed

Multi-locator web rates are in [drift-real.md](drift-real.md). Primary-only rates are in [drift-real-before.md](drift-real-before.md). Desktop rates are in [drift-real-desktop.md](drift-real-desktop.md).

Web, multi-locator, scored steps: move 6/6, resize 4/5, scale 6/6, theme-dark 6/6, theme-light 6/6, font 6/6, lang 5/5, slow 6/6. Dynamic loading has no second language here, so that row is n/a. The one resize failure is Wikipedia. Python docs search and dynamic loading passed resize.

Desktop, both locator modes: calculator and gedit passed baseline, move, resize, 2x scale, Adwaita-dark, Adwaita, and a 1.5 DPI font scale. Language is n/a because only `en_US.utf8` is installed. Network throttle is n/a because these apps do not load a page. Calculator's equals step needed the expect wait on scale, both themes, and the font scale. The label `12` showed up after the click.

Language is where a later locator changes the result. Primary tries the role name only. Spanish renames the fields (`Search Wikipedia` / `Search` versus `Buscar en Wikipedia` / `Búsqueda`) and leaves the id or the `name` attribute.

| workflow | change | primary | multi | what fixed the multi pass |
| --- | --- | --- | --- | --- |
| wikipedia-search | lang | 0/1 | 2/2 | css `#searchInput`, then the expect wait |
| python-search | lang | 0/1 | 3/3 | css on the click and the type, then the expect wait |
| internet-add | stale-label | 1/1 | 1/1 | label repair both times, not a later locator |

The stale step's recorded name is `Add Element now`. The live button is `Add Element`. Detail: `Add Element ~ Add Element (1.00)`.

GNOME Calculator's button and its inner label share a name. Role is 20 points, under the 25 point margin, so the scorer ties them. Digit replay then takes the one node whose role is `button`. That is not a second stored locator. gedit's only locator is role `text` with an empty name, the unnamed document. Multi-locator did not change either desktop result.

### What failed

Wikipedia resize to 880×560 failed closed on both locator modes in this run. Vector hides `#searchInput` below about 1120px (the box is 0×0) and shows a search link instead. Locators skip a collapsed box. The label repair does too, so it does not fill the invisible input. The step fails in locate, attribute `role`, fixed by none. The Enter step is n/a because replay stopped. The next section fixes that with a reveal repair. Move keeps a 1280×720 viewport and only relocates the window, and that passed.

The Wikipedia workflow is fill plus Enter. A click on `#searchInput` opens the typeahead and the node the click found is not the node the next step has to type into.

gedit's interpreted value postcondition asks for the buffer in `values`. The AT-SPI driver does not put the buffer there, so that postcondition is dropped. The check is the dirty-tab label `*note.txt`.

### Heal

The heal workflow's locators all say `Submit freeze` / `#missing-add`. Repairs refused. `cursorHeal` wrote `heal-request.json` and `heal-shot.png` and waited. The response identity is the only button in that failure DOM, text `Add Element`. No `BAO_HEAL_FIXTURE`, no canned provider. The audit model is `cursor` version `live`. The patched step passed its expect (`Delete`). It stayed provisional through theme-dark and resize, then two replays, then promoted. The trail is [heal-real-trail.jsonl](heal-real-trail.jsonl).

### Puppeteer replay export

`toPuppeteerReplay` writes Chrome DevTools Recorder JSON. Role plus name becomes `aria/<name>`. Anchor locators are omitted. Click steps set `offsetX` and `offsetY` to 1 because `@puppeteer/replay` 4.0.2 forwards a missing offset as `undefined`, and Puppeteer 25 then waits until timeout. A one-click export of a local fixture ran under `@puppeteer/replay` 4.0.2 with `puppeteer-core` against Playwright's Chromium. The page text was `Go` then `clicked`. The file is [puppeteer-replay-proof.json](puppeteer-replay-proof.json). Those packages are not added to this repo.

### Proof

Unit and property tests: 76 passed. `tsc -p tsconfig.desktop.json --noEmit` was clean after the last edit.

Screen recordings from this run:

- `/opt/cursor/artifacts/python-search-theme-resize.mp4` — Python docs search, dark theme, viewport 880×560. The process printed `WEB passed` and the URL `https://docs.python.org/3/search.html?q=json`.
- `/opt/cursor/artifacts/calculator-move-scale.mp4` — Calculator launched at `GDK_SCALE=2`, window moved, then 7+5=. The process printed `CALC passed`.
- `/opt/cursor/artifacts/stale-label-repair-trail.mp4` — Add Element recovered by the label repair, with the trail entry on screen. The process printed `repair: label` and `Add Element ~ Add Element (1.00)`.

The heal screenshot is `/opt/cursor/artifacts/heal-shot-add-element.png`. The repair and heal trails are also under `/opt/cursor/artifacts/`.

## 2026-10-21 — Reveal, phase checks, read-back receipts, trajectory diff

Same public pages and the same two Linux apps. Throwaway profiles and a throwaway gedit file. No account login.

### What passed

Wikipedia at 880×560 passes in both locator modes. Vector still collapses `#searchInput` to a 0×0 box. Replay treats that box, or a node marked hidden, as unusable. It clicks a recorded `reveal` locator when the step has one, otherwise the one visible Search or Buscar link or button in the search landmark, and logs `repair: reveal`. It then tries every stored locator, because the field that opens is not the collapsed node (role `input` becomes `combobox`). The text locator hits the visible field. Fill plus Enter reaches `https://en.wikipedia.org/wiki/Ada_Lovelace`.

The resize row is 6 passed, 0 failed, 0 n/a. Both Wikipedia steps pass. The previous row was 4 passed, 1 failed, 1 n/a.

Nothing else in the suite moved. Multi-locator web: move 6/6, scale 6/6, theme-dark 6/6, theme-light 6/6, font 6/6, lang 5/5 (dynamic loading n/a), slow 6/6, stale-label 1/1. Primary language is still 0/1 on Wikipedia and Python; multi still uses the css locator. Desktop calculator and gedit stay 100% on baseline, move, resize, scale, both themes, and font. Language and network throttle stay n/a.

A step can carry `waitFor`, `expect`, and `gone`. A miss is reported as `wait_for`, `find`, `action`, or `expect`, plus the reason. `gone` fails in `expect`. The drift failure table has a phase column. The run viewer puts that phase on the step row.

A step or the workflow can declare a `readBack`. The run appends a receipt: expected, what was read, pass or fail, and a sha256 over the canonical body including the previous hash. The file is append-only JSONL. A `file` source reads only a path under the temp directory, supplied at runtime, never stored on the step. The local fixture form types a note, clicks Save note, and re-reads the saved text. gedit types into a throwaway `note.txt`, sends Ctrl+S, and re-reads the file (`bao note`). The credit-freeze example's Apply step re-reads `Status: Frozen` on the local `/freeze` page. That is the shape a later "verify freeze status after Apply" step uses. It is not a credit bureau and no account was opened.

Replay writes a trajectory per step: target identity, action, postcondition, and a timing bucket (under 1s, under 10s, under 60s, 60s or more). The drift reports diff that against the recording in plain sentences. A diff does not change the pass rate. On Wikipedia resize the type step aimed at `input#searchInput` in the recording and at `combobox[name=search]` on replay, and Enter moved from under 1s to under 10s. Calculator and gedit baseline matched.

### What failed

No scored drift step failed in this run.

### Proof

Unit and property tests: 86 passed. `tsc -p tsconfig.desktop.json --noEmit` was clean after the last edit.

```
BAO_BROWSER=/usr/bin/google-chrome BAO_REAL_PART=web node desktop/dist/desktop/src/v1/real-drift.js
BAO_REAL_PART=desktop node desktop/dist/desktop/src/v1/real-drift.js
```

Reports: [drift-real.md](drift-real.md), [drift-real-before.md](drift-real-before.md), [drift-real-desktop.md](drift-real-desktop.md).

- `/opt/cursor/artifacts/wikipedia-880-reveal-repair.mp4` — Wikipedia at 880×560. The search toggle opens, the article is Ada Lovelace, and the trail shows `repair: reveal` / `recorded role Search`.
- `/opt/cursor/artifacts/run-viewer-receipt.png` — fixture note replay. Receipt pass, expected Ada Lovelace, read Ada Lovelace.
- `/opt/cursor/artifacts/run-viewer-phase-failure.png` — a `wait_for` miss on a banner the fixture never shows.

## 2026-10-21 — Logged-out replay and a masked password

Local fixture only. `GET /freeze` redirects to `/login` when the `bao_freeze` cookie is missing or expired. The login page asks for a username, then a `type=password` field. `?verify=1` adds a "Verify it's you" code stage. The cookie is a random token. The password is not stored. Profiles were throwaway directories. No real site, account, or credential.

The credit-freeze workflow's precondition is `{ kind: "url", match: "/freeze", phase: "auth" }`. A replay that lands on `/login` fails that check in phase `auth`. It does not call a model, including when a heal provider is available. Cheap repairs still run for locate misses. Auth is not one of those.

The login step has two paths. With no secret, replay shows the same confirm-style banner, title "Sign in on the site window", and waits. With the password supplied on the upfront secret input, replay fills the masked field and does not show that banner. Either way it continues on `/freeze`, clicks Frozen, re-reads `Status: none`, and pauses on the confirm step. The workflow has no Apply click. A confirm step with no postcondition pauses and does not write a `human-confirm` trail event. While that event is absent, replay refuses Apply clicks from the step, from a repair, and from a heal. The fixture counts Apply posts. The count stayed 0.

A password field recorded in a capture session becomes a `secret` input with no default. The page script does not read the field's value. Interpret drops a leaked password string. Saved runs are masked. Screenshots cover `input[type=password]` with a black bar before the PNG is taken, and the accessibility snapshot is omitted while that field is on the page.

### What passed

`tsc -p tsconfig.desktop.json --noEmit` was clean. Desktop unit tests: 98 passed, 0 failed, including the fast-check property that replays a logged-out workflow and scans the written workflow, run, trail, receipts, and log. The headed fixture runs below also scanned the library directory and the PNGs. Match count was 0.

- `/opt/cursor/artifacts/auth-logged-out-human-handoff.mp4` — logged-out replay. The banner "Sign in on the site window" is up, a scripted human signs in on the fixture, the password field is bullets, replay resumes, and it stops on "Press Apply on the site window." Status stays `Status: none`.
- `/opt/cursor/artifacts/auth-logged-out-secret-fill.mp4` — the same replay with the secret typed into the upfront password field (bullets). The site field is bullets. No sign-in banner. Stops at the confirm banner. Apply is not pressed.
- `/opt/cursor/artifacts/auth-logged-out-artifact-grep.mp4` — artifact grep of the stills, both videos, and the two library directories. `matches: 0`. The needle is not printed.
- `/opt/cursor/artifacts/auth-logged-out/a-login-banner.png` — the sign-in banner next to the fixture login page.
- `/opt/cursor/artifacts/auth-logged-out/a-password-masked.png` — human path, password stage, bullets.
- `/opt/cursor/artifacts/auth-logged-out/a-confirm-stop.png` — paused confirm, receipt pass, `Status: none`.
- `/opt/cursor/artifacts/auth-logged-out/b-form-masked.png` — upfront secret field, bullets.
- `/opt/cursor/artifacts/auth-logged-out/b-site-masked-hold.png` — site password field, bullets, during the fill hold.
- `/opt/cursor/artifacts/auth-logged-out/b-secret-field-masked.png` — PNG taken while the field was covered. Black bar and dots. The file bytes do not contain the secret.
- `/opt/cursor/artifacts/auth-logged-out/b-confirm-stop.png` — secret path stopped at confirm.
- `/opt/cursor/artifacts/auth-logged-out/c-grep.png` — the grep page, matches 0.

### What failed

On parent commit `346ac1b`, `desktop/test/live/browser.test.ts` ("capture login, upload, and drop, then replay with two input sets") clicked Log in with an empty heal list. Swapping the identity to `missing-login` left the stored locators on `testid` `login`, the css selector, and the role name `Log in`. Replay tries those locators before identity, so the fixture healer never ran. The test now rewrites every stored locator on that step — testid, css, role name, text, xpath, and anchor — to a control that is not on the page. The broken replay fails in phase `find` with no heal. With `BAO_HEAL_FIXTURE=1` the same workflow passes, the heal model is `bao-heal-fixture`, and the postcondition passes.

The replay form used to rebuild on each state change and drop a password that had been typed but not submitted. It now puts those typed values back, including the secret field. The secret is still not written to the library.

## Decisions

### 2026-10-22 — Look like a normal browser

Capture, replay, login import, and the computer-use spikes start the installed Google Chrome and attach over a private debugging port (`connectOverCDP` with `noDefaults`). The binary is Google Chrome when it is installed (`/Applications/Google Chrome.app` on macOS, `/opt/google/chrome/chrome` on Linux), otherwise `BAO_BROWSER`, otherwise Playwright's Chromium. Bao does not look up `google-chrome` on `PATH`. A wrapper there can inject `--no-sandbox` and port 9222. `npm run test:v1` uses a test browser instead. See `desktop/test/README.md`.

Playwright's `launchPersistentContext` was putting `--no-sandbox` on the command line whenever `chromiumSandbox` was left unset, plus `--disable-extensions`, a debugging pipe, a mock keychain, SwiftShader, and a long `--disable-features` list. That launch reports `navigator.webdriver === true`, and on a Mac the window shows the unsupported-flag infobar for `--no-sandbox`. A Chrome process started with the profile and a private port keeps `navigator.webdriver === false` after the attach, including after `Runtime.evaluate`. The port is never 9222, and the profile is never the daily Chrome. `page.video()` does not exist on a CDP attach, so `BAO_RUN_VIDEO=1` is the one path that still uses Playwright's launcher. The Mac window recorder does not need it.

The Mac app is headed unless `BAO_HEADED=0`. `--no-sandbox` is never added on macOS, including when `BAO_CHROME_NO_SANDBOX=1` or `CI` is set. Linux adds `--no-sandbox` and `--disable-dev-shm-usage` only when `BAO_CHROME_NO_SANDBOX=1` or `CI` is `1` / `true`. The sandbox starts on a normal Linux desktop.

Capture and replay share one directory, `<home>/chrome-profile`. Stopping a capture does not delete it. A cookie set while capturing is still there for the next replay. Hermetic tests, evals, and a replay that was not given that directory still get a throwaway profile. The launch does not pass `--restore-last-session`. Saved tabs are removed before Chrome starts, the window is parked on `about:blank`, and the first capture or replay navigation is the one Bao issues.

Bao does not spoof a fingerprint, patch `navigator`, or solve a check. It also does not pass the switches that advertise automation. A check that is still on the page stays the existing pause: complete the check in the Bao window, then press Continue. Replay continues in the same profile.

### 2026-10-22 — Read a failure before healing it

Compared with Playwright trace viewer, mabl, Momentic, and Skyvern, the run viewer was a filmstrip of equal frames and a single failure card. It now keeps a per-step identity score table, the step's accessibility and DOM snapshot, and the console and network lines captured on that browser. Filmstrip width follows the step, and gaps longer than a second are left out. The failure card opens the step that stopped.

Healing is no longer one switch for the whole workflow. A step can be auto, ask, or never, so a confirm step stays with the person. A provisional locator promotes after a drift suite and N later real runs (default 3, set in Settings). A miss is classed before any model call: a real change may be healed, a temporary blocker or an outage is not. Auto-heal also opens a circuit when three runs of that workflow fail within ten minutes. The "you need to act" wait defaults to 120 minutes and is the same bar, notification, and badge.

### 2026-10-22 — Heal on the Cursor account

The healer used to swap files with a Cursor session (`BAO_HEAL_CURSOR=1` writes `heal-request.json` and waits for `heal-response.json`). That still works. It is the fallback, not the first try.

**Use the Cursor CLI print mode when `agent login` has already been done.** `agent status --format json` is the check. Logged out, CLI 2026.10.19-6bbf2c4 prints `{ "status": "unauthenticated", "isAuthenticated": false }` and exits 0. Logged in, the same command prints `status: "authenticated"` and `isAuthenticated: true` (CLI source `src/commands/status.ts`). A partial login (`hasAccessToken` without a refresh token) is not a session. bao treats only `isAuthenticated: true` as able to heal.

The call is `agent --print --mode ask --trust --sandbox enabled --output-format stream-json --workspace <empty temp dir>`. The prompt is written to stdin. The CLI reads stdin only when the argument prompt is empty and stdin is not a terminal (`src/commands/build-prompt.ts`). bao does not put the prompt on the command line, and it never passes `--api-key` or reads `CURSOR_API_KEY`. If the user already exported that variable for the CLI, the process inherits it. The stream-json init event then says `apiKeySource: "env"`. A stored login is `login`. Passing `--api-key` would be `flag`; bao refuses that result. When both a stored login and a key are present, the CLI keeps the login (`src/commands/chat.ts` skips the key once the stored session is authenticated).

The heal record's provider is `cursor`. The name is the model on the init event (or `cursor-agent` when the event has none). The version is `login` or `env`. The file fallback stays `cursor` / `live`.

Billing follows the Cursor plan. Cursor's CLI docs say headless print mode is a normal agent request, and a Cursor staff reply on 2025-08-10 said IDE and CLI share the same plan pricing. This machine was not logged in, so no request was sent. `agent --print` here exited 1 with `Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY`.

**Do not use MCP sampling.** Cursor's MCP docs list tools, prompts, resources, roots, elicitation, and apps. Sampling is not in that list. A conformance run dated 2026-06-28 (Cursor 0.47) reports `sampling/createMessage` unimplemented. The MCP spec deprecated sampling in protocol `2026-07-28`. A bao MCP server that asked would get no answer, including when Cursor launched it.

**Do not use the Cursor HTTP APIs for this.** The documented APIs are admin, analytics, Cloud Agents, and the TypeScript SDK. Cloud Agents and the SDK run an agent over a workspace. They authenticate with `CURSOR_API_KEY` or a browser login that mints a key. They are not a one-shot identity patch, and they ask for a key bao would have to store. The CLI login does not.

`BAO_HEAL_CURSOR_ACCOUNT=0` skips the CLI. With no vendor key, no login, and without `BAO_HEAL_CURSOR`, healing stays off.

### 2026-10-22 — Clocks use the machine zone

The desktop window and the web app share one formatter (`web/src/lib/time.ts`). A shown time is the machine's zone with the short zone name, for example `Oct 22, 12:50 AM EDT`. A time from the last day also leads with how long ago (`23 min ago · Oct 22, 12:50 AM EDT`) on rows that have the room: Heals, the runs list, saved logins, and the workflow's last run. The recent-runs header is the zoned clock, and the hover adds the relative phrase. Stored instants, HAR times, and cookie expirations stay ISO. A unit test renders those pages and fails if an ISO `Z` timestamp, a `YYYY-MM-DD` date, or a clock with no zone is left in the HTML.

### 2026-10-22 — Act prompts survive a restart

A login or confirm wait is stored in the app home as `pending-prompt.json`. Closing the window and opening it again restores the bar and the badge. When the deadline passes and no replay is still in that wait, the file is removed and the run is marked stopped, timed out. A wait that finishes inside a running replay still stops with `nothing applied` or `waiting for you to log in`.

### 2026-10-22 — Locator history and a banner that stays off the workflow

Locator versions live on the workflow versions, in the one Versions panel. A version holds the recorded locator, a heal, a revert, or a rollback: the local time with its zone, the source run, the score, and which attributes changed. Restore saves that version as a new draft and does not edit the older versions. When a click misses because a cookie banner, a modal, or a spinner is in the way, replay dismisses or waits for this run only, at most three times, and the run viewer says `recovered:` plus the reason. The workflow file is not changed. A CAPTCHA, a 5xx response, and a signed-out page stay failures and are not sent to a model.

### 2026-10-22 — Trace-style run viewer

A filmstrip frame shows the step's cropped, redacted screenshot, with the outline drawn on the target when the picture was taken. A step with no picture keeps the icon. Clicking a step seeks the replay video, and moving through the video highlights the step at that time. The recording is served with byte ranges so the player can land on that timestamp. Before and After switch the selected picture. A stored input is `name: value`, so a secret reads `password: ••••` and is still asked again. A failed step has a side panel: the phase, then each locator that was tried and the score it got.

### 2026-10-22 — Try a step, input tokens, and per-site trust

Try, on a workflow step, looks that step up on the live window and outlines the match. It does not click, type, or call a model. Run from step N opens the same run form and starts replay at that step. An input in the step text is a token: label, type, default, and required. Clicking it edits that input, and a secret token stays masked. The run form fills the same default. Settings lists each site as Always ask or Allow for ordinary actions. That map is separate from the confirm policy. A confirm step still waits for the person when the site is Allow.

### 2026-10-22 — Re-run, skipped idle, and a per-step heal limit

A past run can be started again from the run viewer. Re-run with this run's inputs fills the form from that run and asks for a secret again. Debug from this step starts at the selected step. Idle longer than 3 seconds is collapsed on the filmstrip and in the replay video, with a marker such as `skipped 12s`. When the same step heals itself on 3 consecutive runs, auto-heal stops for that step, the step is marked needs review, and the act bar says so.

## 2026-10-22 — One checkout for the signed app

The integration branch (pull request 58) is the tree a Mac build should use. It already contains the desktop window, and this pass landed the rest of the open desktop work on that same branch:

- Step pictures in the filmstrip and in Before / After are cropped around the target element's box, with padding, the control centered and fully in frame, and a thin outline on it. A type step shows the field before the value and after it. A secret is covered.
- Recent runs are a grid: steps down the side, the last runs across, newest on the right. Each column header is the machine-local clock with its zone (`Oct 22, 12:50 AM EDT`). Hover a cell for the run id, and for a run from the last day, how long ago. The act bar says "Sign in to the site in the Bao window."
- The Mac permission card is only on macOS, and only while Accessibility or Screen Recording is missing. Library shows it once, collapsed until opened. After Continue, a sidebar dot is the only copy. Linux does not list those grants as missing.
- Chrome login import from pull request 57. One site at a time, after a click: cookies, localStorage, and IndexedDB into Bao's own Chrome. Session cookies survive a clean exit. A saved site is probed before a run, and a dead session stops as needs sign-in instead of failing a later step.
- Sync, the marketplace, and the four-tool MCP catalog from pull request 59. `bao sync` pairs and pushes or pulls. `bao mcp` exposes `search_workflows`, `describe_workflow`, `run_workflow`, and `get_run`. The Mac Accessibility driver is `bao mcp-ax`. The web app under `web/` is the registry. Replay still happens on the device.

`docs/mac-build.md` is the path from a fresh macOS account to the signed `Bao.app`. `docs/mac-test.md` is the pass on an installed app. Pull request 58 landed on `v1/desktop` as a merge commit. Pull request 57 followed it. Pull request 59 is rebased on `v1/desktop` and stays open for that merge. Replay → Re-run with past inputs fills non-secret fields from the last run. Settings → Sync pairs this Mac. `BAO_CHROME_NO_SANDBOX=1` adds `--no-sandbox` and `--disable-dev-shm-usage` on Linux only. It does nothing on macOS.

# Importing one site's login

Bao can bring a single site's session from the person's Chrome into Bao's own Chrome. The person names the site and clicks **Import this site's login from my Chrome**. That click is the only time Bao reads a Chrome profile. It reads the clicked site's origins and nothing else, and it never shows cookie values, localStorage values, or IndexedDB contents.

The form asks for the site. Probe URL, extra same-host origins, a signed-in selector or text, and the anti-bot choice sit under Advanced. A blank probe uses the page that was typed, when that page is an http or https URL. Otherwise it uses the origin. Anti-bot cookies are skipped unless Advanced says to include them.

The profile picker lists every profile in that Chrome's `Local State`: name, email, avatar or initials, how many cookies match the site, how many of those will be imported, how many are expired, how many are anti-bot cookies, the localStorage item count, and the IndexedDB origin count. A picture that is only one color is shown as initials on that color. The profile with the most matching cookies is already selected. The person can import that profile or decline. The act bar stays only while that choice is open. Bao does not assume `Default` when another profile has more matches.

## What is restored

Three stores, all limited to the clicked site:

- **Cookies.** The profile's cookie SQLite (`Network/Cookies`, or the legacy `Cookies` file). A cookie matches when it is host-only for that host, or a domain cookie for that host or a parent that is not a public suffix. Expired cookies are counted and left behind. Bao sets the ones it keeps one at a time with `Network.setCookie`, so one rejected `__Host-` or `SameSite=None` row does not drop the session cookie next to it. A cookie with no expiry is a session cookie. Chrome deletes those on a clean exit unless the profile is set to continue where you left off. Bao sets that on its own profile: `session.restore_on_startup` is 1. The launch does not pass `--restore-last-session`, because a restored tab navigates on its own and can interrupt the first replay. Before each launch Bao deletes the saved tab files (`Sessions`, `Current Session`, `Current Tabs`, `Last Session`, and `Last Tabs`) so Chrome has no tab to reopen. The window starts on `about:blank`, and capture or replay then navigates to its own URL. A session cookie still stays in Bao's profile when Bao's Chrome exits, and the next launch sends it. Bao does not mark the profile as crashed, and it does not read the person's Chrome again to fill a cookie back in. If the cookie is gone at run time, the pre-run probe returns needs sign-in.
- **localStorage.** Chrome keeps every origin in one LevelDB, `Local Storage/leveldb`. The map key is `_`, the origin, a NUL, and the item key. The value is tagged Latin-1 or UTF-16. Chrome is also moving this store to SQLite (`maps` joined to `map_entries`). When that file is present, Bao reads it the same way: the origin is the start of `storage_key`, up to the first NUL. `VERSION` and `META` rows are not site data. Bao then writes the items into its own Chrome one at a time with `DOMStorage.setDOMStorageItem`. One rejected item does not drop the rest.
- **IndexedDB.** Chrome stores this as one directory per origin, named `scheme_host_port.indexeddb.leveldb` (and `.indexeddb.blob` when Chrome has one). The default port is `0`. Bao copies only the directories for the clicked origin, and for extra origins the person listed on the **same host**. It skips `LOCK` files. There is no CDP call that writes IndexedDB, so the copy happens before Bao's Chrome starts.

An extra origin on a different host is ignored. A preview click does not copy IndexedDB. It only counts.

The result line is `Imported N. Signed in: yes.` or `Imported N. Signed in: no.` N is the number of cookies Chrome accepted. Storage is the next sentence, when there is any: `Restored N localStorage items and M IndexedDB origins.`

## Whole-profile copy is a no

Copying the Chrome user-data directory would bring every site's cookies, storage, history, and passwords. Bao's rule is one site per click. The profile directory stays where Chrome left it. Bao reads the cookie database and the storage for the origins of that site, then writes those into a profile Bao owns.

That owned profile is not the daily Chrome, and it is not started with remote-debugging port 9222. Capture and replay use this same profile, so a session imported earlier is still there for the next run.

## CDP getCookies on the person's Chrome

`Storage.getCookies` and `Network.getCookies` only answer if that Chrome was launched with a debugging port. Chrome then shows a debugging banner, and the profile is locked, so the person cannot use the same window at the same time. Bao's launcher refuses port 9222 and refuses the daily profile. An explicit click does not make attaching to that Chrome acceptable: the click authorizes a read of one site, and the write goes into Bao's Chrome.

Playwright `storageState` is a different tool. It is a JSON snapshot of cookies and localStorage from a browser context the caller already controls. It does not read the person's Chrome, and it does not include IndexedDB. It is the right shape for a test fixture. It is not an import.

Browserbase Contexts persist a whole browser profile and reuse it on a later session. That is the whole-profile copy Bao will not do. The gap those products expose is real: a login is not cookies alone. Bao closes that gap by reading localStorage and IndexedDB for the clicked origins, and by checking the session again before a run. It does not close it by keeping the entire profile.

## Signed in, and still signed in

After the cookies and localStorage are in place, Bao loads the probe URL in its own Chrome. The signed-in decision waits until that page has been open for at least 5 seconds and the network is idle. It is not taken at DOMContentLoaded, so a client redirect that follows the first paint still counts. With no selector and no text, signed in means the final URL is not a login URL (`login`, `sign-in`, and the same words with an underscore or an extra hyphen). A site can instead name a selector, a text fragment, or both. Those are combined, and the login URL is then ignored. The probe URL should be a page that redirects to login when the session is dead. If the probe URL is itself the login page, Bao treats a healthy session as signed out.

The import click saves the site. From then on, a workflow whose start URL is that origin is checked before it runs. Bao opens the probe in its own Chrome. If the probe is signed out, or the probe page does not load, the run stops. The status is `needs-sign-in`, the step list is empty, and replay does not start. The message is:

> Needs sign-in. The session is not live, so Bao did not start the run. Sign in once in Bao's window.

A workflow for an origin that was never saved is not checked. Bao runs it as before.

Saved sites are listed on Logins. Each row shows the last probe time and whether that probe was live or needs sign-in. Re-check loads the probe in Bao's Chrome only. It does not read the person's profile. Remove drops the saved site, so later runs of that origin are not gated. It does not delete cookies already in Bao's profile.

## Sites that tie the session down

Some sessions do not survive a change of browser, even when the cookies and storage copied cleanly. Bao skips anti-bot cookies by default. A site can be switched to include them. Bao does not spoof a fingerprint or solve a captcha, and it does not pass automation switches. There is no stealth plugin that rewrites navigator.

The cookie names Bao treats as anti-bot:

| Vendor | Names |
|---|---|
| Imperva | `reese84`, `___utmvc`, `visid_incap_*`, `incap_ses_*`, `nlbi_*` |
| Akamai | `_abck`, `bm_sz`, `ak_bmsc`, `bm_sv`, `bm_mi`, `bm_so` |
| Cloudflare | `cf_clearance`, `__cf_bm`, `cf_chl_*` |
| DataDome | `datadome` |
| HUMAN | `_px`, `_px2`, `_px3`, `_pxvid`, `_pxhd`, `pxcts` |
| Kasada | `KP_UIDz*` |

Experian is the case that made the default. After the Imperva cookies were skipped, the site redirected to `/login`. The same shape shows up anywhere a bot manager binds a clearance cookie to the browser that received it: Akamai on a retail front, Cloudflare on a site that sits behind a challenge, DataDome, HUMAN (PerimeterX), and Kasada.

Other binding that a copy cannot honestly replay:

- WebAuthn and passkeys stay on the authenticator that created them.
- TLS token binding and similar channel bindings fail in a second process.
- A device id in a cookie or in localStorage often fails a server check against the browser that minted it. Bao still copies that localStorage, because it is part of the site's state. The probe then says whether the session stuck.
- An IP-bound session fails when the network changes.

When that happens, the reliable path is to sign in once in Bao's window. The button is **Sign in once in Bao's window**.

What Bao says, depending on what it found:

Only anti-bot cookies were available, and skip is the policy:

> This site only had anti-bot cookies (Imperva) for Bao to see. Bao skipped them. Skipping them is the default. Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated.

Session cookies were imported, anti-bot cookies were skipped, and the probe landed on a login URL:

> This site ties the session to its anti-bot cookies (Imperva). Bao skipped those cookies. Skipping them is the default, and the site sent Bao's Chrome to a login page. Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated. You can include anti-bot cookies for this site and import again. They are bound to the browser that received them, so the session often still fails.

The anti-bot cookies were included, and the probe still failed:

> Bao imported the anti-bot cookies as well. The site still sent Bao's Chrome to a login page. Those cookies are tied to the browser that received them. Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated.

Nothing about those cookies explains the miss:

> The session did not stick. Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated.

The vendor in parentheses follows the cookies that were actually present. Two vendors are joined with "and". The same sentences are the ones on the result card.

## macOS keychain

On macOS the cookie key is the keychain item "Chrome Safe Storage", account Chrome. Bao runs `security find-generic-password -s "Chrome Safe Storage" -a Chrome -w` and waits up to 60 seconds. The password is the PBKDF2 password as the string the keychain returns. Bao does not base64-decode it. The KDF is PBKDF2-HMAC-SHA1, salt `saltysalt`, 1003 iterations, a 16-byte key, AES-128-CBC, and an IV of 16 spaces.

Linux v10 uses the password `peanuts` and 1 iteration. Linux v11 uses the libsecret password (`chrome_libsecret_os_crypt_password_v2`, then the v1 schema) with the same KDF, and Bao retries the empty password Chrome still accepts. This build does not decrypt Windows cookies. The result there tells the person to sign in once in Bao's window.

Cookie DB meta version 24 and later (Chrome 130 through the current 15x line; Chromium main is still 24) stores raw SHA-256 of `host_key` in front of the decrypted value. The file's `meta` version is what Bao trusts. A 129 build that already wrote meta 24 is treated as prefixed. Older files are not stripped. A prefix that does not match the row's host is rejected with `host prefix does not match`. A row that has both a plaintext value and an encrypted value is rejected. `v12` and `v20` are `unsupported cipher`.

Preview does not need the key. On macOS the picker says:

> **macOS will ask for Chrome Safe Storage**
>
> When you import, macOS asks whether bao may use the "Chrome Safe Storage" item in your keychain. Click Always Allow. If you do not see the prompt, look behind this window. Allow once makes the next import ask again.

**Always Allow** keeps the next import from asking again. **Allow** once asks the next time. If the prompt is behind the window, that is a missed prompt, not a wrong password.

If the prompt is missed, dismissed, or the item is absent, Bao does not decrypt, does not launch Chrome, and does not load the probe. The result is `Imported 0. Signed in: no.` The sentence under it is `Bao did not load the site, because the cookies could not be decrypted.` The note for a missed prompt is:

> **Allow the Chrome Safe Storage prompt**
>
> The keychain prompt was not answered. It may be behind this window. macOS asks whether bao may use the "Chrome Safe Storage" item in your keychain. That item is the key for this site's cookies. Click Always Allow. Allow once makes the next import ask again. A missed prompt does not mean the password was wrong. Bao reads cookies only for the site you clicked, and it does not show cookie values.

A dismissed prompt starts with `The keychain prompt was dismissed.` A missing item is titled `Chrome Safe Storage is not in the keychain` and says Bao looked for that item and did not decrypt any cookies. The secret itself is not shown, logged, or written into the result.

# Sync, share, and run Bao workflows

Bao keeps a workflow as schema v2 JSON on the Mac that recorded it. A heal or an edit is a new version. The Versions panel lists each one in local time, with the machine's zone label. Restore saves that version as a draft. Replay keeps using the live file until the draft is promoted. A registry lets that Mac meet your other Macs, and a web app lets you share or list a workflow. Replay still happens on a device. The server never sees a cookie, a secret, or an unredacted screenshot.

## Run it locally

From the repo root, with Node 22 or newer for the web app:

```bash
npm install
npm --prefix web install
npm --prefix web run dev
```

The dev server uses PGlite under `web/.data/pglite` and files under `web/.data/blobs` when `DATABASE_URL` is unset. `BAO_AUTH_STUB=1` (or any non-production run) returns the email sign-in link in the response instead of sending mail. The GitHub button signs you in as a verified stub user on a local build. Do not set `BAO_AUTH_STUB` on a hosted deployment. Production refuses to start if it is set. A hosted registry uses `BAO_OWNER_EMAIL` and `BAO_INVITE_SECRET` instead: sign-in accepts that email only, and only with the secret.

Pair a Mac from Devices. The page shows a code. Type it in the Mac app under Settings → Sync. The command line is the other way:

```bash
npm run bao -- sync pair CODE --server http://127.0.0.1:3000
npm run bao -- sync
```

A hosted registry also needs the invite secret on that command (`--secret`) or in the Settings → Sync field. Paste it once. It is stored in `sync.json` with the device token and is not sent on later syncs. Local `vercel dev` leaves the owner variables unset, so pairing does not ask for a secret.

`bao sync` pushes local changes, pulls newer versions, and refreshes the device list. The first sync copies `workflows/`, `runs/`, and `settings.json` to `backups/before-sync-<time>/` before anything is sent. Back up daily or Back up weekly, beside that copy, writes `backups/scheduled-<time>/` when the interval is due. Settings → Sync shows the backup as a local phrase from the shared formatter, such as “Last night, 2:00 AM EDT”. Reveal in Finder opens that folder. The path stays on the tooltip. Each cloud version records the device and the parent version. A push whose parent is not the cloud's latest is stored as a conflict draft and does not replace the head. The Versions panel names both Macs, shows the steps side by side, and offers Keep mine, Keep theirs, and Keep both as a copy. The workflow page shows a Conflict badge, both device names, and the same version numbers as the Mac. Its buttons name the devices, such as Keep Ada's Mac and Keep Home Mac, plus Keep both as a copy. The crop line appears only when a step picture is stored. The copy you had is also written to `conflicts/<id>.json`. An edit made while the Mac is offline waits in the outbox and pushes the next time sync reconnects. The device token is stored in `sync.json` mode `0600` and is not returned by the local app's `/api/state`.

The web Devices page lists each paired Mac with the time it last synced, how many workflows that sync held, and Unpair. Settings → Sync shows the paired devices, item counts per site category, and a toggle for workflows, run history, heal records, and settings. While a category is catching up it reads “N on this device of M in the cloud.” An offline Mac finishes that catch-up the next time sync reaches the account. Those times use the shared formatter in `web/src/lib/time.ts`. A device row from the last day leads with how long ago and then the zoned clock (`just now · Oct 22, 12:41 AM EDT`). This Mac's last sync is the zoned clock (`Oct 22, 12:41 AM EDT`). The Mac permission card stays on Library, and only while a grant is missing. It is not repeated here. Secrets are inputs of type `secret` with no default. Typed secret values, cookie headers, and screenshot bytes are dropped before a push. A payload that still contains them is rejected.

## Share a workflow

On the workflow page, mark which inputs are asked on import. Share copies the `bao://workflow/<id>` link, opens the public preview, and exports the workflow file. Publish stays disabled until a device replays the redacted copy, and a failed clean replay stays disabled with the reason beside it. Export stays disabled, with a reason, when the workflow has no steps. Emails, names, phone numbers, file paths, street addresses, and secret defaults are cleared from the shared copy. Those inputs show up as questions on an import sheet. Nothing is saved until the questions are answered.

Secret and file answers are not stored. A path is asked with the same file field capture records, and the path is not shown. An email typed as an answer is dropped. Other answers become defaults on the recipient's private copy only. A non-personal sample is shown as an example.

Each workflow and each marketplace listing has two links. `bao://workflow/<id>` opens that workflow. `bao://import/<id>` opens the import sheet and does not save until the questions are answered. `bao://run/<id>?inputs=<json>` opens the run form with those non-secret inputs filled in. A secret key in that JSON is refused, and a secret is asked again on the device.

```bash
npm run bao -- open bao://workflow/<id>
npm run bao -- open bao://import/<id>
```

Replay → Re-run with past inputs fills the non-secret fields from the last run. Passwords are not kept.

## List a workflow

Publish shows a preview of what would be public: the diff of cleared values, the domains the workflow touches, the last replayed-green date, and a verified-author badge when the account is verified.

Listing stays disabled until a device replays that redacted copy:

```bash
npm run bao -- sync review <id> --inputs inputs.json
```

`bao sync review` replays on this Mac and records the hash of the public copy. That review does not stamp last green. Confirming the listing runs the public copy once more, in a clean throwaway browser, against its public site. That run stamps Verified. A passed replay on a Mac also stamps last green, and sync carries that time to the other Macs. A failing replay blocks the listing, names the step, and leaves List it disabled. The reason beside that button is a sentence. Replay again runs the clean browser once more. The marketplace card counts that clean replay: when no device run was stored it says “Verified by 1 replay” instead of “0 runs.” The listing page shows the step list with redacted crops, one Inputs section, the sites it touches, and the version history. Before the first run it shows a permissions preview: the sites (listed once), the inputs (a secret is a label and a secret tag, and you enter it on your device), whether it runs in the browser or with computer use, and whether it can press confirm or submit. Allow is required before install or copy. Copy to my library stays disabled until Allow, and the server rejects that copy with 403. A confirm or submit step defaults to Always ask, and that step keeps the Always ask tag after Allow. Install then opens `bao://import/<id>`. The replay clock is labeled Publisher replayed green. After you run it, Your last green is a separate line and does not move the publisher's time. Share copies the workflow link and the import link. Report a problem is a quiet link at the bottom of the page. There is no payment step.

Example workflows (a fixture sign-in, a row pick, a username, a file upload, Wikipedia search, and a public form) ship private. They show up in the marketplace only after the device review and that clean replay both pass. A fixture sign-in stays unlisted: the password is not stored, so the clean replay cannot sign in.

## MCP

`bao mcp` exposes four tools no matter how many workflows you add:

| Tool | What it returns |
| --- | --- |
| `search_workflows` | At most 5 ranked hits from this Mac, workflows synced from your other devices, and marketplace listings. Each hit includes its input schema, a source (`this Mac`, the device name, or `marketplace`), and the last green time in the local zone. A marketplace time this Mac has not replayed is labeled `publisher green`. When the score is tied, this Mac comes first, then another device, then marketplace. |
| `describe_workflow` | The steps, the input schema, a `bao://workflow/<id>` link, the same source, and the last green time. Secret defaults are omitted. |
| `run_workflow` | `ok`, `needs_human`, `needs_signin`, `needs_approval`, or `failed`. It replays only in Bao's own Chrome. A `cdp-live` workflow or an `extension` workflow returns `failed` with the reason and does not run. Replay a `cdp-live` workflow from the Bao app that recorded it, after `live_stop`. Replay through `bao mcp` comes in a later step. A workflow that is not on this Mac is installed here before replay. A marketplace listing that has not been allowed returns `needs_approval` (`outcome`, `status`, `workflowId`, `source`, `reason`, `link`, and `permissions`) and does not run. Allow is the same account choice as the listing page. A confirm or submit listing is Always ask, so an allowed run still waits before that step. A passed run stamps the last green time, and the next search shows it. A human step returns immediately with `status`, `run_id`, `step`, `reason`, `ask`, `deadline`, and `resume_token`. Pass that token to continue the same run. `cancel: true` stops it and applies nothing. `rerun: true` reuses past non-secret inputs. |
| `get_run` | A stored outcome. |

A missing secret or file, or a heal that is waiting for approval, is `needs_human` and does not leave the device. A sign-in ask is `needs_signin`. A confirm ask is `needs_human`. Neither blocks the tool call, and neither is a bare string. Pass the resume token after the person acts to continue that same run. `cancel: true` with the token stops the run and leaves the page unpressed. The token is deleted when it is used. While the person has the page, step screenshots and trail capture pause. The trail records handoff start and end with the local zone.

A scripted client searched for "sign in", described `agent-sign-in`, and ran it as grace. The tool list stayed these four names. Search returned four hits, under the cap of five, and each hit included its input schema. The run result was:

```json
{
  "outcome": "ok",
  "workflowId": "agent-sign-in",
  "receipts": [
    { "id": "user", "status": "passed", "readBack": "grace" },
    { "id": "pass", "status": "passed", "readBack": "[secret]" },
    { "id": "go", "status": "passed", "readBack": "Welcome grace" }
  ],
  "stops": [],
  "link": "bao://workflow/agent-sign-in"
}
```

The password never appears in that result. The full redacted exchange is the live-test artifact `agent-transcript.json`.

## Deploy

The click-through for a hosted registry is [web/README.md](../web/README.md). It imports this repo with root `web/`, sets `BAO_OWNER_EMAIL` and a generated `BAO_INVITE_SECRET`, leaves Standard Protection on, connects a private Blob store and Neon from the Marketplace, and points Settings → Sync at the production domain. This repo does not create the project or the stores.

The app uses the Neon serverless driver when `DATABASE_URL` is a hosted Postgres URL, and the `pg` driver for `localhost`. Blob uploads use the private store when `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` is set. With neither, the files stay on disk, which is the local path above.

# Bao MCP drivers

`bao mcp` is the stdio server a driver talks to. Live mode is `BAO_MCP_LIVE=1` with `BAO_FIXTURE_URL` set to a page bao opened. The default server does not open a browser. It appends the call to `trail.jsonl` and returns text.

## Live tools

| Tool | Arguments | What the driver gets back | Trail |
| --- | --- | --- | --- |
| `screenshot` | none | PNG | read, with a snapshot |
| `snapshot` | none | JSON boxes (`id`, `role`, `name`, layout `x` `y` `w` `h`, visible intersection `vx` `vy` `vw` `vh`) and a PNG | read, with a snapshot |
| `click` | `x` and `y` in viewport CSS pixels, origin top left. Optional `ref` | `OK`, or `STOP login`, or `STOP confirm` | act, with a snapshot |
| `type` | `text` | `OK`, or `STOP login` when the focused field is a password | act, with a snapshot |
| `key` | `key`, a Playwright key name | `OK` | act, with a snapshot |
| `scroll` | `x`, `y`, `dx`, `dy` | `OK` | act, with a snapshot |
| `upload` | `id` DOM id, `path` local file | `OK` | act, with a snapshot. The line stores the basename, not `path` |

`ref` is the element's DOM `id`. It is not a macOS AX identifier and not a Linux AT-SPI name. If `ref` is set, bao ignores `x` and `y`, clicks the center of that element, and records that center as provenance.

A password `type` is not performed. A `click` on an element with `data-bao-gate="login"` or `data-bao-gate="confirm"`, or a button whose text is `Log in`, `Sign in`, or `Confirm`, is not performed. The trail line has `gate` and `performed: false`. A login stop also records a sign-in click when the driver does not click Log in. That click stays in the derived workflow, and its postcondition is the Welcome line. Replay performs the step with the inputs supplied for that run.

A file input is a file parameter whether the driver called `upload`, dropped a file, or typed a path. The absolute path is not written into `trail.jsonl`. `eval drivers` retries an HTTP 429 once after a 45 second backoff. If the driver still exits without finishing, the cell is `infra` and the run directory still has a partial trail. That cell is not a bao replay failure.

Every read and every act stores `snapshot.sha256` and `snapshot.path`. The file is a PNG. `latencyMs` is the time inside the tool call, including the snapshot.

## Stub tools

With `BAO_MCP_LIVE` unset, the tools are `screenshot`, `click`, `type`, `key`, and `scroll`. `click` requires `x` and `y`. The server does not take a snapshot, does not return a PNG, and does not change a page.

## What each driver can send

Computer-use tool names are not this server. Claude's `left_click` and `coordinate` pair is the proxy adapter in `desktop/src/proxy/claude.ts`. Codex does not publish a pixel action schema. Neither shape is accepted by `bao mcp`.

| Driver | How it would attach | Tool names it can call here | Screenshots | Coordinates | AX or AT-SPI ids |
| --- | --- | --- | --- | --- | --- |
| Claude CLI | MCP client pointed at `bao mcp`. This machine has no `claude` binary and no `ANTHROPIC_API_KEY`, so the eval did not start it | bao's tool names above, not `left_click` | PNG on `screenshot` and `snapshot`, if the CLI renders MCP image content | `click` `x`, `y` | not accepted. `ref` is a DOM id |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` is not installed here | same as the CLI, if the SDK is configured as an MCP client | same | same | not accepted |
| Codex CLI | MCP server in the Codex config. This machine has no `codex` binary and no `OPENAI_API_KEY` | bao's tool names, if Codex calls them. Codex has no pixel schema of its own | PNG only when Codex calls `screenshot` or `snapshot` and keeps the image | `click` `x`, `y` when it calls `click` | not accepted |
| Cursor `cursor-agent` | MCP client. `cursor-agent` is not on `PATH` here | bao's tool names | PNG on `screenshot` and `snapshot` | `click` `x`, `y` | not accepted. `ref` is a DOM id |
| Scripted client in `bao eval drivers` | spawns `bao mcp` and speaks the live tools. No model | all live tools | yes, and the trail snapshot is checked | yes. The client reads boxes from `snapshot` and sends the center | one `click` on the form task sends `ref` `noop`, a DOM id. No AX id |

The viewport is the page. The browser tab strip is not in it. The tabs task is in-page tabs. The dialog task is a page element with `role="dialog"`, not an OS file dialog.

## Commands

```sh
npm run bao -- eval drivers
npm run bao -- eval intent
npm run bao -- eval heldout capture --dir docs/eval/heldout/batch1
npm run bao -- eval heldout --dir docs/eval/heldout/batch1 --out docs/eval/heldout/batch1.md
```

`eval drivers` writes `docs/eval/drivers.md`. `eval intent` writes `docs/eval/intent.md`. A missing CLI or a missing key is a `not run` cell. The command does not invent a pass.

`eval intent` runs three condensers. `condense` is deterministic. The model condenser edits the raw trail. `hybrid` starts from that deterministic workflow: the model may drop a Help step, write intent text, and flag login or confirm. It cannot add a step, change an input, or clear a secret tag. A judge model scores the intent text and is calibrated on ten hand labels.

`eval heldout` scores those same condensers on trails captured from public pages. `eval heldout capture` writes the trails and `truth.json` and does not condense them. `--tasks batch2` and `--tasks batch3` capture the later batches. Held-out replay tries role, text, test id, css, and xpath after an identity miss, and opens a collapsed target through a search toggle. `eval heldout --judge` lints intent text first, then scores whatever the lint passes with the same rubric.
