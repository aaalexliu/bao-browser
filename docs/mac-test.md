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

`package-app.sh` for the helper builds `desktop/os-helper-macos/BaoOSHelper.app` (`dev.bao.oshelper`). The desktop script builds `desktop/packaging/macos/dist/Bao.app` (`dev.bao.desktop`) and a dmg next to it. Both are signed with `BAO_SIGN_IDENTITY`. There is no notarization step.

Open `Bao.app`. If it is a script bundle, Gatekeeper may say it is from an unidentified developer. Right-click → Open once. Do not rebuild the helper after the grant, or the signature changes and macOS asks again.

## Permissions

1. Launch `BaoOSHelper.app` once so the prompt appears.
2. System Settings → Privacy & Security → Accessibility → enable `BaoOSHelper`.
3. Same pane, Screen Recording → enable `BaoOSHelper`.
4. Quit and relaunch the helper. `BaoOSHelper.app/Contents/MacOS/bao-os-macos permissions` should report both true.

The app itself does not need Accessibility. Chrome will ask for nothing beyond a normal window.

## Record

1. In Bao, Sessions → Browser → Start capture. URL can be the built-in fixture (`http://127.0.0.1:4787/fixture`) or a page you choose.
2. Type a username. Type a password. The password must not show up later in the trail or the workflow.
3. Drag a throwaway file onto the drop zone, or pick one with the file input. Use a file you created for the test, not a real document.
4. Stop and save.
5. Library shows the workflow. Export if you want the JSON. Confirm there is a `secret` input and a `file` input, and no absolute path.

## Replay twice

1. Replay. The form lists every input before Run. Fill a different username and a different file than the capture.
2. Run. Each step goes pass or fail. The fixture page shows the new username.
3. Move and resize the Chrome window.
4. Run again with a third username. It should pass without using the old coordinates.
5. Optional: Settings → Approve before applying. Break a step's `testId` in the library editor, run again. With no API key the run stops on that step and shows the snapshot. With a key and the setting on approve, it pauses on the proposal. Auto (the default) continues only when a key is set.

## Calculator, after the walk is fixed

The 2026-10-20 spike could hit-test Calculator's `7`, `Add`, `5`, and `Equals`, but the tree walk did not contain them, so press-by-name missed. Do not paper over that with a click at the stored point.

When `bao-os-macos nodes --bundle com.apple.calculator` includes those buttons:

```sh
# Capture fixtures for the scorer. Commit the dumps.
bash -c 'see fixtures/ax/macos-26/README.md'
```

Then replay `examples/workflows/calculator.json` with two pairs, for example `a=7 b=5` and `a=5 b=7`, after moving the Calculator window. The label should match the sum. The press command in the helper log must not contain an x,y.

## Done

You can install the build, grant the two permissions, record a typed input and a dragged file, save, and replay twice with different upfront inputs after moving the window. That pass is yours to make. This repo's Linux run is the evidence for the same flows on the fixture page, the GTK calculator, the drift table, and the MCP trail.
