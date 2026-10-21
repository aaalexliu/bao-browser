# Files and drag

A workflow step stores a `file` input (`{{file}}` or `{{drop}}`). The path exists only in the replay arguments for that run. Capture records the basename in the trail event and interpret drops even that, so the saved workflow has neither the path nor the filename.

## What was run here

| Path | What bao does | Status on this machine |
| --- | --- | --- |
| Web `<input type=file>` | Playwright `setInputFiles` on the element the scorer accepted. | Captured and replayed. `desktop/test/live/browser.test.ts`. |
| Web drop zone | Synthesize `dragenter`, `dragover`, and `drop` with a `DataTransfer` built from the file bytes inside the page. | Captured and replayed on `#drop` in the same test. |
| GTK / zenity open dialog | `bao-os-helper set-text` writes the path into the accessible text entry by role and name, then `press` confirms. No coordinate fallback. | The command is in the helper. A live zenity open was not part of the green run tonight. Spike 2 already set text in a zenity save dialog by the same AT-SPI editable-text interface. |
| Native drag onto a window | Not implemented on Linux. The AT-SPI driver throws rather than invent a pointer drag. | Documented miss. |
| macOS open panel | Type the path with Cmd-Shift-G, then Return, through `BaoOSHelper` `set-value` on the go-to-folder field. | For the mac agent. Not run here. |
| macOS drag onto a window | Only where Accessibility exposes a drop target. Otherwise stop and say so. | Not run here. |

## Replay arguments

The app form accepts a file from the picker or a drop on the field. The browser cannot see a real path, so the UI sends the bytes and the server writes a temp file for that run only. The CLI passes `{ "name": "note.txt", "path": "/tmp/..." }` in the same args object. MCP uses that object too.

## macOS open panel, for the agent on alex-jxp

1. The workflow step is `upload` or `type` on the open panel's text field, with a `file` input.
2. Replay focuses the file dialog, sends Cmd-Shift-G (the Go to Folder sheet), and calls `bao-os-macos set-value` with the runtime path.
3. Confirm with the default button by role and name (`AXButton`, `Open` or `Go`), not by a stored point.
4. If the sheet's text field is missing from the tree, stop with `below-threshold` or `no-candidates`. Do not click the center of the dialog.
