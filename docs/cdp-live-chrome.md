# Live Chrome over CDP (spike notes)

Observed on alex-m1. Google Chrome **155.0.8059.86**, arm64, already running as a normal window (pid 1497). This path is Chrome's own local remote-debugging switch (`chrome://inspect/#remote-debugging`, Chrome 144+). It is separate from the extension driver in [extension.md](extension.md).

The `cdp-live` driver, the books.toscrape.com allowlist, and the Allow-dialog click guard are in the tree. On 2026-10-26, with the session unlocked and the display awake, the p5 Mystery replay passed twice on one browser socket: 32 rows each, `isTrusted` true, connect-to-Allow 20559 ms. The remote-debugging checkbox was already on and was left on. The runner read `DevToolsActivePort` and no other file in the Chrome profile.

## Measured run

BaoOSHelper (`dev.bao.oshelper`, launched with `open -a`, parent `launchd`) reported accessibility granted, screen capture not granted, and no prompt. The checkbox **Allow remote debugging for this browser instance** was already on (`AXCheckBox` value `1`). It was not pressed again. The Allow dialog was absent before the handshake. An `AXButton` named "Allow sites" was in the tree and was not pressed.

The runner read only `DevToolsActivePort`, opened a browser WebSocket with no `Origin` header, and pressed `AXButton` "Allow" once the dialog was present. The button's window was the Inspect page. The socket completed after that press. Connect-to-Allow was **20559 ms**: about 10 s for the accessibility walk that found the dialog, then about 10 s for the press lookup. An earlier connection the same afternoon, before click trust was kept across navigation, measured **20544 ms** and also passed 32 rows twice (3030 ms and 2107 ms) with an empty trust log.

Each replay opened its own window with `Target.createTarget` and closed only that target.

| Run | Status | Rows | Time | isTrusted | webdriver |
| --- | --- | --- | --- | --- | --- |
| 1 | passed | 32 | 1932 ms (navigate 904, click 520, extract 319) | true on `A` "Mystery" and `A` "next" | false |
| 2 | passed | 32 | 1678 ms (navigate 879, click 379, extract 417) | true on `A` "Mystery" and `A` "next" | false |

Host was `books.toscrape.com`. No step paused for a person. Model calls were 0. Each run counted 9 child-frame navigations and did not follow them.

While the socket was open, the accessibility tree contained **Chrome is being controlled by automated test software**. After the socket closed, that text was absent. Nothing was left connected to port 9222. The checkbox stayed on, and Chrome kept listening on `127.0.0.1:9222`.

## What AX returned while the session was locked

BaoOSHelper (`dev.bao.oshelper`, launched with `open -a` from `/Applications/Bao.app`) reported accessibility granted and screen capture not granted. It was not asked to prompt, and it was not asked to capture the screen.

`nodes` for `com.google.Chrome` (pid 1497) returned **2** elements:

| Role | Count |
| --- | --- |
| AXApplication | 1 |
| AXMenuBar | 1 |

No `AXWindow`. The checkbox "Allow remote debugging for this browser instance" was not in the tree (`found: false`). The dialog title "Allow remote debugging?" was not in the tree. No `AXButton` named "Allow". `matches` was empty. A later read, still while the session was locked, returned the same two roles.

Hit tests through the same helper:

| Point | Result |
| --- | --- |
| (864, 200), (864, 500), (400, 176), (200, 40) | `useful: false`, reason `no accessibility element at point` |
| (200, 12), (200, 5) | `useful: false`, reason `window walk hit AXMenuBar, not an actionable control`, role `AXMenuBar` |
| focused element | `useful: false`, reason `focused element is AXApplication, not a text control`, role `AXApplication` |

The same shape came back after the display was woken in the earlier attempt. The session stayed locked, which is when macOS hides app windows from accessibility. This later read was taken with the display asleep and the session still locked.

One earlier `cg-key` of `cmd+t` was attempted while that tree was empty. The helper refused it (`app did not become frontmost; key was not posted`). No character was sent. The driver now stops before any key when the tree has no window.

CoreGraphics still listed two on-screen Chrome windows, both 1728×1084. Chrome pid 1497 was listening on `127.0.0.1:9222`. That listen was checked with `lsof`. During the locked attempt the port file's contents were not read, and nothing else under the Chrome profile directory was listed or read.

