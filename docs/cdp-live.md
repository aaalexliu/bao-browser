# CDP live

`driver` set to `cdp-live` attaches to Chrome that is already running. The measured session is [cdp-live-chrome.md](cdp-live-chrome.md).

1. In that Chrome, open `chrome://inspect/#remote-debugging` and allow remote debugging for this browser.
2. From the repo root, run `npm run build:desktop`.
3. Replay uses the live attach. `refusesOwnedBrowser` in `desktop/src/cdp-live/launch-guard.ts` is true for `cdp-live`, so Bao's own Chrome stays closed.
4. `node desktop/dist/desktop/src/cdp-live/run.js` is the books runner. It reads `DevToolsActivePort`.
5. `node desktop/dist/desktop/src/cdp-live/session.js` is the generic session. Pass `--hosts`, `--start`, `--intent`, `--deny`, `--commit`, `--stop-path`, and `--reached`. Add `--attach-path` to use one already-open page.

## Driver

`cdp-live` attaches to the browser WebSocket published by `DevToolsActivePort` and to no other file in the Chrome profile. The desktop refuses to launch Bao's Chrome for a workflow whose driver is `cdp-live`. The string `cdp` stays invalid and still maps to Playwright if something calls `workflowDriver` without the live-attach check.

The driver:

- A new-window run opens one window with `Target.createTarget` `about:blank` and closes only that target.
- An attach run (`--attach-path`) calls `Target.getTargets` only to choose the one already-open page whose host and pathname match. It does not create a target, does not call `Page.navigate` on that tab, and detaches instead of closing it. Two different paths, or no allowlisted page, stop with `needs_human` and do not attach. When every open allowlisted page shares one unexpected path, the run attaches to the first of those, screenshots it, clicks nothing, and still stops with `needs_human`.
- Navigates only to `http` or `https` `books.toscrape.com`. `about:blank` is the empty opener, not a site. `javascript:`, `data:`, `file:`, `chrome:`, `chrome-extension:`, subdomains, and other hosts are refused before `Page.navigate`. A top-frame navigation off that host closes the driver's own target.
- Clicks with `Input.dispatchMouseEvent` (`mouseMoved`, `mousePressed`, `mouseReleased`). It does not call `element.click()` and does not patch `navigator`.
- Reads lists through the same page functions as the Playwright driver. Pagination uses the same trusted click.
- Returns `needs_human` when the page classifier reports a bot wall or a login wall (`holdForPerson` is off for this runner). It does not solve a captcha.
- Presses the Allow button only when `mayClickAllow` is true. This process opened the socket, the dialog was absent before the handshake, the dialog title is present, and exactly one `AXButton` is named "Allow". "Allow sites" does not count. A dialog that was already up is not clicked.

The p5 runner is `desktop/src/cdp-live/run.ts`. Click `isTrusted` is stored in `sessionStorage` so a navigation does not wipe it before the run is read. The runner stops before typing when the accessibility tree has no window.

## Session

`desktop/src/cdp-live/session.ts` is a generic live session. The caller passes the host list, the start URL, an intent string, a deny pattern, a commit pattern, a stop-path pattern, and a reached pattern. The program opens one new window with `Target.createTarget` and does not call `Target.createBrowserContext`, so the omitted context id is the default browser context. It reads visible controls and clicks only when a later command names an index that the guard still allows. Submit controls, radios, checkboxes, and buttons that match the commit pattern are refused. Links stay available unless the deny pattern matches them. A password field, a stop path, a captcha, or an upsell dialog ends the session with no further click. If the new window is a sign-in page, the session compares its browser context with an already-open allowlisted page. A different context is opened again in the default context. If that is still a sign-in page, the session closes only its own window and opens one new tab in the window that already shows the allowlisted page. It does not navigate, close, or click that existing tab. The published result says whether a separate browser context was created and whether the new page matched the already-open page. It does not include other tab titles, other tab URLs, or cookie values. The published path has no query string, and long numeric or uuid segments are replaced with `:id`. The command inbox and the workflow draft stay under `.evidence/` and are not part of this tree.
