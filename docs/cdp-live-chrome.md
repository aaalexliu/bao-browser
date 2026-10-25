# Live Chrome over CDP (spike notes)

Observed on alex-m1, 2026-10-25. Google Chrome **155.0.8059.86**, arm64, already running as a normal window. This path is Chrome's own local remote-debugging switch (`chrome://inspect/#remote-debugging`, Chrome 144+). It is separate from the extension driver in [extension.md](extension.md).

The checkbox is off on this machine, so the WebSocket was not opened. What follows is the Chrome 155.0.8059.86 source plus the official Chrome docs, checked against this process only as far as the endpoint's absence.

## What this machine showed

- The running browser is `/Applications/Google Chrome.app`, bundle version 155.0.8059.86, architecture arm64. The main process was started without `--remote-debugging-port`.
- `~/Library/Application Support/Google/Chrome/DevToolsActivePort` is **absent**. Existence was tested with `test -f`. The file was not read, because it is not there, and nothing else under that directory was listed or read.
- Nothing is listening on TCP 9222.
- A local process therefore has no debugging WebSocket to connect to until the checkbox below is turned on.

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

The uuid is there because `IsBrowserTargetDiscoverable()` defaults to false, so `browser_guid_` is `/devtools/browser/` plus a random v4 uuid. The file is rewritten when the server starts. The 155 handler writes it and does not delete it on the stop path that was read, so a leftover file is not proof the server is still up. Absence, as on this machine, means this Chrome has not published an endpoint.

The inspect page's **Server running at:** line is the address Chrome itself is advertising.

## What a local process can connect to

Approval mode (`RemoteDebuggingServerMode::kWithApprovalOnly`) is WebSocket-only:

- `GET /json/version`, `/json/list`, `/json/new`, and the rest of `/json/*` return **404**.
- The discovery HTML page and bundled frontend resources also return 404.
- A WebSocket whose path starts with `/devtools/browser` is the browser target. The 155 handler comment is "If we require user approval, we do not require guid." The path in `DevToolsActivePort` works. A path of `/devtools/browser` with no uuid also matches `StartsWith`. Any other path, including `/devtools/page/<id>`, is rejected with 403 before the dialog.
- After Allow, that one socket is the browser-level CDP session. Further targets are attached with CDP (`Target.createTarget`, `Target.attachToTarget`) on that socket. They are not separate HTTP upgrades.
- The listen address is loopback. A client that sends an `Origin` header must be same-origin with that loopback address, or named in `--remote-allow-origins`. A local process that sends no `Origin` is not rejected by that check. This was not exercised here, because the server is not running.
- The socket does not complete until Allow is clicked. A client that times out in a couple of seconds will miss the approval.

`--browser-url=http://127.0.0.1:9222` is the wrong discovery path for this mode. Chrome's own auto-connect reads `DevToolsActivePort` and opens `ws://127.0.0.1:<port><path>` directly ([configuration guide](https://developer.chrome.com/docs/devtools/agents/get-started/configuration)).

## How to turn it off

Leave the checkbox however it was found. On this machine it is off.

To turn it off later: open `chrome://inspect/#remote-debugging` and clear **Allow remote debugging for this browser instance**. Chromium stops the server when that preference flips to false. The connection dialog's **Turn off in settings** button does the same navigation and denies the pending socket. Quitting Chrome also drops the socket. The checkbox preference itself survives a restart until it is cleared.

## Not done yet

The p5 books.toscrape.com replay, the `cdp-live` driver, and the extension comparison are waiting on the checkbox. No WebSocket was opened, no tab was created, and no page was driven.
