# macOS 26 accessibility fixtures

Host was macOS 26.6.2. Dumps come from `bao-os-macos fixture`. Each file is one test window. The menu bar is omitted. Strings that are not the test content are replaced with `[sidebar]`, `[redacted]`, or `[redacted-path]` before the file is written. Frames are top-left screen points.

`calculator.observed.json` is the earlier partial keypad (buttons named `7`, `Add`, `5`, `Equals`). It is not this dump. The scorer tests both.

## Calculator

`calculator.json` has the keypad in the tree. `AXChildren` includes the digit and operator buttons, and a 48-point hit-test grid also returns them (`sampleCount` 40).

What identifies a key:

- `AXTitle` is empty.
- `AXDescription` is the visible label (`7`, `Add`, `Equals`, `All Clear`).
- `AXIdentifier` is the stable token (`Seven`, `Add`, `Equals`, `AllClear`).

The display is an `AXStaticText` value, not the scroll area. The value can include a leading left-to-right mark (`0` is not a bare `0`). Button frames are present. An earlier build of this helper found the keypad only by hit-testing. This dump shows both.

`AXSize` on this window returns `-25200`. A resize drift row for Calculator is not applicable. Moving the window is the check that ran.

## TextEdit

`textedit.json` is a new untitled window. The body is an `AXTextArea` whose `AXIdentifier` is `First Text View`. Title and description on that node are empty, so a lookup by visible title misses it. The window title is `Untitled` on one launch and `Untitled.rtf` on the next. Those are the same kind of document. The three `AXButton` nodes are the window controls, not the text.

## Finder

`finder.json` is one new window on a folder created under `/tmp` with `a.txt` and `b.txt`. The file name is the `AXValue` of an `AXTextField`, not the row title. The icon is a separate `AXImage` a few points to the left of that field. Sidebar labels are not test content and are stored as `[sidebar]`.

## Safari

`safari.json` is one private window after the address field was set to `https://the-internet.herokuapp.com`. The window title is `The Internet, Private Browsing`. The address field identifier is `WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD` and its description is `smart search field in a private window`. Page content is an `AXWebArea` whose description is `The Internet`, plus links and groups. The web area title is empty, so the window title and the address-field identifier are the stable names.

`AXUIElementPostKeyboardEvent` reported success for the private-window shortcut and for the URL, and the test page did not load. `CGEvent` keyboard events were posted only after `AXFrontmost` became true. While another app stayed front, that check stayed false and the URL was not sent. Setting `AXValue` on the private window's address field and performing `AXConfirm` did load the test page. The private window was then closed. A window that was already open was left alone and was not dumped.

## Electron

The throwaway app is `fixtures/ax/electron-app`. No installed Electron app was opened. `app.accessibilitySupportEnabled` has to be set inside `app.whenReady`, before the window is created. Setting it earlier throws, and the process then has a CoreGraphics window whose accessibility role is empty.

With the flag set after ready, `electron.json` contains an `AXWindow` titled `bao ax electron`, an `AXWebArea`, and an `AXButton` titled `bao-button`. `electron-manual-off.json` is the same shape when the helper does not set `AXManualAccessibility`. The app flag is what exposes the button. The helper flag does not add nodes beyond that. Hit-testing this window returned no samples.

## Open panel and drag

Recorded in `files.json`.

`AXUIElementPostKeyboardEvent` for `cmd+o`, `cmd+shift+g`, the path, and Return reported success. The Open panel did not appear, and the untitled document stayed empty.

`CGEvent` keyboard events, once TextEdit was frontmost, opened the panel (`AXWindow` title `Open`) and the Go to Folder sheet (`AXSheet`). The typed `/tmp/.../note.txt` path was the sheet text field's `AXValue`. That field's action is `AXConfirm`, not `AXPress`. Return and `AXPress` on the panel's Open button did not load the file while the sheet was up. A later `AXConfirm` on that field did not run: TextEdit would not become frontmost, and the helper refuses to post `CGEvent` keys in that case.

A left-button `CGEvent` drag from the `a.txt` icon to the TextEdit text area moved the pointer. The coordinate space that matched was top-left, the same space as the accessibility frames. The cursor location read before the first post was not on the display (`y` negative). After the move it matched the requested point. The text area value did not become the file contents. macOS delivered the pointer motion and did not start a file drag.
