# Real-world proof

Measured on Linux with headless Chrome from v1/desktop. Replay video is macOS-only, so each browser replay saved keyframes. Pass means both the doc's check and 0 model calls. ACCEPT stays 60 and MARGIN stays 25.

p1 and p8 were recorded and replayed again after the vignette and dialog-handler fixes. p3 and p7 are the passing measurement from the same tree (drag range, Enter, and the vector Go button). p2, p4, p5, p6, and p9 were not remeasured in this run. p5 and p9 are left on purpose.

| Task | Pass | Model calls | Heals | First failure |
|---|---|---|---|---|
| p1 Sign-up, contact upload, delete account | 2/2 | 0, 0 | 0 ; 0 | — |
| p2 Practice form with date picker and dependent selects | 0/2 | 0, 0 | 0 ; 0 | select "Select {{text}}": option-list name, closed date popup |
| p3 Booking, stop before reserve | 2/2 | 0, 0 | 0 ; 0 | — |
| p4 Trial search and CSV download | 0/2 | 0, 0 | 0 ; 0 | not remeasured; previous run typed an empty change into disabled `#from-age-input` |
| p5 Paginated catalog to CSV | 0/2 | 0, 0 | 0 ; 0 | no extract or CSV output; category is a click, not an input |
| p6 Spreadsheet rows into a web table | 0/2 | 0, 0 | 0 ; 0 | not remeasured; previous run paused on a reCAPTCHA iframe in the ad stack |
| p7 Wikipedia history across skins | 2/2 | 0, 0 | 0 ; 0 | — |
| p8 Unstable DOM, new tab, JS dialogs | 2/2 | 0, 0 | 0 ; 0 | — |
| p9 Shadow-DOM shop, stop before place order | 0/2 | 0, 0 | 0 ; 0 | no confirm gate before Place Order |

## Failure causes

The four passing tasks are not in this list. The rows below are the tasks this run did not turn green.

1. p2 — the saved select step's accessible name is the month or year option list, truncated at 80 characters. The live `<select>` shows only the chosen option, and it sits inside a closed `.react-datepicker`. A recording after the input-kinds change does not emit that step: a `change` inside `.react-datepicker`, `.rbc-calendar`, or `[data-bao-picker]` is ignored.
2. p4 — not remeasured. The recorder now skips an empty `change` on a hidden or closed field and scrolls a click target into view. The previous run never stored the Recruiting checkbox or the download.
3. p5 — left for the extract step. p9 — left; a confirm gate before Place Order is a separate feature.
4. p6 — not remeasured on demoqa. A bot wall now requires a visible challenge widget, a known interstitial title or body, or a document-level 403/429 with challenge markers, and the recorded target has to be missing. A hidden reCAPTCHA iframe does not pause. Fixture: `/ads` in `desktop/test/live/page-class.test.ts`, and the unit case in `desktop/test/unit/page-class.test.ts`.

## Per task

### p1 Sign-up, contact upload, delete account

Site: automationexercise.com

Replay 2 of the previous recording clicked Delete Account and stayed on `/contact_us#google_vignette`. The ad script swallowed the navigation. Replay now follows the link when that hash is the only URL change. This recording passed 2/2.

Recorded:

