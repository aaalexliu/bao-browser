# Real-world proof

Measured on Linux with headless Chrome from v1/desktop. Pass means both the doc's check and 0 model calls. ACCEPT stays 60 and MARGIN stays 25.

p1 replay 2 was run again in its own browser after the shared-window end shot matched replay 1 pixel for pixel. p4, p5, and p9 were replayed again the same way. Their end pages are still the same pixels, because each replay stops on the same screen. p6 replay 2 was never run; its png is the old replay 1 file. p2, p3, p7, and p8 were not replayed again in this pass.

| Task | Pass | Model calls | Heals | First failure |
|---|---|---|---|---|
| p1 Sign-up, contact upload, delete account | 2/2 | 0, 0 | 0 ; 0 | — |
| p2 Practice form with date picker and dependent selects | 0/2 | 0, 0 | 0 ; 0 | select name is the truncated option list of a closed date popup |
| p3 Booking, stop before reserve | 2/2 | 0, 0 | 0 ; 0 | — |
| p4 Trial search and CSV download | 0/2 | 0, 0 | 0 ; 0 | fill of disabled `#from-age-input` |
| p5 Paginated catalog to CSV | 0/2 | 0, 0 | 0 ; 0 | no extract or CSV output; category is a click, not an input |
| p6 Spreadsheet rows into a web table | 0/2 | 0, 0 | 0 ; 0 | replay 2 was not run; the old png is a copy of replay 1 |
| p7 Wikipedia history across skins | 2/2 | 0, 0 | 0 ; 0 | — |
| p8 Unstable DOM, new tab, JS dialogs | 2/2 | 0, 0 | 0 ; 0 | — |
| p9 Shadow-DOM shop, stop before place order | 0/2 | 0, 0 | 0 ; 0 | no confirm gate before Place Order |

## Failure causes

1. p2 — the saved select step is named with the month or year option list, cut at 80 characters. The live select shows only the chosen option and sits in a closed `.react-datepicker`.
2. p4 — both replays fill the disabled age field `#from-age-input`. A fresh browser for replay 2 still photographs that same screen, so the png bytes match. The run ids differ.
3. p5 and p9 — replay 2 ran again in its own browser and stopped on the same page as replay 1, so the end png matches. p5 has no extract. p9 has no confirm gate.
4. p6 — replay 2 has no run id. `p6-r2.png` is the same bytes and the same timestamp as `p6-r1.png`. It was not recaptured. A real bot wall holds the proof for the act timeout.

## Keyframes

p2, p3, p7, and p8 already had distinct replay 2 shots. p1's new shots are distinct. p4, p5, and p9 were recaptured and are still the same pixels. p6 was not recaptured.

## Per task

### p1 Sign-up, contact upload, delete account

Site: automationexercise.com

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

Replay 1 and replay 2 each opened a browser. The end shots are not the same file.

| | Replay 1 | Replay 2 |
|---|---|---|
| Run id | `run-mvjpq0dq-5i25` | `run-mvjpriny-3emj` |
| Started | 2026-10-22 15:45:23 UTC | 2026-10-22 15:46:34 UTC |
| Ended | 2026-10-22 15:46:02 UTC | 2026-10-22 15:47:12 UTC |
| Name | Bao Alpha | Bao Beta |
| Email | bao-alpha-mvjp070t@example.com | bao-beta-mvjp070t@example.com |
| End URL | `/delete_account` | `/delete_account` |
| Shot sha256 | `2babf3c490891d3f…` | `e386fbfb6c8d9698…` |

Replay 1: pass (passed), model calls 0, heals 0. ACCOUNT DELETED!

Replay 2: pass (passed), model calls 0, heals 0. ACCOUNT DELETED! The banner ad is a different image from replay 1.

Artifacts:

- `docs/proof/realworld/artifacts/p1-r1.png`
- `docs/proof/realworld/artifacts/p1-r2.png`

### p4 Trial search and CSV download

Site: clinicaltrials.gov

Recorded:

```json
{
  "id": "wf-1792676908524",
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
  ]
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: wf-1792676908524-1 type Type {{text}} — type "Type {{text}}": action locator.fill: Timeout 30000ms exceeded. Call log: - waiting for locator('[data-bao-i="225"]') - locator resolved to <input disabled data-bao-i="225" id="from-age-input" name="from-age-input" formcontrolname="fromAge" _ngcontent-ng-c956280390="" class="usa-input age-input ng-untouched ng-pristine"/> - fill("") - attempting fill action 2 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 20ms 2 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 100ms 60 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 500ms

Replay 2: fail (failed), model calls 0, heals 0
First failure: wf-1792676908524-1 type Type {{text}} — type "Type {{text}}": action locator.fill: Timeout 30000ms exceeded. Call log: - waiting for locator('[data-bao-i="225"]') - locator resolved to <input disabled data-bao-i="225" id="from-age-input" name="from-age-input" formcontrolname="fromAge" _ngcontent-ng-c956280390="" class="usa-input age-input ng-untouched ng-pristine"/> - fill("") - attempting fill action 2 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 20ms 2 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 100ms 60 × waiting for element to be visible, enabled and editable - element is not enabled - retrying fill action - waiting 500ms

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

### p9 Shadow-DOM shop, stop before place order

Site: shop.polymer-project.org

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
  ]
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: check — no confirm gate before Place Order

Replay 2: fail (failed), model calls 0, heals 0
First failure: check — no confirm gate before Place Order

Artifacts:

- `docs/proof/realworld/artifacts/p9-r1.png`
- `docs/proof/realworld/artifacts/p9-r2.png`

