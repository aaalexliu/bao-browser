# Real-world proof

Measured on Linux with headless Chrome from v1/desktop. Replay video is macOS-only, so each browser replay saved keyframes (and a keyframe webm when ffmpeg could encode one). Pass means both the doc's check and 0 model calls. A task with expect needs_human passes when the replay pauses for a person and that check holds.

| Task | Pass | Model calls | Heals | First failure |
|---|---|---|---|---|
| p1 Sign-up, contact upload, delete account | 2/2 | 0, 0 | 0 ; 0 | — |
| p2 Practice form with date picker and dependent selects | 2/2 | 0, 0 | 0 ; 0 | — |
| p3 Booking, stop before reserve | 2/2 | 0, 0 | 0 ; 0 | — |
| p4 Trial search and CSV download | 2/2 | 0, 0 | 0 ; 0 | — |
| p5 Paginated catalog to CSV | 2/2 | 0, 0 | 0 ; 0 | — |
| p6 Spreadsheet rows into a web table | 2/2 | 0, 0 | 0 ; 0 | — |
| p7 Wikipedia history across skins | 2/2 | 0, 0 | 0 ; 0 | — |
| p8 Unstable DOM, new tab, JS dialogs | 2/2 | 0, 0 | 0 ; 0 | — |
| p9 Shadow-DOM shop, stop before place order | 2/2 | 0, 0 | 0 ; 0 | — |
| p10 TextEdit | needs Mac | — | — | needs Mac |
| p11 W-9 download and Preview | needs Mac | — | — | needs Mac |
| p12 CSV into Numbers | needs Mac | — | — | needs Mac |
| p13 Excalidraw canvas | 0/2 | 0, 0 | 0 ; 0 | no embedded scene JSON; canvas steps recorded: 0; labels Alpha, Beta not verified |
| p14 Bot wall | 2/2 | 0, 0 | 0 ; 0 | — |

## Failure causes

1. missing step type — 1 task

## Per task

### p1 Sign-up, contact upload, delete account

Site: automationexercise.com

Recorded:

```json
{
  "id": "wf-1792700589362",
  "openUrl": "https://automationexercise.com/login",
  "startUrl": "https://automationexercise.com/login",
  "steps": 30,
  "actions": {
    "navigate": 2,
    "type": 14,
    "click": 8,
    "check": 1,
    "select": 4,
    "upload": 1
  },
  "inputs": [
    "name:text=Bao Record",
    "username:text=bao-record-mvjzm7ln@example.com",
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
    "username2:text=bao-record-mvjzm7ln@example.com",
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
    "click Click \"Submit\"",
    "click Click \"Delete Account\""
  ]
}
```

Replay 1: pass (passed), model calls 0, heals 0

Replay 2: pass (passed), model calls 0, heals 0

Artifacts:

- `docs/proof/realworld/artifacts/p1-r1.png`
- `docs/proof/realworld/artifacts/p1-r1-identity.png`
- `docs/proof/realworld/artifacts/p1-r2.png`
- `docs/proof/realworld/artifacts/p1-r2-identity.png`

### p2 Practice form with date picker and dependent selects

Site: demoqa.com

Recorded:

```json
{
  "id": "wf-1792700745872",
  "openUrl": "https://demoqa.com/automation-practice-form",
  "startUrl": "https://demoqa.com/automation-practice-form",
  "steps": 21,
  "actions": {
    "navigate": 1,
    "type": 8,
    "check": 2,
    "click": 9,
    "upload": 1
  },
  "inputs": [
    "firstName:text=Ada",
    "lastName:text=Lovelace",
    "username:text=ada-form@example.com",
    "username2:text=9990001111",
    "subjectsInput:text=Maths",
    "file:file",
    "currentAddress:text=1 Market Street",
    "text:text=NCR",
    "text2:text=Delhi",
    "dateOfBirthInput:date=-13429d"
  ],
  "labels": [
    "navigate Open https://demoqa.com/automation-practice-form",
    "type Type {{firstName}}",
    "type Type {{lastName}}",
    "type Type {{username}}",
    "check Check \"Male\"",
    "click Click \"Male\"",
    "click Click \"Male\"",
    "type Type {{username2}}",
    "click Pick {{dateOfBirthInput}}",
    "type Type {{subjectsInput}}",
    "click Click {{subjectsInput}}",
    "check Check \"Sports\"",
    "click Click \"Sports\"",
    "click Click \"Sports\"",
    "upload Upload file",
    "type Type {{currentAddress}}",
    "type Type {{text}}",
    "click Click {{text}}",
    "type Type {{text2}}",
    "click Click {{text2}}",
    "click Click \"Submit\""
  ]
}
```

