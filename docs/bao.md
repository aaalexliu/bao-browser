# Bao spike log

Earlier desktop notes are in [v1.md](v1.md) and the fixture drift report is [drift-linux.md](drift-linux.md). This file is the log for spikes after that.

## 2026-10-21 — Real-app drift and multi-locator

Recorded three public login-free pages and two stock Linux apps into schema-v2 workflows, then replayed them with no model. A second pass tried every stored locator before the repair tiers. Profiles and app homes were throwaway directories. Nothing here is a person's real session.

Targets: English Wikipedia search (Spanish portal for language), Python 3 docs search (Spanish docs for language), the-internet dynamic loading, GNOME Calculator 7+5=, gedit typing into a throwaway `note.txt`. A fourth page, the-internet add/remove elements, is the stale-name repair and the live heal, not a visual mutation of the site.

### What passed

Multi-locator web rates are in [drift-real.md](drift-real.md). Primary-only rates are in [drift-real-before.md](drift-real-before.md). Desktop rates are in [drift-real-desktop.md](drift-real-desktop.md).

Web, multi-locator, scored steps: move 6/6, resize 4/5, scale 6/6, theme-dark 6/6, theme-light 6/6, font 6/6, lang 5/5, slow 6/6. Dynamic loading has no second language here, so that row is n/a. The one resize failure is Wikipedia. Python docs search and dynamic loading passed resize.

Desktop, both locator modes: calculator and gedit passed baseline, move, resize, 2x scale, Adwaita-dark, Adwaita, and a 1.5 DPI font scale. Language is n/a because only `en_US.utf8` is installed. Network throttle is n/a because these apps do not load a page. Calculator's equals step needed the expect wait on scale, both themes, and the font scale. The label `12` showed up after the click.

Language is where a later locator changes the result. Primary tries the role name only. Spanish renames the fields (`Search Wikipedia` / `Search` versus `Buscar en Wikipedia` / `Búsqueda`) and leaves the id or the `name` attribute.

| workflow | change | primary | multi | what fixed the multi pass |
| --- | --- | --- | --- | --- |
| wikipedia-search | lang | 0/1 | 2/2 | css `#searchInput`, then the expect wait |
| python-search | lang | 0/1 | 3/3 | css on the click and the type, then the expect wait |
| internet-add | stale-label | 1/1 | 1/1 | label repair both times, not a later locator |

The stale step's recorded name is `Add Element now`. The live button is `Add Element`. Detail: `Add Element ~ Add Element (1.00)`.

GNOME Calculator's button and its inner label share a name. Role is 20 points, under the 25 point margin, so the scorer ties them. Digit replay then takes the one node whose role is `button`. That is not a second stored locator. gedit's only locator is role `text` with an empty name, the unnamed document. Multi-locator did not change either desktop result.

### What failed

Wikipedia resize to 880×560 failed closed on both locator modes in this run. Vector hides `#searchInput` below about 1120px (the box is 0×0) and shows a search link instead. Locators skip a collapsed box. The label repair does too, so it does not fill the invisible input. The step fails in locate, attribute `role`, fixed by none. The Enter step is n/a because replay stopped. The next section fixes that with a reveal repair. Move keeps a 1280×720 viewport and only relocates the window, and that passed.

The Wikipedia workflow is fill plus Enter. A click on `#searchInput` opens the typeahead and the node the click found is not the node the next step has to type into.

gedit's interpreted value postcondition asks for the buffer in `values`. The AT-SPI driver does not put the buffer there, so that postcondition is dropped. The check is the dirty-tab label `*note.txt`.

### Heal

The heal workflow's locators all say `Submit freeze` / `#missing-add`. Repairs refused. `cursorHeal` wrote `heal-request.json` and `heal-shot.png` and waited. The response identity is the only button in that failure DOM, text `Add Element`. No `BAO_HEAL_FIXTURE`, no canned provider. The audit model is `cursor` version `live`. The patched step passed its expect (`Delete`). It stayed provisional through theme-dark and resize, then two replays, then promoted. The trail is [heal-real-trail.jsonl](heal-real-trail.jsonl).

### Puppeteer replay export

`toPuppeteerReplay` writes Chrome DevTools Recorder JSON. Role plus name becomes `aria/<name>`. Anchor locators are omitted. Click steps set `offsetX` and `offsetY` to 1 because `@puppeteer/replay` 4.0.2 forwards a missing offset as `undefined`, and Puppeteer 25 then waits until timeout. A one-click export of a local fixture ran under `@puppeteer/replay` 4.0.2 with `puppeteer-core` against Playwright's Chromium. The page text was `Go` then `clicked`. The file is [puppeteer-replay-proof.json](puppeteer-replay-proof.json). Those packages are not added to this repo.

