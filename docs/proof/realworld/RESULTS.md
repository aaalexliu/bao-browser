# Real-world proof

Measured on Linux with headless Chromium (Playwright Chrome for Testing) from v1/desktop `410c1f7`, on 2026-10-22. One record and two replays per browser task. Replay window video is macOS-only (`BAO_HEADED` on darwin), so each browser replay saved a PNG and, when at least two frames existed, a keyframe webm. Pass means the doc's check held and the replay made 0 model calls.

Model calls are 0 on all 22 replays. Heals are 0 on all 22 replays. No heal model was configured: `healProvider` falls through to `cursorAccountHeal`, and this environment had no Cursor account heal session and no `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. A miss therefore stayed a miss. Two replays did record an overlay repair, which is not a heal: p4 replay 1 (`spinner`) and both p6 replays (`modal`).

The Cause column is read from the saved run JSON. The runner's raw phase labels were missing step type (7), lookup miss (2: p4, p6), action (1: p2), and bot wall (1: p14). Radio `locator.fill` is missing step type. p4's first step targets `#adv-date-start-from`. p6's lastName miss follows an overlay repair that dismissed the registration dialog. p9 recorded 0 steps and the page text was empty.

| Task | Pass | Model calls | Heals | Cause | First failure |
|---|---|---|---|---|---|
| p1 Sign-up, contact upload, delete account | 0/2 | 0, 0 | 0 ; 0 | missing step type | No open step. Both replays started at `https://automationexercise.com/account_created#google_vignette` instead of `/login`. First step `type {{name}}` find below-threshold. Recording had already stopped on that vignette page, before contact upload and delete. |
| p2 Practice form with date picker and dependent selects | 0/2 | 0, 0 | 0 ; 0 | missing step type | Both replays: `type {{gender}}` action `locator.fill` on `#gender-radio-1` (`type="radio"`, value Male): input of type radio cannot be filled. |
| p3 Booking, stop before reserve | 0/2 | 0, 0 | 0 ; 0 | missing step type | No open step. Both replays started at `https://automationintesting.online/reservation/1?checkin=2026-10-22&checkout=2026-10-23`. First step `click "Book now"` find below-threshold. |
| p4 Trial search and CSV download | 0/2 | 0, 0 | 0 ; 0 | date picker | Both replays: first step `type {{text}}` targets `#adv-date-start-from`, find below-threshold (css score 15). Replay 1 also logged overlay repair `spinner`. Download was never reached. |
| p5 Paginated catalog to CSV | 0/2 | 0, 0 | 0 ; 0 | missing step type | No open step. Both replays started at `.../travel_2/index.html`. First step `click "Travel"` find below-threshold (text score 40). |
| p6 Spreadsheet rows into a web table | 0/2 | 0, 0 | 0 ; 0 | dialog | Both replays: step 1 `type {{firstName}}` passed with `recovered: modal` (overlay repair dismissed the registration dialog). Next step `type {{lastName}}` find below-threshold on `#lastName` (score 0). The failure snapshot is the table, not the form. |
| p7 Wikipedia history across skins | 0/2 | 0, 0 | 0 ; 0 | missing step type | Replay 1 status passed (3/3 steps, 0 model calls) and the history page showed `19:53, 4 October 2026`, but there is no extract step to compare with the MediaWiki API. Replay 2 (`useskin=vector`) failed `click "Search"` find below-threshold (text score 40). |
| p8 Unstable DOM, new tab, JS dialogs | 0/2 | 0, 0 | 0 ; 0 | missing step type | No open step. Both replays started at `/javascript_alerts` instead of `/challenging_dom`. First step `click "edit"` find below-threshold. The new-tab and dialog steps did not run. |
| p9 Shadow-DOM shop, stop before place order | 0/2 | 0, 0 | 0 ; 0 | shadow DOM | 0 steps recorded. Both replays status passed with empty body text. Check failed: no confirm gate before Place Order. The record click `shop-app >> a.nth(8)` timed out; the link was not visible. |
| p10 TextEdit | needs Mac | — | — | — | needs Mac. Not run on Linux. |
| p11 W-9 download and Preview | needs Mac | — | — | — | needs Mac. Not run on Linux. |
| p12 CSV into Numbers | needs Mac | — | — | — | needs Mac. Not run on Linux. |
| p13 Excalidraw canvas | 0/2 | 0, 0 | 0 ; 0 | missing step type | 0 canvas steps recorded. Both replays status passed. Check failed: no embedded scene JSON; labels Alpha, Beta not verified. The record click `button:text-is('Rectangle')` timed out. |
| p14 Bot wall | 0/2 | 0, 0 | 0 ; 0 | bot wall | Cloudflare title `Just a moment...`, text `Performing security verification`. Both replays status `passed`, not `needs_human`. Heals 0, model calls 0, captcha clicks 0. Ray IDs `a4e88ea60e61c892` (replay 1) and `a4e88f652aeec892` (replay 2). |

