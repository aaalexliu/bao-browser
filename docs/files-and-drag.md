# Files and drag

A workflow step stores a `file` input (`{{file}}` or `{{drop}}`). The path exists only in the replay arguments for that run. Capture records the basename in the trail event and interpret drops even that, so the saved workflow has neither the path nor the filename.

## What was run here

| Path | What bao does | Status on this machine |
| --- | --- | --- |
| Web `<input type=file>` | Playwright `setInputFiles` on the element the scorer accepted. | Captured and replayed. `desktop/test/live/browser.test.ts`. |
| Web drop zone | Synthesize `dragenter`, `dragover`, and `drop` with a `DataTransfer` built from the file bytes inside the page. | Captured and replayed on `#drop` in the same test. |
| GTK / zenity open dialog | `bao-os-helper set-text` writes the path into the accessible text entry by role and name, then `press` confirms. No coordinate fallback. | The command is in the helper. A live zenity open was not part of the green run tonight. Spike 2 already set text in a zenity save dialog by the same AT-SPI editable-text interface. |
| Native drag onto a window | Not implemented on Linux. The AT-SPI driver throws rather than invent a pointer drag. | Documented miss. |
| macOS open panel | `CGEvent` keys, and only after the target app is frontmost. `AXConfirm` on the Go to Folder sheet's text field. | Ran on alex-jxp. AX keyboard posting does not open the panel. See below. |
| macOS drag onto a window | Not a file drag. `drag-file` returns `fallback: open-panel`. | A `CGEvent` pointer drag moved the cursor and left the TextEdit value empty. |

## Replay arguments

The app form accepts a file from the picker or a drop on the field. The browser cannot see a real path, so the UI sends the bytes and the server writes a temp file for that run only. The CLI passes `{ "name": "note.txt", "path": "/tmp/..." }` in the same args object. MCP uses that object too.

## macOS open panel and drag

Recorded on macOS 26 in `fixtures/ax/macos-26/files.json`.

`AXUIElementPostKeyboardEvent` reports success and does nothing. TextEdit's document stayed empty, and the Open panel did not appear. The same is true for Safari: posting the URL that way did not load the page. Setting `AXValue` on the private window's address field and performing `AXConfirm` did.

`CGEvent` keys work only while the target app is frontmost. The helper refuses to post them otherwise (`app did not become frontmost; key was not posted`). Once TextEdit was front, those keys opened the Open panel (`AXWindow` title `Open`) and the Go to Folder sheet (`AXSheet`). The path was the sheet text field's `AXValue`. That field's action is `AXConfirm`, not `AXPress`. Return and `AXPress` on the panel's Open button did not load the file while the sheet was up.

Replay of a file input on macOS:

1. Bring the target app frontmost.
2. Post `cmd+o`, `cmd+shift+g`, and the runtime path with `CGEvent` (`cg-key` / `cg-type`), not `AXUIElementPostKeyboardEvent`.
3. `AXConfirm` the sheet's text field. Do not press the Open button while the sheet is up.
4. If the app will not come front, stop. Do not click the center of the dialog.

A left-button `CGEvent` drag from a Finder icon to the TextEdit text area moved the pointer in top-left screen points (the same space as the accessibility frames). The text area value did not become the file. macOS does not start a file drag from another process's mouse events. An `NSDraggingSession` has to begin in the source app, with a pasteboard the destination accepts. This helper cannot start that session. `bao-os-macos drag-file --path <file>` returns `ok: false`, `fileDrag: false`, and `fallback: "open-panel"`. The pointer `drag` command still moves the cursor and sets `fileDrag: false` so a moved pointer is not counted as a drop. Use the Open panel.

## v1 scope

A Finder drag onto the replay form in the product window is an ordinary web drop on the page Bao serves. The field's drop handler takes `dataTransfer.files`, assigns them to the file input when the engine allows it, and keeps the same `File` for Run. A synthetic `DataTransfer` drop of `dragged-note.txt` is the check for that handler. A person can drag a file from Finder onto that field the same way.

On the fixture, the drop handler writes `Dropped file: <name>` into the banner at the top of the page. Replay fails unless that phrase is on screen. The upload line `Waiting for a file` is not the drop proof.

A native `NSDraggingSession` onto a Mac app (TextEdit, Finder, or any window that is not this web form) stays out of v1. The helper still returns `fallback: "open-panel"` for that path.
