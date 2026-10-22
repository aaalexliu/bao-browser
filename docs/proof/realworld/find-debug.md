# Find debug, p1 p3 p7 p8

Replayed the saved workflows (not a new recording) and wrote a shot at the moment find gave up. Screenshots and the raw probe are in `docs/proof/realworld/find-debug/`.

The accept line is still 60 and the margin is still 25. None of these misses is a threshold problem. Each page is the page the step recorded, the target is in the DOM, and two or more controls share a score above 60. `locate` then reports that tie as `below-threshold`.

## p1 Type {{username}}

- Shot: `docs/proof/realworld/find-debug/wf-1792674880957-2.png`
- URL: `https://automationexercise.com/login`
- Direct query: `input[name="email"]` count 2, visible 2. Role `textbox` with an empty recorded name count 5, visible 5.
- Top candidates: index 11 and index 18, both textboxes, both `nameAttr` email, both score 70 (`nameAttr` 70). Everything else scores 0.
- Locator scores: role 40, css 40, xpath 40.

The login form and the signup form both use `name="email"`. The recording stored that name and a role locator with an empty name. It did not store `data-qa="signup-email"` or the structural css path, so nothing scored 100 and the two 70s tied.

The runner's step status was `paused / bot check` on this same step. The find had already missed. The miss path then classified the login page as a bot wall even though both email fields were on the page. That is the same class of false wall as p6 (a challenge signal that is not blocking the recorded target).

Cause: ambiguous recorded locators. The page and the target are right.

## p3 Click "Book now"

- Shot: `docs/proof/realworld/find-debug/wf-1792675070495-1.png`
- URL: `https://automationintesting.online/`
- Direct query: role `link` name `Book now` count 3, visible 3. Text `Book now` count 3, visible 3.
- Top candidates: indexes 17, 18, and 19, each a link with text `Book now`, each score 110 (`roleName` 70 + `text` 40).
- Locator scores: role 40, text 40. No css, href, or test id was recorded.

Cause: three identical "Book now" links. The recording did not keep the href (`/reservation/1`) or the structural path, so the scorer tied them.

## p7 Click "Search"

- Shot: `docs/proof/realworld/find-debug/wf-1792675703188-2.png`
- URL: `https://en.wikipedia.org/wiki/Special:Search`
- Direct query: role `button` name `Search` count 2, visible 2. Text `Search` count 7, visible 3.
- Top candidates: four buttons with text `Search` (indexes 44, 88, 188, 192), each score 110 (`roleName` 70 + `text` 40). A link "Search Wikipedia [alt-f]" scores 40 on text only.
- Locator scores: role 40, text 40. No id or css path was recorded.

Cause: several controls share the accessible name Search. The type step before this one had already passed, so the page was the search page and had settled. The recording did not keep a path that names one button.

## p8 Click "edit"

- Shot: `docs/proof/realworld/find-debug/wf-1792675790341-1.png`
- URL: `https://the-internet.herokuapp.com/challenging_dom`
- Direct query: role `link` name `edit` count 10, visible 10. Text `edit` count 10, visible 10.
- Top candidates: the first five of those links (indexes 5, 7, 9, 11, 13), each score 110 (`roleName` 70 + `text` 40).
- Locator scores: role 40, text 40. No css path was recorded. Every edit link's href is `#edit`, so the href alone does not pick a row.

Cause: ten identical edit links. Row text changes between loads, so the structural css path is the locator that still names the recorded row.

## Second recording, after css path and href were stored

The locator change did not make these four tasks pass. A new recording of each one, replayed twice, still missed. The shots above are the first probe. These are the causes on the new workflows.

### p1 Click Continue

The Continue step stored expect and postcondition `url /account_created`. During capture the only URL change was `#google_vignette` on `/account_created`. `urlCheck` treated any string difference as a navigation and kept the pathname. Replay dismisses that overlay, Continue goes home, and the expect fails. Replay 2 reuses the same profile, still logged in, so the signup name field is not the field the step looks for.

