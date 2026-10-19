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

Host: macOS 26.6.2 (build 25G83), arm64. The release binary was already built.
`npm run spike-macos` typechecked the proxy wiring, then asked for permission
once. Both checks stayed false on the recheck, so the spike did not launch
Calculator or TextEdit and did not take a screenshot.

| Check | Result |
| --- | --- |
| Accessibility | false |
| Screen Recording | false |
| Prompted | once, then stop |
| Calculator / TextEdit | not launched |

Enable this exact binary in System Settings, Privacy & Security:

`/Users/alexliu/dev/bao-mac-spike/desktop/os-helper-macos/target/release/bao-os-macos`

- Accessibility: that binary. codesign identifier `bao_os_macos-fcc59b856054f483`, ad-hoc, no Team ID.
- Screen Recording: that binary. The parent at the prompt was
  `/Users/alexliu/.local/share/mise/installs/node/24.19.0/bin/node`,
  because the spike spawns the helper from Node. If the list names Node or
  Cursor instead, enable that row too. A later capture runs `/usr/sbin/screencapture`
  as a child of the helper.

A rebuild changes the ad-hoc cdhash, and macOS treats that as a different app.
Do not rebuild this binary after granting it. The spike must be re-run with
`BAO_OS_PROMPT=0` so it does not prompt again.

## Not observed yet

Calculator on recent macOS is SwiftUI. This run never saw its tree, so button
names (`7`, `+`, `5`, `=`) and whether the display is an `AXStaticText` value
are still unknown. TextEdit's untitled `AXTextArea` was not opened. The
coordinate flip detector has not been compared against a live window. Those
are the demo criteria, and they are unmet until the permission is granted.
