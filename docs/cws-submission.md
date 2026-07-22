# Chrome Web Store submission

A step-by-step checklist for publishing Bao to the Chrome Web Store (CWS). This is
mostly a manual, one-time process. The strategic notes behind it (review risk, the
`<all_urls>` justification, distribution modes) live in `README.md`; this doc is the
literal procedure.

Current state: `manifest.json` version `0.1.0`, MV3, icons wired, no `debugger`
permission. `npm run package` produces an upload-ready `bao.zip`. All listing art
(icons, promo tile, screenshots) now regenerates deterministically from scripts in
`assets/` - see §5.

---

## 0. One-time account setup

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in with the Google account that will own the listing (use a dedicated
   project account, not a personal one, if this is more than a spike).
3. Pay the **one-time $5 USD developer registration fee**. Registration can take a
   few minutes to a few hours to clear before you can publish.
4. Verify the account email. For a `<all_urls>` extension, Google may also require a
   verified publisher / group publisher; do this early since it can add delay.
5. **Add a contact email** in Account > Profile and verify it. A verified contact
   email is required before you can publish or edit any item.
6. **Trader declaration (EEA law, required).** The dashboard makes you declare the
   account a **trader** or **non-trader** under EU/EEA consumer-protection law
   (Digital Services Act + Omnibus Directive). This is not optional cruft; you cannot
   fully distribute without answering it.
   - **Trader** = you publish in the course of a business, trade, or profession
     (commercial intent, monetization, or a company behind it).
   - **Non-trader** = purely personal/hobby, outside any profession.
   - Consequences: declaring **trader** requires verifying identity + contact details
     via a **Google payments profile**, and those contact details are shown publicly
     on the EEA listing. Until a declared trader is verified, the listing is publicly
     **labelled "non-trader"** and EEA distribution can be restricted.
   - **Recommendation for Bao:** the roadmap is a product (backend + workflow sharing),
     so the honest declaration is **trader** - complete the Google payments-profile
     verification (it can sit "pending" for a bit). Only use non-trader if you are
     genuinely shipping this as a non-commercial personal project; mis-declaring
     carries legal/policy risk, not just a label.

---

## 1. Pre-submission checklist (code)

- [ ] **Bump the version.** `0.1.0` is fine for a first upload, but every re-upload
      to the store needs a strictly higher `version` in `manifest.json`. Bump it in
      both `manifest.json` and `package.json` to keep them in sync.
- [x] **Build fresh.** `npm run build` (esbuild -> `dist/`). `dist/` is gitignored,
      so it must be rebuilt before packaging. `npm run package` does this for you.
- [ ] **Typecheck + tests pass.** `npm run typecheck && npm test`.
- [x] **Confirm the permission set is minimal.** Current manifest requests:
      `storage`, `scripting`, `webNavigation`, `alarms`, `downloads`, `sidePanel`,
      and `host_permissions: ["<all_urls>"]`. No `debugger`, no `activeTab`. Do not
      add permissions you cannot justify (see §4) — each one widens review.
- [ ] **Description is accurate.** The manifest `description` is
      "Record + deterministic replay of browser actions." The store listing
      description can be longer but must match what the extension actually does.

---

## 2. Package the ZIP

The store wants a ZIP whose **root contains `manifest.json`** (not a parent folder).
The package needs the manifest, the built `dist/` bundles, the two HTML entry points,
and the icons. It does **not** need `src/`, `test/`, `node_modules/`, `assets/`,
`docs/`, or config files.

From the repo root:

```sh
npm run build
rm -f bao.zip
zip -r bao.zip \
  manifest.json \
  dist/ \
  sidepanel.html \
  dashboard.html \
  icons/
```

Then sanity-check the archive:

```sh
unzip -l bao.zip
```

You should see `manifest.json` at the top level, `dist/background.js`,
`dist/content.js`, `dist/sidepanel.js`, `dist/dashboard.js`, `dist/forceopen.js`,
both `.html` files, and the four `icons/icon-*.png` sizes. Nothing else.

> Tip: load `bao.zip`'s contents as an unpacked extension one more time before
> uploading (unzip to a temp dir, `chrome://extensions` -> Load unpacked) to confirm
> the packaged file list actually runs, not just your working tree.

Consider adding a `package` script to `package.json` so this is repeatable:

```json
"package": "node build.mjs && rm -f bao.zip && zip -r bao.zip manifest.json dist/ sidepanel.html dashboard.html icons/"
```

---

## 3. Create the listing (Developer Dashboard)

1. In the dashboard, click **Add new item**.
2. Upload `bao.zip`. If the manifest is rejected, fix and re-zip (the store validates
   the manifest on upload).
