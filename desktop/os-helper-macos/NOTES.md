# macOS Accessibility helper

`bao-os-macos` is the OS-plane helper for this Mac. It is a separate crate from
the Linux AT-SPI helper because `atspi` does not build here and the Accessibility
APIs do not build on Linux.

## What it does

- `nodes` walks one app and reports role, subrole, title, description, identifier,
  ancestor path, and a top-left frame.
- `hit` calls `AXUIElementCopyElementAtPosition` on the system-wide element, then
  climbs to a named pressable control. A point outside `--allow-bundle` is
  unresolved and the foreign title is not stored.
- `press` and `set-value` look the element up again by role, name, and path.
  They do not click a stored coordinate.
- `permissions` reports `AXIsProcessTrustedWithOptions` and
  `CGPreflightScreenCaptureAccess`. `--prompt` shows the system prompt once.

Frames in the JSON are top-left points, which is the space the hit test expects.
If an AX window frame is the vertical flip of the CoreGraphics window, the helper
converts before the JSON leaves the process.

Window captures use `screencapture -l <window id>`. That crops to the test window.
`CGWindowListCreateImage` is obsolete on this OS.

## Ran 2026-10-19, blocked

Host: macOS 26.6.2 (build 25G83), arm64. The release binary was not rebuilt.
codesign identifier `bao_os_macos-fcc59b856054f483`, ad-hoc, no Team ID.

First run prompted once. Accessibility and Screen Recording were both false,
so Calculator and TextEdit were not launched.

Second run used `BAO_OS_PROMPT=0` and did not prompt. Accessibility for the
helper is now true. `CGPreflightScreenCaptureAccess` inside that same binary
is still false, so the spike stopped again before launching an app. There is
no screenshot or replay.

| Check | First run | Second run |
| --- | --- | --- |
| Accessibility | false | true |
| Screen Recording | false | false |
| Prompted | once | no |
| Calculator / TextEdit | not launched | not launched |

The missing row is Screen Recording for this exact binary:

`/Users/alexliu/dev/bao-mac-spike/desktop/os-helper-macos/target/release/bao-os-macos`

The preflight runs in the helper, not in its parent. A Screen Recording grant
on Node or on Cursor does not satisfy this check. When the spike spawns the
helper, the parent is
`/Users/alexliu/.local/share/mise/installs/node/24.19.0/bin/node`.
The worker above that is `cursor-agent`. Those are separate rows. A later
window capture also runs `/usr/sbin/screencapture` as a child of the helper.

A rebuild changes the ad-hoc cdhash, and macOS treats that as a different app.
Do not rebuild this binary after granting it. Re-run with `BAO_OS_PROMPT=0`.

## Not observed yet

Calculator on recent macOS is SwiftUI. This run never saw its tree, so button
names (`7`, `+`, `5`, `=`) and whether the display is an `AXStaticText` value
are still unknown. TextEdit's untitled `AXTextArea` was not opened. The
coordinate flip detector has not been compared against a live window. Those
are the demo criteria, and they are unmet until the permission is granted.
