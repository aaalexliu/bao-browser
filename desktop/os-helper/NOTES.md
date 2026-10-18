# Spike 2 — Linux AT-SPI save dialog

`npm run spike2` (`desktop/os-helper/spike2.sh`) is the pass/fail demo. It builds
`bao-os-helper` and runs it against zenity 4.0.1 (`--file-selection --save`) on a
private Xvfb display, a private session bus, and a private `HOME` under
`/tmp`. Nothing in this run attaches to the agent's display or the daily home
directory.

The helper is Rust (`atspi` 0.30). That crate's `zvariant` dependency needs
Cargo edition 2024, so the toolchain is rustup stable (1.85 or newer). The
image's apt Rust 1.83 cannot compile it. `rust-toolchain.toml` pins stable.

## Result

Pass, on one run after the role-name fix below.

| Check | Result |
| --- | --- |
| Tree enumerated | 196 nodes, app `zenity`, dialog `Bao spike2` |
| `osSetValue` | role `text box`, name `Name:`, value `bao-spike2-note.txt`, platform `linux`, ancestor path stored |
| `osConfirm` | role `button`, name `OK`, same platform and a path |
| Record | `EditableText.SetTextContents` returned true, character count went 0 → 19, then `Action.doAction(0)` named `click` returned true. zenity printed `$WORKDIR/bao-spike2-note.txt` and exited |
| Replay | A new zenity and a new helper process. Same two calls. Same printed path. Dialog exited |
| Screenshot | `import` of the Xvfb root before confirm is a real dialog image (about 15KB, non-flat). The Name field shows `bao-spike2-note.txt`. The fresh dialog before replay shows `wrong.txt` |
| Coordinates | Extents are stored. Both widgets report origin `(0, 0)` (entry 762×34, OK 54×34). The helper has no coordinate click and no `xdotool` call. A missed lookup exits |
| Files | The printed path is `$WORKDIR/bao-spike2-note.txt`. zenity does not create that file. The demo does not write outside the throwaway directory |

Role enum from `GetRole` is `Text` and `Button`. `GetRoleName` (what the IR stores) is `text box` and `button`.

## What broke

The first helper lookup asked for role `text` and `push button`. Those are the
names libatspi and pyatspi derive from the role enum. GTK 4.14's
`GetRoleName` on this dialog returns `text box` and `button`, so the lookup
missed and the run stopped. It did not fall through to a coordinate click.

`GTK_A11Y=1` is not a flag on GTK 4.14. The process logs
`Unrecognized accessibility backend "1"` and registers no tree (desktop child
count 0). The backend name is `atspi`.

Zenity's save button is named `OK`, not `Save`. The IR stores `OK`.

`Component.GetExtents(Screen)` returns `(0, 0, w, h)` for both the name field
and OK. A click at that origin would miss the widget. That is why bbox stays
audit data.

## What AT-SPI cannot see

`Text.getText` on the Name field returns `""` in every state we tried: while
the screen shows `wrong.txt` (character count 0), and after
`SetTextContents("bao-spike2-note.txt")` (character count 19, and the pixels
update). The string is not readable back off the bus. Replay checks the
character count before it will press OK, and the demo checks zenity's stdout
for the path.

The ancestor path is mostly unnamed `generic` containers (GTK 4's name for
what GTK 3 called `panel`). Role + name is unique for these two widgets, so
replay matches on that. Requiring the full path would be brittle the moment
GTK inserts another box.

The file list is visible: rows expose name, path, type, and a modified time
that includes U+200E before the colon. A workflow that keyed off that time
string would fail the next minute. Places sidebar entries are list items.
`Create Folder` is a button whose nested toggle is a separate object. This
spike does not invoke it. pyatspi reported 0 actions on the outer button.

AT-SPI does not see Chrome's own file picker. That picker is spike 1
(`Page.handleFileChooser` / `setInputFiles`). This demo never launched Chrome.

Wayland was not tested. The session is Xvfb. Screenshots here are X
`import`, which a portal-less Wayland session will not do.

Setting the name pops an autocomplete menu of the current directory (the
replay video shows `confirm.log`, `workflow.json`, `tree.txt` under the
field). OK still returned the basename we set, not one of those rows. The
completion popup is not a step in the IR.