### Proof

Unit and property tests: 76 passed. `tsc -p tsconfig.desktop.json --noEmit` was clean after the last edit.

Screen recordings from this run:

- `/opt/cursor/artifacts/python-search-theme-resize.mp4` — Python docs search, dark theme, viewport 880×560. The process printed `WEB passed` and the URL `https://docs.python.org/3/search.html?q=json`.
- `/opt/cursor/artifacts/calculator-move-scale.mp4` — Calculator launched at `GDK_SCALE=2`, window moved, then 7+5=. The process printed `CALC passed`.
- `/opt/cursor/artifacts/stale-label-repair-trail.mp4` — Add Element recovered by the label repair, with the trail entry on screen. The process printed `repair: label` and `Add Element ~ Add Element (1.00)`.

The heal screenshot is `/opt/cursor/artifacts/heal-shot-add-element.png`. The repair and heal trails are also under `/opt/cursor/artifacts/`.

## 2026-10-21 — Reveal, phase checks, read-back receipts, trajectory diff

Same public pages and the same two Linux apps. Throwaway profiles and a throwaway gedit file. No account login.

### What passed

Wikipedia at 880×560 passes in both locator modes. Vector still collapses `#searchInput` to a 0×0 box. Replay treats that box, or a node marked hidden, as unusable. It clicks a recorded `reveal` locator when the step has one, otherwise the one visible Search or Buscar link or button in the search landmark, and logs `repair: reveal`. It then tries every stored locator, because the field that opens is not the collapsed node (role `input` becomes `combobox`). The text locator hits the visible field. Fill plus Enter reaches `https://en.wikipedia.org/wiki/Ada_Lovelace`.

The resize row is 6 passed, 0 failed, 0 n/a. Both Wikipedia steps pass. The previous row was 4 passed, 1 failed, 1 n/a.

Nothing else in the suite moved. Multi-locator web: move 6/6, scale 6/6, theme-dark 6/6, theme-light 6/6, font 6/6, lang 5/5 (dynamic loading n/a), slow 6/6, stale-label 1/1. Primary language is still 0/1 on Wikipedia and Python; multi still uses the css locator. Desktop calculator and gedit stay 100% on baseline, move, resize, scale, both themes, and font. Language and network throttle stay n/a.

A step can carry `waitFor`, `expect`, and `gone`. A miss is reported as `wait_for`, `find`, `action`, or `expect`, plus the reason. `gone` fails in `expect`. The drift failure table has a phase column. The run viewer puts that phase on the step row.

A step or the workflow can declare a `readBack`. The run appends a receipt: expected, what was read, pass or fail, and a sha256 over the canonical body including the previous hash. The file is append-only JSONL. A `file` source reads only a path under the temp directory, supplied at runtime, never stored on the step. The local fixture form types a note, clicks Save note, and re-reads the saved text. gedit types into a throwaway `note.txt`, sends Ctrl+S, and re-reads the file (`bao note`). The credit-freeze example's Apply step re-reads `Status: Frozen` on the local `/freeze` page. That is the shape a later "verify freeze status after Apply" step uses. It is not a credit bureau and no account was opened.

Replay writes a trajectory per step: target identity, action, postcondition, and a timing bucket (under 1s, under 10s, under 60s, 60s or more). The drift reports diff that against the recording in plain sentences. A diff does not change the pass rate. On Wikipedia resize the type step aimed at `input#searchInput` in the recording and at `combobox[name=search]` on replay, and Enter moved from under 1s to under 10s. Calculator and gedit baseline matched.

### What failed

No scored drift step failed in this run.

### Proof

Unit and property tests: 86 passed. `tsc -p tsconfig.desktop.json --noEmit` was clean after the last edit.

```
BAO_BROWSER=/usr/bin/google-chrome BAO_REAL_PART=web node desktop/dist/desktop/src/v1/real-drift.js
BAO_REAL_PART=desktop node desktop/dist/desktop/src/v1/real-drift.js
```

Reports: [drift-real.md](drift-real.md), [drift-real-before.md](drift-real-before.md), [drift-real-desktop.md](drift-real-desktop.md).