## Failure causes

Ranked by how many browser tasks the first failure breaks. One count per task. Mac tasks are not counted. Eleven browser tasks failed 0/2.

1. missing step type — 7 tasks (p1, p2, p3, p5, p7, p8, p13)

The other four causes each break one task, so there is no unique second or third:

- date picker — 1 task (p4)
- dialog — 1 task (p6)
- shadow DOM — 1 task (p9)
- bot wall — 1 task (p14)

iframe, new tab, and download were not the first failure of any task. p1's recording stopped on a Google vignette (`#google_vignette`) before the replay's first failed step, which was the missing open. p8 recorded a new-tab click and JS dialog clicks, and those steps never ran. p4 never reached the CSV download. p3 recorded day-number clicks (`05`, `07`) on a reservation URL of 2026-10-22 to 2026-10-23, and those steps never ran.

## Per task

### p1 Sign-up, contact upload, delete account

Site: automationexercise.com

Recording error before stop: timed out waiting for "Logged in as" at https://automationexercise.com/account_created#google_vignette — Home  Products Cart Signup / Login Test Cases API Testing Video Tutorials Contact us ACCOUNT CREATED! Congratulations! Your new account has been successfully created!Get Writing T

Recorded:

```json
{
  "id": "wf-1792671600734",
  "openUrl": "https://automationexercise.com/login",
  "startUrl": "https://automationexercise.com/account_created#google_vignette",
  "steps": 19,
  "actions": {
    "type": 15,
    "click": 4
  },
  "inputs": [
    "name:text=Bao Record",
    "username:text=bao-record@example.com",
    "title:text=Mr",
    "password:secret",
    "days:text=10",
    "months:text=1",
    "years:text=1990",
    "first_name:text=Bao",
    "last_name:text=Record",
    "country:text=Canada",
    "address1:text=1 Proof Street",
    "state:text=Ontario",
    "city:text=Toronto",
    "zipcode:text=M5V1A1",
    "mobile_number:text=5550100000"
  ],
  "labels": [
    "type Type {{name}}",
    "type Type {{username}}",
    "click Click \"Signup\"",
    "type Type {{title}}",
    "click Click",
    "type Type secret",
    "type Type {{days}}",
    "type Type {{months}}",
    "type Type {{years}}",
    "type Type {{first_name}}",
    "type Type {{last_name}}",
    "type Type {{country}}",
    "type Type {{address1}}",
    "type Type {{state}}",
    "type Type {{city}}",
    "type Type {{zipcode}}",
    "type Type {{mobile_number}}",
    "click Click \"Create Account\"",
    "click Click \"Continue\""
  ],
  "recordError": "timed out waiting for \"Logged in as\" at https://automationexercise.com/account_created#google_vignette — Home  Products Cart Signup / Login Test Cases API Testing Video Tutorials Contact us ACCOUNT CREATED! Congratulations! Your new account has been successfully created!Get Writing T"
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792671600734-0 type Type {{name}} — no open step; replay started at the stop URL https://automationexercise.com/account_created#google_vignette instead of https://automationexercise.com/login. type "Type {{name}}": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792671600734-0 type Type {{name}} — no open step; replay started at the stop URL https://automationexercise.com/account_created#google_vignette instead of https://automationexercise.com/login. type "Type {{name}}": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p1-r1.png`
- `docs/proof/realworld/artifacts/p1-r1-frame-1.png`
- `docs/proof/realworld/artifacts/p1-r1-keyframes.webm`
- `docs/proof/realworld/artifacts/p1-r2.png`
- `docs/proof/realworld/artifacts/p1-r2-frame-1.png`
- `docs/proof/realworld/artifacts/p1-r2-keyframes.webm`

### p2 Practice form with date picker and dependent selects

