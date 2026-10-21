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

## Ran 2026-10-19, permission granted, tree has no buttons

A later fresh process, still without a rebuild and without another prompt,
reported both checks true. Same file: mtime 2026-10-19 16:01:21, size 776496,
cdhash `13a561381ca5073009e5c80d549d6a857201d618`. The Screen Recording row
matches this binary. It is not a stale signature.

`BAO_OS_PROMPT=0 npm run spike-macos` then launched Calculator. The CoreGraphics
window was 207 by 369 points at (459, 558), window id 136621. The AX walk did
not contain that window. It returned 21 nested `AXApplication` elements and
20 `AXMenuBar` elements, and nothing with a button name. `useful` was empty,
so the script stopped at `no AX button for 7`. `hit` on the window bounds, on
a flipped y, and on a menu-bar point all returned `no accessibility element
at point`. TextEdit was not opened. No replay screenshot was taken. The
Calculator process this run started was quit.

The walker only follows `AXChildren`. Calculator's buttons are not in that
list. Fixing the walk (follow `AXWindows`) or the hit test means a Rust
change, which means a rebuild, which changes the ad-hoc cdhash and drops this
grant. A minimal `.app` bundle with its own bundle id, signed once and
launched with `open`, is the way to make the next grant stick to an identity
that does not change every rebuild.

## BaoOSHelper.app, prompted once on 2026-10-20

`package-app.sh` builds the release binary with `CC=/usr/bin/clang` and wraps it
as `BaoOSHelper.app`. No codesigning identity was in the keychain (0 matches),
so the bundle is ad-hoc. Nothing was added to the keychain.

| Field | Value |
| --- | --- |
| Path | `/Users/alexliu/dev/bao-mac-spike/desktop/os-helper-macos/BaoOSHelper.app` |
| Bundle id | `dev.bao.oshelper` |
| Designated requirement | `identifier "dev.bao.oshelper"` |
| cdhash | `d8083cd84abd98ad99c2bad6b39d1c4dcb8f97a5` |
| Team ID | none |

One LaunchServices launch (`open -n -W -g -a BaoOSHelper.app --args permissions --prompt`)
ran. The process parent was launchd. The recheck inside that process was still
false for both Accessibility and Screen Recording. System Settings was open on
the Accessibility pane afterward. No separate Screen Recording dialog was on
screen. Calculator and TextEdit were not launched, so the button walk is not
verified yet. Do not rebuild this app until those two rows are enabled.

Add `BaoOSHelper.app` with the + button if the row is missing. The path is the
one in the table above.

## 2026-10-20, signed with bao dev signing

One self-signed certificate was imported into the login keychain. Common name
`bao dev signing`. SHA-1 `A5:22:E1:5D:43:1A:2F:36:AC:E4:51:DD:57:5A:02:E9:E8:77:FB:D1`.
It expires in 2036. Extended key usage is code signing, basic constraints are
CA false, and key usage is digital signature. It is not in the System keychain,
and trust settings were not changed. The temp key, cert, and p12 were deleted.
No keychain password dialog appeared. `codesign` is allowed to use the key
(`security import -T /usr/bin/codesign`).

`package-app.sh` signs with `BAO_SIGN_IDENTITY` (default `bao dev signing`):

```
codesign --force --options runtime --identifier dev.bao.oshelper -s "bao dev signing"
```

Designated requirement:

```
designated => identifier "dev.bao.oshelper" and certificate leaf = H"a522e15d431a2f36ace451dd575a02e9e877fbd1"
```

cdhash after this sign: `bac5c56ac584bc325e0961999e028fdb87d74edd`. A later
rebuild keeps the grant when the same certificate signs the same bundle id,
because the requirement is the identifier plus that certificate, not the cdhash.

The walker now follows `AXChildrenInNavigationOrder`, `AXContents`,
`AXVisibleChildren`, and `AXChildren`, descends through groups, and caps depth
at 30. Unit tests cover that list and the dedupe key. They do not talk to
Calculator. The app was then rebuilt, which replaces the previous ad-hoc grant.

One prompt followed the rebuild. Inside that process Accessibility and Screen
Recording were both true. System Settings was already open on Screen & System
Audio Recording; no new dialog was observed. The demo was not run. If the
Privacy lists still show the old ad-hoc BaoOSHelper row, remove it and add:

`/Users/alexliu/dev/bao-mac-spike/desktop/os-helper-macos/BaoOSHelper.app`

## 2026-10-20, grant is on, keypad is hit-test only

A fresh launch of the same app, with no rebuild and no prompt, reported
Accessibility true and Screen Recording true. Calculator was opened only for
this check and then quit. TextEdit was not opened.

`AXUIElementCopyElementAtPosition` inside the window returns the keypad:
`AXButton` named `7`, `8`, `9`, `4`, `5`, `6`, `1`, `2`, `3`, `0`, `Add`,
`Subtract`, `Multiply`, `Divide`, `Equals`, `All Clear`, `Delete`, `Percent`,
`Change Sign`, and `Point`. The display row hit the application element, not a
named readout.

The tree walk still does not contain those buttons. It stops at the window
chrome: toolbar (`Show Sidebar`, `Mode`), the traffic lights, and one
`AXSplitGroup` named `main, SidebarNavigationSplitView`. `press` for
`AXButton` / `7` returns `accessible lookup missed` and refuses a coordinate
fallback. Replay cannot run until the walk records the elements the hit test
already sees. That is a Rust change, so this app was not rebuilt.

## Process macOS treats as the parent

The helper's parent chain on this machine ends at launchd, not at Cursor.app.

1. `bao-os-macos` (this binary).
2. `/bin/zsh`, or Node at
   `/Users/alexliu/.local/share/mise/installs/node/24.19.0/bin/node`
   when the spike spawns it.
3. pid 58964, argv0 `cursor-agent`, parent pid 1. The executable is
   `/Users/alexliu/Library/Application Support/Cursor/User/globalStorage/anysphere.cursor-agent-worker/agent-cli/.local/share/cursor-agent/versions/2026.10.01-e373342/node`.
   codesign identifier `node`, Team ID `HX7739G8FX`, no Info.plist, no bundle id.
   The `cursor-agent` path next to it is an unsigned bash script.
4. `/sbin/launchd`.

Cursor.app is not in that chain. Its bundle id is `com.todesktop.230313mzl4w4u92`
(Team ID `VDXQ22DGB9`). `CGPreflightScreenCaptureAccess` inside `bao-os-macos`
is what turned true, so the grant that matters for this check is the
`bao-os-macos` row, not the Node row and not Cursor.app.
