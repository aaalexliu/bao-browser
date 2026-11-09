# What Bao asks permission for

The default [agent-browser pass-through](agent-browser-engine.md#pick-an-engine-and-profile) uses Bao's own lasting profile and page screenshots through CDP. That route, and a marked profile copy, need no Accessibility, Automation, or Screen Recording grant. On macOS 27 and later, reading Chrome's profiles needs the [Files & Folders switch](#files--folders--google-chrome). Explicit [`browser: "current"`](agent-browser-engine.md#use-the-owners-running-chrome) controls the owner's running Chrome with BaoOSHelper's existing Accessibility grant. It needs neither Automation nor Screen Recording. The older daily-Chrome driver remains retired. Bao no longer shows its permission card, footer warnings, or Automation Allow button. The helper's optional native-app and remote-debugging CLI features remain below. A grant for one feature does not grant another.

## Files & Folders > Google Chrome

macOS 27 and later let a process read `~/Library/Application Support/Google/Chrome` only when System Settings > Privacy & Security > Files & Folders turns on Google Chrome for the app responsible for that process. There is no prompt: `stat` works, and opening or listing fails with `EPERM`. macOS 26 and earlier have no such rule. Bao reads that folder to list Chrome profiles, to import a site's sign-in into its own profile, to copy a profile for `browser: "copy"`, to read `DevToolsActivePort` for Running Chrome, and for **Import a login**.

Which app needs the switch:

- **The Bao app** opened from Finder: Bao.
- **`bao-cli`** (`bao setup`, `bao doctor`, and `bao` on `PATH`): Bao. The launcher runs Node through `Contents/MacOS/bao --run-node --own`, which starts a copy of Bao's main executable that answers for itself, the way Claude Desktop's `disclaimer` helper starts its servers, and stays as Node's parent ([`bao-run-node.h`](../desktop/packaging/macos/bao-run-node.h)).
- **`bao-mcp`**, which agents start: Bao in a build signed with a certificate, so one switch covers Codex, Claude, and any other host. An ad-hoc build leaves agents with the app that started them, such as ChatGPT for Codex or the terminal that runs Claude Code. macOS keys an ad-hoc grant to one build (its designated requirement is the cdhash), so a grant to Bao would not survive an update. Claude Desktop starts `bao-mcp` through its own `disclaimer`, so Bao answers there in either build.

When a read is refused, Bao says `macOS did not let Bao read Google Chrome's folder (EPERM on <file>).`, names the switch and the app, and for an ad-hoc Bao adds that a switch already on must be turned off and on again after an update. Bao's own profile still opens and imports no sign-ins; a Chrome copy and Running Chrome stop. [agent-browser pass-through](agent-browser-engine.md#choose-the-chrome-profile) shows the results.

The step is optional. Settings → Mac permissions → **Google Chrome's folder** shows whether Bao can read the folder and has **Open System Settings**. `bao setup` ends with the same step: `o` opens Files & Folders, `c` checks again, Enter skips. `bao doctor` reports it as `chrome folder`.

## The Chrome remote-debugging toggle

This is the checkbox **Allow remote debugging for this browser instance** at `chrome://inspect/#remote-debugging`. You can flip it in Chrome or use `bao remote-debugging on` and `bao remote-debugging off`. The default copied-profile pass-through does not use this toggle. The explicit current-Chrome route enables it through the helper and presses native debugging Allow sheets during connection polling, including reconnects, without asking the owner to do either. This includes sheets already present when polling starts; Bao does not attribute each sheet to a particular connection. Chrome enforces it: while it is off, no local program can open a debugging connection to that browser. While it is on, Chrome listens on this Mac only (`127.0.0.1`) and will still ask before each connection. The checkbox is a Chrome preference. It stays as you left it across restarts until you clear it. Leaving it on costs nothing by itself. The automation banner appears only while a connection is actually open.

## BaoOSHelper Accessibility

The optional native-app MCP driver uses the helper's Accessibility access to read and press controls in Calculator and TextEdit. The separate `bao remote-debugging on|off` CLI uses it to read and set Chrome's debugging checkbox by pid. Owned-browser replay window placement also tries the helper after CDP as a best-effort step; missing access does not block replay. Copied-profile Chrome agents need none of these helper paths. The explicit current-Chrome route uses PID-scoped Accessibility input to open inspect, set its debugging checkbox, and press its Allow sheet. macOS grants Accessibility to BaoOSHelper, not to `node` or the product window.

If you choose a feature that needs Accessibility, enable BaoOSHelper in System Settings > Privacy & Security > Accessibility. If its row is missing, use the + button to add `Bao.app/Contents/Resources/BaoOSHelper.app`. Keep the signed helper identity described in [Rebuild with an existing grant](mac-build.md#rebuild-with-an-existing-grant).

## Automation for Google Chrome

Only the separate `bao remote-debugging on|off` command uses this grant. Its helper opens `chrome://inspect/#remote-debugging`, checks the URL, and restores the selected tab through Apple Events to one Chrome pid. It never runs JavaScript through Apple Events. A toggle that already matches the requested state does not ask. Running the CLI can ask for Automation when the toggle must change; Chrome agents and app status never ask or open Chrome for it.

The outer app's [`NSAppleEventsUsageDescription`](../desktop/packaging/macos/Info.plist) and the [helper's purpose string](../desktop/os-helper-macos/Info.plist) name that CLI feature. They permit a future prompt, not a grant or a reset of a prior denial. macOS can attribute an installed nested-helper request to Bao (`dev.bao.desktop`) or a standalone request to BaoOSHelper. If you choose to use this CLI after denying Automation, open System Settings > Privacy & Security > Automation and enable Google Chrome under Bao for the installed app, or under BaoOSHelper for a standalone request. No Automation grant is needed for normal Chrome agents.

## Which grant each job needs

The helper reports only two optional capabilities. The retired `ax-press` and `live-chrome` rows remain removed. Explicit current-Chrome control checks Accessibility directly; it does not add a capability row. The older helper commands also remain available to the separate CLI and native-app driver.

- **Window capture** (`window-capture`) supplies `bao mcp-ax` with window pictures through `shot`. It needs Screen Recording, not a Chrome page screenshot grant.
- **Native-app MCP driver** (`mcp-ax`) drives Calculator and TextEdit through `bao mcp-ax`. It uses Accessibility and Screen Recording to observe and act on those apps, not Chrome.

Both API rows have `optional: true`; neither creates a footer warning, onboarding card, or permission button. These rows do not read the Screen Recording grant and cannot report whether it is on. Without the helper or outside macOS, `helper.label` reads `helper off`. With the helper present on macOS, it reads `helper available`, regardless of grants. That label reports presence, not native-app readiness. Settings → Mac permissions shows Accessibility status and explains native-app control. Its Screen Recording row explains window capture, says Not checked, and offers Open System Settings on macOS. Copied-profile and Bao-profile Chrome agents need neither grant. Explicit current-Chrome control needs the helper's existing Accessibility grant. Settings' permission-free sentence does not yet distinguish that route. See [Known gaps](agent-browser-engine.md#known-gaps). Both rows show Mac only on Linux.

The separate remote-debugging CLI still checks Accessibility before changing Chrome's checkbox and retains its Automation gate. Extension replay has its own site grant. Neither is a required helper capability.

`shot` is the only helper command that captures pixels from macOS. It remains an explicit opt-in for legacy OS tools. The generic `permissions` command reports Accessibility and preflights Screen Recording without prompting. The explicit diagnostic commands `windows` (WindowServer enumeration) and `permissions --prompt` can also check or request Screen Recording; the remote-debugging CLI's Chrome wrapper refuses all three. Normal `nodes`, `press`, `hit`, `focus`, and remote-debugging toggle calls use AX window bounds, never WindowServer window lists or screen capture. App status and the remote-debugging CLI use `permissions-ax`, which omits `screenCapture` from its report and does not preflight Screen Recording. The app reports `helper.screenCapture: false` without checking that optional grant. An old helper rejects that command rather than falling back to a Screen Recording check. The CLI's Chrome wrapper refuses `nodes` unless `--bundle` is exactly `com.google.Chrome`.

## Extension host grants

These belong to the Bao extension in Chrome, not to the remote-debugging connection. Chrome enforces them. Replay through the extension cannot touch a site until you choose **Only this site** or **Allow all sites** on the extension's allow page. Nothing is granted at install. A per-site grant covers that origin. An all-sites grant covers later http or https origins of that scheme. The default wait is 90 seconds; if the grant does not arrive, the run stops and asks you. The pass-through does not use this grant. `cdp-live` workflow replay is retired.

## Agent Chrome control

The [`agent_browser` pass-through](agent-browser-engine.md#direct-mcp-commands) uses a marked profile copy by default. Selecting `browser: "current"` on the first `open` attaches to the owner's running Chrome and starts navigation in a new tab. Ending that session disconnects without quitting Chrome or closing its tabs. Neither route uses a host allowlist. Bao does not block final clicks. The older live driver and its policy modes are retired. A saved file that is not [schema v4](workflow-schema.md) is not loaded.

## What stays on this Mac

Pass-through runs save raw command arguments, native stdout/stderr, and readable page screenshots in Bao's local Library. They do not redact credentials or other private page content. Do not use this route for data you do not want saved locally. Page screenshots use CDP, not macOS Screen Recording. The app serves local run evidence on `127.0.0.1`, with caching off.

Historical live-driver session files, pictures, and video stay on disk. Retirement does not rewrite or upload them. Their old redaction rules do not apply to current pass-through records. A workflow file that is not [schema v4](workflow-schema.md) is not loaded. [Run evidence](agent-browser-engine.md#evidence) describes the current paths and failure behavior.

### Secret text in saved files

Bao keeps typed passwords and other input values in the local Library. Workflows keep secret defaults for replay. Trails, runs, receipts, version books, pending prompts, debug files, and teaching cases keep their values too. Bao no longer scans saved text for password fields, card numbers, SSNs, JWTs, or API-token shapes. The `scrub-secrets` command has been removed. Existing files stay as they are.

A recorded password still uses a named secret input and a stable field locator. Its default is the recorded value. Replay fills that default unless a runtime input overrides it. Inputs bound to fields with `autocomplete="one-time-code"` are the exception: capture and the input editor omit their defaults, and replay never fills them from defaults or past inputs. Supply a fresh code for each run. The input editor can change other defaults. Run links can supply secret inputs. Re-run forms can reuse saved inputs. File inputs still use the file picker and supported file references rather than a saved absolute path.

Older records can contain `[secret stripped]` or a redacted key with no value. These mean missing data, not text to type. Replay stops with “This step needs a value” before dispatch or healing. Supply a fresh runtime input to replace an old stripped default, or edit the saved step and input.

Read-back receipts seal the original expected and actual values with the previous receipt hash. Later local saves keep those bodies intact. `verifyReceiptChain` still checks the chain. The MCP run viewer replaces read-back values equal to the run's saved secret inputs with `[secret stripped]`. New runs record secret-input names; runs without that field use current workflow typing, a Known gap. Local Runs and receipts stay raw. Workflow sync hashes still track edits; they are not immutable seals.

Outbound copies still use `shared/outbound-secrets.ts` to replace eligible whole user values with `[secret stripped]`; they do not scan arbitrary metadata or secret fragments inside free text. Sync still omits secret defaults and sensitive literals through `stripUnsafe`. Local saves and workflow JSON downloads do not use that filter. Marketplace review samples also omit whole values matching the token, card, and SSN checks. `describe_workflow` omits inferred text/value checks that match those shapes or a known secret; explicit notes and checks stay unchanged. Browser and extension pictures have no Bao-added masks or blur. Chrome still draws its own password fields. DOM and accessibility snapshots, console text, model prompts and replies, titles, labels, and navigation notes retain captured text within their existing size limits. Guide downloads keep saved values, paths, and original crop bytes. Proxy HAR contents follow the [network capture contract](proxy-design.md#network-capture-and-what-replay-would-mean).

When sync pulls a newer workflow or resolves a conflict, `retainLocalDefaults` preserves this device's saved defaults and literals when the incoming fields still match their outbound copies. It does not recover values on another device or overwrite changed incoming fields. Conflict history restores local values only when a cloud document matches exactly one non-draft local version's outbound copy. File and OTP defaults are not restored.

## What each one costs in speed

Copied-profile Chrome agents do not wait for Mac privacy grants or the daily-Chrome debugging switch. Explicit current-Chrome control checks existing Accessibility access without prompting, then lets BaoOSHelper handle the debugging switch and Chrome's Allow sheet. The separate remote-debugging CLI returns at once if the checkbox already matches. Changing it needs a helper accessibility walk. An extension host grant is a separate prompt with a wait of up to 90 seconds; it is not part of the pass-through.
