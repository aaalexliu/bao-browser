# Real-world proof

Measured on Linux with headless Chrome from v1/desktop. Replay video is macOS-only, so each browser replay saved keyframes (and a keyframe webm when ffmpeg could encode one). Pass means both the doc's check and 0 model calls.

p4 and p6 were recorded and replayed again after rebasing onto `42a80cc` (extract, files and dates, and the page classifier). The other rows are the earlier measurement on this branch.

| Task | Pass | Model calls | Heals | First failure |
|---|---|---|---|---|
| p1 Sign-up, contact upload, delete account | 0/2 | 0, 0 | 0 ; 0 | type "Type {{username}}": find below-threshold |
| p2 Practice form with date picker and dependent selects | 0/2 | 0, 0 | 0 ; 0 | select "Select {{text}}": find below-threshold |
| p3 Booking, stop before reserve | 0/2 | 0, 0 | 0 ; 0 | click "Click "Book now"": find below-threshold |
| p4 Trial search and CSV download | 0/2 | 0, 0 | 0 ; 0 | type into disabled `#from-age-input` (empty date-field changes; download never recorded) |
| p5 Paginated catalog to CSV | 0/2 | 0, 0 | 0 ; 0 | no extract or CSV output; category is a click, not an input, so Mystery and Historical Fiction were not replayed |
| p6 Spreadsheet rows into a web table | 0/2 | 0, 0 | 0 ; 0 | paused on Click Add: bot check (reCAPTCHA iframe in the ad stack) |
| p7 Wikipedia history across skins | 0/2 | 0, 0 | 0 ; 0 | click "Click "Search"": find below-threshold |
| p8 Unstable DOM, new tab, JS dialogs | 0/2 | 0, 0 | 0 ; 0 | click "Click "edit"": find below-threshold |
| p9 Shadow-DOM shop, stop before place order | 0/2 | 0, 0 | 0 ; 0 | no confirm gate before Place Order |

## Failure causes

1. lookup miss — 5 tasks
2. missing step type — 2 tasks
3. action — 1 task (p4)
4. bot check — 1 task (p6, rerun on 42a80cc)

## Per task

### p1 Sign-up, contact upload, delete account

Site: automationexercise.com

Recording error before stop: timed out waiting for "Enter Account Information" at https://automationexercise.com/signup — Home  Products Cart Signup / Login Test Cases API Testing Video Tutorials Contact us Login to your account Login OR New User Signup! Email Address already exist! Signup SUBSCRIPTI

Recorded:

