# Login handoff research

Research for [ALE-240](https://linear.app/aaalexliu/issue/ALE-240). Written 2026-11-25. Nothing here is built or decided.

**The question.** A Bao agent is working in Alex's real Chrome on his Mac and hits a sign-in wall. Alex is away, with only his phone. How can he finish that sign-in so the session ends up in the Chrome on the Mac?

**The short answer.**

1. Many walls need no handoff. Chrome already holds a saved password or a live Google session, and a real click from Bao is enough to use it. Chrome's own agent works this way.
2. For the rest, the common pattern in the market is a live view of the page that the person takes over. Every vendor that documents the stream uses pixels. Typing through a pixel stream is the slow part, so Bao should type through a native phone field and use pictures only to show the page.
3. The safest pattern in the market is a vault fill: the person approves, the password manager types into the page, and the model never sees the secret. 1Password documents this for personal agents on a support page dated 2026-11-04. It is partner-only today.
4. Nobody has solved passkeys from afar. The Bluetooth check in the QR flow and the Touch ID check on the Mac are there to stop exactly this. The only routes are a passkey that Bao itself holds, or falling back to a password and a code.
5. A proxy and a cookie move both fail on the sites that matter, and both are the shape of a phishing kit. Do not build them.

**How to read the sources.** Each link carries the date printed on its page.

- **read 2026-11-25**: the page shows no date, and I read it live that day.
- **old**: the source is dated before 2026 and no 2026 page confirms it. Treat that claim as not confirmed for 2026.
- **could not verify**: I found no source.
- **My reading**: my own reasoning from the specs, not a claim a source makes.

Every quote is word for word from the linked page. Nothing in this doc was tested on a real account.

## Contents

- [Rules for this research](#rules-for-this-research)
- [Primer](#primer)
- [What Bao does today](#what-bao-does-today)
- [Methods](#methods)
- [Matrix: login types against methods](#matrix-login-types-against-methods)
- [Best route for each login type](#best-route-for-each-login-type)
- [What Alex already knew, checked](#what-alex-already-knew-checked)
- [Products and repos](#products-and-repos)
- [Threat model](#threat-model)
- [Recommendation](#recommendation)
- [Tests to run before building](#tests-to-run-before-building)

## Rules for this research

- **The session must land in Bao's Chrome on the Mac.** A sign-in that ends on the phone is useless.
- **The cookie line.** [VISION.md](../VISION.md) says "optional remote access does not give Bao's server direct access to Chrome's cookies". Each method below says whether it crosses that line. Two cross it: a proxy hosted on a Bao server (method 12) and a cookie move (method 13). Three come close, because a relay could read passwords as typed: field relay, pixel view and DOM mirror (methods 4 to 7). Two would put something worse than cookies on a server if built carelessly: a vault token (method 9) and synced passkeys (method 10).
- **Transport is open.** [ALE-7](https://linear.app/aaalexliu/issue/ALE-7) has not picked how a phone reaches the Mac: Bao's outbound relay, or Tailscale. This doc treats that as an input. Where a method needs more from the transport, it says so.
- **Live runs only.** Alex is present on his phone while the agent works. Replay with stored secrets is out of scope ([ALE-224](https://linear.app/aaalexliu/issue/ALE-224)).

## Primer

### Sessions and cookies

When you sign in, the site hands your browser a **session cookie**: a long random string. From then on the browser sends that string with every request, and the site treats whoever sends it as you. The password, the code and the passkey are only used once, to earn the cookie.

Two things follow. First, the goal of any handoff is to get the site to hand its cookie to **Chrome on the Mac**. Second, a plain cookie works from any machine that holds it, which is why thieves steal cookies and why sites now fight copies.

### Passwords and password managers

A password manager stores your passwords and types them for you. It also does one quiet safety job: it only offers a password on the web address it was saved for. A look-alike site gets nothing. When you type a password by hand, that check is gone.

Where the manager lives matters here:

- **Chrome's own manager** (Google Password Manager) lives inside the Chrome that Bao drives.
- **1Password and Bitwarden** run as a Chrome extension on the Mac, and as apps on the phone. The Mac extension must be unlocked to fill.
- **iCloud Keychain** (Apple Passwords) lives in the Mac and the phone. In Chrome it needs Apple's [iCloud Passwords extension](https://chromewebstore.google.com/detail/icloud-passwords/pejdijmoenmkgeppbflobdenhhabjlaj) (updated 2026-09-29).

### Second steps: codes and approvals

- **SMS or email code.** The site sends six digits to your phone or inbox. You type them into the page.
- **Authenticator code (TOTP).** An app on your phone, or your password manager, shows six digits that change every 30 seconds.
- **Magic link.** The site emails a link. Opening it signs in the browser that opens it, or on some sites the browser that asked for it.
- **Push approval.** The site pings its app on your phone. You tap Approve, and the waiting page on the Mac goes through. The session lands on the Mac with no typing. Many now show a number on the page that you must type into the phone app. Microsoft says "Number matching is enabled for all Authenticator push notifications" ([Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity/authentication/how-to-mfa-number-match), updated 2026-10-21).

All of these are short strings or taps. A string can be relayed. That is why a fake site can relay them too, and why they are called phishable.

### Passkeys

A passkey replaces the password with a key pair. The site keeps the public half. The private half stays inside an **authenticator**: your Mac's secure chip, your phone, a password manager, or a USB key. To sign in, the site sends a random challenge, the authenticator signs it, and the site checks the signature.

Three properties make passkeys hard to hand off:

1. **Bound to the site.** The browser tells the authenticator which site is asking, and the signature covers that address. A page on another address gets a signature the real site rejects.
2. **Needs you, here.** The authenticator asks for Touch ID, Face ID, a PIN or a touch before it signs. On a Mac, Chrome shows "macOS's system user verification dialog", which uses "Apple Watch, Touch ID or a system password" ([Chrome blog](https://developer.chrome.com/blog/passkeys-on-icloud-keychain), read 2026-11-25).
3. **The private key does not leave.** Synced passkeys (iCloud Keychain, Google Password Manager, 1Password) copy the key between your own devices, but no page or script can read it.

**The QR flow.** Chrome on the Mac shows a QR code. Your phone scans it and signs with its passkey. The data goes over the internet through a tunnel server. But the phone must also send a Bluetooth beacon that the Mac hears. The spec gives the reason: "Without a proof of proximity a web site could, for example, display a QR code and attempt to convince the user to scan it" ([CTAP 2.3, section 11.5](https://fidoalliance.org/specs/fido-v2.3-ps-20260226/fido-client-to-authenticator-protocol-v2.3-ps-20260226.html), 2026-02-26). A phone that was linked earlier skips the QR code but still must be heard: the phone will "start advertising over BLE as a proximity challenge" (same spec, section 11.5.2). The next draft of this protocol keeps the rule: "Bluetooth Low Energy (BLE) advertisements are used for proof of proximity" ([Proximity Exchange Protocol draft](https://fidoalliance.org/specs/hybrid/proximity-exchange-protocol-v1.0-wd-20260717.html), 2026-07-17).

### "Sign in with Google" and work sign-in (SSO, OAuth)

The site sends you to an identity provider (Google, Apple, Okta, Microsoft). You sign in there, or you are already signed in there, and the provider sends you back with proof. If Chrome on the Mac already has a live Google session, this is one click on an account picker. If not, it becomes a Google sign-in with all the steps above.

### Device-bound sessions (DBSC)

DBSC is Chrome's answer to cookie theft. At sign-in, Chrome makes a key pair in the Mac's secure chip and gives the site the public half. The site then issues cookies that last only minutes. To get the next one, Chrome must sign a challenge with the private half.

- Keys are "hardware-backed ... the Trusted Platform Module (TPM) on Windows and the Secure Enclave on macOS", and "cannot be exported from the machine" ([Google](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/), 2026-04-09).
- "Any exfiltrated cookies quickly expire and become useless" (same post).
- Windows got it in Chrome 146. On the Mac it "shipped in Chrome 147, but it's arriving gradually" ([Scott Helme](https://scotthelme.co.uk/device-bound-session-credentials-lands-in-chrome-on-macos/), 2026-08-11). A later report says Chrome 148 for macOS ([TechRepublic](https://www.techrepublic.com/article/news-vercel-dbsc-session-cookie-theft-protection/), 2026-11-06).
- Sites must opt in. Google went first: DBSC is "enabled by default for Google Workspace users" in Chrome on Windows ([Google Workspace](https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html), 2026-05-28). Vercel added it in November 2026 (same TechRepublic report). Okta took part in the trials (Google post above).

What this means for Bao: a bound session must be **born in Chrome on the Mac**. A session born on the phone or in a proxy cannot be moved there. Bao's docs already record the cost of trying: "a copied Google sign-in used in another browser signs him out everywhere" ([agent-browser-engine.md](agent-browser-engine.md#sites-that-stay-in-running-chrome)).

### Captchas and bot checks

Sites score the browser and the person: the network address, the browser's fingerprint, how the pointer moves. A real Chrome on a home Mac with years of history scores well. A cloud browser scores badly. This is the reason Bao exists ([bao.md](bao.md)). It also means the check is tied to that browser. Passing it somewhere else does not carry over.

## What Bao does today

At the Mac, this already works ([agent-browser-engine.md](agent-browser-engine.md#wait-for-owner-input-in-the-same-session), [ALE-100](https://linear.app/aaalexliu/issue/ALE-100)):

- Bao spots a wall from the tab's address, title, or an in-page dialog, and halts the run with **needs you**.
- The tab shows a pill such as "Sign in to nytimes.com, then click Done". Alex signs in by hand in that tab.
- While Alex holds the tab, Bao reads only the tab's address and title. It takes no snapshot and no screenshot, and the tab video pauses. The model sees nothing he types.
- The agent calls `wait_for_owner` until the page moves on.
- Push approvals already work from afar, because the phone app and the Mac page talk to the site, not to each other.

What is missing is everything between "needs you" and Alex's phone: telling him, showing him the page, and carrying his input back.

## Methods

Fifteen methods, grouped by where the sign-in happens. The first group is the only one that keeps device-bound sessions, the bot score and the password manager's address check intact.

### Group 1: the sign-in happens in Chrome on the Mac

#### 1. Self-serve: use what Chrome already has

The agent finishes the sign-in with no human, using state Chrome already holds.

- **Saved passwords.** Chrome fills a saved password when the field gets a real click. Bao's clicks over CDP count as real. One open-source agent relies on this: "Chrome's PasswordAutofillAgent fills saved credentials only on a trusted interaction (synthetic DOM events are ignored), so the click must come over Input.dispatchMouseEvent" ([hermes-agent commit](https://github.com/NousResearch/hermes-agent/commit/6ec4f029fd90d998bb31c23ada00da19802870f3), 2026-11-07). Not tested on Bao.
- **Live identity sessions.** "Sign in with Google" is one click when Google is already signed in.
- **Unlocked extensions.** An unlocked 1Password or Bitwarden extension offers its fill in the page.

Google's own agent does this with consent: "Gemini in Chrome asks for your permission before it gets help from Google Password Manager to sign in to sites for you. Google Password Manager does not share your passwords with Gemini in Chrome" ([Chrome help](https://support.google.com/chrome/answer/16821166?hl=en), read 2026-11-25).

- Needs: a rule for when the agent may do this. Nothing on the phone.
- Breaks: Chrome set to ask for Touch ID before filling; a locked extension; any second step.
- Risk: the agent signs in with no human in the loop. A page that tricks the agent can point it at a sign-in. The password manager's address check still holds, because Chrome only fills on the saved address.
- Cookie line: not crossed.

#### 2. Notify and approve out of band

Bao pings Alex's phone: which site, what the page asks, and a still picture. For a push approval that is all he needs. For number matching, the notice shows the number.

- Needs: a way to push to the phone. A push needs a server in the path, or the agent's own chat app.
- Breaks: nothing by itself; it carries no input back.
- Risk: a fake notice. See the [threat model](#threat-model).
- Cookie line: not crossed, if the push holds only a wake-up and the picture travels encrypted to the paired phone.

#### 3. Chat relay

The agent asks in its own chat ("send me the code"), Alex types it there, and the agent types it into the page.

- Needs: nothing new. It works today.
- Breaks: anything that is not a short string.
- Risk: the secret passes through the model and stays in the transcript. [VISION.md](../VISION.md) allows it ("The chosen agent can receive requested page text and screenshots, including credentials"). OpenAI tells users the opposite for its own agent: "Avoid typing passwords or private info directly in messages" ([ChatGPT agent help](https://help.openai.com/en/articles/11752874-chatgpt-agent), read 2026-11-25). Fine for a number that is not a secret, such as a push match number. Poor for a 30-second code. Wrong for a password.
- Cookie line: not crossed.

#### 4. Field relay: a native form on the phone

Bao reads the sign-in form on the Mac (which fields, which labels), sends that list to the phone, and the phone shows a plain native form: site name, a password box, a code box. Alex fills it. Bao types the values into Chrome over CDP. The values never pass through the model.

- Why it feels good: typing is local, so there is no lag. The phone's own helpers work. iOS offers an SMS code "for up to three minutes after it has been received" in a one-time-code field, and "the key icon gives users access to all the credentials saved on the device" ([Apple](https://developer.apple.com/documentation/security/about-the-password-autofill-workflow), read 2026-11-25). So Alex can pull a password from iCloud Keychain or 1Password on the phone with two taps.
- Needs: a phone surface (an app, or a web page served by the Mac), and a sure way to read forms.
- Breaks: anything that is not typing or a simple choice. Captchas, passkeys, odd page flows. Multi-page sign-ins need one round per page.
- Risk: the phone's password helper cannot match the site, because the form belongs to Bao, not to the site. iOS only suggests passwords for an app's own "associated domains" (same Apple page). Alex picks the entry by hand, so Bao must show the true address, read from Chrome and not from the page or the model.
- Cookie line: not crossed. The transport carries the password, so it needs end-to-end encryption between phone and Mac.

#### 5. Pixel view over CDP screencast

Chrome sends pictures of the tab (`Page.startScreencast`, JPEG or PNG frames); the phone shows them and sends taps and keys back (`Input.dispatch*`). The command is marked experimental in the [protocol definition](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Page.pdl) (read 2026-11-25).

- Feel: works on any page. Frames are whole pictures, so it costs bandwidth and lags on a weak link. Typing through it is the worst part.
- A cheaper cut: **still pictures**. Send one picture after each action; Alex taps; Bao clicks there and sends the next picture. A sign-in is a handful of steps, so a second per step is fine. Bao already takes a CDP screenshot after each command.
- Needs: a phone surface. No Mac permission.
- Breaks: anything Chrome draws outside the page. My reading: the screencast shows the page only, so the passkey chooser, the Touch ID sheet, permission bubbles and native menus are missing. Sign-in pop-up windows are separate tabs that Bao must follow.
- Risk: the stream shows everything on the page, and carries his keystrokes. Whoever holds the link holds the session. Steel warns: "Anyone who has the `debugUrl` can watch the session, and can control it" ([Steel](https://steel.dev/docs/observability/live-view), reviewed 2026-11-12).
- Cookie line: not crossed, but close. A relay that can read the stream sees passwords as typed. Needs end-to-end encryption.

#### 6. Pixel view over WebRTC video

The same idea, sent as real video (H.264) over WebRTC, which copes with weak links and drops delay. This is where vendors have moved: Steel's default "streams its screen as video over WebRTC, at 20 frames per second in H.264", and calls the screenshot stream "an older view" ([Steel](https://steel.dev/docs/observability/live-view), reviewed 2026-11-12).

- Feel: the best a pixel view gets. Still a tiny desktop page on a phone, and still slow typing unless paired with a native field.
- Needs: a video source on the Mac. Capturing the window through macOS needs Screen Recording, which [VISION.md](../VISION.md) rules out as a default ("Chrome screenshots and video come from Chrome, not macOS screen capture"). Encoding the screencast frames avoids that.
- Breaks and risk: as method 5.
- Cookie line: as method 5. WebRTC can run phone to Mac directly, with the server only introducing them.

#### 7. DOM mirror (rrweb style)

Bao sends the page's structure instead of pictures. The phone rebuilds a copy of the page, and each change follows as a small update. Input on the copy is replayed on the real page.

- Feel: sharp text, little data, quick. [Upscope](https://upscope.com/what-is-cobrowsing) (read 2026-11-25) sells this for support: it "replicates web page code directly" rather than a video.
- Breaks: the hard parts of sign-in pages. rrweb's defaults are `recordCanvas: false` and `recordCrossOriginIframes: false`, and cross-origin frames need rrweb "injected in each child iframe" ([rrweb guide](https://github.com/rrweb-io/rrweb/blob/main/guide.md), read 2026-11-25). Captcha widgets and many identity-provider frames are exactly that. The copy is a desktop layout on a phone.
- Risk: the copy holds more than pixels: hidden fields and tokens in the markup. It is also the newest phishing kit design. See the [threat model](#threat-model).
- Cookie line: not crossed, but close, as method 5.

#### 8. Remote desktop of the whole Mac

Alex opens the Mac's screen from his phone with a tool he already trusts: Chrome Remote Desktop, Screen Sharing over Tailscale, Jump Desktop.

- Feel: he sees everything, including macOS dialogs. Tiny targets on a phone. Jump Desktop adds "Type Your Clipboard" for places "where pasting doesn't work, like a sign-in screen" ([Jump Desktop](https://jumpdesktop.com/remote-desktop-iphone-ipad.html), read 2026-11-25).
- Needs: nothing from Bao except the notice. Chrome Remote Desktop has an iPhone path: "all remote desktop sessions are fully encrypted" ([Google](https://support.google.com/chrome/answer/1649523?co=GENIE.Platform%3DiOS&hl=en), read 2026-11-25).
- Breaks: Touch ID. Whether a Mac passkey prompt accepts the Mac password typed over remote desktop: could not verify.
- Risk: full control of the Mac, far beyond one tab.
- Cookie line: not crossed. No Bao server is involved.

#### 9. Vault fill with human approval

A password manager fills the page after Alex approves, and hides the value from the agent.

- **1Password for Agents** ([support page](https://support.1password.com/1password-for-agents/), 2026-11-04): "1Password shows you a prompt that names the requesting app and suggested logins ... the 1Password browser extension in your agent's browser fills your username, password, and one-time password directly into the website's sign-in form outside the agent's view, then submits the form." Limits from the same page: "Passkeys, Login items that rely on sign-in providers, other item types, and shared vaults aren't yet supported"; personal and family accounts only; the app must be "installed on the same computer or mobile device as your agent app"; and an approval lasts: "the agent may continue to use 1Password to sign in to the website with it for up to 30 days".
- It fills "only on matching pages" ([security page](https://support.1password.com/1password-for-agents-security/), 2026-11-03), so the address check survives.
- It is for partners: "Don't see your agent? Join the waitlist" (same [support page](https://support.1password.com/1password-for-agents/)). Whether Bao could join, and whether the approval can show on a phone while the browser is on the Mac: could not verify. The Browserbase guide says to approve "on the computer running the 1Password desktop app" ([Browserbase docs](https://docs.browserbase.com/integrations/1password/agentic-autofill), read 2026-11-25). An older press release promised "approval prompts via 1Password mobile or desktop" ([1Password](https://1password.com/press/2025/oct/browserbase-ai-security-partnership), 2025-10-08, old).
- **Bitwarden** is behind. Its MCP server lets an agent "Retrieve passwords and TOTP codes", which hands the secret to the model ([Bitwarden](https://bitwarden.com/blog/bitwarden-mcp-server/), read 2026-11-25). Its Agent Access SDK is early alpha: the owner "approves the credential via the CLI", and a browser extension "will also be available in the future" ([Bitwarden](https://bitwarden.com/blog/introducing-agent-access-sdk/), read 2026-11-25).
- Risk: the filled value sits in the page until submit. "Whether the agent's model could ever see a credential depends on how the developer builds its service" (1Password security page). Bao would have to stop snapshots during the fill, as it does during an owner wait.
- Cookie line: not crossed if the fill happens in the Mac's extension. Crossed in spirit if a Bao server ever held a vault token.

#### 10. A passkey that Bao holds

Chrome's debugging protocol can add a **virtual authenticator** to a tab: software that answers passkey requests. Bao would create its own passkey for each site, once, while Alex is signed in. Later, at a passkey prompt, Bao asks Alex to approve on his phone, then lets the virtual authenticator sign.

- It is real but built for tests: "This domain allows configuring virtual authenticators to test the WebAuthn API", marked experimental; a credential is "The ECDSA P-256 private key in PKCS#8 format" that the caller supplies ([protocol definition](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/WebAuthn.pdl), read 2026-11-25). Chrome's own DevTools MCP server added a tool for it, off by default: it "answers navigator.credentials.create() and get() and is removed when the page closes" ([chrome-devtools-mcp commit](https://github.com/ChromeDevTools/chrome-devtools-mcp/commit/ada7963246c0c91eae185125a57aecd13cbe0376), 2026-10-23).
- The phone side could be an iOS credential provider app, so the same passkey also works on the phone. Apple's extension point covers this: "Prepare the view controller to show user interface for registering a new passkey" ([Apple](https://developer.apple.com/documentation/authenticationservices/ascredentialproviderviewcontroller), read 2026-11-25).
- Needs: a one-time enrollment per site; safe storage for keys on the Mac; a phone app for approval.
- Breaks: sites that allow only one passkey or demand a certified authenticator. While the virtual authenticator is on, it takes over passkey requests in that tab, so Bao must turn it on only for sites it holds a key for. Whether Chrome's debugging toggle exposes this domain on the owner's running Chrome: not tested.
- Risk: Bao becomes a store of sign-in keys. The key is handed to Chrome as bytes, so it is a software key, weaker than the Mac's secure chip. Anyone who can drive Bao can sign in.
- Cookie line: not crossed. But a Bao server that synced these keys would hold something worse than cookies. Sync, if any, must be end-to-end encrypted.

#### 11. Forward the passkey request to the phone

Chrome has an extension API made for remote desktop tools: it "lets remote desktop software running on a remote host intercept Web Authentication API (WebAuthn) requests in order to handle them on a local client" ([chrome.webAuthenticationProxy](https://developer.chrome.com/docs/extensions/reference/api/webAuthenticationProxy), read 2026-11-25). In theory a Bao extension on the Mac could catch the passkey request and send it to the phone, where the real synced passkey signs it.

- Where it stops: the phone app must ask iOS for a passkey signature for someone else's site. Apple gives that only to browsers: the entitlement "lets your app make registration and assertion requests for passkeys and security keys for any relying party identifier", and "Only add this entitlement if your app can act as a user's web browser" ([Apple](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential), read 2026-11-25). That page lists macOS only. An iOS path for a non-browser app: could not verify.
- Risk: this is a passkey relay, the exact attack the Bluetooth check exists to stop. It would be safe only because the phone and the Mac are paired and the request comes from Chrome itself.
- Verdict: not viable today. Listed so nobody rediscovers it.
- Cookie line: not crossed.

### Group 2: the sign-in happens somewhere else

#### 12. Reverse proxy through Bao (Evilginx style)

The phone opens a Bao address. Bao fetches the real sign-in page, rewrites it, and passes traffic both ways. The site sees Bao's machine as the browser.

Where it breaks, exactly:

1. **The session lands in the proxy, not in Chrome.** It then needs a cookie move (method 13).
2. **Passkeys fail.** The phone's browser sees Bao's address, so the signature is for the wrong site. Attack kits do not beat this; they hide the passkey button: "Its `js_inject` capability can make sure the passkey option is, well, not an option" ([Jessar Qais](https://blog.jessar.dev/2026/10/17/evilginx-passkeys/), 2026-10-17).
3. **Password managers do not fill.** Same cause: wrong address.
4. **DBSC fails.** The proxy has no secure chip to bind to. Kits get past it only by removing it: "A proxy can strip the registration and capture an unbound session" ([Push Security](https://pushsecurity.com/blog/aitm-phishing-dom-mirroring), 2026-11-18). That leaves an unbound session, which a DBSC site treats as lesser.
5. **Bot checks fail.** The site's scripts run on the wrong address, and the proxy's network handshake is not Chrome's (my reading). A 2026 thesis found that proxied traffic "can be detected with an accuracy of 99.7\%" from the changes a proxy makes to request headers ([BYU](https://scholarsarchive.byu.edu/etd/11206), 2026-04-14).
6. **Google blocks it by policy.** Sign-in is refused from embedded frameworks and automation because of "man-in-the-middle" risk ([Google](https://developers.googleblog.com/en/guidance-to-developers-affected-by-our-effort-to-block-less-secure-browsers-and-applications/), 2020-08-28, old).
7. **Every site needs its own rewrite rules.** Evilginx calls them phishlets: "configuration files that tell Evilginx how to mirror a target site" (same Jessar Qais post).

- Cookie line: **crossed** if the proxy runs on a Bao server, which would hold the session. On the Mac it is not crossed, but everything above still breaks.
- Verdict: do not build.

#### 13. Move a session from the phone

Alex signs in inside a web view in a Bao phone app. The app reads the cookies and sends them to the Mac, and Bao sets them in Chrome.

- Breaks: device-bound sessions cannot move at all. Bot-check cookies are tied to the browser that earned them; Bao's own login import found this ("Those cookies are tied to the browser that received them", [bao.md](bao.md)). The site sees a phone sign in and a Mac use the session, which is what a stolen cookie looks like. Google refuses sign-in in embedded web views (same 2020 Google source, old).
- Even the vendors that sell this hedge it. Browser Use's profile sync "does not import a password manager or guarantee that the target site accepts a moved login" ([Browser Use](https://docs.browser-use.com/cloud/guides/profile-sync.md), read 2026-11-25).
- Cookie line: **crossed** if any Bao server can read the cookies in transit. End-to-end encryption would keep the letter of the rule, but this is the practice the rule warns about.
- Verdict: do not build.

### Group 3: flows the site itself offers

#### 14. OAuth device grant

Made for TVs and command-line tools. The device shows a short code; you open a page on your phone, sign in there, and type the code; the device gets a token ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628), a 2019 standard).

- Why it does not help: the site must offer it, and it yields an API token for a device, not a web session in Chrome. Few consumer sites offer it for their web app.
- Risk: it is a live phishing method. "The threat actor initiates the flow and provides the user with a code ... Microsoft recommends blocking device code flow wherever possible" ([Microsoft](https://www.microsoft.com/en-us/security/blog/2026/09/22/unmasking-eviltokens-getting-to-the-root-of-device-code-phishing/), 2026-09-22).
- Useful only where an agent can use a site's API in place of its web pages. That is a different product.
- Cookie line: not crossed.

#### 15. The site's own cross-device sign-in

Some sites sign in a desktop browser from their phone app: a push approval, or a QR code on the desktop page that the app scans. A push already works (method 2). The standard behind server-started approvals is CIBA, where "the user authenticates with the OpenID Provider and grants consent" on a second device ([OpenID](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0-final.txt), a 2021 standard); only the site can choose to use it. A QR code shown on the Mac is hard when the only camera is on the phone that displays it. Some sites offer a typed code in place of the QR; which ones: could not verify. Scanning a login QR that someone sends you is also a known scam, so Bao showing Alex QR codes to scan would train a bad habit.

### Method summary

Speed notes are estimates unless a source is cited. Nothing was measured on Bao.

| Method | Speed and feel | Main risk | Needs | Cookie line |
| --- | --- | --- | --- | --- |
| 1. Self-serve | Instant, no human | Agent signs in unasked | A consent rule | Not crossed |
| 2. Notify | One tap on the phone | Fake notices | A push path | Not crossed |
| 3. Chat relay | One chat turn | Secret goes through the model | Nothing | Not crossed |
| 4. Field relay | Fast: local typing, phone autofill | No address check on the phone | Phone surface, form reader | Not crossed; encrypt end to end |
| 5. Pixel view, screencast | Laggy stream, or about a second per step with stills | Stream shows and carries everything | Phone surface | Close; encrypt end to end |
| 6. Pixel view, WebRTC | Smooth: 20 fps video (Steel) | As 5 | Phone surface, video encoder | Close; encrypt end to end |
| 7. DOM mirror | Sharp and quick, but brittle | Leaks hidden page data | Phone surface, script in every frame | Close; encrypt end to end |
| 8. Remote desktop | Slow, tiny targets | Whole Mac exposed | A remote desktop app | Not crossed |
| 9. Vault fill | One approval, no typing | Value sits in the page until submit | 1Password partner access | Not crossed on the Mac |
| 10. Bao passkey | One approval, no typing | Bao stores sign-in keys | Phone app, enrollment per site | Not crossed; a key sync would be worse |
| 11. Passkey forward | n/a | Passkey relay | Apple browser entitlement | Not crossed |
| 12. Proxy | Normal page on the phone | Phishing kit shape; session in the proxy | Rules per site | **Crossed** on a server |
| 13. Cookie move | Normal sign-in on the phone | Looks like cookie theft to the site | Phone app with a web view | **Crossed** unless sealed |
| 14. Device grant | Type a code on the phone | Device-code phishing | Site support | Not crossed |
| 15. Site's own flow | A tap, or a scan | QR scams | Site support | Not crossed |

## Matrix: login types against methods

Does the pair get a session into Chrome on the Mac while Alex is away?

- ✅ works
- 🟡 works with a condition; see the note for that row
- ⚠️ works, but with a risk Bao should not take
- ❌ does not work
- n/a does not apply

Columns: **Self** self-serve (1), **Chat** chat relay (3), **Field** field relay (4), **Pixel** pixel view by screencast or WebRTC (5 and 6, same reach, different speed), **Mirror** DOM mirror (7), **Desk** remote desktop (8), **Vault** vault fill (9), **BaoKey** Bao passkey (10), **Fwd** passkey forward (11), **Proxy** (12), **Move** cookie move (13), **Site** the site's own flow (14 and 15). Notify (2) carries no input, so it has no column; it is the first step of every row.

| Login type | Self | Chat | Field | Pixel | Mirror | Desk | Vault | BaoKey | Fwd | Proxy | Move | Site |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Password in Chrome's manager | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | n/a | 🟡 | n/a | ⚠️ | ⚠️ | n/a |
| 2. Password in 1Password | 🟡 | ⚠️ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | n/a | ⚠️ | ⚠️ | n/a |
| 3. Password in iCloud Keychain | 🟡 | ⚠️ | ✅ | ✅ | ✅ | ✅ | ❌ | 🟡 | n/a | ⚠️ | ⚠️ | n/a |
| 4. Password in Bitwarden | 🟡 | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ | 🟡 | n/a | ⚠️ | ⚠️ | n/a |
| 5. Password from memory | ❌ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ❌ | 🟡 | n/a | ⚠️ | ⚠️ | n/a |
| 6. Magic link | 🟡 | 🟡 | ✅ | ✅ | 🟡 | ✅ | n/a | 🟡 | n/a | ❌ | ⚠️ | n/a |
| 7. Emailed code | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | n/a | 🟡 | n/a | ⚠️ | ⚠️ | n/a |
| 8. SMS code | ❌ | 🟡 | ✅ | ✅ | ✅ | ✅ | ❌ | 🟡 | n/a | ⚠️ | ⚠️ | n/a |
| 9. Authenticator code (TOTP) | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | n/a | ⚠️ | ⚠️ | n/a |
| 10. Push approval | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | n/a | n/a | ⚠️ | ⚠️ | ✅ |
| 11. Passkey on the Mac, local or synced (iCloud, Chrome, Google) | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 | ❌ | ✅ | ❌ | ❌ | ⚠️ | n/a |
| 12. Passkey in a 1Password or Bitwarden extension | 🟡 | ❌ | ❌ | 🟡 | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ⚠️ | n/a |
| 13. Passkey on the phone by QR | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ⚠️ | n/a |
| 14. USB security key | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ⚠️ | n/a |
| 15. SSO: Google, Apple, work sign-in | 🟡 | n/a | 🟡 | ✅ | 🟡 | ✅ | ❌ | 🟡 | n/a | ❌ | ⚠️ | n/a |
| 16. Captcha or bot check | 🟡 | ❌ | ❌ | 🟡 | ❌ | ✅ | n/a | n/a | n/a | ❌ | ❌ | n/a |
| 17. New-device or "verify it's you" check | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | n/a | ❌ | ❌ | n/a |
| 18. Account picker | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | n/a | n/a | n/a | n/a | n/a |
| 19. Device-bound session (DBSC) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | ❌ | ❌ | ✅ |
| 20. The site's own QR sign-in | ❌ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | n/a | n/a | n/a | ❌ | ⚠️ | 🟡 |

Notes by column, for marks that repeat down the table:

- **Chat ⚠️ on passwords.** It works, and the password ends up in the model's context and the transcript.
- **Chat 🟡 on codes.** The model sees a code that dies in seconds or minutes. Low harm; still a habit to avoid.
- **BaoKey 🟡 on password and code rows.** A Bao passkey replaces the whole sign-in, if the site takes passkeys and Alex enrolled one earlier.
- **Proxy ⚠️.** It can work on a plain site with no bot check, and the session then lands in the proxy.
- **Move ⚠️.** It can work on a site that does not bind its session to the browser, and looks like theft to one that does.

Notes by row:

1. **Chrome's manager.** Self-serve fails if Chrome is set to ask for Touch ID before each fill.
2. **1Password.** Self-serve needs the Mac extension unlocked; a locked one wants Touch ID or the account password at the Mac. Vault fill is the 1Password for Agents route, partner-only today.
3. **iCloud Keychain.** Self-serve needs Apple's Chrome extension set up and unlocked on the Mac; its behavior under an agent: could not verify. Field relay is the natural route, since the same passwords are on the phone. No agent approval route found.
4. **Bitwarden.** As 1Password for self-serve. Its agent routes today hand the secret to the model or to a command line.
6. **Magic link.** Self-serve means the agent opens webmail in the same Chrome and clicks the link; it must be allowed to read mail. In field relay, Alex pastes the link and Bao opens it in the tab. Opening the link in Mac Chrome is right for sites that demand "the same device and browser that you started it on", which is Clerk's default ([Clerk docs](https://clerk.com/docs/nextjs/guides/development/custom-flows/authentication/email-links.md), read 2026-11-25). Tapping the link on the phone signs in the phone.
7. **Emailed code.** Self-serve as row 6.
9. **TOTP.** Self-serve works when the code lives in a Mac-side manager that fills it. 1Password for Agents fills one-time passwords.
10. **Push.** With number matching, Alex needs the number. It is not a secret, so the agent can say it in chat.
11. **Passkey on the Mac.** The prompt is a macOS dialog, outside the tab, so page-level views cannot see it. Remote desktop might pass it with the Mac password; not tested.
12. **Passkey in an extension.** Works by self-serve only while the vault is unlocked, and then the agent is using the passkey with no human. 1Password for Agents does not cover passkeys yet.
13. **QR passkey.** The Bluetooth check fails from afar under every view. Only a Bao-held passkey or another sign-in method gets through.
15. **SSO.** Self-serve works when the provider's session is live in Chrome. If not, it turns into rows 1 to 14 at the provider. Sign-in pop-ups need care in field relay and mirror. 1Password for Agents excludes "Login items that rely on sign-in providers" ([1Password](https://support.1password.com/1password-for-agents/), 2026-11-04).
16. **Captcha.** Many checks pass unseen in a real Chrome. The agent should not solve one; Anthropic lists "bypassing bot authorizations" as prohibited for Claude in Chrome ([Claude help](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide), read 2026-11-25). A person can click through a pixel view; drag and hold puzzles are doubtful.
17. **New-device check.** It arrives as a code, a link or a push, so see those rows. A proxy and a moved cookie both cause this check.
19. **DBSC.** Not a login step. It is a property that only in-Chrome sign-ins keep.
20. **Site QR.** A phone cannot scan its own screen. A typed-code variant works where the site offers one.

## Best route for each login type

| Login type | At launch | Long term | What Alex does on his phone |
| --- | --- | --- | --- |
| Password in Chrome's manager | Self-serve | Self-serve | Nothing |
| Password in 1Password | Field relay | Vault fill | Picks the entry, later just approves |
| Password in iCloud Keychain | Field relay | Field relay | Picks the entry from the key icon |
| Password in Bitwarden | Field relay | Vault fill, when Bitwarden ships it | Picks the entry |
| Password from memory | Field relay | Field relay | Types it |
| Magic link | Field relay (paste the link) | Self-serve through webmail, if he allows it | Copies the link from his mail |
| Emailed code | Field relay | Field relay | Types or pastes the code |
| SMS code | Field relay | Field relay | Taps the code iOS suggests |
| Authenticator code | Field relay | Vault fill | Types the code, later just approves |
| Push approval | Notify | Notify | Taps Approve; types the number if asked |
| Passkey of any kind | "Try another way", then the rows above | Bao passkey | Approves on the phone |
| SSO with a live session | Self-serve | Self-serve | Nothing |
| Captcha | Still-picture view | WebRTC view | Taps through it |
| Account picker | Self-serve, or ask in chat | Same | Names the account |

## What Alex already knew, checked

- **"Pixel streaming is slow."** True for a stream of screenshots, less true for video. Steel moved its default to WebRTC H.264 at 20 fps and calls the screenshot stream "an older view" ([Steel](https://steel.dev/docs/observability/live-view), reviewed 2026-11-12). One repo reports "~30 seconds per keystroke" when it re-streams a cloud browser ([browser-handoff](https://github.com/synacktraa/browser-handoff), read 2026-11-25). The lasting pain is typing and small targets, not frame rate. Native typing fixes most of it.
- **"A proxy breaks passkeys, DBSC and bot checks."** Confirmed, with detail in [method 12](#12-reverse-proxy-through-bao-evilginx-style). New: attack kits do not beat passkeys or DBSC; they strip them, which leaves a weaker session that Bao does not want.
- **"The QR flow needs Bluetooth range."** Confirmed by the spec. New: a phone linked earlier still needs it, and so does the next draft of the protocol.
- **"iCloud passkeys can't be signed from a Mac somewhere else."** Confirmed in part. The Mac's prompt takes Touch ID, Apple Watch or the system password. Typing the Mac password over remote desktop might pass; not tested, and not a habit to build on.
- **"Push approvals already work."** Confirmed, with one gap: number matching needs the number from the page.

## Products and repos

No product found does what Bao needs: a phone handoff into the owner's own Chrome on his own Mac. Cloud vendors hand off into their browser. Local agents hand off to a person at the same desk. One small repo, Browser Bot, is the closest match.

### Cloud browsers

**Browserbase**

- Handoff: a live view in an iframe. "Log in to a website inside this first session, either manually through the live view feature or programmatically" ([Contexts](https://docs.browserbase.com/features/contexts), read 2026-11-25). Stream type, phone support, latency: could not verify.
- 1Password: "an agent can request access to a login, wait for the user to approve or deny the request in 1Password, and continue its task once 1Password signs it in ... 1Password removes the filled credential so the agent cannot read or reuse it" ([Browserbase](https://www.browserbase.com/blog/browserbase-is-partnering-with-1password-for-agents), 2026-10-22). Approval is "on the computer running the 1Password desktop app", and "The prompt closes after two minutes" ([docs](https://docs.browserbase.com/integrations/1password/agentic-autofill), read 2026-11-25). Passkeys: could not verify.
- Session: Contexts keep "Cookies: session cookies, explicitly backed up and restored between sessions", "uniquely encrypted at rest" (Contexts page).

**Anchor Browser**

- Handoff: a hosted sign-in page. "Your backend mints a short-lived link, the user completes sign-in on Anchor's hosted UI, and your app receives the new identity on callback" ([OmniConnect docs](https://docs.anchorbrowser.io/essentials/omniconnect), read 2026-11-25). There is also a live browser view: "Open the `live_view_url` to watch it in real time" ([announcement](https://anchorbrowser.io/blog/launching-omniconnect-authentication-for-computer-use-agents), read 2026-11-25).
- Secrets: stored identities hold "Username/password, TOTP secrets, 1Password refs, email MFA mailbox", and Anchor "runs the application's auth flow using stored credentials" when a session expires ([Identities](https://docs.anchorbrowser.io/essentials/authenticated-applications), read 2026-11-25). Passkeys, SMS: could not verify.

**Steel**

- Handoff: "Your agent stops at that step, a person does it in the session's live view, and the agent continues in the same browser with the result" ([Steel](https://steel.dev/docs/observability/hand-control-to-a-human), reviewed 2026-11-12).
- Stream: WebRTC H.264 at 20 fps for headed sessions (live view page, quoted above). Phone support: could not verify.
- Secrets: a stored `totpSecret` yields "a fresh code when the site asks for one"; but "code that reads the page, such as a Playwright script, can still read a filled field". Passkeys and SSO: "For those, hand control to a human" ([Credentials](https://steel.dev/docs/logins/credentials), reviewed 2026-11-12).

**Kernel**

- Handoff: Managed Auth runs the sign-in "in a separate browser session managed by KERNEL" and "requests user input when needed" ([Auth overview](https://www.kernel.sh/docs/auth/overview), read 2026-11-25). It shows a hosted page or your own UI, covering "MFA selection, and external actions (push notifications, security keys)" ([Managed Auth](https://www.kernel.sh/docs/auth/managed-auth), read 2026-11-25). Its live view lets people step in "in real-time to resolve errors or take unscripted actions" ([Live View](https://www.kernel.sh/docs/browsers/live-view), read 2026-11-25); that page documents WebRTC connection states, so the stream is WebRTC by my reading.
- Secrets: "KERNEL doesn't return stored sensitive fields in api responses or add them to model context", but "Page scripts, extensions, developer tools, and an agent with unrestricted browser access can read them after fill" (Auth overview). With 1Password, the user "approves each login request in the 1Password app ... KERNEL stores no login values" ([Fill from Vault](https://www.kernel.sh/docs/auth/fill-from-vault), read 2026-11-25).
- Passkeys: a passkey-only site fails with `unsupported_auth_method` ([Kernel](https://www.kernel.sh/ai-library/agent-identity-how-to-authenticate-an-ai-browser-agent), read 2026-11-25).
- Incident: on 2026-11-04 Kernel said an outside party "accessed and downloaded data" from a logging provider, including "a small number of kernel API keys and app deployments' third-party secrets" ([Kernel notice](https://www.kernel.sh/blog/public-notice-of-security-incident-nov-4-2026), 2026-11-04). The notice does not tie it to login handoff. It shows what a vendor-held session store costs when it leaks.

**Hyperbeam**

- Handoff: a shared cloud browser in an iframe, with "Mobile & touch support" ([Hyperbeam](https://hyperbeam.com/), read 2026-11-25). No agent pause-and-resume flow is documented. Transport and latency: could not verify.
- Session: `profile.save` keeps an "encrypted browser state from a previous session" ([API docs](https://next.hyperbeam.com/docs/rest-api/dispatch/starting-a-session/), read 2026-11-25).

**Browser Use Cloud**

- Handoff: "Open the live browser, take over, then continue the same session." It is the only vendor found that documents a phone: "For a person on a phone, create the run with `browserSettings.allowResizing: true` and add `fit=1` to the `live.browser-use.com` URL" ([Human in the loop](https://docs.browser-use.com/cloud/agent/human-in-the-loop.md), read 2026-11-25). The trick is to resize the remote browser to the phone's shape.
- Warning: "Treat live-view URLs as credentials" (same page).

**Browserless and Airtop**

- Browserless: "pause an automated script, hand control to a human via a secure live URL, and resume"; the page "upgrades a same-origin WebSocket to stream frames and input" ([Hybrid Automation](https://docs.browserless.io/baas/monitor-sessions/hybrid-automation), read 2026-11-25). After a vault fill it locks the page down: screenshots blocked, and "an already-streaming live view is torn down" ([1Password page](https://docs.browserless.io/baas/features/1password), read 2026-11-25). It can also read an emailed code "over IMAP inside Browserless".
- Airtop: a live view for "Authentication workflows" ([Airtop](https://docs.airtop.ai/guides/how-to/creating-a-live-view), read 2026-11-25). Details: could not verify.

### Agent products

**OpenAI: Operator, ChatGPT agent, Atlas**

- Operator let a user "take over control of the remote browser", and "does not collect or screenshot information entered by the user" ([OpenAI](https://openai.com/index/introducing-operator/), 2025-07-17, old). It is now part of ChatGPT agent.
- ChatGPT agent: "If a task requires a login, ChatGPT agent will pause and prompt you to take control of the virtual browser ... While you control the browser, screenshots are not captured"; "Cookies persist across sessions"; it runs on "ChatGPT Web, mobile (iOS/Android), and desktop apps" ([help page](https://help.openai.com/en/articles/11752874-chatgpt-agent), read 2026-11-25). The browser is OpenAI's, in the cloud. Stream type and passkeys: could not verify.
- Atlas is OpenAI's own browser on the owner's computer. OpenAI names "new risks that can come from access to logged-in sites and browsing history" ([OpenAI](https://openai.com/index/introducing-chatgpt-atlas/), read 2026-11-25). A takeover from a phone: could not verify.

**Claude in Chrome**

- It drives the owner's Chrome through an extension. Sign-in uses 1Password: "You approve each request with biometrics, and 1Password fills the credential directly so Claude never sees your password or one-time code. 1Password for Claude is in beta on macOS" ([Claude help](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome), read 2026-11-25). It covers "logins and one-time codes (TOTP)" ([1Password for Claude](https://support.claude.com/en/articles/15936181), read 2026-11-25).
- This is the closest shipped product to Bao's long-term option. A phone approval for a Mac browser: could not verify.

**Chrome auto browse (Gemini in Chrome)**

- Uses Google Password Manager with consent, and hides the password from the model (quoted in [method 1](#1-self-serve-use-what-chrome-already-has)). "For certain tasks that you need to complete personally, Gemini will ask you to take over." When the computer sleeps it "might use a remote browser", and there "For certain steps, like signing in to a website, the task pauses until you take over" ([Chrome help](https://support.google.com/chrome/answer/16821166?hl=en), read 2026-11-25). No phone view of the desktop browser is documented.

**browser-use (open source)**

- `Browser('chrome')` drives "the Chrome you have open, with your logins". `sensitive_data` hides a password from the prompt, with an honest limit: "Not a sandbox: model-written Python can read the value, and screenshots, `js()` reads of the field and a cloud live view can reveal it" ([README](https://github.com/browser-use/browser-use/blob/d567193f6e06c8b6f570dd3482babb027eb9dfaf/README.md), 2026-11-22). 122,048 stars on 2026-11-25.

**Skyvern (open source)**

- No takeover. It injects secrets: "The model that drives the browser gets placeholders, not your values", from 1Password, Bitwarden, Azure Key Vault or a custom service. For codes, a person can "Push a 2FA Code", or Skyvern polls your `totp_url`. Limit: "A typed value can still show up in later screenshots and page text" ([credentials docs](https://github.com/Skyvern-AI/skyvern/blob/74e10397d8cc0131e003877ba618599dcafeb83b/docs/credentials.mdx), 2026-11-14). The code-push endpoint is a server-side cousin of field relay.

**Muse from Meta**

- A Chrome extension. Its store page says "Approve actions before they happen" and discloses handling "Authentication information" ([Chrome Web Store](https://chromewebstore.google.com/detail/muse-from-meta/jnakhhjmpmoohbjgfccbccfoifnmbdjd), updated 2026-11-21). [ALE-100](https://linear.app/aaalexliu/issue/ALE-100) read version 2.0.65 of the extension: it shows "Needs your help" on the tab and lets the person at that computer click to take control. A phone handoff: no documented answer found.

**Perplexity Comet, Microsoft Edge Copilot**

- Comet "will pause and ask for permission" before "logging in to a certain site", ([Perplexity](https://www.perplexity.ai/hub/blog/comet-assistant-puts-you-in-control), read 2026-11-25). It pairs with a 1Password extension for "Passwords and passkeys" ([Perplexity](https://www.perplexity.ai/hub/blog/secure-credentials-on-comet-with-1password), read 2026-11-25).
- Edge Copilot "cannot access autofill data, saved passwords, or wallet information"; it asks the owner to "take control of the tab and enter it yourself", and then "will not capture or send any screenshots until you start the task again" ([Microsoft](https://support.microsoft.com/en-us/edge/copilot/browse-with-copilot), read 2026-11-25).
- Both are local, at-the-desk handoffs.

**Small repos built for this**

- [Browser Bot](https://github.com/snoopyrain/browser-bot-oss) (0 stars, last commit 2026-09-11): the nearest thing to Bao's case. "Chat from your phone" while an agent drives a signed-in Chrome on your Mac; at a login it "pauses, you take over in a live view, then hand control back". Live view is "CDP Page.startScreencast → frames; taps/keys → Input.dispatch*". "The phone reaches it over Tailscale (no public exposure, no relay)", with one shared token. It runs on a copy of the Chrome profile.
- [browser-session-mcp](https://github.com/xav-ie/browser-session-mcp) (2 stars, last commit 2026-11-23): "the agent sends you a link to a live view of the page". "The link works for one browser only: the first to open it claims it, and it expires after 30 minutes." It "turns passkey prompts down, so sites fall back to a password or a code".
- [scry](https://github.com/dataplanelabs/scry) (4 stars, last commit 2026-06-14): noVNC onto the agent's browser for a "one-time interactive login".
- [browser-handoff](https://github.com/synacktraa/browser-handoff) (4 stars, last commit 2026-07-03): pauses a Playwright page until a person signs in.

### Password managers

- **1Password**: the leader. See [method 9](#9-vault-fill-with-human-approval). On MCP it says "we will not use MCP to expose raw credentials or secrets" ([1Password](https://1password.com/blog/where-mcp-fits-and-where-it-doesnt), read 2026-11-25).
- **Bitwarden**: agent routes hand over the secret or are alpha. See method 9. Its "Log in with device" phone approval unlocks a Bitwarden client, not a website ([Bitwarden](https://bitwarden.com/help/log-in-with-device/), read 2026-11-25).
- **Google Password Manager**: open to Chrome's own agent only. Passkeys on a Mac may ask for "Your desktop password or PIN", "Your fingerprint", or "Your Google Password Manager PIN" ([Chrome help](https://support.google.com/chrome/answer/13168025?hl=en), read 2026-11-25). A way for an outside tool to use it beyond a real click: could not verify.
- **iCloud Keychain**: no agent feature and no remote approval found.
- **Dashlane**: "does not allow AI agents to autonomously access or operate on your vault" ([Dashlane](https://www.dashlane.com/blog/ai-browsers), read 2026-11-25).
- **Proton Pass**: scoped "AI access tokens" with a logged reason for each use; no approval per fill ([Proton](https://proton.me/blog/pass-access-tokens), read 2026-11-25).

### Co-browsing

Built for a support agent helping a customer, so the trust runs the other way: the helper must not see secrets.

- **Surfly** is a proxy: requests are changed so "it looks as if the original request came from surfly.com", and the page is rewritten to load in an iframe ([Surfly](https://help.surfly.com/en/the-surfly-proxy), read 2026-11-25). My reading: the session lives in the proxied context, not in a Chrome profile. Passkeys and SSO through it: could not verify.
- **Upscope** mirrors the DOM and will "Automatically hide sensitive fields like passwords" ([Upscope](https://upscope.com/cobrowse), read 2026-11-25).
- **Cobrowse.io** warns that "nothing is redacted automatically. Password, card number and similar fields are visible to the agent until you add them to your redaction configuration" ([Cobrowse.io](https://docs.cobrowse.io/sdk-features/redact-sensitive-data), read 2026-11-25).
- **rrweb** is the open-source base for mirrors (20,505 stars on 2026-11-25). Passwords are masked by default (`maskInputOptions` has `password: true` in the [guide](https://github.com/rrweb-io/rrweb/blob/main/guide.md), read 2026-11-25). [Syncit](https://github.com/rrweb-io/syncit) adds remote control on top (52 stars).

These need their script inside the site, which a site owner adds. Bao can inject it over CDP, which is also how the phishing kits below do it.

### Evilginx and its family

Push Security sorts today's sign-in phishing kits into four classes ([Push Security](https://pushsecurity.com/blog/aitm-phishing-dom-mirroring), 2026-11-18):

- **Reverse proxy**: "The kit passes the vendor's real sign-in page through attacker infrastructure ... as in the original Evilginx."
- **Replica page**: a copy of the page that relays what the victim types.
- **Pixel streaming**: "The attacker runs a real browser and streams it into the phishing page as video frames, so the sign-in completes in the attacker's browser."
- **DOM mirroring**: "The kit rebuilds a copy of the real sign-in page in the victim's browser, from page data sent by the attacker's remote browser", built from "open-source libraries such as rrweb". It is "the newest and fastest-growing class".

Evilginx's last public release is v3.3.0, from 2024-04-02 ([GitHub](https://github.com/kgretzky/evilginx2/releases), read 2026-11-25). A 2026 service built on it, BigBear 2.0, held "4,148 session cookies" and injects script "that disables FIDO2 and WebAuthn in the victim's browser" ([Start With Identity](https://startwithidentity.com/blog/2026-09-07-bigbear-phishing-service-disabled-webauthn-to-force-a-downgrade/), 2026-09-07).

## Threat model

### Every remote method has a criminal twin

| Bao method | The same design, used to steal |
| --- | --- |
| Proxy | Evilginx |
| Pixel view | Browser-in-the-middle, noVNC phishing |
| DOM mirror | DOM mirroring kits |
| Field relay | Replica page |
| Forwarding a passkey request | Passkey relay |
| Device grant | Device-code phishing |
| Showing a QR code to scan | QR login scams |

The difference between Bao and a kit is only **who runs the far browser, and how Alex knows that**. Two results follow.

1. **Sites may treat Bao like a kit.** "It is relatively easy to detect the use of remote desktop software" ([Push Security](https://phishing-techniques.pushsecurity.com/techniques/desktop-control/), read 2026-11-25). Methods that keep the sign-in in real Chrome with real input events give a site the least to notice. A proxy gives the most.
2. **Alex must be able to tell Bao from a fake.** If Bao teaches him to type passwords into a page that arrives by link, a fake link will work on him.

### Look-alike risk

- **A fake handoff.** Someone sends "Bao needs you to sign in" with a link. Defense: a handoff opens only inside a surface paired with the Mac ahead of time, never from a link in a text, an email or a chat. A web page that anyone with the link can open is the weak design. The small repos show the range: one shared token, or a link the first browser claims.
- **A fake site inside a real handoff.** The agent is on `g00gle.com` and asks for help. A pixel view has no address bar. Defense: Bao shows the address it reads from Chrome, large, above the form or picture, and marks a site Alex has never signed in to from this Chrome. The page and the model must not be able to write that label.
- **Lost address check.** On the Mac, a password manager refuses a look-alike. On the phone, with field relay, Alex picks the entry by hand. Methods that fill on the Mac (self-serve, vault fill) keep the check. This is the main reason to prefer them when they apply.

### Prompt injection

- A page can tell the agent to sign in again at an attacker's address, or to ask Alex for a code. OpenAI warns of hidden instructions "stealing data from sites you're logged into" ([OpenAI](https://openai.com/index/introducing-chatgpt-atlas/), read 2026-11-25), and Google names "indirect prompt injection" as the main threat to its agent ([Google](https://blog.google/security/architecting-security-for-agentic/), 2025-12-08, old).
- So the model must not be the voice Alex trusts. The handoff text should come from Bao's own wall check ("Sign in to nytimes.com"), with the agent's reason shown as a quote.
- Self-serve is the sharpest edge: a tricked agent could sign in somewhere Alex did not intend. Chrome only fills a saved password on its own address, which limits the harm to real sites he already uses. A consent rule per site, as Chrome's agent has, closes most of the rest.
- An approval that lasts (1Password's 30 days) is a standing grant. A tricked agent can use it without a new prompt.
- Push fatigue: an agent that starts sign-ins can make approve prompts appear. Alex should see which run asked, before he taps.

### What the model sees

- **During the handoff.** Bao already goes blind at the Mac: address and title only, no snapshots, video paused. A remote handoff should keep that rule. ChatGPT agent and Edge Copilot do the same.
- **The path of the secret.** With field relay, pixel view and vault fill, the secret goes phone to Bao to Chrome. It never enters a tool result. Chat relay is the one method that puts it in the model's context.
- **After the handoff.** The next snapshot can show what is still on the page: a filled field, a recovery code. Steel, Kernel, Skyvern and browser-use all admit this. Browserless blocks reads until the page moves on. Bao should resume only once the page has left the wall, which its ready check already waits for.
- **The local record.** [VISION.md](../VISION.md) accepts that "A local-only recording may retain typed credentials". A handoff should add nothing to the record beyond a step that says the owner signed in.

### What the transport sees

- Field relay, pixel view and DOM mirror all carry secrets between phone and Mac. With the relay from [ALE-7](https://linear.app/aaalexliu/issue/ALE-7), a Bao server sits in that path. It would not see cookies, but it would see a password as typed. That keeps the letter of the cookie line and breaks its intent. These methods need encryption from the phone to the Mac that the relay cannot open, with keys set at pairing.
- With Tailscale, the path is private already, but a push still needs some server to wake the phone.
- Whoever holds the paired phone can sign in as Alex anywhere the agent goes. The phone surface should ask for Face ID before it sends anything.

## Recommendation

Ranked. Each step is useful without the next.

### Launch

1. **Self-serve where Chrome can already do it.** Let the agent finish a sign-in when Chrome fills a saved password or the identity provider's session is live, on sites Alex allows. No phone work. This removes the most walls for the least build, and it is the only step that keeps the address check with no human present.
2. **Tell Alex.** When a run halts with **needs you**, push a notice with the site name from Chrome and a still picture. This alone finishes push approvals and number matching.
3. **Step view with native typing.** A paired phone surface that shows a still picture of the tab after each action, takes a tap as a click, and offers a native text field for whatever the page asks: password, code, pasted link. Bao types into Chrome over CDP. The model stays blind, as it is today at the Mac. This one surface covers passwords from any manager, SMS, email and authenticator codes, magic links, account pickers and click-through captchas. It needs no stream, so it runs on either ALE-7 route.

For passkeys at launch: choose "Try another way" on the site and fall back to a password and a code. The surface should say that plainly.

What launch leaves out: passkey-only accounts, drag and hold captchas, and macOS dialogs.

### Long term

1. **Vault fill.** Apply to 1Password for Agents, and track Bitwarden's. It is the only route where the model is blind, the address is checked, and Alex only approves. Open points to raise with 1Password: a local agent that drives the owner's own Chrome, and approval on a phone while the browser is on the Mac.
2. **A Bao passkey.** The only real answer for passkey-only accounts when Alex is away. It turns a passkey into a phone approval. It also makes Bao a keeper of sign-in keys, which is a larger promise than Bao makes today, so it needs its own decision. It needs a native phone app.
3. **WebRTC live view.** For what a still picture cannot do: drag puzzles, odd flows. Build it last. It is the most work and the least pleasant to use.

### Do not build

- **A reverse proxy.** It breaks on the sites that matter and is the design of a phishing kit.
- **A cookie move from the phone.** Device-bound sessions end it, and it is the practice the cookie line warns about.
- **A DOM mirror.** It is weakest exactly where sign-in pages are hardest, and it sends more page data off the Mac than a picture does.
- **Raw CDP to the phone or a server.** That would hand over the cookie jar. [proxy-design.md](proxy-design.md) already rejects it.

### Left for Alex and for ALE-7

- **Web page or native app for the phone surface.** A web page served by the Mac ships sooner and works over both routes. A native app gets pushes, Face ID, pairing keys, and is required for a Bao passkey. My pick: a web page for launch only if it is reachable solely over a private route; an app once the relay is involved.
- **Whether self-serve is on by default.** VISION says Bao is not "a mandatory approval system for the person's own agent", which argues for on. The injection risk argues for a rule per site.

## Tests to run before building

All on fixtures or throwaway accounts. None was run for this doc.

1. **Saved-password fill.** In a throwaway Chrome profile with a saved password for a local fixture, does a CDP click fill the field? Does it still work when Chrome is set to ask for Touch ID before it fills?
2. **What a screencast misses.** On a fixture with a passkey prompt, a native select menu and a sign-in pop-up, what shows in `Page.startScreencast` frames and in still screenshots?
3. **Virtual authenticator on Running Chrome.** Does the `WebAuthn` domain work over the connection Bao uses for the owner's Chrome? Register and sign in on a WebAuthn demo site with a throwaway account.
4. **Phone autofill.** In a web form and in a native form, does iOS offer an SMS code and the password picker when the form is Bao's, not the site's?
5. **Step-view round trip.** Time from tap to next picture over each ALE-7 route.
6. **Mac passkey prompt over remote desktop.** Does the macOS dialog take the account password from a remote session? A yes changes row 11 of the matrix.