Site: demoqa.com

Recording error before stop: POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.
Call log:
  - waiting for locator('label[for=hobbies-checkbox-1]')
    - locator resolved to <label title="" for="hobbies-checkbox-1" class="form-check-label">Sports</label>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <td>Student Email</td> from <div role="dialog" tabindex="-1" aria-modal="true" class="fade modal show" aria-labelledby="example-modal-sizes-title-lg">…</div> subtree intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not stable
    - retrying click action
      - waiting 100ms
    - waiting for element to be visible, enabled and stable
    - element is not stable
  2 × retrying click action
      - waiting 500ms
      - waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <td>State and City</td> from <div role="dialog" tabindex="-1" aria-modal="true" class="fade modal show" aria-labelledby="example-modal-sizes-title-lg">…</div> subtree intercepts pointer events
  5 × retrying click action
      - waiting 500ms
      - waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <td>Date of Birth</td> from <div role="dialog" tabindex="-1" aria-modal="true" class="fade modal show" aria-labelledby="example-modal-sizes-title-lg">…</div> subtree intercepts pointer events
    - retrying click action
      - waiting 500ms
      - waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <td>Student Email</td> from <div role="dialog" tabindex="-1" aria-modal="true" class="fade modal show" aria-labelledby="example-modal-sizes-title-lg">…</div> subtree intercepts pointer events
    - retrying click action
      - waiting 500ms
      - waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <td>Student Email</td> from <div role="dialog" tabindex="-1" aria-modal="true" class="fade modal show" aria-labelledby="example-modal-sizes-title-lg">…</div> subtree intercepts pointer events
    - retrying click action
      - waiting 500ms
      - waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <td>State and City</td> from <div role="dialog" tabindex="-1" aria-modal="true" class="fade modal show" aria-labelledby="example-modal-sizes-title-lg">…</div> subtree intercepts pointer events
  - retrying click action
    - waiting 500ms


Recorded:

