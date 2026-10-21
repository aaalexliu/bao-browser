# macOS test, clean account

Do this on a fresh macOS user. The machine in the notes is alex-jxp, macOS 26. The helper and the app are different bundles so the Accessibility grant sticks to the helper.

## Install

```sh
git fetch origin v1/desktop
git checkout v1/desktop
npm install
npx tsc -p tsconfig.desktop.json

export BAO_SIGN_IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
bash desktop/os-helper-macos/package-app.sh
bash desktop/packaging/macos/package-app.sh
```

`package-app.sh` for the helper builds `desktop/os-helper-macos/BaoOSHelper.app` (`dev.bao.oshelper`). The desktop script builds `desktop/packaging/macos/dist/Bao.app` (`dev.bao.desktop`) and a dmg next to it. Both are signed with `BAO_SIGN_IDENTITY`. There is no notarization step. The desktop script compiles `bao-main.c` into `Contents/MacOS/bao` and copies Playwright's Chromium into `Contents/Resources`. It does not open Google Chrome. `npx playwright install chromium` runs first if that browser is not already downloaded.

Open `Bao.app`. Gatekeeper may say it is from an unidentified developer. Right-click → Open once. Do not rebuild the helper after the grant, or the signature changes and macOS asks again.

## Permissions

1. Launch `BaoOSHelper.app` once so the prompt appears.
2. System Settings → Privacy & Security → Accessibility → enable `BaoOSHelper`.
3. Same pane, Screen Recording → enable `BaoOSHelper`.
4. Quit and relaunch the helper. `BaoOSHelper.app/Contents/MacOS/bao-os-macos permissions` should report both true.

The app itself does not need Accessibility. The bundled Chromium is a normal window. It is not the Chrome profile you use for daily browsing.

## Record

1. In Bao, Sessions → Browser → Start capture. URL can be the built-in fixture (`http://127.0.0.1:4787/fixture`) or a page you choose.
2. Type a username. Type a password. The password must not show up later in the trail or the workflow.
3. Drag a throwaway file onto the drop zone, or pick one with the file input. Use a file you created for the test, not a real document.
4. Stop and save.
5. Library shows the workflow. Export if you want the JSON. Confirm there is a `secret` input and a `file` input, and no absolute path.

## Replay twice

1. Replay. The form lists every input before Run. Fill a different username and a different file than the capture.
2. Run. Each step goes pass or fail. The fixture page shows the new username.
3. Move the browser window. Calculator cannot be resized: `AXSize` returns `-25200`, and that drift row is n/a.
4. Run again with a third username. It should pass without using the old coordinates.
5. Optional: Settings → Approve before applying. Break a step's `testId` in the library editor, run again. With no API key the run stops on that step and shows the snapshot. With a key and the setting on approve, it pauses on the proposal. Auto (the default) continues only when a key is set.

## Calculator and TextEdit

The macOS 26 dumps are already in `fixtures/ax/macos-26/`. Calculator keys are in the tree: description is the visible label (`7`, `Add`), identifier is the stable token (`Seven`, `Add`). Do not click a stored point.

A live Codex run through `bao mcp` (`desktop/src/proxy/mcp-bao.ts`) pressed Clear / All Clear three times, then `7 + 5`, and the display read `12`. Interpret kept `{{a}}`, `Add`, `{{b}}`, `Equals`. Replay of `3+4` and `8+1` read `7` and `9` after the window moved. Resize did not run.

TextEdit's body is the text area `First Text View`. Interpret kept one `osSetValue` of `{{text}}`. Replay wrote two different strings. The window title may be `Untitled` or `Untitled.rtf`.

A file does not drag from this helper. Use the Open panel path in `docs/files-and-drag.md`.

## Done

You can install the build, grant the two permissions, record a typed input and a dragged file, save, and replay twice with different upfront inputs after moving the window. That pass is yours to make. This repo's Linux run is the evidence for the same flows on the fixture page, the GTK calculator, the drift table, and the MCP trail.