Replay 1: pass (passed), model calls 0, heals 0

Replay 2: pass (passed), model calls 0, heals 0

Artifacts:

- `docs/proof/realworld/artifacts/p2-r1.png`
- `docs/proof/realworld/artifacts/p2-r2.png`

### p3 Booking, stop before reserve

Site: automationintesting.online

Recorded:

```json
{
  "id": "wf-1792700830528",
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

Replay 1: pass (paused), model calls 0, heals 0

Replay 2: pass (paused), model calls 0, heals 0

Artifacts:

- `docs/proof/realworld/artifacts/p3-r1.png`
- `docs/proof/realworld/artifacts/p3-r2.png`

### p4 Trial search and CSV download

Site: clinicaltrials.gov

Recorded:

```json
{
  "id": "wf-1792700918495",
  "openUrl": "https://clinicaltrials.gov/search",
  "startUrl": "https://clinicaltrials.gov/search",
  "steps": 12,
  "actions": {
    "navigate": 1,
    "type": 2,
    "key": 1,
    "click": 7,
    "download": 1
  },
  "inputs": [
    "advcond:text=type 1 diabetes",
    "text:text=California",
    "text2:date=-2472d",
    "text3:date=-660d"
  ],
  "labels": [
    "navigate Open https://clinicaltrials.gov/search",
    "type Type {{advcond}}",
    "key Press Enter",
    "type Type {{text}}",
    "click Click {{text}}",
    "click Pick {{text2}}",
    "click Pick {{text3}}",
    "click Click \"Recruiting (425)\"",
    "click Click \"Apply Filters\"",
    "click Click \"download\"",
    "click Click \"CSV\"",
    "download Download"
  ]
}
```

Replay 1: pass (passed), model calls 0, heals 0

Replay 2: pass (passed), model calls 0, heals 0

Artifacts:

- `docs/proof/realworld/artifacts/p4-r1.png`
- `docs/proof/realworld/artifacts/p4-r2.png`

### p5 Paginated catalog to CSV

Site: books.toscrape.com

Recorded:

```json
{
  "id": "wf-1792701005767",
  "openUrl": "https://books.toscrape.com/",
  "startUrl": "https://books.toscrape.com/",
  "steps": 3,
  "actions": {
    "navigate": 1,
    "click": 1,
    "extract": 1
  },
  "inputs": [
    "category:text=Mystery"
  ],
  "labels": [
    "navigate Open https://books.toscrape.com/",
    "click Click {{category}}",
    "extract Extract books"
  ]
}
```

Replay 1: pass (passed), model calls 0, heals 0

Replay 2: pass (passed), model calls 0, heals 0

Artifacts:

- `docs/proof/realworld/artifacts/p5-r1.png`
- `docs/proof/realworld/artifacts/p5-r2.png`

### p6 Spreadsheet rows into a web table

Site: demoqa.com/webtables

Recorded:

```json
{
  "id": "wf-1792701097515",
  "openUrl": "https://demoqa.com/webtables",
  "startUrl": "https://demoqa.com/webtables",
  "steps": 41,
  "actions": {
    "navigate": 1,
    "click": 10,
    "type": 30
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
    "department3:text=Networks",
    "firstName4:text=Donald",
    "lastName4:text=Knuth",
    "username4:text=donald-table@example.com",
    "age4:text=84",
    "salary4:text=10004",
    "department4:text=Algorithms",
    "firstName5:text=Margaret",
    "lastName5:text=Hamilton",
    "username5:text=margaret-table@example.com",
    "age5:text=89",
    "salary5:text=10005",
    "department5:text=Apollo"
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
    "click Click \"Submit\"",
    "click Click \"Add\"",
    "type Type {{firstName4}}",
    "type Type {{lastName4}}",
    "type Type {{username4}}",
    "type Type {{age4}}",
    "type Type {{salary4}}",
    "type Type {{department4}}",
    "click Click \"Submit\"",
    "click Click \"Add\"",
    "type Type {{firstName5}}",
    "type Type {{lastName5}}",
    "type Type {{username5}}",
    "type Type {{age5}}",
    "type Type {{salary5}}",
    "type Type {{department5}}"
  ]
}
```

Replay 1: pass (passed), model calls 0, heals 0

Replay 2: pass (passed), model calls 0, heals 0

Artifacts:

- `docs/proof/realworld/artifacts/p6-r1.png`
- `docs/proof/realworld/artifacts/p6-r2.png`

### p7 Wikipedia history across skins

Site: en.wikipedia.org

Recorded:

```json
{
  "id": "wf-1792701197004",
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

Replay 1: pass (passed), model calls 0, heals 0

Replay 2: pass (passed), model calls 0, heals 0

Artifacts:

- `docs/proof/realworld/artifacts/p7-r1.png`
- `docs/proof/realworld/artifacts/p7-r2.png`

### p8 Unstable DOM, new tab, JS dialogs

Site: the-internet.herokuapp.com

Recorded:

```json
{
  "id": "wf-1792701274010",
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

Replay 1: pass (passed), model calls 0, heals 0

Replay 2: pass (passed), model calls 0, heals 0

Artifacts:

- `docs/proof/realworld/artifacts/p8-r1.png`
- `docs/proof/realworld/artifacts/p8-r2.png`

### p9 Shadow-DOM shop, stop before place order

Site: shop.polymer-project.org

Recorded:

```json
{
  "id": "wf-1792701379505",
  "openUrl": "https://shop.polymer-project.org/",
  "startUrl": "https://shop.polymer-project.org/",
  "steps": 16,
  "actions": {
    "navigate": 2,
    "click": 4,
    "select": 2,
    "type": 7,
    "confirm": 1
  },
  "inputs": [
    "sizeSelect:text=M",
    "quantitySelect:text=2",
    "username:text=bao-buyer@example.com",
    "accountPhone:text=4155550199",
    "shipAddress:text=1 Market",
    "shipCity:text=San Francisco",
    "shipState:text=CA",
    "shipZip:text=94105",
    "ccName:text=Bao"
  ],
  "labels": [
    "navigate Open https://shop.polymer-project.org/",
    "navigate Open https://shop.polymer-project.org/list/mens_tshirts",
    "click Click",
    "select Select {{sizeSelect}}",
    "select Select {{quantitySelect}}",
    "click Click \"Add this item to cart\"",
    "click Click \"VIEW CART\"",
    "click Click \"Checkout\"",
    "type Type {{username}}",
    "type Type {{accountPhone}}",
    "type Type {{shipAddress}}",
    "type Type {{shipCity}}",
    "type Type {{shipState}}",
    "type Type {{shipZip}}",
    "type Type {{ccName}}",
    "confirm Confirm \"Place Order\""
  ]
}
```

Replay 1: pass (paused), model calls 0, heals 0

Replay 2: pass (paused), model calls 0, heals 0

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

Recording error before stop: POST /api/sessions/drive 500 locator.click: Timeout 12000ms exceeded.
Call log:
  - waiting for locator('button:text-is(\'Rectangle\')').first()


Recorded:

```json
{
  "id": "wf-1792701525922",
  "openUrl": "https://excalidraw.com/",
  "startUrl": "https://excalidraw.com/",
  "steps": 1,
  "actions": {
    "navigate": 1
  },
  "inputs": [],
  "labels": [
    "navigate Open https://excalidraw.com/"
  ],
  "recordError": "POST /api/sessions/drive 500 locator.click: Timeout 12000ms exceeded.\nCall log:\n  - waiting for locator('button:text-is(\\'Rectangle\\')').first()\n"
}
```

Replay 1: fail (failed), model calls 0, heals 0
First failure: check — no embedded scene JSON; canvas steps recorded: 0; labels Alpha, Beta not verified

Replay 2: fail (failed), model calls 0, heals 0
First failure: check — no embedded scene JSON; canvas steps recorded: 0; labels Gamma, Delta not verified

Artifacts:

- `docs/proof/realworld/artifacts/p13-r1.png`
- `docs/proof/realworld/artifacts/p13-r2.png`

### p14 Bot wall

Site: practicesoftwaretesting.com

Recorded:

```json
{
  "id": "wf-1792701595283",
  "openUrl": "https://practicesoftwaretesting.com/",
  "startUrl": "https://practicesoftwaretesting.com/",
  "steps": 1,
  "actions": {
    "navigate": 1
  },
  "inputs": [],
  "labels": [
    "navigate Open https://practicesoftwaretesting.com/"
  ]
}
```

Replay 1: pass (paused), model calls 0, heals 0

Replay 2: pass (paused), model calls 0, heals 0

Artifacts:

- `docs/proof/realworld/artifacts/p14-r1.png`
- `docs/proof/realworld/artifacts/p14-r2.png`

