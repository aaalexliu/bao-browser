# Importing one site's login

Bao can bring a single site's session from the person's Chrome into Bao's own Chrome. The person names the site and clicks **Import this site's login from my Chrome**. That click is the only time Bao reads a Chrome profile. It reads the clicked site's origins and nothing else, and it never shows cookie values, localStorage values, or IndexedDB contents.

The form asks for the site. Probe URL, extra same-host origins, a signed-in selector or text, and the anti-bot choice sit under Advanced. A blank probe uses the page that was typed, when that page is an http or https URL. Otherwise it uses the origin. Anti-bot cookies are skipped unless Advanced says to include them.

The profile picker lists every profile in that Chrome's `Local State`: name, email, avatar or initials, how many cookies match the site, how many of those will be imported, how many are expired, how many are anti-bot cookies, the localStorage item count, and the IndexedDB origin count. The profile with the most matching cookies is already selected. The person can choose another, then import. Bao does not assume `Default` when another profile has more matches.

## What is restored

Three stores, all limited to the clicked site:

- **Cookies.** The profile's cookie SQLite (`Network/Cookies`, or the legacy `Cookies` file). A cookie matches when it is host-only for that host, or a domain cookie for that host or a parent that is not a public suffix. Expired cookies are counted and left behind. Bao sets the ones it keeps one at a time with `Network.setCookie`, so one rejected `__Host-` or `SameSite=None` row does not drop the session cookie next to it. A cookie with no expiry is a session cookie. Chrome deletes those on a clean exit unless the profile is set to continue where you left off. Bao sets that on its own profile: `session.restore_on_startup` is 1, and the launch passes `--restore-last-session`. A session cookie then stays in Bao's profile when Bao's Chrome exits, and the next launch sends it. Bao does not mark the profile as crashed, and it does not read the person's Chrome again to fill a cookie back in. If the cookie is gone at run time, the pre-run probe returns needs sign-in.
- **localStorage.** Chrome keeps every origin in one LevelDB, `Local Storage/leveldb`. The map key is `_`, the origin, a NUL, and the item key. The value is tagged Latin-1 or UTF-16. Chrome is also moving this store to SQLite (`maps` joined to `map_entries`). When that file is present, Bao reads it the same way: the origin is the start of `storage_key`, up to the first NUL. `VERSION` and `META` rows are not site data. Bao then writes the items into its own Chrome one at a time with `DOMStorage.setDOMStorageItem`. One rejected item does not drop the rest.
- **IndexedDB.** Chrome stores this as one directory per origin, named `scheme_host_port.indexeddb.leveldb` (and `.indexeddb.blob` when Chrome has one). The default port is `0`. Bao copies only the directories for the clicked origin, and for extra origins the person listed on the **same host**. It skips `LOCK` files. There is no CDP call that writes IndexedDB, so the copy happens before Bao's Chrome starts.

An extra origin on a different host is ignored. A preview click does not copy IndexedDB. It only counts.

The result line is `Imported N. Signed in: yes.` or `Imported N. Signed in: no.` N is the number of cookies Chrome accepted. Storage is the next sentence, when there is any: `Restored N localStorage items and M IndexedDB origins.`

## Whole-profile copy is a no

Copying the Chrome user-data directory would bring every site's cookies, storage, history, and passwords. Bao's rule is one site per click. The profile directory stays where Chrome left it. Bao reads the cookie database and the storage for the origins of that site, then writes those into a profile Bao owns.

That owned profile is not the daily Chrome, and it is not started with remote-debugging port 9222. Replay uses the same profile, so a session imported earlier is still there for the next run. Capture still uses a separate temporary profile.

## CDP getCookies on the person's Chrome

`Storage.getCookies` and `Network.getCookies` only answer if that Chrome was launched with a debugging port. Chrome then shows a debugging banner, and the profile is locked, so the person cannot use the same window at the same time. Bao's launcher refuses port 9222 and refuses the daily profile. An explicit click does not make attaching to that Chrome acceptable: the click authorizes a read of one site, and the write goes into Bao's Chrome.

Playwright `storageState` is a different tool. It is a JSON snapshot of cookies and localStorage from a browser context the caller already controls. It does not read the person's Chrome, and it does not include IndexedDB. It is the right shape for a test fixture. It is not an import.

Browserbase Contexts persist a whole browser profile and reuse it on a later session. That is the whole-profile copy Bao will not do. The gap those products expose is real: a login is not cookies alone. Bao closes that gap by reading localStorage and IndexedDB for the clicked origins, and by checking the session again before a run. It does not close it by keeping the entire profile.

## Signed in, and still signed in

After the cookies and localStorage are in place, Bao loads the probe URL in its own Chrome. With no selector and no text, signed in means the final URL is not a login URL (`login`, `sign-in`, and the same words with an underscore or an extra hyphen). A site can instead name a selector, a text fragment, or both. Those are combined, and the login URL is then ignored. The probe URL should be a page that redirects to login when the session is dead. If the probe URL is itself the login page, Bao treats a healthy session as signed out.

The import click saves the site. From then on, a workflow whose start URL is that origin is checked before it runs. Bao opens the probe in its own Chrome. If the probe is signed out, or the probe page does not load, the run stops. The status is `needs-sign-in`, the step list is empty, and replay does not start. The message is:

> Needs sign-in. The session is not live, so Bao did not start the run. Sign in once in Bao's window.

A workflow for an origin that was never saved is not checked. Bao runs it as before.