```json
{
  "id": "wf-1792674880957",
  "openUrl": "https://automationexercise.com/login",
  "startUrl": "https://automationexercise.com/login",
  "steps": 4,
  "actions": {
    "navigate": 1,
    "type": 2,
    "click": 1
  },
  "inputs": [
    "name:text=Bao Record",
    "username:text=bao-record@example.com"
  ],
  "labels": [
    "navigate Open https://automationexercise.com/login",
    "type Type {{name}}",
    "type Type {{username}}",
    "click Click \"Signup\""
  ],
  "recordError": "timed out waiting for \"Enter Account Information\" at https://automationexercise.com/signup — Home  Products Cart Signup / Login Test Cases API Testing Video Tutorials Contact us Login to your account Login OR New User Signup! Email Address already exist! Signup SUBSCRIPTI"
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792674880957-2 type Type {{username}} — type "Type {{username}}": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792674880957-2 type Type {{username}} — type "Type {{username}}": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p1-r1.png`
- `docs/proof/realworld/artifacts/p1-r2.png`

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
  "id": "wf-1792674983482",
  "openUrl": "https://demoqa.com/automation-practice-form",
  "startUrl": "https://demoqa.com/automation-practice-form",
  "steps": 12,
  "actions": {
    "navigate": 1,
    "type": 5,
    "check": 1,
    "click": 3,
    "select": 2
  },
  "inputs": [
    "firstName:text=Ada",
    "lastName:text=Lovelace",
    "username:text=ada-form@example.com",
    "username2:text=9990001111",
    "text:text=January",
    "text2:text=1990",
    "subjectsInput:text=Maths"
  ],
  "labels": [
    "navigate Open https://demoqa.com/automation-practice-form",
    "type Type {{firstName}}",
    "type Type {{lastName}}",
    "type Type {{username}}",
    "check Check \"Male\"",
    "click Click \"Male\"",
    "type Type {{username2}}",
    "click Click",
    "select Select {{text}}",
    "select Select {{text2}}",
    "type Type {{subjectsInput}}",
    "click Click \"Submit\""
  ],
  "recordError": "POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.\nCall log:\n  - waiting for locator('label[for=hobbies-checkbox-1]')\n    - locator resolved to <label title=\"\" for=\"hobbies-checkbox-1\" class=\"form-check-label\">Sports</label>\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>Student Email</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n    - retrying click action\n    - waiting 20ms\n    2 × waiting for element to be visible, enabled and stable\n      - element is not stable\n    - retrying click action\n      - waiting 100ms\n    - waiting for element to be visible, enabled and stable\n    - element is not stable\n  2 × retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>State and City</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n  5 × retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>Date of Birth</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n    - retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>Student Email</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n    - retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>Student Email</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n    - retrying click action\n      - waiting 500ms\n      - waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <td>State and City</td> from <div role=\"dialog\" tabindex=\"-1\" aria-modal=\"true\" class=\"fade modal show\" aria-labelledby=\"example-modal-sizes-title-lg\">…</div> subtree intercepts pointer events\n  - retrying click action\n    - waiting 500ms\n"
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792674983482-8 select Select {{text}} — select "Select {{text}}": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792674983482-8 select Select {{text}} — select "Select {{text}}": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p2-r1.png`
- `docs/proof/realworld/artifacts/p2-r2.png`

### p3 Booking, stop before reserve

Site: automationintesting.online

Recorded:

```json
{
  "id": "wf-1792675070495",
  "openUrl": "https://automationintesting.online/",
  "startUrl": "https://automationintesting.online/",
  "steps": 5,
  "actions": {
    "navigate": 1,
    "click": 4
  },
  "inputs": [],
  "labels": [
    "navigate Open https://automationintesting.online/",
    "click Click \"Book now\"",
    "click Click \"Next\"",
    "click Click \"05\"",
    "click Click \"07\""
  ]
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792675070495-1 click Click "Book now" — click "Click "Book now"": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792675070495-1 click Click "Book now" — click "Click "Book now"": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p3-r1.png`
- `docs/proof/realworld/artifacts/p3-r2.png`

### p4 Trial search and CSV download

Site: clinicaltrials.gov

Rerun on `42a80cc`. Still 0/2, 0 model calls, 0 heals.

The page's advanced date inputs fire empty `change` events while the filter panel is closed. Those became 24 `type` steps (`#adv-date-start-from` and the other From/To fields, accessible name "From" or "Date Picker") before the condition "type 1 diabetes" and the location "California". None became a `datePicker` step: there was no parsed date to fold. Replay's first type step looks up a textbox named From, hits the disabled age field `#from-age-input` (the date input is not in the tree until filters open), and `locator.fill("")` waits out the timeout because the control is disabled.

Recording also never reached download. The Recruiting checkbox `#adv-check0-status1` is in the filter panel and Playwright reports it outside the viewport, so the click times out. The workflow ends at Click "More Filters". No `download` step, so the files-and-dates download path does not run.

Replay 1 and replay 2: failed on `Type {{text}}`, model calls 0, heals 0.

Artifacts: `docs/proof/realworld/artifacts/p4-r1.png`, `docs/proof/realworld/artifacts/p4-r2.png`.

### p5 Paginated catalog to CSV

Site: books.toscrape.com

Recorded:

```json
{
  "id": "wf-1792675534903",
  "openUrl": "https://books.toscrape.com/",
  "startUrl": "https://books.toscrape.com/",
  "steps": 2,
  "actions": {
    "navigate": 1,
    "click": 1
  },
  "inputs": [],
  "labels": [
    "navigate Open https://books.toscrape.com/",
    "click Click \"Travel\""
  ]
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: check — no extract or CSV output; category is a click, not an input, so Mystery and Historical Fiction were not replayed

Replay 2: fail (failed), model calls 0, heals 0
First failure: check — no extract or CSV output; category is a click, not an input, so Mystery and Historical Fiction were not replayed

Artifacts:

- `docs/proof/realworld/artifacts/p5-r1.png`
- `docs/proof/realworld/artifacts/p5-r2.png`

### p6 Spreadsheet rows into a web table

Site: demoqa.com/webtables

Rerun on `42a80cc`. The registration dialog is recorded. Replay does not reach it.

The capture has 25 steps: navigate, then Add, six fields, and Submit, three times (Ada Lovelace, Grace Hopper, Radia Perlman). `startUrl` is `https://demoqa.com/webtables`.

Replay 1 paused on Click "Add" (step 2 of 25) before the click. The act bar said "Demoqa is showing a bot check." The visible page is the web table, with no challenge and no registration dialog. A fresh load of the same URL classifies as `bot_wall` / reCAPTCHA because the ad stack loads `https://www.google.com/recaptcha/api2/aframe` (a script/iframe src). That is the page classifier from #107. This run did not change it. Replay holds for a person (two hours), so replay 2 was not started; a second load of the URL classifies the same way. Model calls 0. Heals 0.

The earlier measurement failed later, on Click "Submit" inside the dialog (below threshold). That is no longer the first failure.

Artifact: `docs/proof/realworld/artifacts/p6-bot-check.png`.

### p7 Wikipedia history across skins

Site: en.wikipedia.org

Recorded:

```json
{
  "id": "wf-1792675703188",
  "openUrl": "https://en.wikipedia.org/wiki/Special:Search",
  "startUrl": "https://en.wikipedia.org/wiki/Special:Search",
  "steps": 4,
  "actions": {
    "navigate": 1,
    "type": 1,
    "click": 2
  },
  "inputs": [
    "search:text=Baozi"
  ],
  "labels": [
    "navigate Open https://en.wikipedia.org/wiki/Special:Search",
    "type Type {{search}}",
    "click Click \"Search\"",
    "click Click \"Past revisions of this page [alt-h]\""
  ]
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792675703188-2 click Click "Search" — click "Click "Search"": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792675703188-3 click Click "Past revisions of this page [alt-h]" — click "Click "Past revisions of this page [alt-h]"": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p7-r1.png`
- `docs/proof/realworld/artifacts/p7-r2.png`

### p8 Unstable DOM, new tab, JS dialogs

Site: the-internet.herokuapp.com

Recorded:

```json
{
  "id": "wf-1792675790341",
  "openUrl": "https://the-internet.herokuapp.com/challenging_dom",
  "startUrl": "https://the-internet.herokuapp.com/challenging_dom",
  "steps": 7,
  "actions": {
    "navigate": 1,
    "click": 6
  },
  "inputs": [],
  "labels": [
    "navigate Open https://the-internet.herokuapp.com/challenging_dom",
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
First failure: wf-1792675790341-1 click Click "edit" — click "Click "edit"": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792675790341-1 click Click "edit" — click "Click "edit"": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p8-r1.png`
- `docs/proof/realworld/artifacts/p8-r2.png`

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
  "id": "wf-1792675898524",
  "openUrl": "https://shop.polymer-project.org/",
  "startUrl": "https://shop.polymer-project.org/",
  "steps": 2,
  "actions": {
    "navigate": 1,
    "click": 1
  },
  "inputs": [],
  "labels": [
    "navigate Open https://shop.polymer-project.org/",
    "click Click \"Men's T-Shirts\""
  ],
  "recordError": "POST /api/sessions/drive 500 page.click: Timeout 12000ms exceeded.\nCall log:\n  - waiting for locator('shop-app').locator('a').nth(8)\n    - locator resolved to <a class=\"image-link\" href=\"/list/mens_outerwear\">…</a>\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is not visible\n    - retrying click action\n    - waiting 20ms\n    2 × waiting for element to be visible, enabled and stable\n      - element is not visible\n    - retrying click action\n      - waiting 100ms\n    23 × waiting for element to be visible, enabled and stable\n       - element is not visible\n     - retrying click action\n       - waiting 500ms\n"
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: check — no confirm gate before Place Order

Replay 2: fail (failed), model calls 0, heals 0
First failure: check — no confirm gate before Place Order

Artifacts:

- `docs/proof/realworld/artifacts/p9-r1.png`
- `docs/proof/realworld/artifacts/p9-r2.png`

