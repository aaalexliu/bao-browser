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

One earlier `cg-key` of `cmd+t` was attempted while that tree was empty. The helper refused it (`app did not become frontmost; key was not posted`). No character was sent. The current toggle uses the pid-targeted path in [Agent entry point](#agent-entry-point), not keyboard events.

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

The later W10 agent run completed the real-cart add, replay, and restore. [eval/agent-instacart-real.md](eval/agent-instacart-real.md) records its setup, results, and limits.

## Intent session

The session contract is [cdp-live.md](cdp-live.md).

## Agent entry point

`bao mcp [--home dir]` is the one stdio MCP server for agents. It lists the four catalog tools (`search_workflows`, `describe_workflow`, `run_workflow`, `get_run`), then the eight live tools: `live_session_start`, `live_snapshot`, `live_click`, `live_type`, `live_key`, `live_scroll`, `live_screenshot`, and `live_stop`. The catalog tools run inside `bao mcp`. Each live call goes to the running Bao app's `POST /api/live`. `bao mcp` finds the app the same way as `bao open`: `server.json` in `--home`, then `BAO_HOME`, then the default libraries. `bao mcp-live` is an alias for `bao mcp`.

The `initialize` reply has `instructions` that give the agent the order: start a session, read with `live_snapshot`, act with `live_click`, `live_type`, `live_key`, or `live_scroll`, and end with `live_stop`, which saves the workflow. They also tell the agent to start on the site's home or store page, not a search results url, and to search through the site's own search box: `live_type` the query, then `live_key` Enter or a click on the search button. The workflow keeps only the steps the agent took, so a search it skipped with a results url is not a step. For a `stale_ref` or `unknown_ref` refusal they say to read again. For `element is covered`, which means a dialog or popup sits over the control, they say to read again and only click a control that closes or dismisses the covering popup (Close, X, No thanks, Not now, Dismiss), or press Escape with `live_key`, then retry the original click once. Never press Continue, Accept, Agree, Sign in, Subscribe, Place order, or any consent or purchase control to clear a popup. Bao's deny lists still apply. If no dismiss control exists or the retry is refused, end the session and tell the user. A successful retry of the same control clears its covered refusal from the session status; an unresolved covered refusal or any other refusal still fails the session. Any other refusal or halt ends the session. When no app answers, a live tool returns an error that names the start command. From the app's `bao-mcp` launcher that is `Bao is not running. Open the Bao app, or run: open /Applications/Bao.app`. From a checkout it is the `node ... cli.js serve --home <home>` command. The catalog tools still work then.

Claude Code and Codex use one entry, the `bao-mcp` launcher inside Bao.app. `bao agent config claude|codex` prints it, and `--write` adds it to the agent's config with Bao's tools pre-approved. The guards in this page still refuse a commit, credential, or submit click. [Agent quickstart](agent-quickstart.md#mcp) has both entries.

The live names are also CLI verbs, for example `bao live_session_start --intent text --url https://host/`, `bao live_key --key Enter --ref e3.c0`, `bao live_scroll --direction down`, and `bao live_snapshot --page 2`. They post to the same `POST /api/live`, so the app must be running. The host is `desktop/src/cdp-live/live-host.ts`. It takes `/tmp/bao-cdp-session.lock`, writes an audit row before each action, and refuses or halts on the same guards as the intent session. The live window fails a page load to another host or onto a stop path before the request leaves Chrome. After a blocked stop-path load, the window goes back to the last allowed page, and the refusal carries a fresh read of that page, so its refs work. A rejected, refused, or halted call is an MCP error. The CLI exits 1 when rejected and 2 when refused or halted.

`live_session_start` needs only `intent` and `url`. `workflowId` is optional. Settings selects the page engine for the next session or replay; see [agent-browser trial](agent-browser-engine.md) for the copied-profile route and its limits. With the current engine, the app picks Chrome with `bao serve --live-target <target>` or `BAO_LIVE_TARGET`, and the flag wins (`desktop/src/cdp-live/live-target.ts`):

| Target | Chrome | Port file | Allow dialog |
| --- | --- | --- | --- |
| `daily` (default) | The person's own Chrome, window in the `Default` profile | `~/Library/Application Support/Google/Chrome/DevToolsActivePort` | Yes. BaoOSHelper turns the checkbox on when it is off, and presses Allow. |
| `daily:<profile directory>` | The same Chrome, window in that profile, such as `Profile 2` | Same | Yes |
| `bao` | Bao's own Chrome | `<home>/chrome-profile/DevToolsActivePort` | No |
| `throwaway:<path>` | A Chrome started with `--remote-debugging-port` and its own `--user-data-dir`, such as a test browser | That absolute path | No |

When the daily Chrome is open but does not listen on its DevTools port, a session or replay start turns remote debugging on the way a person does (`desktop/src/cdp-live/remote-debugging.ts`). BaoOSHelper reuses the active tab when it already shows `chrome://inspect/#remote-debugging`; otherwise it opens a new tab in that Chrome with Apple Events addressed to its pid (`typeKernelProcessID`), not its bundle id or app name. It sets **Allow remote debugging for this browser instance** through Accessibility by pid, without raising or activating Chrome, then waits for Chrome to listen. It closes only a tab it opened, by its tab id, and leaves a reused tab open. Creating the tab can make Chrome bring itself forward. The helper records the frontmost app pid just before creating it, confirms the URL, and waits up to 10 seconds for the checkbox before handing focus back; if the checkbox does not appear, Bao reports an error. Closing the tab also hands focus back if Chrome came forward, using the app that was frontmost just before close. Chrome drops `chrome://` urls given on its command line, so the profile-window handoff below cannot open that page. `bao remote-debugging on|off [--home dir]` does the same on its own, and `off` clears the checkbox and waits for the port to close. A request whose port state already matches opens no tab and asks for no Automation grant. `--home` selects the audit-log home, not a different Chrome. It takes the CDP lock first, so it never cuts a session or replay. The daily Chrome is the one browser process of Google Chrome on the port file's folder; a headless Chrome or one on another `--user-data-dir` does not count. The Apple Event goes to that pid, so another `com.google.Chrome` process does not receive it. If debugging was already on, Bao leaves it on when the session ends. If Bao turned it on, Bao turns it off at the end. A locked screen, a missing Accessibility grant, or Chrome not running fails at once with that reason.

With the current engine, a caller can still pass `portFile`. A copied-profile session refuses this override. The configured target's own file keeps that target, profile included. The daily Chrome's file keeps the Allow press, and any other file is a throwaway target. For a target with no dialog, the host connects with no helper call, so neither the Accessibility grant nor the checkbox is read.

Every Bao takes the same live lock, `/tmp/bao-cdp-session.lock`, so two apps never drive one Chrome at once. `bao serve --live-lock <file>` gives the app its own lock, and serve refuses it unless the target is `throwaway:`, a Chrome no other Bao drives. That app then refuses a `portFile` for any other Chrome. A test uses it so it never waits on, or blocks, a Bao on the same Mac.

`Target.createTarget` opens a window in whichever profile Chrome used last, and CDP cannot pick another one. So for the daily Chrome the host runs the binary of the Chrome that owns the DevTools port with `--user-data-dir=<the port file's folder> --profile-directory=<profile> --new-window` and a `data:` marker page. Chrome hands that command line to the running browser and exits. The browser opens the window in that profile, and the session drives only the page that shows its own marker. A headless Chrome does not take the hand-off, so the live lane checks it on a headed test browser (`desktop/test/live/live-profile.test.ts`). Chrome quietly makes a new, empty profile for a name it does not know, so the host first refuses a profile with no folder in that user-data dir. The error names the profile and lists the `Default` and `Profile <n>` folders that do exist.

The start url's host picks the preset. `instacart.com` and `www.instacart.com` always use `instacart`, and `books.toscrape.com` always uses `books`, whatever `preset` says. Other hosts use the `preset` given, else `generic`.

The session saves its workflow in the library when it ends. It ends on `live_stop`, when the MCP client closes `bao mcp`'s stdin or stops it with SIGTERM or SIGINT, or after 10 minutes with no call. Two minutes before that idle save, the app warns the person. Bao.app posts the warning as a notification and sets the Dock badge, the same way it posts a step that needs you. The Bao window shows it above every screen with a **Keep open** button. Keep open (`POST /api/live/keep`) restarts the 10-minute wait, as a call does. A call also clears the warning. A person who is away gets the same save at 10 minutes. `bao mcp` sends a client id with each call, so a disconnect ends only the session that client started. The end closes the session's window and socket, then frees the CDP lock. Each replay selects its engine and live target anew and makes no model calls.

Each `live_click`, `live_type`, `live_key`, and `live_scroll` that goes through appends one line to `<home>/live-session/trail.jsonl`, which a new session empties. The line names the control by the full identity `CdpLiveDriver.tree()` gives it: role, name, test id, css path, and xpath. It also has the url before and after, and for a click, the page text the click changed. A refused or halted call writes no line. When the session ends, `condense()` and `interpret()` build the workflow from the trail, as `bao eval drivers` does (`desktop/src/cdp-live/live-trail.ts`). A click with no effect is dropped. Typed text becomes an input, except text typed into a search box: the workflow types that text again and has no input for it, because a recorded workflow replays the cart action it saw. That step's label names the field, as `Type into "Search Costco"`, not the text. The trail drops prices from a control's name, text, label, and title, unless a price is all one of them shows. It keeps them when another node on the page reads the same once its prices drop, so `Donate $10` and `Donate $25` stay apart. Replay matches a `role` or `text` locator against a control's text with its prices dropped too, after a match as shown. So the product link's step label and locators carry no price, and its `href` locator stays. The price-free name still finds the link after its price changes, while the link's text fits the 80-character cut `dumpPage` applies to a node's text and name. On a long name, a price with more or fewer digits moves that cut, and replay then falls back to the `href` and position locators. When a click on `Add 1 ct {item}` brings up a control that names the item, such as `Increment quantity of {item}`, the step gets `when: { absent }` with that name, so `replay()` on a `CdpLiveDriver` skips the Add while the item is in the cart. A plain `Add to cart` on a product page, which has one `h1`, gets `when: { absent: "1 in cart", anyCount: true }` when the add makes the page show `1 in cart`, so the Add is skipped at any count. `desktop/test/unit/live-recording.test.ts` proves both paths. A click on a Buy, Pay, or Reserve button becomes a confirm step that a person does on replay. The saved file has `driver: "cdp-live"`, no cookie or storage field, and no step label that matches the preset's deny or confirm labels. A trail that would break that rule fails the save. A session with no step saves nothing.

One runner replays a `cdp-live` workflow: `replayLiveWorkflow` in `desktop/src/cdp-live/live-replay.ts`. The app replay (`POST /api/replay`), `bao mcp`'s `run_workflow`, and the relay all call it. `run_workflow` posts the workflow to the running app's `/api/live` as `live_replay`, so the replay drives the Chrome the live tools drive. Without the app it fails with `Bao is not running. Open the Bao app, or run: <start command>`.

- It takes the CDP lock, opens its own connection and its own window in the selected live target, and runs `replay()` with no heal provider, so `modelCalls` is 0. A replay while a session is open is refused.
- A recorded workflow runs with no approval step. It types the search text the session typed. Inputs, when a workflow has any, start from the recorded defaults.
- A step with `when: { absent }` is skipped while the page shows that text, at any count with `anyCount`, so the Add does not run when the item is already in the cart.
- Every click, typed field, and key goes through the same guard code as the live tools (`desktop/src/cdp-live/live-act.ts`). The hosts, deny and confirm labels, and stop paths come from the preset of the workflow's start url. A control that moved, or one the live view does not list, is refused. A typed step replaces the field's text, and a credential field or secret-looking text is refused.
- A refusal fails the step. A workflow edited to click Checkout fails with `denied`, and one edited to open `/checkout` fails with `blocked-path`, before any load. A sign-in page, a bot check, a stop path, or a new window pauses the run with `needs_human`. A confirm step a person does on replay also pauses it.
- The replay closes its window and socket and frees the lock when it ends.

Copied-profile capture and replay also retain Library run evidence as described in [Evidence](agent-browser-engine.md#evidence), including recording status, video limits, and unavailable-evidence reasons.

With `BAO_RUN_VIDEO=1`, the current engine records each live window through the CDP connection that drives it (`desktop/src/cdp-live/screencast.ts`). `Page.startScreencast` sends a JPEG each time the page paints; Bao keeps the newest frame in each 0.1-second slot. When the window ends, Bao closes the socket, restores remote debugging if it turned it on, and frees the CDP lock before ffmpeg joins the frames, each shown until the next one came, into `<home>/videos/live-<session>-<time>.webm` for a session and `<home>/videos/<runId>.webm` for a replay, which the run page plays. The app serves replay videos at `/api/runs/<id>/video`. Frames painted under an audit screenshot's blur veil are left out. With no ffmpeg, or no frame, no file is written. See [What stays on this Mac](permissions.md#what-stays-on-this-mac) for video privacy and grants.

`desktop/test/unit/live-replay.test.ts` records the blueberries task on the fixture through the app, then replays it through `/api/replay` and `run_workflow`, skips the Add when the item is in the cart, and refuses checkout.

`desktop/test/unit/instacart-acceptance.test.ts` is the acceptance lane L1. A scripted MCP client records the task through `bao mcp` and a spawned `bao serve`, tries the checkout and login traps, disconnects without `live_stop`, and replays the saved workflow through `run_workflow` four times: twice on an empty cart, then once each on a cart that already holds the item at qty 1 and at qty 2. Those last two skip the Add as `already done` and write nothing. `desktop/test/README.md` says how to run it and what it checks.

`npm run bao -- eval agent-instacart` is lane L2. Claude Code or Codex gets only the prompt `put costco kirkland organic blueberries into the cart at instacart` and drives the same setup through `bao mcp`, locked to bao's tools. It spends model tokens and writes `docs/eval/agent-instacart.md`.

The live tools, as `desktop/src/cdp-live/live-ops.ts` defines them:

- `live_snapshot` lists controls in page order, 50 to a page. Each reply has `page`, `pages`, and `controlsTotal`. `live_snapshot` with `page` returns that page of the last read without reading the page again, so every ref from that read still works. Every other reply shows page 1. An action that goes through reads the page again; a refused one shows the read it was planned on. A field's `<label>` text counts when bao looks for credential fields.
- `live_key` presses `Enter`, `Tab`, or `Escape` and refuses any other key. With a `ref`, the host marks that control again, focuses it, and refuses it on the same rules as `live_click`: confirm and denied labels, credential fields, stale refs, the host list, and stop paths. `Enter` needs a `ref`. `Enter` in a field is refused when the field's label is a confirm or denied label, or when its form would submit through a button `live_click` would refuse. A field with no submit button to judge takes `Enter` only when it is a search box, so a search box with no visible button can be submitted. Without a `ref`, `Tab` and `Escape` go to whatever has focus. Focus in a credential field halts the session. The saved workflow keeps each key press as a `key` step, and replay presses it on the same rules.
- `live_scroll` moves most of a screen `down`, `up`, `right`, or `left`. With a `ref`, the nearest scrolling box around that control moves, or the page when there is none. Without one the page moves, or, when the page cannot, the largest scrolling box on screen. The reply is a new read plus `scroll: { target, moved }`. `moved: false` means that edge was already reached.

A control is a confirm button, listed under `stopBeforeConfirm` and never clicked, when its label matches the preset's confirm labels or, under every preset, checkout, place order, pay now, buy now, confirm purchase, submit order, or complete purchase. A form's submit button is a confirm button too, unless the form is a search form or the preset allows its label: `instacart` allows Add, Add to cart, Add item, `Add N ct ...`, Search, the quantity steppers, and Remove but not Remove all; `books` allows Add to basket and Search; `generic` allows none. A `type=submit` button with no form submits nothing, so it is judged as a plain button. Deny labels are checked first, so under `instacart` Checkout and Place order are `denied`.
