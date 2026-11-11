# Sign-in recorder fixtures

`signin-single.recording.json` and `signin-multi.recording.json` are Bao recorder output captured on 2026-11-11 from the local `signin.html` page. They are not hand-written event arrays and are not recordings of account sign-ins. All entered values are synthetic fixture values.

The capture used a running checkout app, a temporary HOME and Library, a synthetic browser profile, headless pinned Playwright Chromium, the hermetic lane's connection guard, and no model keys or native grants. Each pointer click, fill, checkbox change, and keypress went through the app's `/api/sessions/drive` test surface and the production recorder. The raw output retains repeated password events, source identities, URLs, timestamps, and the separate checkbox click/change pair.

| File | Recorded path |
| --- | --- |
| `signin-single.recording.json` | Focus username, fill username, focus password, fill password, check Remember me, focus password, press Enter, add the Account overview check, open the statement. |
| `signin-multi.recording.json` | Focus username, fill username, focus password, fill password, check Remember me, submit to `/challenge`, focus/fill Confirm password, focus/fill PIN, press Enter, add the Account overview check, open the statement. |

To capture again, serve `signin.html` from an isolated local fixture server. Start Teach through `/api/sessions` on `/` for the single-page case or `/?multi=1` for the challenge case. Perform the listed actions, call `/api/teach/check` after the final submit, then click `#business`. Stop and save Teach. Copy the resulting temporary Library trail, excluding `kind: "decision"` records, into the matching recording file. Do not edit the event payloads by hand.

`desktop/test/unit/teach-signin.test.ts` checks every mark position against these stored recorder outputs. `desktop/test/unit/teach-signin-app.test.ts` captures the challenge flow anew in the running app, confirms the suggested span through its UI, saves it, and proves replay waits while the owner completes both forms. Its fixture server redirects a fresh request for `/account` back to sign-in, as a signed-out protected page would.
