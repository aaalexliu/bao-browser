# Chrome extension driver

A workflow can run in the Chrome already on this machine. The page sees that profile's cookies and fingerprint. Playwright stays the default driver.

The extension is not in the Chrome Web Store. Load the unpacked build.

## Install on a Mac

1. `npm install`
2. `npm run build:desktop`
3. `npm run build:extension`

   This writes `extension/dist`. The private key is not in the repo. The unpacked id is `jcjcpblcjaakcmbgljdjkfgmmdfdbnfj`, from the public key in `extension/manifest.json`.

4. `./install-extension.sh`

   The script copies `extension/dist` to `~/.bao-browser/extension`. `BAO_EXTENSION_DIR` overrides that path. Load the staged directory. It stays put when you rebuild.

5. `npm run bao`

   `bao serve` installs the native host `com.bao.desktop` for the current user:

   - `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json`
   - `~/Library/Application Support/Chromium/NativeMessagingHosts/com.bao.desktop.json`

   Linux uses `~/.config/google-chrome/NativeMessagingHosts/` and the Chromium equivalent. The host is a small stdio bridge. It checks a token in a `0600` file under the Bao home and then forwards frames to the app. The extension never reads that token. Chrome's `allowed_origins` is this extension id, so a web page cannot open the pipe.

6. In Chrome, open `chrome://extensions`, turn on Developer mode, and Load unpacked `~/.bao-browser/extension`.
7. Open the site, click the Bao icon, choose Allow this site, then Record. Stop saves the workflow.
8. On the run form, Driver chooses Extension, Playwright, or CDP live. An old workflow with no driver stays on Playwright.

## Reload and the native host

After `./install-extension.sh`, click Reload on the Bao card at `chrome://extensions`. A page that already ran the content script needs its own reload.

`npm run bao` is `bao serve`. Each start rewrites the native-host manifest and `bao-native-host.sh`. The socket lives under `$BAO_HOME/extension-host` (the CLI default is `~/.local/share/bao`). The token file stays when it is already there. The open port drops because the socket is replaced.

Chrome reads `com.bao.desktop.json` when the browser starts. On macOS that file is `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json`. On Linux it is `~/.config/google-chrome/NativeMessagingHosts/com.bao.desktop.json`. `allowed_origins` is `chrome-extension://jcjcpblcjaakcmbgljdjkfgmmdfdbnfj/`. The same manifest is written for Chromium.

The wrapper path inside that file is `$BAO_HOME/extension-host/bao-native-host.sh`. While that path is unchanged, the next `connectNative` runs the new wrapper. A different `BAO_HOME` changes the path. Quit Chrome and open it again so Chrome picks up the new path.

The extension connects on install, on Chrome startup, and on the `bao-link` alarm about once a minute. Reload the extension to connect again immediately. Click the Bao icon. The popup says `linked to Bao` when the native port is open, and `Bao isn't running` when it is closed. A replay that needed the extension and found no port returns `extension is not connected`.

Branded Chrome ignores `--load-extension` (the command-line switch was removed). Load unpacked is how a person installs this build. The throwaway proof uses Chrome for Testing, which still accepts `--load-extension`.

## What it can touch

Nothing happens until Record or a run starts.

Record asks for that tab's origin and injects the same recorder the Playwright driver uses. Replay opens a page with two choices. Allow all sites is the default: it asks Chrome for `http://*/*` and `https://*/*`, and later runs do not ask again. Only this site asks for the workflow's origin. Either way, replay opens a new window and drives that tab. It does not type into the tab the person is already using. A secret is typed only on the origin the workflow opened.

The toolbar badge says REC or RUN while a session is active. A strip inside the page appears only for "needs you" (a confirm, a login, or a bot wall).

Steps, locators, the confirm gate, and the page classifier are the ones the Playwright driver already uses. Place Order, Buy, Pay, Submit order, and Reserve stay confirm steps. A bot wall pauses. Password values are dropped. A click, a key, and a file input attach `chrome.debugger` for that action. The click is `Input.dispatchMouseEvent`, typing is `Input.insertText` or `Input.dispatchKeyEvent`, and a file input is `DOM.setFileInputFiles`. The debugger detaches when the action finishes. A native `<select>` is set from the page and held on that option, so a control that resets when its data arrives stays where the workflow put it. The browser's select popup does not open. A click waits for an in-flight XHR on that tab to finish before it lands.

## What it does not touch

- No `<all_urls>` at install, and no install-time host permission. `optional_host_permissions` stays `http://*/*` and `https://*/*`. Allow all sites requests those from a click. Only this site requests one origin. Settings shows all sites, per site, or none, and Revoke calls `chrome.permissions.remove`.
- Allow all sites lets Bao read and act on any site in this Chrome profile, only while a run or a recording is active. Content scripts are registered for the page the run is on. An all-sites grant does not inject them on every site. Network listeners attach after the grant and still drop events for tabs the run does not own.
- Tabs the person did not pick are not read. Network and cookie listeners drop events for any other tab.
- `navigator` is not patched. The extension does not invent a user agent, client hints, or a TLS fingerprint.
- Captchas and challenge widgets are not solved and not clicked. The run pauses as needs you.
- Clicks and typing are real input events (`isTrusted: true`) from the debugger session above. The extension does not spoof `isTrusted` from the page. The toolbar badge stays visible. Chrome may show its debugging infobar while the debugger is attached.
- Nothing leaves the machine except the local Bao server.

## Select the driver

`driver` on a workflow is `playwright`, `extension`, or `cdp-live`. Any other string fails validation in `validateWorkflow` (`desktop/src/v1/schema.ts`). Omit `driver` and replay uses Playwright.

`playwright` launches installed Google Chrome when that binary is present, then `BAO_BROWSER`, then Playwright's Chromium. That order is `resolveNormalChrome` in `desktop/src/launch.ts`. `extension` uses this native-messaging extension. `cdp-live` attaches to Chrome that is already running, and the desktop refuses to launch its own browser for that workflow. The contract is [cdp-live.md](cdp-live.md).