## What this machine showed before the checkbox

Checked on 2026-10-25, before the checkbox was pressed:

- The running browser is `/Applications/Google Chrome.app`, bundle version 155.0.8059.86, architecture arm64. The main process was started without `--remote-debugging-port`.
- `~/Library/Application Support/Google/Chrome/DevToolsActivePort` was **absent**. Existence was tested with `test -f`. The file was not read, and nothing else under that directory was listed or read.
- Nothing was listening on TCP 9222.

After that, BaoOSHelper pressed the checkbox (value 0 to 1) on the inspect page. The port file is now present and Chrome is listening on `127.0.0.1:9222`. The locked attempt did not read the file and did not connect. The unlocked run later read only that file.

## Where the toggle lives

In Chrome 144 and later, open `chrome://inspect/#remote-debugging` in the already-running browser. The section heading is **Remote debugging**. The control is a checkbox, **Allow remote debugging for this browser instance**.

The page text under the checkbox (Chromium `chrome/browser/resources/inspect/inspect.html` at the 155.0.8059.86 tag, same strings on current main):

> Turning on this setting allows external apps to request full control of this browser. This includes read access to your saved data, cookies and site data, and the ability to navigate to any URL.
>
> Only web developers should turn on this feature, and only use it with trusted apps.

Checking the box sends `set-remote-debugging-enabled`. The page script does not raise a second confirm for the checkbox itself. When the server is up, the same section shows **Server running at:** and the bound address. While it is coming up, that line reads `starting…`.