3. Fill in the **Store listing** tab:
   - **Product name:** Bao
   - **Summary:** one line, matches the manifest description.
   - **Detailed description:** what it does, who it's for (QA/dev wedge for launch #1),
     how record + replay works. No unverifiable claims.
   - **Category:** Productivity / Workflow.
   - **Language:** English.
4. Fill in the **assets** (see §5 — these are the current blockers).
5. Fill in **Privacy** (see §6).
6. Fill in **Distribution:** choose **Public** or **Unlisted**. For a beta, **Unlisted**
   lets you share a direct install link without ranking in search while you iterate.

---

## 4. Permission justifications

The `<all_urls>` host permission plus `scripting` / `webNavigation` / `downloads`
trigger the per-permission justification form and heavier human review. Budget for
back-and-forth. Pre-filled justifications, one per requested permission:

- **`host_permissions: <all_urls>`** (the crux): "Bao is a general-purpose browser
  action recorder and replayer. The user chooses which page to record on at runtime,
  so the extension cannot know the target origin in advance and must be able to run on
  any page the user selects. It does not collect or transmit page data; recordings are
  stored locally."
- **`scripting`:** "Injects the content script that captures user interactions and
  replays them deterministically on the page the user is recording."
- **`webNavigation`:** "Detects page navigations during a recording so multi-page
  workflows replay in the correct order."
- **`downloads`:** "Exports a recorded workflow to a local file at the user's request."
- **`storage`:** "Persists recorded workflows locally in the browser."
- **`alarms`:** "Schedules internal timing/housekeeping for the recorder's background
  service worker."
- **`sidePanel`:** "The recorder UI is presented in the browser side panel."

Data story to state plainly: **local-first today**; no remote data transmission in this
version. Cloud features are opt-in and not part of this build. Keeping this simple is
what keeps review manageable.

---

## 5. Listing assets

All listing art is generated by deps-free Playwright scripts in `assets/` (they reuse
the Chromium that Playwright already installs), so it regenerates consistently whenever
the icon or UI changes. The single source of truth for the mark is `assets/icon.svg`.

| Asset | Requirement | Command | Output |
| --- | --- | --- | --- |
| **Icon 128x128** (+ 16/32/48) | required | `npm run icons` | `icons/icon-*.png` |
| **Screenshots** | 1–5, **1280x800** | `npm run screenshots` | `assets/store/0*-*.png` |
| **Small promo tile** | required, **440x280** | `npm run promo` | `assets/store/promo-440x280.png` |
| **Marquee (920x680)** | optional (featured only) | — | — |

Notes:

- `npm run screenshots` loads the built extension exactly as the E2E tests do,
  seeds a fixed demo library + run history through the SW, and screenshots the real
  dashboard and side-panel UI. Same input, same PNGs every run — no hand-arranging.
- The promo tile renders **@2x (880x560)**; resize to 440x280 before uploading.
- After changing `assets/icon.svg`, run `npm run icons && npm run promo` to keep the
  PNG icons and the promo mark in sync.

---

## 6. Privacy & data disclosure

- **Single purpose:** state it clearly ("record and deterministically replay browser
  actions"). MV3 single-purpose policy is strict; `<all_urls>` extensions are checked
  against it.
- **Data usage form:** declare that Bao does **not** collect or transmit user data in
  this version (recordings are local). Do not over-declare.
- **Privacy policy URL:** none is maintained in-repo. The store may require a policy URL
  specifically because of `<all_urls>`. If asked, host a short statement at submission
  time: local-first today, no data leaves the browser, cloud features opt-in and coming.
  A single static page on the landing site (`site/`) is enough.

---

## 7. Submit and after

1. Click **Submit for review**.
2. Review for an `<all_urls>` extension typically takes **days, not hours**, and can
   bounce back with questions on the host-permission justification. Answer promptly.
3. On rejection: read the cited policy, adjust manifest/justification, **bump the
   version**, re-package (§2), and re-upload.
4. On approval: if you published **Unlisted**, share the install link with beta/design
   partners. Switch to **Public** when ready for launch #1 (the QA/dev wedge).

## Interim distribution (while in review)

The store listing is the real answer for the non-technical primary user (one-click
install). Until it's live, for beta and design-partner installs use:

- **Unpacked load** (`chrome://extensions` -> Developer mode -> Load unpacked) — fine
  for technical partners, hostile to non-technical users.
- **`.crx` / Enterprise force-install** — for managed/design-partner machines.

Do not treat unpacked load as the launch distribution; it contradicts the product
thesis.