- `/opt/cursor/artifacts/wikipedia-880-reveal-repair.mp4` — Wikipedia at 880×560. The search toggle opens, the article is Ada Lovelace, and the trail shows `repair: reveal` / `recorded role Search`.
- `/opt/cursor/artifacts/run-viewer-receipt.png` — fixture note replay. Receipt pass, expected Ada Lovelace, read Ada Lovelace.
- `/opt/cursor/artifacts/run-viewer-phase-failure.png` — a `wait_for` miss on a banner the fixture never shows.

## 2026-10-21 — Logged-out replay and a masked password

Local fixture only. `GET /freeze` redirects to `/login` when the `bao_freeze` cookie is missing or expired. The login page asks for a username, then a `type=password` field. `?verify=1` adds a "Verify it's you" code stage. The cookie is a random token. The password is not stored. Profiles were throwaway directories. No real site, account, or credential.

The credit-freeze workflow's precondition is `{ kind: "url", match: "/freeze", phase: "auth" }`. A replay that lands on `/login` fails that check in phase `auth`. It does not call a model, including when a heal provider is available. Cheap repairs still run for locate misses. Auth is not one of those.

The login step has two paths. With no secret, replay shows the same confirm-style banner, title "Sign in on the site window", and waits. With the password supplied on the upfront secret input, replay fills the masked field and does not show that banner. Either way it continues on `/freeze`, clicks Frozen, re-reads `Status: none`, and pauses on the confirm step. The workflow has no Apply click. A confirm step with no postcondition pauses and does not write a `human-confirm` trail event. While that event is absent, replay refuses Apply clicks from the step, from a repair, and from a heal. The fixture counts Apply posts. The count stayed 0.

A password field recorded in a capture session becomes a `secret` input with no default. The page script does not read the field's value. Interpret drops a leaked password string. Saved runs are masked. Screenshots cover `input[type=password]` with a black bar before the PNG is taken, and the accessibility snapshot is omitted while that field is on the page.

### What passed

`tsc -p tsconfig.desktop.json --noEmit` was clean. Desktop unit tests: 98 passed, 0 failed, including the fast-check property that replays a logged-out workflow and scans the written workflow, run, trail, receipts, and log. The headed fixture runs below also scanned the library directory and the PNGs. Match count was 0.

- `/opt/cursor/artifacts/auth-logged-out-human-handoff.mp4` — logged-out replay. The banner "Sign in on the site window" is up, a scripted human signs in on the fixture, the password field is bullets, replay resumes, and it stops on "Press Apply on the site window." Status stays `Status: none`.
- `/opt/cursor/artifacts/auth-logged-out-secret-fill.mp4` — the same replay with the secret typed into the upfront password field (bullets). The site field is bullets. No sign-in banner. Stops at the confirm banner. Apply is not pressed.
- `/opt/cursor/artifacts/auth-logged-out-artifact-grep.mp4` — artifact grep of the stills, both videos, and the two library directories. `matches: 0`. The needle is not printed.
- `/opt/cursor/artifacts/auth-logged-out/a-login-banner.png` — the sign-in banner next to the fixture login page.
- `/opt/cursor/artifacts/auth-logged-out/a-password-masked.png` — human path, password stage, bullets.
- `/opt/cursor/artifacts/auth-logged-out/a-confirm-stop.png` — paused confirm, receipt pass, `Status: none`.
- `/opt/cursor/artifacts/auth-logged-out/b-form-masked.png` — upfront secret field, bullets.
- `/opt/cursor/artifacts/auth-logged-out/b-site-masked-hold.png` — site password field, bullets, during the fill hold.
- `/opt/cursor/artifacts/auth-logged-out/b-secret-field-masked.png` — PNG taken while the field was covered. Black bar and dots. The file bytes do not contain the secret.
- `/opt/cursor/artifacts/auth-logged-out/b-confirm-stop.png` — secret path stopped at confirm.
- `/opt/cursor/artifacts/auth-logged-out/c-grep.png` — the grep page, matches 0.

### What failed

`desktop/test/live/browser.test.ts` ("capture login, upload, and drop, then replay with two input sets") still fails on the parent commit `346ac1b`, before these edits. The login step's stored locators include `testid` `login`. Replacing the identity with `missing-login` does not remove those locators, so replay passes with `heals` empty and the assertion wants model name `bao-heal-fixture`. This spike did not change that.

The replay form used to rebuild on each state change and drop a password that had been typed but not submitted. It now puts those typed values back, including the secret field. The secret is still not written to the library.

## Decisions

### 2026-10-22 — Read a failure before healing it

