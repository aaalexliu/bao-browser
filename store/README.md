# Chrome Web Store submission - do this

Everything needed to publish Bao to the Chrome Web Store is in this folder. The code
work is done; what's left is account setup + copy/paste into the dashboard. Budget ~30
minutes plus review wait.

> **Launch #1 = the QA/dev wedge.** This build is local-only, no backend, no `debugger`
> permission - the easiest thing CWS will ever review from us. See
> [§ When we add the backend](#later-when-we-add-the-backend-m2) for what a revamp costs.

## What's in this folder

| File | What it is | Where it goes |
|---|---|---|
| `bao-extension.zip` | The packaged extension, ready to upload | "Package" upload |
| `screenshots/1-library.png` … `4-panel.png` | Four 1280×800 store screenshots | "Screenshots" |
| `promo-tile-440x280.png` | Small promo tile | "Store icon / promo" (optional but recommended) |
| `gen-store-assets.mjs` | Regenerates all the above from the real UI | - run `node store/gen-store-assets.mjs` |
| `listing.md` copy below | Name / summary / description / permission answers | Listing + Privacy tabs |

The 128px store icon is already inside the zip (`icons/icon-128.png`); CWS reads it from
the manifest.

---

## Before you start (one-time)

1. **Create a Chrome Web Store developer account** - https://chrome.google.com/webstore/devconsole
   Pay the **one-time $5** registration fee. (Use the Google account you want to own the listing.)
2. **Verify a contact email** in the developer console (Account tab) - required before you can publish.
3. **Host the privacy policy at a public URL.** CWS needs a link, not a file. Easiest options:
   - publish [`../PRIVACY.md`](../PRIVACY.md) on the landing site as `/privacy`, **or**
   - enable GitHub Pages and link the rendered `PRIVACY.md`, **or**
   - link the raw file: `https://github.com/aaalexliu/bao-browser/blob/main/PRIVACY.md`.
   Copy that URL - you'll paste it in step 3 of submission.
4. *(Recommended)* **Bump the version** off `0.0.1` in `manifest.json` to e.g. `0.1.0`, then
   re-run `npm run build` and re-zip (command at the bottom). `0.0.1` reads as "not real."

---

## Submit (in the developer console)

1. **New item → Upload** `store/bao-extension.zip`.
2. **Store listing tab** - paste from [§ Listing copy](#listing-copy) below:
   - Name, Summary, Description
   - Category: **Developer Tools**
   - Language: English
   - Upload the four **screenshots** from `screenshots/`
   - Upload the **promo tile** (Small promo, 440×280)
3. **Privacy tab** - the part reviewers actually scrutinize:
   - **Single purpose**: paste the single-purpose statement below.
   - **Permission justifications**: paste one line per permission from the table below.
     `host_permissions <all_urls>` is the one they care about - the justification is written
     to be the crux of approval.
   - **Data usage**: check **"does not collect or use"** for every data category (this build
     transmits nothing). Then certify the three boxes: not selling data, not using it for
     unrelated purposes, not for creditworthiness/lending. All true today.
   - **Privacy policy URL**: paste the URL from prerequisite step 3.
   - **Remote code**: **No** (MV3-compliant; all JS ships in the package).
4. **Distribution**: **Public** (or **Unlisted** if you want a link-only beta first - a good
   idea while you shake out review).
5. **Submit for review.**

---

## Listing copy

### Name
```
Bao - Record & Replay Browser Workflows
```
> The store title comes from the manifest `name` (currently just "Bao"). To use the longer,
> more discoverable title above, set `"name"` in `manifest.json` before you build the zip.
> Keep it or shorten it - your call.

### Summary (max 132 chars)
```
Record a browser task once, replay it deterministically. Readable, editable steps. Local-first - your secrets never leave.
```

### Description
```
Bao records what you do on a web page and replays it exactly - as plain, deterministic
steps, not an AI agent guessing each run.

Record a workflow once (log in, open the report, download the CSV) and Bao turns it into
a readable, editable list of steps you can replay any time. Replay is ordinary code: free,
instant, works offline, and when a page has genuinely changed it tells you which step to
re-record instead of clicking the wrong thing.

WHY IT'S DIFFERENT
- Deterministic, not probabilistic. A ranked selector ladder re-finds each element the
  same way every time. No tokens, no latency, no dice roll.
- Readable steps you own. Every step is human-readable and editable - reorder, delete, or
  change a value with no re-recording. Export any workflow as JSON.
- Built for QA & CI. Capture assertions while you record, then replay headless from a
  one-line runner that exits non-zero when a step or assertion fails.
- Survives churn. Anchored capture re-resolves the same item even after a feed reorders.

PRIVACY BY DESIGN
- Local-first: your workflows and screenshots stay in your browser. This build has no
  backend and no account.
- Secrets are never captured: passwords, card numbers, CVVs, SSNs and one-time codes are
  detected and dropped at recording time - never stored, never screenshotted.
- No "debugger" permission, so no scary trust banner.

Bring a repetitive browser task; leave with a workflow you can trust to run the same way
every time.
```

### Single purpose (Privacy tab)
```
Bao records a user's actions on a web page and replays those actions deterministically, so
a repetitive browser workflow can be re-run or used as an automated UI test.
```

### Permission justifications (Privacy tab - one per permission)

| Permission | Justification to paste |
|---|---|
| `host_permissions: <all_urls>` | Bao is a general-purpose recorder and replayer. The user chooses which page to automate, and the extension cannot know that page in advance, so it needs to run on any site the user points it at. It reads and acts on a page only while the user is actively recording or replaying on it, and every result is stored locally in the browser - nothing is transmitted. |
| `scripting` | To inject the content script that records the user's actions and replays them on the current page. |
| `webNavigation` | To follow a workflow across page navigations (for example a login redirect) and detect when the next page is ready so replay can continue on the right document. |
| `downloads` | So a workflow that downloads a file (for example "download the report CSV") can complete, and so replay can confirm the download happened. |
| `storage` | To save the user's recorded workflows and their screenshots locally in the browser. |
| `alarms` | Timeout timing for the background service worker, which Manifest V3 shuts down between events; `alarms` is the supported way to schedule a wake-up instead of an in-memory timer. |
| `sidePanel` | Bao's main UI is a browser side panel. |

---

## Regenerating assets

All screenshots and the promo are generated from the **real** extension UI (no mockups):

```sh
npm run build
node store/gen-store-assets.mjs        # writes screenshots/*.png + promo-tile-440x280.png
```

Rebuild the upload package after any code or manifest change:

```sh
npm run build
rm -f store/bao-extension.zip
zip -rq store/bao-extension.zip manifest.json dist icons sidepanel.html dashboard.html \
  -x "*.DS_Store" "icons/preview.png"
```

---

## After you submit

- **Review time**: typically hours to a few days. Broad host permissions (`<all_urls>`) can
  stretch it - that's expected, not a rejection.
- If they push back, it will almost certainly be about `<all_urls>`. The justification above
  is the answer; you can also point to the privacy policy (local-only, no transmission).
- Once approved, the listing has a stable item ID. **Every future update carries the same ID**,
  so users' installs and data survive upgrades.

## Later: when we add the backend (M2)

The revamp that adds the hosted compiler + workflow sharing is re-reviewed on its own, and
two things change the review's nature (not the fact that it happens):
- **New permissions** (if any) can auto-disable the extension for existing users until they
  re-consent. Add only what's needed, when it's needed.
- **Data transmission**: the moment a trace reaches a server, the Privacy-tab "data usage"
  answers change from "collects nothing" to declaring exactly what's sent, and the privacy
  policy must be updated. Plan for heavier scrutiny then.
- Remote **code** is still banned - a backend API you call is fine; shipping JS fetched from
  a server is not. Our compiler-as-a-service model is compatible.

Shipping this local-only build first means that harder review happens later, from a position
of an established listing and developer-account standing.