Cause: a hash-only URL change was recorded as a navigation. The page was right. The scorer was not asked.

### p3 one night

Book now was found by its css path. The stay was not. The booking calendar is `.rbc-calendar`. Clicking the day buttons does not select a range. The fold kept the last picker click (day 07) as one date, and replay showed the default `£100 x 1 nights`. A drag from the 5th through the 6th is the selection the page shows as 2 nights. The grand total includes a cleaning fee and a service fee, so it is not nights times the rate.

### p7 Click Search, then history

Before the query is typed, the header control is `#searchform > button:nth-of-type(1)`. Typing reparents it to `#searchform > div:nth-of-type(1) > button:nth-of-type(1)`. The recorded click is not a pointer click: pressing Enter fires a trusted click with `detail` 0 on that button, and the path was taken from the button before the suggestion popup rewrote it. After replay types, that css path matches nothing. Two visible Search buttons then tie. On `useskin=vector` the header control is `input#mw-searchButton`, the role match is the other Search button, and it submits an empty advanced search (`search=`). The history link is then looked up on that search page, not on the article.

Cause: the recorded action is Enter. The page state after typing is not the state the css path was taken from. The scorer tied the buttons that remained.

### p8 Click Gallery

Replay URL was `https://the-internet.herokuapp.com/challenging_dom#edit`. The edit link was found. Gallery is on `/shifting_content/menu`, which the capture opened with `page.goto`. The in-page recorder does not see that navigation, so replay never left the DOM challenge page. Gallery is not there. The same gap drops the windows page and the alerts page.

Cause: replay is on the wrong page.

## What changed

The recorder now stores `data-testid`, `data-qa`, `data-test`, and `data-cy` as the test id, plus the structural css path and a link's href. Replay tries that path and href after the shared name. A single hit still scores 100. A shared name still scores 40 and still loses. Empty role names are no longer stored. Thresholds are unchanged.

The second recording's misses are not scored differently. A hash-only URL change is not a navigation. Enter in a field is recorded as Enter, and the detail-0 submit click it causes is not a second step. A capture `goto` is a navigate step. The booking stay is the calendar's drag range, read after the selection bar paints, and the night check counts the room line and the fees that sit between it and the total.

## p2 Select {{text}}

Not part of the find probe. The saved workflow `docs/proof/realworld/workflows/p2.json` (recorded before the date-picker skip) has two select steps whose accessible name is the option list, truncated at 80 characters: `January February March April May June July August September October November Dec` and `1900 1901 1902 ...`. The live dump of a `<select>` shows only the selected option, and those selects sit inside a closed `.react-datepicker` until the date field is opened. The role and text locators therefore match nothing on the settled form.

A recording made after the input-kinds change does not emit those steps: a `change` inside `.react-datepicker`, `.rbc-calendar`, or `[data-bao-picker]` is ignored and left for the date-picker fold. The miss is the old option-list locator against a closed popup, not the select action itself.

## After those locator misses were fixed

The four probes above were ties on the right page. ACCEPT stayed 60 and MARGIN stayed 25. Later recordings of the same tasks missed for other reasons, and those are what the passing runs fixed:

- p1 replay 2 clicked Delete Account and stayed on `/contact_us#google_vignette`. The ad script swallowed the navigation. The link was on the page. Replay follows that link when the hash is the only URL change.
- p8 replay 2 reached the alerts page and the New Window heading, and the result line was `You entered:` with an empty value. Replay 1 and replay 2 share one page. The first dialog handler accepted the prompt before the second driver supplied `beta-prompt`. One handler is kept per page.
- p3 passed once the stay was a drag on `.rbc-calendar` (05 through 06 is 2 nights; run 2 shifts the end by one day). The grand total includes the cleaning and service fees.
- p7 passed once Enter was the search step, and the vector run clicked `#searchButton` (Go) instead of the full-text Search button.

p1, p3, p7, and p8 are 2/2 with 0 model calls. End-state keyframes are in `docs/proof/realworld/artifacts/`.