Official steps: [Let your Coding Agent debug your browser session](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session) (published 2025-12-11, Chrome M144) and [Connect your AI agent to your personal browser with auto-connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) (updated 2026-10-12). Both say to enable the switch at `chrome://inspect/#remote-debugging` before any client connects. The later [Build extensions with coding agents](https://developer.chrome.com/docs/extensions/ai/build-with-ai) guide names the checkbox in those words.

The stored preference is application-wide, not per profile: `devtools.remote_debugging.user-enabled` (`prefs::kDevToolsRemoteDebuggingEnabled` in `chrome/common/pref_names.h`). The comment there says it records that the user enabled the server through `chrome://inspect`, and that the debugging server is global. An enterprise policy, `devtools.remote_debugging.allowed`, can refuse to start it (`RemoteDebuggingAllowed`). On Mac, Windows, and Linux the feature `kDevToolsAcceptDebuggingConnections` is enabled by default in the 155.0.8059.86 tree (disabled on ChromeOS).

`--remote-debugging-port` and `--remote-debugging-pipe` still take precedence when present, but since Chrome 136 those switches are ignored for the default user-data directory unless a non-default `--user-data-dir` is also set. That change is [Changes to remote debugging switches to improve security](https://developer.chrome.com/blog/remote-debugging-port) (2025-03-17). The inspect checkbox is the supported way to debug the default profile. This spike does not launch a second Chrome and does not pass those switches.

## Per session, or per connection

Two different gates:

1. **The checkbox** starts and stops the local server. It is a Local State preference, so Chromium keeps it across restarts and starts the approval-mode server again on the next launch if the preference is still true. This machine has not been restarted with the box on, so that persistence is from the preference comment and `RemoteDebuggingServerTest.StartsAndStopsWithPref`, not from a restart here.
2. **Each new WebSocket** is approved on its own. `remote_debugging_server.cc` in 155.0.8059.86 says approval mode is the mode "in which each incoming connection needs to be approved by the user." `ChromeDevToolsManagerDelegate::AcceptDebugging` shows `DevToolsConnectionDialog` and does not read a saved allow-list. The Chrome DevTools team has said there is no "remember this decision" control, because a remembered allow would let any local program open the profile ([chrome-devtools-mcp#825](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825)).

The dialog, from `chrome/app/generated_resources.grd` at the same tag:

| Control | Text |
| --- | --- |
| Title | Allow remote debugging? |
| Body | An external app wants full control over this Chrome session to debug it. This includes access to your saved data, cookies and site data, and the ability to navigate to any URL. |
| Body | Only web developers should turn on this feature, and only use it with trusted apps. |
| OK button | Allow |
| Cancel | Cancel (this button is focused; the dialog sets no default button, so Enter does not Allow) |
| Extra | Turn off in settings (opens `chrome://inspect#remote-debugging` and denies the connection) |

The handshake stays open until one of those buttons is used. Cancel or closing the dialog denies the socket. A later connection asks again. Holding one browser WebSocket open does not ask again for targets attached on that same socket.

While at least one approved socket is open, Chrome shows the infobar **Chrome is being controlled by automated test software** (`IDS_CONTROLLED_BY_AUTOMATION`). The infobar is removed when the last socket closes. That is the same banner described in the December 2025 blog post.

## Where the endpoint is published

Not a fixed "always port 9222" contract.

`RemoteDebuggingServer::StartHttpServerInApprovalModeWithPort` binds `127.0.0.1` (then `::1` if IPv4 fails) through `TCPServerSocketFactoryWithPortFallback`. The port it tries first is the first line of `DevToolsActivePort` in the user-data directory, or **9222** (`kDefaultDevToolsPort`) when that file is missing. If that port is busy it binds an ephemeral port.

On bind, `DevToolsHttpHandler` writes the user-data file (on this Mac, `~/Library/Application Support/Google/Chrome/DevToolsActivePort`, which is the user-data directory, the parent of `Default/`). Two lines, no trailing secret beyond the path:

```
<port>
/devtools/browser/<uuid>
```

The uuid is there because `IsBrowserTargetDiscoverable()` defaults to false, so `browser_guid_` is `/devtools/browser/` plus a random v4 uuid. The file is rewritten when the server starts. The 155 handler writes it and does not delete it on the stop path that was read, so a leftover file is not proof the server is still up. Absence means this Chrome has not published an endpoint. On this machine the file is present. The unlocked runner read only that file and connected to its browser path. The path is not copied here. `lsof` shows pid 1497 listening on `127.0.0.1:9222`.

The inspect page's **Server running at:** line is the address Chrome itself is advertising.

## What a local process can connect to

Approval mode (`RemoteDebuggingServerMode::kWithApprovalOnly`) is WebSocket-only:

- `GET /json/version`, `/json/list`, `/json/new`, and the rest of `/json/*` return **404**.
- The discovery HTML page and bundled frontend resources also return 404.
- A WebSocket whose path starts with `/devtools/browser` is the browser target. The 155 handler comment is "If we require user approval, we do not require guid." The path in `DevToolsActivePort` works. A path of `/devtools/browser` with no uuid also matches `StartsWith`. Any other path, including `/devtools/page/<id>`, is rejected with 403 before the dialog.
- After Allow, that one socket is the browser-level CDP session. Further targets are attached with CDP (`Target.createTarget`, `Target.attachToTarget`) on that socket. They are not separate HTTP upgrades.
- The listen address is loopback. A client that sends an `Origin` header must be same-origin with that loopback address, or named in `--remote-allow-origins`. A local process that sends no `Origin` is not rejected by that check. The measured run sent no `Origin` and received the upgrade after Allow. A request that does send `Origin` was not tried.
- The socket does not complete until Allow is clicked. A client that times out in a couple of seconds will miss the approval.

`--browser-url=http://127.0.0.1:9222` is the wrong discovery path for this mode. Chrome's own auto-connect reads `DevToolsActivePort` and opens `ws://127.0.0.1:<port><path>` directly ([configuration guide](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)).

## How to turn it off

The checkbox was left **on**. Chrome is still listening on `127.0.0.1:9222`. No client is connected.

To turn it off: open `chrome://inspect/#remote-debugging` and clear **Allow remote debugging for this browser instance**. Chromium stops the server when that preference flips to false. The connection dialog's **Turn off in settings** button does the same navigation and denies the pending socket. Quitting Chrome also drops the socket. The checkbox preference itself survives a restart until it is cleared.

## Driver

The driver and session contract is [cdp-live.md](cdp-live.md). The numbers below are from this Mac.

## Extension and cdp-live

Extension numbers are the earlier extension proof in [bao.md](bao.md) and [extension.md](extension.md), not a new Mystery run. Books rows there were 11 Travel and 26 Historical Fiction, not Mystery. cdp-live numbers are the unlocked Mystery pair above.

| | Extension (earlier proof) | cdp-live (this spike) |
| --- | --- | --- |
| isTrusted | `true` for `Input.dispatchMouseEvent` / `Input.insertText` | `true` for the Mystery link and the next link, both runs. `navigator.webdriver` was false. The driver does not spoof `isTrusted`. |
| Mystery rows | Not this workflow. Prior books runs: 11 Travel, 26 Historical Fiction, 2/2 | 2/2 passed, 32 rows each. |
| Timing | Not recorded for Mystery | 1932 ms and 1678 ms. |
| Connect-to-Allow | No browser-socket approval. The debugger attaches per action and then detaches. | 20559 ms from the handshake to the Allow press finishing. The dialog was absent before the handshake. |
| Banner | Toolbar badge REC/RUN. Infobar may show while the debugger is attached. `navigator.webdriver` stayed false. | "Chrome is being controlled by automated test software" was visible while the socket was open and absent after it closed. |
| Visible UI | Per-origin allow page. Badge stays. | Checkbox was already on. One Allow press per connection, on the dialog this process opened. |
| File chooser | `DOM.setFileInputFiles` | This driver throws. The protocol can set a file input; the spike does not. |
| Downloads | Extension download capture | This driver does not arm downloads. |
| Cross-origin iframes | Debugger can address the tab it is attached to | Each run counted 9 child-frame navigations and did not follow them. The driver does not attach to other targets. |
| Shadow DOM | Open shadow is visible to the page script the extension already uses | Same page dump: open shadow is walked, closed shadow is not. |
| Background tab / focus | The action attaches the debugger on that tab | Input is sent to the driver's own target. The target is brought to the front first. |
| Other tabs | The extension is granted per origin, not the whole browser | The browser socket can list them. This driver does not call `Target.getTargets`. Each replay opens and closes only its own window. |
| Survives Chrome restart | The extension stays installed. A debugger session does not. | The Allow decision does not. The checkbox preference does, until it is cleared. Not restarted here. |
| Toggle off | The extension does not use this switch | Before the checkbox was pressed, the port file was absent and nothing listened on 9222. It is on now, and 9222 is listening. |

## Instacart, one add and one remove

A separate runner, `desktop/src/cdp-live/instacart-run.ts`, opens one new window on `www.instacart.com`. The books allowlist is unchanged. This run allows only `instacart.com` and `www.instacart.com`. Checkout, login, account, payment, and address paths are refused before navigation. Image CDNs are subresources, not top-frame navigations, so they are not in the allowlist.

The runner searches for bananas, adds one item, and removes that one item. It will not click checkout, place order, a trial, address, payment, delivery time, or a tip. A login wall, captcha, store picker, or any other dialog stops the run before a click. If the line quantity is greater than one, it presses decrease once and does not press Remove. The cart badge must return to the count from before the add.

Instacart's header cart says "View Cart. Items in cart: N" when the count is read from that phrase, and "Add $X to get $0 delivery fee N" once the cart has items. The count is that N, not the dollar amount. Add controls are "Add" or "Add 1 ct {name}" for a banana. At quantity 1 the line control is "Remove"; above that it is "Decrement" once. Open shadow roots are walked when the click target is marked. A closed shadow root is not.

Per-store summaries labeled "Distinct items in cart" are not the header cart and are not clicked. The runner searches first, then reads the single header cart on the results page before the add. A second summary does not get a click.

The live add did not happen. The home page exposed more than one per-store summary, so the first pass that understood those labels stopped at `cart-ambiguous` with 0 clicks. After the search was submitted, the results page showed an Add control and a header control whose first word was "view", and no control exposed a cart count. The runner stopped at `cart-count`. The only runner click was the search field. That click was trusted, and so was the button event from submitting the search. Add was not clicked. The before and after counts were never read, and the cart was not changed. `navigator.webdriver` was false. No dialog, captcha, or login wall appeared. One open shadow root was on the page. Connect-to-Allow on that attempt was 34624 ms. The automation banner was visible while the socket was open and absent after it closed.

The gap is that results-page cart control. Its accessible name does not include a count, so the add stays refused.

## Intent session

The session contract is [cdp-live.md](cdp-live.md).
