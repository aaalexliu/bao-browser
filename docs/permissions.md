# What Bao asks permission for

Bao never needs Screen Recording to drive Chrome. It uses Accessibility plus Automation for Google Chrome; screenshots and video come from CDP. Leave Screen Recording off. Chrome and macOS enforce separate permissions. Turning one on does not turn the others on. The daily-Chrome helper path is below. For the separate copied-profile route and its permission requirements, see [agent-browser trial](agent-browser-engine.md#pick-an-engine-and-profile).

## The Chrome remote-debugging toggle

This is the checkbox **Allow remote debugging for this browser instance** at `chrome://inspect/#remote-debugging`. You can flip it in Chrome, or let Bao manage it as described in [Agent entry point](cdp-live-chrome.md#agent-entry-point). Chrome enforces it: while it is off, no local program can open a debugging connection to that browser. While it is on, Chrome listens on this Mac only (`127.0.0.1`) and will still ask before each connection. The checkbox is a Chrome preference. It stays as you left it across restarts until you clear it. Leaving it on costs nothing by itself. The automation banner appears only while a connection is actually open.

## The Allow dialog, once per connection

Each new debugging connection raises **Allow remote debugging?** Chrome does not remember the answer. Bao does not get a socket until you press **Allow** or until BaoOSHelper presses that one button. The helper may press it only for a dialog that appeared after Bao started the connection, and only the button named Allow. **Allow sites** is a different button and is not pressed. A later connection asks again. The costly part is the wait: the helper walks Chrome's accessibility tree to find the dialog, then presses once. On this Mac that has taken from about 8 seconds to about 50 seconds. Holding the socket open does not ask again for tabs attached on that same connection.

## BaoOSHelper Accessibility

macOS grants this to the helper app, BaoOSHelper, not to `node` and not to the product window. macOS enforces it. The helper uses it to read and set the remote-debugging checkbox and press Allow, all by Chrome pid. It does not read site content. The first prompt is once per signed helper. After that, each Allow press is one short accessibility walk, which is most of the time in the paragraph above.

## Automation for Google Chrome

Status checks do not ask for Automation or open Chrome. BaoOSHelper sends several Apple Events to one Chrome process, by pid, to open `chrome://inspect/#remote-debugging`, confirm the URL, read the tab and window ids and bounds, and later restore the tab selection and close its tab. It never uses Apple Events to run JavaScript. macOS asks once, when a toggle first needs Automation or when you press **Allow** beside **Automation: Google Chrome** in Bao. If Chrome is closed, that button opens it normally before asking. The prompt names BaoOSHelper and Google Chrome. The prompt text comes from `NSAppleEventsUsageDescription` in [`desktop/os-helper-macos/Info.plist`](../desktop/os-helper-macos/Info.plist). A toggle that already matches the requested state does not ask. If you deny Automation, enable it in System Settings > Privacy & Security > Automation > BaoOSHelper > Google Chrome. This grant is not Accessibility, and it is not a grant to control any other app.

## Which grant each job needs

The helper reports four jobs, including legacy OS tools. Extension replay has its own site grant. A grant for one job does not turn another job off.

- **AX press** reads and presses a control by its name. It needs Accessibility. The footer reads **AX press ready**.
- **Window capture** is the explicit legacy `shot` command, not the Chrome screenshot path. It needs Screen Recording. The footer reads **window capture ready** when that optional grant exists.
- **Live Chrome** reads Chrome's controls through Accessibility. The footer reads **live Chrome ready** when Accessibility is granted and either Automation for Google Chrome is granted or that Chrome is already listening with remote debugging on. If Chrome is closed, the Automation check stays neutral. If debugging is off and Automation is not yet asked or denied, the footer reads **live Chrome needs one more permission**. Use **Allow** beside **Automation: Google Chrome** for not yet asked, or System Settings > Privacy & Security > Automation > BaoOSHelper > Google Chrome for denied. An unavailable check shows its error and does not claim readiness unless Chrome is already listening. Live Chrome does not capture the window; Screen Recording never blocks it.
- **Legacy OS MCP driver** (`bao mcp-ax`) calls `shot` before it observes, clicks, types, or presses a key. It needs Accessibility and Screen Recording for that explicit window capture. The footer reads **MCP driver ready** only when both are on. Use the Chrome MCP driver instead to avoid Screen Recording.
- **Extension replay** uses the extension's site grant. The helper status does not report it.

`helper.label` stays `helper ok` when Accessibility and Screen Recording are both on, and `helper needs permission` when either is off. The live Chrome row also counts Automation as described above.

Do not enable Screen Recording for Bao's Chrome path. The legacy **helper needs permission** label can appear with Screen Recording off even when **live Chrome ready** is true.

`shot` is the only helper command that captures pixels from macOS. It remains an explicit opt-in for legacy OS tools. The explicit diagnostic commands `windows` (WindowServer enumeration) and `permissions --prompt` can also check or request Screen Recording; live Chrome refuses all three. Normal `nodes`, `press`, `hit`, `focus`, and remote-debugging toggle calls use AX window bounds, never WindowServer window lists or screen capture. Live permission checks use `permissions-ax`, which does not even preflight Screen Recording. An old helper rejects that command rather than falling back to a Screen Recording check. The live wrapper accepts only Google Chrome, its Beta/Dev/Canary channels, and Chrome for Testing as walk or press targets. A hit or press covered by another app stops with **point is covered by another app**. The helper checks that element's owner pid only; it does not read the covering app's controls or press through it.

## Extension host grants

These belong to the Bao extension in Chrome, not to the remote-debugging connection. Chrome enforces them. Replay through the extension cannot touch a site until you choose **Only this site** or **Allow all sites** on the extension's allow page. Nothing is granted at install. A per-site grant covers that origin. An all-sites grant covers later http or https origins of that scheme. The default wait is 90 seconds; if the grant does not arrive, the run stops and asks you. `cdp-live` does not use this grant. A live attach and an extension replay are separate doors.

## What an allowlist refuses

A live run is given an exact host list. Bao refuses a navigation whose host is not on that list, before the navigation. An Instacart run may use `instacart.com` and `www.instacart.com` only, and it refuses checkout, login, account, address, and payment paths. A books run stays on `books.toscrape.com`. Subresources such as images are not navigations, so they are not added to the list. Live page reads do not collect cookie values. The separate [profile-copy route](agent-browser-engine.md#pick-an-engine-and-profile) copies profile files, not just the allowlisted site's data.

## What stays on this Mac

The live run view, its step list, and its audit log are files in Bao's home directory on this machine. Live page screenshots use Chrome, not macOS screen recording. App live sessions and the Instacart runner use `captureRedacted` in `desktop/src/cdp-live/driver.ts`; the [live evidence contract](agent-browser-engine.md#evidence) covers the screenshot veil and copied-profile video. The session script `desktop/src/cdp-live/session.ts` uses `redactForShot` instead. It blurs only the nodes it matches, such as an email or a price. A count of 0 still writes the PNG. A plain name and a Place order button stay readable in those shots. The app serves those files only on `127.0.0.1`, with caching off. They are not uploaded. With `BAO_RUN_VIDEO=1`, live sessions and replays use the shared CDP recorder; ordinary MCP sessions and Library runs blur frames before persistence. Only the private app launched by `bao eval agent-instacart` may record its live sessions and MCP replays without blur, so those eval clips contain whatever the page showed; no MCP argument or workflow field can request no-blur. All clips stay local and need no macOS Screen Recording grant. [Agent entry point](cdp-live-chrome.md#agent-entry-point) describes the recording paths and playback.

## What each one costs in speed

The debugging toggle is instant if it is already on. The Allow dialog is the slow gate, about 8 to 50 seconds, once per connection, mostly the accessibility walk. A page click is about a second, with a short pause so the tab can be watched. A screenshot is a local file write. An extension host grant is a separate prompt, up to 90 seconds, and it is not on the live-attach path.