```json
{
  "id": "wf-1792682765516",
  "openUrl": "https://automationexercise.com/login",
  "startUrl": "https://automationexercise.com/login",
  "steps": 29,
  "actions": {
    "navigate": 2,
    "type": 14,
    "click": 7,
    "check": 1,
    "select": 4,
    "upload": 1
  },
  "inputs": [
    "name:text=Bao Record",
    "username:text=bao-record-mvjp070t@example.com",
    "password:secret",
    "days:text=10",
    "months:text=January",
    "years:text=1990",
    "first_name:text=Bao",
    "last_name:text=Record",
    "country:text=Canada",
    "address1:text=1 Proof Street",
    "state:text=Ontario",
    "city:text=Toronto",
    "zipcode:text=M5V1A1",
    "mobile_number:text=5550100000",
    "name2:text=Bao Record",
    "username2:text=bao-record-mvjp070t@example.com",
    "subject:text=Proof note",
    "file:file",
    "message:text=Hello from the proof record."
  ],
  "labels": [
    "navigate Open https://automationexercise.com/login",
    "type Type {{name}}",
    "type Type {{username}}",
    "click Click \"Signup\"",
    "check Check \"Mr.\"",
    "click Click \"Mr.\"",
    "type Type secret",
    "select Select {{days}}",
    "select Select {{months}}",
    "select Select {{years}}",
    "type Type {{first_name}}",
    "type Type {{last_name}}",
    "select Select {{country}}",
    "type Type {{address1}}",
    "type Type {{state}}",
    "type Type {{city}}",
    "type Type {{zipcode}}",
    "type Type {{mobile_number}}",
    "click Click \"Create Account\"",
    "click Click \"Continue\"",
    "navigate Open https://automationexercise.com/",
    "click Click \"Contact us\"",
    "type Type {{name2}}",
    "type Type {{username2}}",
    "type Type {{subject}}",
    "upload Upload file",
    "type Type {{message}}",
    "click Click",
    "click Click \"Delete Account\""
  ]
}
```

Replay 1: pass (passed), model calls 0, heals 0. End URL `https://automationexercise.com/delete_account`, text includes ACCOUNT DELETED!

Replay 2: pass (passed), model calls 0, heals 0. Same end state for the second account.

Artifacts:

- `docs/proof/realworld/artifacts/p1-r1.png`
- `docs/proof/realworld/artifacts/p1-r2.png`

### p2 Practice form with date picker and dependent selects

Site: demoqa.com/automation-practice-form

Not remeasured. The saved workflow `docs/proof/realworld/workflows/p2.json` (recorded before the date-picker skip) has two select steps whose accessible name is the option list, truncated at 80 characters: `January February March April May June July August September October November Dec` and `1900 1901 1902 ...`. The live dump of a `<select>` shows only the selected option, and those selects sit inside a closed `.react-datepicker` until the date field is opened. The role and text locators therefore match nothing on the settled form.

A recording made after the input-kinds change does not emit those steps. The miss is the old option-list locator against a closed popup, not the select action itself. The last scored run was 0/2, 0 model calls, 0 heals, first failure `select "Select {{text}}"`.

### p3 Booking, stop before reserve

Site: automationintesting.online

Book now is found by its css path. The stay is a drag on `.rbc-calendar` from the 5th through the 6th, which the page shows as 2 nights. Run 2 shifts the checkout input by one day (3 nights). The grand total includes the cleaning fee and the service fee. Reserve Now is a confirm step, so the run pauses there and the proof counts that pause as a pass.

Recorded:

```json
{
  "id": "wf-1792681340536",
  "openUrl": "https://automationintesting.online/",
  "startUrl": "https://automationintesting.online/",
  "steps": 4,
  "actions": {
    "navigate": 1,
    "click": 2,
    "confirm": 1
  },
  "inputs": [
    "checkIn:date=+14d",
    "checkOut:date=+15d"
  ],
  "labels": [
    "navigate Open https://automationintesting.online/",
    "click Click \"Book now\"",
    "click Pick {{checkIn}} to {{checkOut}}",
    "confirm Confirm \"Reserve Now\""
  ]
}
```

Replay 1: pass (paused, confirm), model calls 0, heals 0. £100 x 2 nights, room £200, total £240.

Replay 2: pass (paused, confirm), model calls 0, heals 0. £100 x 3 nights, room £300, total £340.

Artifacts:

- `docs/proof/realworld/artifacts/p3-r1.png`
- `docs/proof/realworld/artifacts/p3-r2.png`

### p4 Trial search and CSV download

Site: clinicaltrials.gov

Not remeasured after the recorder change. The previous run was 0/2, 0 model calls, 0 heals. Empty `change` events from the closed advanced date fields became type steps, and replay filled the disabled age field `#from-age-input`. The Recruiting checkbox `#adv-check0-status1` was outside the viewport, so it was never recorded and the download step was never stored.

The recorder now drops an empty `change` when the field is hidden or closed, and a drive click scrolls the target into view before clicking.

### p5 Paginated catalog to CSV

Site: books.toscrape.com

