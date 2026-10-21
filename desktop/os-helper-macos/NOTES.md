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

## 2026-10-20, scripted replay

Both privacy checks stayed true after rebuilds signed with `bao dev signing`.
The designated requirement did not change. No further prompt.

Calculator's keypad is still absent from `AXChildren`. A grid of
`AXUIElementCopyElementAtPosition` inside the window records the buttons, and
`press` uses that same harvest. The display number is the `AXStaticText` value
(a leading left-to-right mark is stripped). Scroll areas named `Edit field` and
`Last Expression` can read `0` after equals, so the static text wins.

`AXPosition` moves the window. `AXSize` returns `-25200` even for the current
size, and the helper reports `resized: false` instead of failing the move.

Scripted OpenAI and Claude 7 + 5 = both replayed to `12` with no coordinate
flags on `press`. The OpenAI loop has one unresolved off-window click.
TextEdit's first window is an Open panel. `New Document` opens Untitled.
A restored document with any other title still aborts without reading it.
The untitled value `bao mac spike` was set and replayed.

`open -W` can return before the helper writes `--result`, so the Node client
polls that file.

## 2026-10-20, live model

`desktop/src/proxy/mcp-bao.ts` is a stdio MCP server. It accepts Calculator and
TextEdit only. A click outside those windows is unresolved and is not pressed.
Screenshot pixels are mapped onto the CoreGraphics window, then resolved to an
accessibility element. The audit trail stores the before and after hashes.

Claude Code's `auth status` was not logged in. No login browser was opened.
Homebrew Codex 0.151.0 cannot call `gpt-6-astra`. The newer CLI bundled in
ChatGPT.app can, and `codex login status` said it was logged in. MCP tool
calls with `approval_policy` `never` fail unless the server sets
`default_tools_approval_mode` to `approve`. That override was passed with `-c`.
The user config file was not written.

Codex pressed Clear and All Clear before the successful `7`, `Add`, `5`,
`Equals` sequence. The display it reported was `12`. Replay bound `{{a}}` and
`{{b}}` to `3+4` and `8+1`.

TextEdit's window title is `Untitled` on one launch and `Untitled.rtf` on
another. A title that does not start with `Untitled` and is not `Open` still
aborts unread. Replay matches the text area by role and name (`First Text
View`) and ignores that window-title path. `AXSize` on TextEdit did change the
width. It did not on Calculator.

Listing TextEdit's autosave directory hung in this session, so new Untitled
autosave files were not deleted. Their contents were not read.

## 2026-10-20, fixtures

`fixture` writes one window: role, subrole, identifier, title, description,
label, value, frame, enabled, focused, actions, child order, and the other
attribute names. Element references are the word `element`. A title filter
skips every other window before its value is copied. The menu bar is skipped.
`type-keys` posts US ANSI characters, including `/`. `cg-key` and `cg-type`
post the same chords through CGEvent only after `AXFrontmost` is true.
`drag` posts a left-button drag and records whether the pointer moved.

On this machine CGEvent mouse positions match accessibility top-left points.
A drag from a Finder file icon onto TextEdit moved the pointer and did not
change the document value. AX keyboard posting is accepted and TextEdit
ignores it. CGEvent posting opens the Open panel and the Go to Folder sheet
when TextEdit is frontmost. The sheet field exposes `AXConfirm`.

Calculator keys are in `AXChildren` in this dump. Description is the visible
label and identifier is the stable token (`Seven`, `AllClear`). TextEdit's
text area identifier is `First Text View`. Safari's private-window address
field accepts `AXValue` plus `AXConfirm`. An Electron window stays one empty
role until `app.accessibilitySupportEnabled` is set after `app.whenReady`.

## 2026-10-20, v1 desktop build

`origin/v1/desktop` is `4153139` ("Merge spike/proxy-macos signing notes into
the desktop v1 line"). That tip does not include the fixture walker. The app
was built from a detached worktree of that commit. The worktree was removed
after the build.

`desktop/os-helper-macos/package-app.sh` and
`desktop/packaging/macos/package-app.sh` signed with `bao dev signing`.
`codesign --verify --deep --strict` passed for `Bao.app` and for the nested
helper.

- `Bao.app` designated requirement: identifier `dev.bao.desktop` and
  certificate leaf `H"a522e15d431a2f36ace451dd575a02e9e877fbd1"`. The
  executable is a shell script, so the host line is `com.apple.bash`.
- Nested `BaoOSHelper.app`: identifier `dev.bao.oshelper` and the same
  certificate leaf.

Copies are in the agent store under `bao-mac-spike/v1/`: `Bao.app`, `Bao.dmg`
(676K, UDZO), and `BaoOSHelper.app`. They are not in git.

A `permissions` run of that helper copy, with no `--prompt`, reported
accessibility true, screen capture true, prompted false, and ppid 1.

`docs/mac-test.md` on that branch is a clean-account procedure. It was not
run. `Bao.app` was not launched, because its launcher opens Google Chrome.
The fresh-user grant, the record pass, and the two replays remain a manual
test. `examples/workflows/calculator.json` was not replayed on this v1 binary.

The live drift test "shift, theme, font, order, slow network, and 2x scale"
failed in 914ms with `Cannot inspect /proc to confirm the owned Chrome
process.` `desktop/src/launch.ts` reads `/proc` after Chrome has started.
macOS has no `/proc`, so the check throws before any variant runs. The
desktop server returned that string from the drive call. No `drift.json` was
written. The throwaway Chrome stayed open (headless, a temp `bao-profile`
directory, not the daily profile) until that process was quit, and the
runner waited on the handle. The profile directory was deleted. The next
check in the same function treats a command line containing `Google/Chrome`
as the daily profile. The macOS Chrome binary path contains that string, so
replacing the `/proc` read would still stop there. That function was not
patched.
