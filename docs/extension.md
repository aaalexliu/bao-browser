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

Record asks for that tab's origin and injects the same recorder the Playwright driver uses. Replay asks for the workflow's origin, then opens a new window and drives that tab. It does not type into the tab the person is already using.

The toolbar badge says REC or RUN while a session is active. A strip inside the page appears only for "needs you" (a confirm, a login, or a bot wall).

Steps, locators, the confirm gate, and the page classifier are the ones the Playwright driver already uses. Place Order, Buy, Pay, Submit order, and Reserve stay confirm steps. A bot wall pauses. Password values are dropped. A file input is the one place that attaches `chrome.debugger`, only long enough to call `DOM.setFileInputFiles`, then detaches.

## What it does not touch

- No `<all_urls>` at install. Host access is an optional permission, granted per origin from the popup or when a run starts.
- Tabs the person did not pick are not read. Network and cookie listeners drop events for any other tab.
- `navigator` is not patched. The extension does not invent a user agent, client hints, or a TLS fingerprint.
- Captchas and challenge widgets are not solved and not clicked. The run pauses as needs you.
- Ordinary clicks and typing go through the content script, so the page sees `isTrusted: false`. Attaching the debugger to make those events trusted would show Chrome's debugging bar, so replay does not do that.
- Nothing leaves the machine except the local Bao server.

## Select the driver

`driver` on a workflow is `extension` or `playwright`. Anything else fails validation. Omit it and replay uses Playwright, which is Bao's own Chrome.