Left for the extract step. Last measurement 0/2, 0 model calls. The recording is a navigate and a click on Travel. Mystery and Historical Fiction were not inputs, and there is no CSV.

### p6 Spreadsheet rows into a web table

Site: demoqa.com/webtables

Not remeasured. The previous run paused on Click Add because an ad-stack reCAPTCHA iframe (`/recaptcha/api2/aframe`) was classified as a bot wall while the table was on screen. A real wall holds the proof for the act timeout, so this task was not started again.

The classifier now requires a challenge that is actually blocking: a visible widget at least 40 by 40, a known interstitial title or body, or a document-level 403/429 with challenge markers, and the recorded target must be missing. An iframe src or a marker class alone does not pause. The `/ads` fixture is a working page with a hidden reCAPTCHA iframe and must not pause.

### p7 Wikipedia history across skins

Site: en.wikipedia.org

Enter in the search field is the search step. The detail-0 click that Enter synthesizes is not recorded. Run 2 uses `useskin=vector` and replaces that Enter with a click on `#searchButton` (Go). The history link is `#ca-history > a`.

Recorded:

```json
{
  "id": "wf-1792681416284",
  "openUrl": "https://en.wikipedia.org/wiki/Special:Search",
  "startUrl": "https://en.wikipedia.org/wiki/Special:Search",
  "steps": 4,
  "actions": {
    "navigate": 1,
    "type": 1,
    "key": 1,
    "click": 1
  },
  "inputs": [
    "search:text=Baozi"
  ],
  "labels": [
    "navigate Open https://en.wikipedia.org/wiki/Special:Search",
    "type Type {{search}}",
    "key Press Enter",
    "click Click \"Past revisions of this page [alt-h]\""
  ]
}
```

Replay 1: pass (passed), model calls 0, heals 0. Baozi history, revision 19:53, 4 October 2026.

Replay 2: pass (passed), model calls 0, heals 0. Xiaolongbao history on `useskin=vector`, revision 03:15, 21 October 2026.

Artifacts:

- `docs/proof/realworld/artifacts/p7-r1.png`
- `docs/proof/realworld/artifacts/p7-r2.png`

### p8 Unstable DOM, new tab, JS dialogs

Site: the-internet.herokuapp.com

Capture `goto` is a navigate step, so Gallery, the new window, and the alerts page are on the recording. The prompt value is an input, and the expect is `You entered: {{prompt}}`. Replay 1 and replay 2 share the page. The first dialog handler was accepting the prompt before the second driver supplied the text. One handler is kept per page.

Recorded:

```json
{
  "id": "wf-1792682913207",
  "openUrl": "https://the-internet.herokuapp.com/challenging_dom",
  "startUrl": "https://the-internet.herokuapp.com/challenging_dom",
  "steps": 10,
  "actions": {
    "navigate": 4,
    "click": 6
  },
  "inputs": [
    "prompt:text=proof-prompt"
  ],
  "labels": [
    "navigate Open https://the-internet.herokuapp.com/challenging_dom",
    "click Click \"edit\"",
    "navigate Open https://the-internet.herokuapp.com/shifting_content/menu?mode=random",
    "click Click \"Gallery\"",
    "navigate Open https://the-internet.herokuapp.com/windows",
    "click Click \"Click Here\"",
    "navigate Open https://the-internet.herokuapp.com/javascript_alerts",
    "click Click \"Click for JS Alert\"",
    "click Click \"Click for JS Confirm\"",
    "click Click \"Click for JS Prompt\""
  ]
}
```

Replay 1: pass (passed), model calls 0, heals 0. Page text includes `You entered: alpha-prompt` and New Window.

Replay 2: pass (passed), model calls 0, heals 0. Page text includes `You entered: beta-prompt` and New Window.

Artifacts:

- `docs/proof/realworld/artifacts/p8-r1.png`
- `docs/proof/realworld/artifacts/p8-r2.png`

### p9 Shadow-DOM shop, stop before place order

Site: shop.polymer-project.org

Left. A confirm gate before Place Order is a separate feature. Last measurement 0/2, 0 model calls, first failure `no confirm gate before Place Order`.
