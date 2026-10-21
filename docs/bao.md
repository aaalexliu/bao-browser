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

Wikipedia resize to 880×560 fails closed on both locator modes. Vector hides `#searchInput` below about 1120px (the box is 0×0) and shows a search link instead. Locators skip a collapsed box. The label repair does too, so it does not fill the invisible input. The step fails in locate, attribute `role`, fixed by none. The Enter step is n/a because replay stopped. Move keeps a 1280×720 viewport and only relocates the window, and that passed.

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