```json
{
  "id": "wf-1792671700327",
  "openUrl": "https://demoqa.com/automation-practice-form",
  "startUrl": "https://demoqa.com/automation-practice-form",
  "steps": 11,
  "actions": {
    "type": 8,
    "click": 3
  },
  "inputs": [
    "firstName:text=Ada",
    "lastName:text=Lovelace",
    "username:text=ada-form@example.com",
    "gender:text=Male",
    "username2:text=9990001111",
    "text:text=0",
    "text2:text=1990",
    "subjectsInput:text=Maths"
  ],
  "labels": [
    "type Type {{firstName}}",
    "type Type {{lastName}}",
    "type Type {{username}}",
    "type Type {{gender}}",
    "click Click",
    "type Type {{username2}}",
    "click Click",
    "type Type {{text}}",
    "type Type {{text2}}",
    "type Type {{subjectsInput}}",
    "click Click \"Submit\""
  ],
  "recordError": "POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.\nCall log:\n  - waiting for locator('label[for=hobbies-checkbox-1]')\n    - locator resolved to <label title=\"\" for=\"hobbies-checkbox-1\" class=\"form-check-label\">Sports</label>\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>Student Email</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n    - retrying click action\n    - waiting 20ms\n    2 × waiting for element to be visible, enabled and stable\n      - element is not stable\n    - retrying click action\n      - waiting 100ms\n    - waiting for element to be visible, enabled and stable\n    - element is not stable\n  2 × retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>State and City</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n  5 × retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>Date of Birth</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n    - retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>Student Email</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n    - retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>Student Email</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n    - retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>State and City</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n  - retrying click action\n    - waiting 500ms\n"
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792671700327-3 type Type {{gender}} — type "Type {{gender}}": action locator.fill: Error: Input of type "radio" cannot be filled Call log: - waiting for locator('[data-bao-i="41"]') - locator resolved to <input required="" type="radio" value="Male" name="gender" data-bao-i="41" id="gender-radio-1" class="form-check-input"/> - fill("Male") - attempting fill action - waiting for element to be visible, enabled and editable

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792671700327-3 type Type {{gender}} — type "Type {{gender}}": action locator.fill: Error: Input of type "radio" cannot be filled Call log: - waiting for locator('[data-bao-i="41"]') - locator resolved to <input required="" type="radio" value="Male" name="gender" data-bao-i="41" id="gender-radio-1" class="form-check-input"/> - fill("Male") - attempting fill action - waiting for element to be visible, enabled and editable

Artifacts:

- `docs/proof/realworld/artifacts/p2-r1.png`
- `docs/proof/realworld/artifacts/p2-r1-frame-1.png`
- `docs/proof/realworld/artifacts/p2-r1-frame-2.png`
- `docs/proof/realworld/artifacts/p2-r1-frame-3.png`
- `docs/proof/realworld/artifacts/p2-r1-keyframes.webm`
- `docs/proof/realworld/artifacts/p2-r2.png`
- `docs/proof/realworld/artifacts/p2-r2-frame-1.png`
- `docs/proof/realworld/artifacts/p2-r2-frame-2.png`
- `docs/proof/realworld/artifacts/p2-r2-frame-3.png`
- `docs/proof/realworld/artifacts/p2-r2-keyframes.webm`

### p3 Booking, stop before reserve

Site: automationintesting.online

Recorded:

```json
{
  "id": "wf-1792671770524",
  "openUrl": "https://automationintesting.online/",
  "startUrl": "https://automationintesting.online/reservation/1?checkin=2026-10-22&checkout=2026-10-23",
  "steps": 4,
  "actions": {
    "click": 4
  },
  "inputs": [],
  "labels": [
    "click Click \"Book now\"",
    "click Click \"Next\"",
    "click Click \"05\"",
    "click Click \"07\""
  ]
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792671770524-0 click Click "Book now" — no open step; replay started at the stop URL https://automationintesting.online/reservation/1?checkin=2026-10-22&checkout=2026-10-23 instead of https://automationintesting.online/. click "Click "Book now"": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792671770524-0 click Click "Book now" — no open step; replay started at the stop URL https://automationintesting.online/reservation/1?checkin=2026-10-22&checkout=2026-10-23 instead of https://automationintesting.online/. click "Click "Book now"": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p3-r1.png`
- `docs/proof/realworld/artifacts/p3-r1-frame-1.png`
- `docs/proof/realworld/artifacts/p3-r1-keyframes.webm`
- `docs/proof/realworld/artifacts/p3-r2.png`
- `docs/proof/realworld/artifacts/p3-r2-frame-1.png`
- `docs/proof/realworld/artifacts/p3-r2-keyframes.webm`

### p4 Trial search and CSV download

Site: clinicaltrials.gov

Recording error before stop: POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.
Call log:
  - waiting for locator('#adv-check0-status1')
    - locator resolved to <input value="rec" type="checkbox" id="adv-check0-status1" _ngcontent-ng-c938690190="" class="usa-checkbox__input"/>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - element is outside of the viewport
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - element is outside of the viewport
    - retrying click action
      - waiting 100ms
    23 × waiting for element to be visible, enabled and stable
       - element is visible, enabled and stable
       - scrolling into view if needed
       - done scrolling
       - element is outside of the viewport
     - retrying click action
       - waiting 500ms


Recorded:

```json
{
  "id": "wf-1792671927354",
  "openUrl": "https://clinicaltrials.gov/search",
  "startUrl": "https://clinicaltrials.gov/search?viewType=Card",
  "steps": 27,
  "actions": {
    "type": 26,
    "click": 1
  },
  "inputs": [
    "text:text",
    "text2:text",
    "text3:text",
    "text4:text",
    "text5:text",
    "text6:text",
    "text7:text",
    "text8:text",
    "text9:text",
    "text10:text",
    "text11:text",
    "text12:text",
    "text13:text",
    "text14:text",
    "text15:text",
    "text16:text",
    "text17:text",
    "text18:text",
    "text19:text",
    "text20:text",
    "text21:text",
    "text22:text",
    "text23:text",
    "text24:text",
    "advcond:text=type 1 diabetes",
    "text25:text=California"
  ],
  "labels": [
    "type Type {{text}}",
    "type Type {{text2}}",
    "type Type {{text3}}",
    "type Type {{text4}}",
    "type Type {{text5}}",
    "type Type {{text6}}",
    "type Type {{text7}}",
    "type Type {{text8}}",
    "type Type {{text9}}",
    "type Type {{text10}}",
    "type Type {{text11}}",
    "type Type {{text12}}",
    "type Type {{text13}}",
    "type Type {{text14}}",
    "type Type {{text15}}",
    "type Type {{text16}}",
    "type Type {{text17}}",
    "type Type {{text18}}",
    "type Type {{text19}}",
    "type Type {{text20}}",
    "type Type {{text21}}",
    "type Type {{text22}}",
    "type Type {{text23}}",
    "type Type {{text24}}",
    "type Type {{advcond}}",
    "type Type {{text25}}",
    "click Click \"More Filters\""
  ],
  "recordError": "POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.\nCall log:\n  - waiting for locator('#adv-check0-status1')\n    - locator resolved to <input value=\"rec\" type=\"checkbox\" id=\"adv-check0-status1\" _ngcontent-ng-c938690190=\"\" class=\"usa-checkbox__input\"/>\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - element is outside of the viewport\n    - retrying click action\n    - waiting 20ms\n    2 × waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - element is outside of the viewport\n    - retrying click action\n      - waiting 100ms\n    23 × waiting for element to be visible, enabled and stable\n       - element is visible, enabled and stable\n       - scrolling into view if needed\n       - done scrolling\n       - element is outside of the viewport\n     - retrying click action\n       - waiting 500ms\n"
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792671927354-0 type Type {{text}} — type "Type {{text}}": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792671927354-0 type Type {{text}} — type "Type {{text}}": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p4-r1.png`
- `docs/proof/realworld/artifacts/p4-r1-frame-1.png`
- `docs/proof/realworld/artifacts/p4-r1-keyframes.webm`
- `docs/proof/realworld/artifacts/p4-r2.png`
- `docs/proof/realworld/artifacts/p4-r2-frame-1.png`
- `docs/proof/realworld/artifacts/p4-r2-keyframes.webm`

### p5 Paginated catalog to CSV

Site: books.toscrape.com

Recorded:

```json
{
  "id": "wf-1792672161233",
  "openUrl": "https://books.toscrape.com/",
  "startUrl": "https://books.toscrape.com/catalogue/category/books/travel_2/index.html",
  "steps": 1,
  "actions": {
    "click": 1
  },
  "inputs": [],
  "labels": [
    "click Click \"Travel\""
  ]
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792672161233-0 click Click "Travel" — no open step; replay started at the stop URL https://books.toscrape.com/catalogue/category/books/travel_2/index.html instead of https://books.toscrape.com/. click "Click "Travel"": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792672161233-0 click Click "Travel" — no open step; replay started at the stop URL https://books.toscrape.com/catalogue/category/books/travel_2/index.html instead of https://books.toscrape.com/. click "Click "Travel"": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p5-r1.png`
- `docs/proof/realworld/artifacts/p5-r1-frame-1.png`
- `docs/proof/realworld/artifacts/p5-r1-keyframes.webm`
- `docs/proof/realworld/artifacts/p5-r2.png`
- `docs/proof/realworld/artifacts/p5-r2-frame-1.png`
- `docs/proof/realworld/artifacts/p5-r2-keyframes.webm`

### p6 Spreadsheet rows into a web table

Site: demoqa.com/webtables

Recorded:

```json
{
  "id": "wf-1792672257232",
  "openUrl": "https://demoqa.com/webtables",
  "startUrl": "https://demoqa.com/webtables",
  "steps": 24,
  "actions": {
    "click": 6,
    "type": 18
  },
  "inputs": [
    "firstName:text=Ada",
    "lastName:text=Lovelace",
    "username:text=ada-table@example.com",
    "age:text=36",
    "salary:text=10001",
    "department:text=Math",
    "firstName2:text=Grace",
    "lastName2:text=Hopper",
    "username2:text=grace-table@example.com",
    "age2:text=41",
    "salary2:text=10002",
    "department2:text=Compilers",
    "firstName3:text=Radia",
    "lastName3:text=Perlman",
    "username3:text=radia-table@example.com",
    "age3:text=44",
    "salary3:text=10003",
    "department3:text=Networks"
  ],
  "labels": [
    "click Click \"Add\"",
    "type Type {{firstName}}",
    "type Type {{lastName}}",
    "type Type {{username}}",
    "type Type {{age}}",
    "type Type {{salary}}",
    "type Type {{department}}",
    "click Click \"Submit\"",
    "click Click \"Add\"",
    "type Type {{firstName2}}",
    "type Type {{lastName2}}",
    "type Type {{username2}}",
    "type Type {{age2}}",
    "type Type {{salary2}}",
    "type Type {{department2}}",
    "click Click \"Submit\"",
    "click Click \"Add\"",
    "type Type {{firstName3}}",
    "type Type {{lastName3}}",
    "type Type {{username3}}",
    "type Type {{age3}}",
    "type Type {{salary3}}",
    "type Type {{department3}}",
    "click Click \"Submit\""
  ]
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792672257232-2 type Type {{lastName}} — type "Type {{lastName}}": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792672257232-2 type Type {{lastName}} — type "Type {{lastName}}": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p6-r1.png`
- `docs/proof/realworld/artifacts/p6-r1-frame-1.png`
- `docs/proof/realworld/artifacts/p6-r1-frame-2.png`
- `docs/proof/realworld/artifacts/p6-r1-frame-3.png`
- `docs/proof/realworld/artifacts/p6-r1-frame-4.png`
- `docs/proof/realworld/artifacts/p6-r1-keyframes.webm`
- `docs/proof/realworld/artifacts/p6-r2.png`
- `docs/proof/realworld/artifacts/p6-r2-frame-1.png`
- `docs/proof/realworld/artifacts/p6-r2-frame-2.png`
- `docs/proof/realworld/artifacts/p6-r2-frame-3.png`
- `docs/proof/realworld/artifacts/p6-r2-frame-4.png`
- `docs/proof/realworld/artifacts/p6-r2-keyframes.webm`

### p7 Wikipedia history across skins

Site: en.wikipedia.org

Recorded:

```json
{
  "id": "wf-1792672349041",
  "openUrl": "https://en.wikipedia.org/wiki/Special:Search",
  "startUrl": "https://en.wikipedia.org/w/index.php?title=Baozi&action=history",
  "steps": 3,
  "actions": {
    "type": 1,
    "click": 2
  },
  "inputs": [
    "search:text=Baozi"
  ],
  "labels": [
    "type Type {{search}}",
    "click Click \"Search\"",
    "click Click \"View history\""
  ]
}
```

Replay 1: fail (passed), model calls 0, heals 0
First failure: check — saw history text 19:53, 4 October 2026 but bao has no extract to compare with the MediaWiki API

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792672349041-1 click Click "Search" — click "Click "Search"": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p7-r1.png`
- `docs/proof/realworld/artifacts/p7-r1-frame-1.png`
- `docs/proof/realworld/artifacts/p7-r1-frame-2.png`
- `docs/proof/realworld/artifacts/p7-r1-frame-3.png`
- `docs/proof/realworld/artifacts/p7-r1-frame-4.png`
- `docs/proof/realworld/artifacts/p7-r1-keyframes.webm`
- `docs/proof/realworld/artifacts/p7-r2.png`
- `docs/proof/realworld/artifacts/p7-r2-frame-1.png`
- `docs/proof/realworld/artifacts/p7-r2-frame-2.png`
- `docs/proof/realworld/artifacts/p7-r2-frame-3.png`
- `docs/proof/realworld/artifacts/p7-r2-keyframes.webm`

### p8 Unstable DOM, new tab, JS dialogs

Site: the-internet.herokuapp.com

Recorded:

```json
{
  "id": "wf-1792672435140",
  "openUrl": "https://the-internet.herokuapp.com/challenging_dom",
  "startUrl": "https://the-internet.herokuapp.com/javascript_alerts",
  "steps": 6,
  "actions": {
    "click": 6
  },
  "inputs": [],
  "labels": [
    "click Click \"edit\"",
    "click Click \"Gallery\"",
    "click Click \"Click Here\"",
    "click Click \"Click for JS Alert\"",
    "click Click \"Click for JS Confirm\"",
    "click Click \"Click for JS Prompt\""
  ]
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792672435140-0 click Click "edit" — no open step; replay started at the stop URL https://the-internet.herokuapp.com/javascript_alerts instead of https://the-internet.herokuapp.com/challenging_dom. click "Click "edit"": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792672435140-0 click Click "edit" — no open step; replay started at the stop URL https://the-internet.herokuapp.com/javascript_alerts instead of https://the-internet.herokuapp.com/challenging_dom. click "Click "edit"": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p8-r1.png`
- `docs/proof/realworld/artifacts/p8-r1-frame-1.png`
- `docs/proof/realworld/artifacts/p8-r1-keyframes.webm`
- `docs/proof/realworld/artifacts/p8-r2.png`
- `docs/proof/realworld/artifacts/p8-r2-frame-1.png`
- `docs/proof/realworld/artifacts/p8-r2-keyframes.webm`

### p9 Shadow-DOM shop, stop before place order

Site: shop.polymer-project.org

Recording error before stop: POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.
Call log:
  - waiting for locator('shop-app').locator('a').nth(8)
    - locator resolved to <a class="image-link" href="/list/mens_outerwear">…</a>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not visible
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not visible
    - retrying click action
      - waiting 100ms
    23 × waiting for element to be visible, enabled and stable
       - element is not visible
     - retrying click action
       - waiting 500ms


Recorded:

```json
{
  "id": "wf-1792672544425",
  "openUrl": "https://shop.polymer-project.org/",
  "startUrl": "https://shop.polymer-project.org/list/mens_tshirts",
  "steps": 0,
  "actions": {},
  "inputs": [],
  "labels": [],
  "recordError": "POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.\nCall log:\n  - waiting for locator('shop-app').locator('a').nth(8)\n    - locator resolved to <a class=\"image-link\" href=\"/list/mens_outerwear\">…</a>\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is not visible\n    - retrying click action\n    - waiting 20ms\n    2 × waiting for element to be visible, enabled and stable\n      - element is not visible\n    - retrying click action\n      - waiting 100ms\n    23 × waiting for element to be visible, enabled and stable\n       - element is not visible\n     - retrying click action\n       - waiting 500ms\n"
}
```

Replay 1: fail (passed), model calls 0, heals 0
First failure: check — no confirm gate before Place Order

Replay 2: fail (passed), model calls 0, heals 0
First failure: check — no confirm gate before Place Order

Artifacts:

- `docs/proof/realworld/artifacts/p9-r1.png`
- `docs/proof/realworld/artifacts/p9-r2.png`

### p10 TextEdit

Site: TextEdit

TextEdit, Preview, and Numbers are computer-use tasks and were not run.

Recorded:

```json
{
  "skipped": "computer-use task; this host is Linux"
}
```

### p11 W-9 download and Preview

Site: irs.gov + Preview

TextEdit, Preview, and Numbers are computer-use tasks and were not run.

Recorded:

```json
{
  "skipped": "computer-use task; this host is Linux"
}
```

### p12 CSV into Numbers

Site: Numbers

TextEdit, Preview, and Numbers are computer-use tasks and were not run.

Recorded:

```json
{
  "skipped": "computer-use task; this host is Linux"
}
```

### p13 Excalidraw canvas

Site: excalidraw.com

Recording error before stop: POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.
Call log:
  - waiting for locator('button:text-is(\'Rectangle\')')


Recorded:

```json
{
  "id": "wf-1792672620080",
  "openUrl": "https://excalidraw.com/",
  "startUrl": "https://excalidraw.com/",
  "steps": 0,
  "actions": {},
  "inputs": [],
  "labels": [],
  "recordError": "POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.\nCall log:\n  - waiting for locator('button:text-is(\\'Rectangle\\')')\n"
}
```

Replay 1: fail (passed), model calls 0, heals 0
First failure: check — no embedded scene JSON; canvas steps recorded: 0; labels Alpha, Beta not verified

Replay 2: fail (passed), model calls 0, heals 0
First failure: check — no embedded scene JSON; canvas steps recorded: 0; labels Gamma, Delta not verified

Artifacts:

- `docs/proof/realworld/artifacts/p13-r1.png`
- `docs/proof/realworld/artifacts/p13-r2.png`

### p14 Bot wall

Site: practicesoftwaretesting.com

Recorded:

```json
{
  "id": "wf-1792672686913",
  "openUrl": "https://practicesoftwaretesting.com/",
  "startUrl": "https://practicesoftwaretesting.com/",
  "steps": 0,
  "actions": {},
  "inputs": [],
  "labels": []
}
```

Replay 1: fail (passed), model calls 0, heals 0
First failure: check — status was passed, not needs_human; heals 0; captcha clicks 0

Replay 2: fail (passed), model calls 0, heals 0
First failure: check — status was passed, not needs_human; heals 0; captcha clicks 0

Artifacts:

- `docs/proof/realworld/artifacts/p14-r1.png`
- `docs/proof/realworld/artifacts/p14-r2.png`