Saved sites are listed on Logins. Each row shows the last probe time and whether that probe was live or needs sign-in. Re-check loads the probe in Bao's Chrome only. It does not read the person's profile. Remove drops the saved site, so later runs of that origin are not gated. It does not delete cookies already in Bao's profile.

## Sites that tie the session down

Some sessions do not survive a change of browser, even when the cookies and storage copied cleanly. Bao skips anti-bot cookies by default. A site can be switched to include them. Bao does not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated. There is no stealth flag on the owned Chrome launch.

The cookie names Bao treats as anti-bot:

| Vendor | Names |
|---|---|
| Imperva | `reese84`, `___utmvc`, `visid_incap_*`, `incap_ses_*`, `nlbi_*` |
| Akamai | `_abck`, `bm_sz`, `ak_bmsc`, `bm_sv`, `bm_mi`, `bm_so` |
| Cloudflare | `cf_clearance`, `__cf_bm`, `cf_chl_*` |
| DataDome | `datadome` |
| HUMAN | `_px`, `_px2`, `_px3`, `_pxvid`, `_pxhd`, `pxcts` |
| Kasada | `KP_UIDz*` |

Experian is the case that made the default. After the Imperva cookies were skipped, the site redirected to `/login`. The same shape shows up anywhere a bot manager binds a clearance cookie to the browser that received it: Akamai on a retail front, Cloudflare on a site that sits behind a challenge, DataDome, HUMAN (PerimeterX), and Kasada.

Other binding that a copy cannot honestly replay:

- WebAuthn and passkeys stay on the authenticator that created them.
- TLS token binding and similar channel bindings fail in a second process.
- A device id in a cookie or in localStorage often fails a server check against the browser that minted it. Bao still copies that localStorage, because it is part of the site's state. The probe then says whether the session stuck.
- An IP-bound session fails when the network changes.

When that happens, the reliable path is to sign in once in Bao's window. The button is **Sign in once in Bao's window**.

What Bao says, depending on what it found:

Only anti-bot cookies were available, and skip is the policy:

> This site only had anti-bot cookies (Imperva) for Bao to see. Bao skipped them. Skipping them is the default. Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated.

Session cookies were imported, anti-bot cookies were skipped, and the probe landed on a login URL:

> This site ties the session to its anti-bot cookies (Imperva). Bao skipped those cookies. Skipping them is the default, and the site sent Bao's Chrome to a login page. Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated. You can include anti-bot cookies for this site and import again. They are bound to the browser that received them, so the session often still fails.

The anti-bot cookies were included, and the probe still failed:

> Bao imported the anti-bot cookies as well. The site still sent Bao's Chrome to a login page. Those cookies are tied to the browser that received them. Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated.

Nothing about those cookies explains the miss:

> The session did not stick. Sign in once in Bao's window. That is the reliable path. Bao will not spoof a fingerprint, solve a captcha, or hide that this Chrome is automated.

The vendor in parentheses follows the cookies that were actually present. Two vendors are joined with "and". The same sentences are the ones on the result card.

## macOS keychain

On macOS the cookie key is the keychain item "Chrome Safe Storage", account Chrome. Bao runs `security find-generic-password -s "Chrome Safe Storage" -a Chrome -w` and waits up to 60 seconds. The password is the PBKDF2 password as the string the keychain returns. Bao does not base64-decode it. The KDF is PBKDF2-HMAC-SHA1, salt `saltysalt`, 1003 iterations, a 16-byte key, AES-128-CBC, and an IV of 16 spaces.

Linux v10 uses the password `peanuts` and 1 iteration. Linux v11 uses the libsecret password (`chrome_libsecret_os_crypt_password_v2`, then the v1 schema) with the same KDF, and Bao retries the empty password Chrome still accepts. This build does not decrypt Windows cookies. The result there tells the person to sign in once in Bao's window.

Cookie DB meta version 24 and later (Chrome 130 through the current 15x line; Chromium main is still 24) stores raw SHA-256 of `host_key` in front of the decrypted value. The file's `meta` version is what Bao trusts. A 129 build that already wrote meta 24 is treated as prefixed. Older files are not stripped. A prefix that does not match the row's host is rejected with `host prefix does not match`. A row that has both a plaintext value and an encrypted value is rejected. `v12` and `v20` are `unsupported cipher`.

Preview does not need the key. On macOS the picker says:

> **macOS will ask for Chrome Safe Storage**
>
> When you import, macOS asks whether bao may use the "Chrome Safe Storage" item in your keychain. Click Always Allow. If you do not see the prompt, look behind this window. Allow once makes the next import ask again.

**Always Allow** keeps the next import from asking again. **Allow** once asks the next time. If the prompt is behind the window, that is a missed prompt, not a wrong password.

If the prompt is missed, dismissed, or the item is absent, Bao does not decrypt, does not launch Chrome, and does not load the probe. The result is `Imported 0. Signed in: no.` The sentence under it is `Bao did not load the site, because the cookies could not be decrypted.` The note for a missed prompt is:

> **Allow the Chrome Safe Storage prompt**
>
> The keychain prompt was not answered. It may be behind this window. macOS asks whether bao may use the "Chrome Safe Storage" item in your keychain. That item is the key for this site's cookies. Click Always Allow. Allow once makes the next import ask again. A missed prompt does not mean the password was wrong. Bao reads cookies only for the site you clicked, and it does not show cookie values.

A dismissed prompt starts with `The keychain prompt was dismissed.` A missing item is titled `Chrome Safe Storage is not in the keychain` and says Bao looked for that item and did not decrypt any cookies. The secret itself is not shown, logged, or written into the result.