Compared with Playwright trace viewer, mabl, Momentic, and Skyvern, the run viewer was a filmstrip of equal frames and a single failure card. It now keeps a per-step identity score table, the step's accessibility and DOM snapshot, and the console and network lines captured on that browser. Filmstrip width follows the step, and gaps longer than a second are left out. The failure card opens the step that stopped.

Healing is no longer one switch for the whole workflow. A step can be auto, ask, or never, so a confirm step stays with the person. A provisional locator promotes after a drift suite and N later real runs (default 3, set in Settings). A miss is classed before any model call: a real change may be healed, a temporary blocker or an outage is not. Auto-heal also opens a circuit when three runs of that workflow fail within ten minutes. The "you need to act" wait defaults to 120 minutes and is the same bar, notification, and badge.

### 2026-10-22 — Heal on the Cursor account

The healer used to swap files with a Cursor session (`BAO_HEAL_CURSOR=1` writes `heal-request.json` and waits for `heal-response.json`). That still works. It is the fallback, not the first try.

**Use the Cursor CLI print mode when `agent login` has already been done.** `agent status --format json` is the check. Logged out, CLI 2026.10.19-6bbf2c4 prints `{ "status": "unauthenticated", "isAuthenticated": false }` and exits 0. Logged in, the same command prints `status: "authenticated"` and `isAuthenticated: true` (CLI source `src/commands/status.ts`). A partial login (`hasAccessToken` without a refresh token) is not a session. bao treats only `isAuthenticated: true` as able to heal.

The call is `agent --print --mode ask --trust --sandbox enabled --output-format stream-json --workspace <empty temp dir>`. The prompt is written to stdin. The CLI reads stdin only when the argument prompt is empty and stdin is not a terminal (`src/commands/build-prompt.ts`). bao does not put the prompt on the command line, and it never passes `--api-key` or reads `CURSOR_API_KEY`. If the user already exported that variable for the CLI, the process inherits it. The stream-json init event then says `apiKeySource: "env"`. A stored login is `login`. Passing `--api-key` would be `flag`; bao refuses that result. When both a stored login and a key are present, the CLI keeps the login (`src/commands/chat.ts` skips the key once the stored session is authenticated).

The heal record's provider is `cursor`. The name is the model on the init event (or `cursor-agent` when the event has none). The version is `login` or `env`. The file fallback stays `cursor` / `live`.

Billing follows the Cursor plan. Cursor's CLI docs say headless print mode is a normal agent request, and a Cursor staff reply on 2025-08-10 said IDE and CLI share the same plan pricing. This machine was not logged in, so no request was sent. `agent --print` here exited 1 with `Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY`.

**Do not use MCP sampling.** Cursor's MCP docs list tools, prompts, resources, roots, elicitation, and apps. Sampling is not in that list. A conformance run dated 2026-06-28 (Cursor 0.47) reports `sampling/createMessage` unimplemented. The MCP spec deprecated sampling in protocol `2026-07-28`. A bao MCP server that asked would get no answer, including when Cursor launched it.

**Do not use the Cursor HTTP APIs for this.** The documented APIs are admin, analytics, Cloud Agents, and the TypeScript SDK. Cloud Agents and the SDK run an agent over a workspace. They authenticate with `CURSOR_API_KEY` or a browser login that mints a key. They are not a one-shot identity patch, and they ask for a key bao would have to store. The CLI login does not.

`BAO_HEAL_CURSOR_ACCOUNT=0` skips the CLI. With no vendor key, no login, and without `BAO_HEAL_CURSOR`, healing stays off.

# Importing one site's login

Bao can bring a single site's session from the person's Chrome into Bao's own Chrome. The person names the site and clicks **Import this site's login from my Chrome**. That click is the only time Bao reads a Chrome profile. It reads the clicked site's origins and nothing else, and it never shows cookie values, localStorage values, or IndexedDB contents.

The form asks for the site. Probe URL, extra same-host origins, a signed-in selector or text, and the anti-bot choice sit under Advanced. A blank probe uses the page that was typed, when that page is an http or https URL. Otherwise it uses the origin. Anti-bot cookies are skipped unless Advanced says to include them.

The profile picker lists every profile in that Chrome's `Local State`: name, email, avatar or initials, how many cookies match the site, how many of those will be imported, how many are expired, how many are anti-bot cookies, the localStorage item count, and the IndexedDB origin count. A picture that is only one color is shown as initials on that color. The profile with the most matching cookies is already selected. The person can import that profile or decline. The act bar stays only while that choice is open. Bao does not assume `Default` when another profile has more matches.

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