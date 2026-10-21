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
