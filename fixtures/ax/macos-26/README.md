# macOS 26 accessibility fixtures

The scorer tests on Linux read these files. They are raw dumps, not hand-written trees.

Capture them on alex-jxp (macOS 26) with the signed helper, after Accessibility is granted to `BaoOSHelper.app`:

```sh
export BAO_SIGN_IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
bash desktop/os-helper-macos/package-app.sh
HELPER=desktop/os-helper-macos/BaoOSHelper.app/Contents/MacOS/bao-os-macos
mkdir -p fixtures/ax/macos-26

dump() {
  local bundle="$1" out="$2"
  "$HELPER" nodes --bundle "$bundle" > "$out"
}

# Open each app first so it has a window.
open -a Calculator
open -a TextEdit
open -a Finder
open -a Safari
dump com.apple.calculator fixtures/ax/macos-26/calculator.dump.json
dump com.apple.TextEdit fixtures/ax/macos-26/textedit.dump.json
dump com.apple.finder fixtures/ax/macos-26/finder.dump.json
dump com.apple.Safari fixtures/ax/macos-26/safari.dump.json
# One Electron app. Cursor's bundle id, or any other Electron app that is running.
dump com.todesktop.230313mzl4w4u92 fixtures/ax/macos-26/electron.dump.json
```

`nodes` prints one JSON object: `{ ok, pid, geometry, nodes: AxNode[] }`. Commit those files as-is. `desktop/test/unit/ax-fixtures.test.ts` loads every `*.dump.json` here and checks the keypad (or the first named button) is unique under the scorer. Until those dumps land, that test skips the missing files.

`calculator.observed.json` is not a dump. It is the partial keypad the 2026-10-20 spike actually resolved (`AXButton` 7, Add, 5, Equals) and exists so the scorer can be tested before the full tree is committed.
