# Real-world proof

Measured on Linux with headless Chrome from v1/desktop. Replay video is macOS-only, so each browser replay saved keyframes. Pass means both the doc's check and 0 model calls. ACCEPT stays 60 and MARGIN stays 25.

p2, p4, and p6 were remeasured in this pass. Each replay opened its own browser. p1, p3, p5, p7, p8, and p9 were not rerun; their rows are the previous measurement.

| Task | Pass | Model calls | Heals | First failure |
|---|---|---|---|---|
| p1 Sign-up, contact upload, delete account | 2/2 | 0, 0 | 0 ; 0 | — |
| p2 Practice form with date picker and dependent selects | 2/2 | 0, 0 | 0 ; 0 | — |
| p3 Booking, stop before reserve | 2/2 | 0, 0 | 0 ; 0 | — |
| p4 Trial search and CSV download | 2/2 | 0, 0 | 0 ; 0 | — |
| p5 Paginated catalog to CSV | 0/2 | 0, 0 | 0 ; 0 | no extract or CSV output; category is a click, not an input |
| p6 Spreadsheet rows into a web table | 2/2 | 0, 0 | 0 ; 0 | — |
| p7 Wikipedia history across skins | 2/2 | 0, 0 | 0 ; 0 | — |
| p8 Unstable DOM, new tab, JS dialogs | 2/2 | 0, 0 | 0 ; 0 | — |
| p9 Shadow-DOM shop, stop before place order | 0/2 | 0, 0 | 0 ; 0 | no confirm gate before Place Order |

## Failure causes

1. p5 — no extract or CSV output. The category is a click, not an input, so Mystery and Historical Fiction were not replayed.
2. p9 — no confirm gate before Place Order.

## Keyframes

p2, p4, and p6 replay 1 and replay 2 were photographed from different browsers. The png bytes differ.

| Task | Replay 1 sha256 | Replay 2 sha256 |
|---|---|---|
| p2 | `742e0d9f4ac61c03…` | `07a54ef0c07da21e…` |
| p4 | `f79e0f2065100f3b…` | `b12e6546c25af21f…` |
| p6 | `403133c044f8ebb1…` | `d4809be2194cde3b…` |

p2 replay 1 shows Grace Hopper and 18 March, 1991. Replay 2 shows Radia Perlman and 04 November, 1984. p4 replay 1 searches type 1 diabetes in California (14 RECRUITING rows). Replay 2 searches migraine in Texas (12 RECRUITING rows). p6 replay 1 shows Alan Turing, Edsger Dijkstra, and Barbara Liskov. Replay 2 shows Ken Thompson, Dennis Ritchie, Frances Allen, Donald Knuth, and Margaret Hamilton. The p6 frames match an earlier passing replay of those same rows; the two runs in this pass are not the same image.

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


### p2 Practice form with date picker and dependent selects

Site: demoqa.com

Recorded:

```json
{
  "id": "wf-1792695069751",
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


### p4 Trial search and CSV download

Site: clinicaltrials.gov

Recorded:

```json
{
  "id": "wf-1792695163010",
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
  "id": "wf-1792695275250",
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

