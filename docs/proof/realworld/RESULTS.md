# Real-world proof

Measured on Linux with headless Chrome from v1/desktop. Replay video is macOS-only, so each browser replay saved keyframes (and a keyframe webm when ffmpeg could encode one). Pass means both the doc's check and 0 model calls.

| Task | Pass | Model calls | Heals | First failure |
|---|---|---|---|---|
| p1 Sign-up, contact upload, delete account | 0/2 | 0, 0 | 0 ; 0 | type "Type {{username}}": find below-threshold |
| p2 Practice form with date picker and dependent selects | 0/2 | 0, 0 | 0 ; 0 | select "Select {{text}}": find below-threshold |
| p3 Booking, stop before reserve | 0/2 | 0, 0 | 0 ; 0 | click "Click "Book now"": find below-threshold |
| p4 Trial search and CSV download | 0/2 | 0, 0 | 0 ; 0 | type "Type {{text}}": action locator.fill: Timeout 30000ms exceeded. Call log: - waiting for locator('[data-bao-i="225"]') - locator resolved to <input disabled data-bao-i="225" id="from-age-input" name="from-age-input" formcontrolname="fromAge" _ngcontent-ng-c956280390="" class="usa-input age-input ng-untouched ng-pristine"/> - fill("") - attempting fill action 2 × waiting for element to be visib |
| p5 Paginated catalog to CSV | 0/2 | 0, 0 | 0 ; 0 | no extract or CSV output; category is a click, not an input, so Mystery and Historical Fiction were not replayed |
| p6 Spreadsheet rows into a web table | 0/2 | 0, 0 | 0 ; 0 | click "Click "Submit"": find below-threshold |
| p7 Wikipedia history across skins | 0/2 | 0, 0 | 0 ; 0 | click "Click "Search"": find below-threshold |
| p8 Unstable DOM, new tab, JS dialogs | 0/2 | 0, 0 | 0 ; 0 | click "Click "edit"": find below-threshold |
| p9 Shadow-DOM shop, stop before place order | 0/2 | 0, 0 | 0 ; 0 | no confirm gate before Place Order |

## Failure causes

1. lookup miss — 6 tasks
2. missing step type — 2 tasks
3. action — 1 task

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
  "id": "wf-1792675287453",
  "openUrl": "https://clinicaltrials.gov/search",
  "startUrl": "https://clinicaltrials.gov/search",
  "steps": 28,
  "actions": {
    "navigate": 1,
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
    "navigate Open https://clinicaltrials.gov/search",
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
First failure: wf-1792675287453-1 type Type {{text}} — type "Type {{text}}": action locator.fill: Timeout 30000ms exceeded. Call log: - waiting for locator('[data-bao-i="225"]') - locator resolved to <input disabled data-bao-i="225" id="from-age-input" name="from-age-input" formcontrolname="fromAge" _ngcontent-ng-c956280390="" class="usa-input age-input ng-untouched ng-pristine"/> - fill("") - attempting fill action 2 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 20ms 2 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 100ms 60 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 500ms

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792675287453-1 type Type {{text}} — type "Type {{text}}": action locator.fill: Timeout 30000ms exceeded. Call log: - waiting for locator('[data-bao-i="225"]') - locator resolved to <input disabled data-bao-i="225" id="from-age-input" name="from-age-input" formcontrolname="fromAge" _ngcontent-ng-c956280390="" class="usa-input age-input ng-untouched ng-pristine"/> - fill("") - attempting fill action 2 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 20ms 2 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 100ms 60 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 500ms

Artifacts:

- `docs/proof/realworld/artifacts/p4-r1.png`
- `docs/proof/realworld/artifacts/p4-r2.png`

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

Recorded:

```json
{
  "id": "wf-1792675612583",
  "openUrl": "https://demoqa.com/webtables",
  "startUrl": "https://demoqa.com/webtables",
  "steps": 25,
  "actions": {
    "navigate": 1,
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
    "navigate Open https://demoqa.com/webtables",
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
First failure: wf-1792675612583-8 click Click "Submit" — click "Click "Submit"": find below-threshold

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792675612583-8 click Click "Submit" — click "Click "Submit"": find below-threshold

Artifacts:

- `docs/proof/realworld/artifacts/p6-r1.png`
- `docs/proof/realworld/artifacts/p6-r2.png`

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

