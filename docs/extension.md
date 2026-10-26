# Chrome extension driver

A workflow can run in the Chrome already on this machine. The page sees that profile's cookies and fingerprint. Bao's own Chromium stays the default.

The extension is not in the Chrome Web Store. Load the unpacked build.

## Install on a Mac

1. `npm install`
2. `npm run build:extension`

   This writes `extension/dist`. The private key is not in the repo. The unpacked id is `jcjcpblcjaakcmbgljdjkfgmmdfdbnfj`, from the public key in `extension/manifest.json`.

3. `npm run bao`

   `bao serve` installs the native host `com.bao.desktop` for the current user:

   - `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.bao.desktop.json`
   - `~/Library/Application Support/Chromium/NativeMessagingHosts/com.bao.desktop.json`

   Linux uses `~/.config/google-chrome/NativeMessagingHosts/` and the Chromium equivalent. The host is a small stdio bridge. It checks a token in a `0600` file under the Bao home and then forwards frames to the app. The extension never reads that token. Chrome's `allowed_origins` is this extension id, so a web page cannot open the pipe.

4. In Chrome, open `chrome://extensions`, turn on Developer mode, and Load unpacked `extension/dist`.
5. Open the site, click the Bao icon, choose Allow this site, then Record. Stop saves the workflow.
6. On the run form, Driver chooses Extension or Playwright. An old workflow with no driver stays on Playwright.

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

`driver` on a workflow is `extension` or `playwright`. Anything else fails validation. Omit it and replay uses Playwright, which is Bao's own Chrome.
