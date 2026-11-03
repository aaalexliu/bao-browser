# What Bao asks permission for

Bao's daily-Chrome path never needs Screen Recording. Live screenshots and video come from CDP. Leave Screen Recording off for this path. Chrome and macOS enforce separate permissions. Turning one on does not turn the others on. For the separate copied-profile route and its permission requirements, see [agent-browser trial](agent-browser-engine.md#pick-an-engine-and-profile).

## The Chrome remote-debugging toggle

This is the checkbox **Allow remote debugging for this browser instance** at `chrome://inspect/#remote-debugging`. You can flip it in Chrome, or let Bao manage it as described in [Agent entry point](cdp-live-chrome.md#agent-entry-point). Chrome enforces it: while it is off, no local program can open a debugging connection to that browser. While it is on, Chrome listens on this Mac only (`127.0.0.1`) and will still ask before each connection. The checkbox is a Chrome preference. It stays as you left it across restarts until you clear it. Leaving it on costs nothing by itself. The automation banner appears only while a connection is actually open.

## The Allow dialog, once per connection

Each new debugging connection raises **Allow remote debugging?** Chrome does not remember the answer. Bao does not get a socket until you press **Allow** or until BaoOSHelper presses that one button. The helper may press it only for a dialog that appeared after Bao started the connection, and only the button named Allow. **Allow sites** is a different button and is not pressed. A later connection asks again. The costly part is the wait: the helper walks Chrome's accessibility tree to find the dialog, then presses once. On this Mac that has taken from about 8 seconds to about 50 seconds. Holding the socket open does not ask again for tabs attached on that same connection.

## BaoOSHelper Accessibility

macOS grants this to the helper app, BaoOSHelper, not to `node` and not to the product window. macOS enforces it. The helper uses it to read and set the remote-debugging checkbox and press Allow, all by Chrome pid. It does not read site content. The first prompt is once per signed helper. After that, each Allow press is one short accessibility walk, which is most of the time in the paragraph above.

## Automation for Google Chrome

Status checks do not ask for Automation or open Chrome. BaoOSHelper sends several Apple Events to one Chrome process, by pid, to open `chrome://inspect/#remote-debugging`, confirm the URL, read the tab and window ids and bounds, and later restore the tab selection and close its tab. It never uses Apple Events to run JavaScript. macOS asks once, when a toggle first needs Automation or when you press **Allow** beside **Automation: Google Chrome** in Bao. If Chrome is closed, that button opens it normally before asking. For the installed Bao.app, macOS attributes the nested helper's request to Bao (`dev.bao.desktop`). The outer app therefore declares `NSAppleEventsUsageDescription` in [`desktop/packaging/macos/Info.plist`](../desktop/packaging/macos/Info.plist), matching the helper's existing description in [`desktop/os-helper-macos/Info.plist`](../desktop/os-helper-macos/Info.plist). The description permits a future prompt; it does not grant Automation or clear an earlier denial. A toggle that already matches the requested state does not ask. If you deny Automation, enable Google Chrome under Bao in System Settings > Privacy & Security > Automation. When macOS attributes a standalone helper request to BaoOSHelper instead, use its entry. This grant is not Accessibility, and it is not a grant to control any other app.

## Which grant each job needs

The helper reports four jobs, including legacy OS tools. Extension replay has its own site grant. A grant for one job does not turn another job off.

- **AX press** reads and presses a control by its name. It needs Accessibility. The footer reads **AX press ready**.
- **Window capture** is the optional legacy `shot` command, not the Chrome screenshot path. It needs Screen Recording. Its API capability has `optional: true`; the UI does not show a missing-grant row or a prompt for it.
- **Live Chrome** reads Chrome's controls through Accessibility. The footer reads **live Chrome ready** when Accessibility is granted and either Automation for Google Chrome is granted or that Chrome is already listening with remote debugging on. If Chrome is closed, the Automation check stays neutral. If debugging is off and Automation is not yet asked or denied, the footer reads **live Chrome needs one more permission**. Use **Allow** beside **Automation: Google Chrome** for not yet asked; for denied, follow [Automation for Google Chrome](#automation-for-google-chrome). An unavailable check shows its error and does not claim readiness unless Chrome is already listening. Live Chrome does not capture the window; Screen Recording never blocks it.
- **Legacy OS MCP driver** (`bao mcp-ax`) drives Calculator and TextEdit, not Chrome. It calls `shot` before it observes, clicks, types, or presses a key. It needs Accessibility and Screen Recording for that explicit window capture. Its API capability has `optional: true`; the UI does not show its missing grants or a prompt. Use the `live_*` tools in [`bao mcp`](cdp-live-chrome.md#agent-entry-point) to drive Chrome without Screen Recording.
- **Extension replay** uses the extension's site grant. The helper status does not report it.

Without the helper or outside macOS, `helper.label` reads `helper off`. With the helper present on macOS, it reads `helper ok` when Accessibility is on and Automation for Google Chrome is granted, or when Accessibility is on and Chrome is closed so Automation cannot be checked. Otherwise it reads `helper needs permission`. Screen Recording never affects the label. An existing remote-debugging listener can satisfy the live Chrome row without changing the label's Automation requirement.

The UI lists two required permissions: Accessibility and Automation: Google Chrome. Do not enable Screen Recording for Bao's daily-Chrome path.

`shot` is the only helper command that captures pixels from macOS. It remains an explicit opt-in for legacy OS tools. The generic `permissions` command reports Accessibility and preflights Screen Recording without prompting. The explicit diagnostic commands `windows` (WindowServer enumeration) and `permissions --prompt` can also check or request Screen Recording; live Chrome refuses all three. Normal `nodes`, `press`, `hit`, `focus`, and remote-debugging toggle calls use AX window bounds, never WindowServer window lists or screen capture. App status and live permission checks use `permissions-ax`, which omits `screenCapture` from its report and does not preflight Screen Recording. The app reports `helper.screenCapture: false` without checking that optional grant. An old helper rejects that command rather than falling back to a Screen Recording check. The live wrapper refuses `nodes` unless `--bundle` is exactly `com.google.Chrome`.

## Extension host grants

These belong to the Bao extension in Chrome, not to the remote-debugging connection. Chrome enforces them. Replay through the extension cannot touch a site until you choose **Only this site** or **Allow all sites** on the extension's allow page. Nothing is granted at install. A per-site grant covers that origin. An all-sites grant covers later http or https origins of that scheme. The default wait is 90 seconds; if the grant does not arrive, the run stops and asks you. `cdp-live` does not use this grant. A live attach and an extension replay are separate doors.

## What an allowlist refuses

Default YOLO live sessions allow navigation to any HTTP(S) host. Careful live sessions, saved-workflow replay, and the Instacart runner use exact host lists and refuse off-list navigation before it starts. In these guarded runs, the Instacart preset allows only `instacart.com` and `www.instacart.com` and refuses checkout, login, account, address, and payment paths. The books preset stays on `books.toscrape.com`. Subresources such as images are not navigations, so they are not added to the list. Live page reads do not collect cookie values. The separate [profile-copy route](agent-browser-engine.md#pick-an-engine-and-profile) copies profile files, not just the allowlisted site's data.

## What stays on this Mac

The live run view, its step list, and its audit log are files in Bao's home directory on this machine. Live page screenshots use Chrome, not macOS screen recording. App live sessions and the Instacart runner use `captureRedacted` in `desktop/src/cdp-live/driver.ts`; the [live evidence contract](agent-browser-engine.md#evidence) covers the screenshot veil and copied-profile video. The session script `desktop/src/cdp-live/session.ts` uses `redactForShot` instead. It blurs only the nodes it matches, such as an email or a price. A count of 0 still writes the PNG. A plain name and a Place order button stay readable in those shots. The app serves those files only on `127.0.0.1`, with caching off. They are not uploaded. With `BAO_RUN_VIDEO=1`, live sessions and replays use the shared CDP recorder; default YOLO live sessions save readable screenshots and video, so those files contain whatever the page showed, including credentials typed by the agent. `careful: true` live sessions and Library replays blur frames before persistence. The private app launched by `bao eval agent-instacart` can also record without blur. Read-back secret redaction remains on in both live modes. No separate no-blur MCP argument or workflow field exists. All clips stay local and need no macOS Screen Recording grant. [Agent entry point](cdp-live-chrome.md#agent-entry-point) describes the recording paths and playback.

In `live-session/session.json`, `start` and `navigate` audit labels that parse as HTTP(S) URLs keep their origins, including host and port digits, plus redacted pathnames, capped at 80 characters. They omit URL credentials, query strings, and fragments. All other audit labels still use `redactLabel` in `desktop/src/cdp-live/live-record.ts`. `desktop/test/unit/cdp-live.test.ts` covers this rule.

### Secret text in saved files

Bao strips detected secrets when it saves live trails, run records and workflows. It replaces whole secret data values with `[secret stripped]`, not fragments inside other strings. A structured table cell counts as one field; harmless columns stay intact. Field structure comes first: password types and `current-password`, `new-password`, `one-time-code` or `cc-*` autocomplete tokens. Value checks cover whole values that match Luhn-valid card numbers, SSN shapes, JWTs or common API-token prefixes. These checks do not change or block live typing. Labels, binding expressions, selectors, URLs, option tokens and existing markers stay stable. Secrets embedded in free text, such as an API token pasted into a sentence, remain. These checks do not find every possible secret. Saved runtime arguments also use the associated workflow's field and input bindings. Cleanup uses those workflow links and saved argument bags when they exist. Older or orphaned files may lack that evidence, so the scrub cannot identify every private value. Screenshots and videos stay unchanged.

Replay stops at a stripped step with “This step needs a value.” It never types the marker. Edit the saved step and its input to supply a new value before replaying it.

To inspect existing saved text in one Bao home, quit active sessions and run:

```sh
bao scrub-secrets --home /path/to/bao-home
```

The command defaults to a dry run and lists the files it would change. Add `--write` to scrub them. Before changing any saved file, Bao backs up every affected original under `<home>/secret-scrub-backups/<run>/`, with private directory and file permissions. Those backups still contain the original secrets. Keep them private and remove them once you no longer need recovery. The command skips symlinks, browser profiles, settings, screenshots and videos. It also lists append-only receipt chains as skipped, with a reason, in both dry-run and write output. Those chains stay byte-for-byte unchanged and may still contain historical secrets. New receipts are stripped before hashing so their chains remain valid. `bao scrub-secrets --help` describes this limit. Invalid JSON in a file to be scrubbed stops the scrub before it writes anything. Run it again to check that no saved text still needs a change.

## What each one costs in speed

The debugging toggle is instant if it is already on. The Allow dialog is the slow gate, about 8 to 50 seconds, once per connection, mostly the accessibility walk. A page click is about a second, with a short pause so the tab can be watched. A screenshot is a local file write. An extension host grant is a separate prompt, up to 90 seconds, and it is not on the live-attach path.
