# What Bao asks permission for

Four grants come up around a live Chrome session. They are different switches, enforced by different programs. Turning one on does not turn the others on.

## The Chrome remote-debugging toggle

This is the checkbox **Allow remote debugging for this browser instance** at `chrome://inspect/#remote-debugging`. You flip it in Chrome. Chrome is the one that enforces it: while it is off, no local program can open a debugging connection to that browser. While it is on, Chrome listens on this Mac only (`127.0.0.1`) and will still ask before each connection. The checkbox is a Chrome preference. It stays as you left it across restarts until you clear it. Leaving it on costs nothing by itself. The automation banner appears only while a connection is actually open.

## The Allow dialog, once per connection

Each new debugging connection raises **Allow remote debugging?** Chrome does not remember the answer. Bao does not get a socket until you press **Allow** or until BaoOSHelper presses that one button. The helper may press it only for a dialog that appeared after Bao started the connection, and only the button named Allow. **Allow sites** is a different button and is not pressed. A later connection asks again. The costly part is the wait: the helper walks Chrome's accessibility tree to find the dialog, then presses once. On this Mac that has taken from about 8 seconds to about 50 seconds. Holding the socket open does not ask again for tabs attached on that same connection.

## BaoOSHelper Accessibility

macOS grants this to the helper app, BaoOSHelper, not to `node` and not to the product window. macOS enforces it. The helper uses it to see the Allow button and press it. It does not read the web page. The first prompt is once per signed helper. After that, each Allow press is one short accessibility walk, which is most of the time in the paragraph above.

## Which grant each job needs

Four jobs can run on this Mac. A grant for one job does not turn another job off.

- **Native automation** reads and presses a control by its name. It needs Accessibility.
- **Window capture** saves one window. It needs Screen Recording.
- **Live Chrome** reads Chrome's controls through Accessibility. It needs Accessibility. It does not capture the window. Leave Screen Recording on when window capture needs it. That grant does not stop live Chrome.
- **Extension replay** uses the extension's site grant. It does not need Accessibility or Screen Recording.

The helper status names each job. `live Chrome ready` means Accessibility is on. `window capture ready` means Screen Recording is on. `native automation ready` follows Accessibility. `extension replay ready` does not read those two grants. `helper.label` stays `helper ok` when both grants are on, and `helper needs permission` when either grant is off.

Use both grants when you want window capture and live Chrome. Do not turn Screen Recording off to start live Chrome.

## Extension host grants

These belong to the Bao extension in Chrome, not to the remote-debugging connection. Chrome enforces them. Replay through the extension cannot touch a site until you choose **Only this site** or **Allow all sites** on the extension's allow page. Nothing is granted at install. A per-site grant covers that origin. An all-sites grant covers later http or https origins of that scheme. The default wait is 90 seconds; if the grant does not arrive, the run stops and asks you. `cdp-live` does not use this grant. A live attach and an extension replay are separate doors.

## What an allowlist refuses

A live run is given an exact host list. Bao refuses a navigation whose host is not on that list, before the navigation. An Instacart run may use `instacart.com` and `www.instacart.com` only, and it refuses checkout, login, account, address, and payment paths. A books run stays on `books.toscrape.com`. Subresources such as images are not navigations, so they are not added to the list. Cookie values are not read or stored.

## What stays on this Mac

The live run view, its step list, and its audit log are files in Bao's home directory on this machine. Screenshots are taken with Chrome's `Page.captureScreenshot` of the page, not with macOS screen recording. A blur covers the page before the file is written, so names, prices, and cart lines are not readable in the picture. The app serves those files only on `127.0.0.1`, with caching off. They are not uploaded.

## What each one costs in speed

The debugging toggle is instant if it is already on. The Allow dialog is the slow gate, about 8 to 50 seconds, once per connection, mostly the accessibility walk. A page click is about a second, with a short pause so the tab can be watched. A screenshot is a local file write. An extension host grant is a separate prompt, up to 90 seconds, and it is not on the live-attach path.
