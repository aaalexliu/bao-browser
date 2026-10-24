# Build Bao on a Mac

This is the rebuild. The pass on an installed app is [Test Bao on a Mac](mac-test.md).

Do not open the listen address in a browser. The product is the Bao window: title **Bao**, no address bar. A second double-click focuses that window. It does not start a second server.

## Launch

Double-click `/Applications/Bao.app` in Finder. No Terminal window, and no `BAO_NODE`.

`bao-main.c` finds Node 24 or newer on its own:

1. `BAO_NODE`, when it is an absolute path to Node 24 or newer. A relative path is ignored.
2. `/opt/homebrew/bin/node`, then `/usr/local/bin/node`. Then the keg-only prefixes `/opt/homebrew/opt/node@24/bin/node` and `/usr/local/opt/node@24/bin/node`, because `brew install node@24` does not link `node` into `bin`.
3. The newest Node 24 or newer under `~/.local/share/mise/installs/node/*/bin/node`, then `~/.nvm/versions/node/*/bin/node`, then `~/.volta/tools/image/node/*/bin/node`, then `~/.volta/bin/node`.
4. One login shell: `$SHELL -lc 'command -v node'`. Finder often leaves `SHELL` unset, so the fallback is `/bin/zsh`, then `/bin/bash`. An alias is ignored. The shell is not asked when an earlier path already works.

Node is not copied into the app. The machine that builds Bao already has Node 24, and a second runtime inside the bundle would be another binary to sign. `codesign --deep` on `Bao.app` would change the helper CDHash and drop the grant. Leave the helper's signature alone.

If Node 24 is not found, Bao shows a native alert that says to install it. The browser does not open. If the server never accepts a connection, Bao shows an alert and does not open the window. The Chromium offline page is that window's error page, and it shows the listen address, so it must not appear.

The default home is `~/Library/Application Support/bao`. Do not delete it. The default port is `4787`. Leave `BAO_HOME` and `BAO_PORT` unset for the installed app.

## Prerequisites

Install these before `package-app.sh`. Node is for the build. Finder finds that same Node later.

### Node 24 or newer

`package.json` asks for Node `>=24`.

```sh
node -v
command -v node
```

`node -v` prints `v24` or a higher major. `command -v node` prints an absolute path. If the version starts with `v22` or lower, install Node 24 before `npm install`. On an older Node, `npm install` prints `EBADENGINE`.

Homebrew on Apple silicon:

```sh
brew install node@24
```

`$(brew --prefix node@24)/bin/node -v` prints `v24` or higher.

### Google Chrome

Install Chrome from [https://www.google.com/chrome/](https://www.google.com/chrome/) if it is not already in `/Applications`.

```sh
/bin/ls -d "/Applications/Google Chrome.app"
```

The command prints `/Applications/Google Chrome.app`. Use `/bin/ls`. A shell `ls` can be an alias.

Capture and replay open the Chromium that `package-app.sh` copies into `Bao.app` (`Contents/Resources/Chromium.app`). Importing a site sign-in is the step that reads the installed Google Chrome. The product window and the capture window leave that daily profile alone.

### Xcode Command Line Tools

The helper and the app need `clang`, `codesign`, and `hdiutil`.

```sh
xcode-select -p
xcrun --find clang
xcrun --find codesign
xcrun --find hdiutil
```

Run `xcode-select --install` only when `xcode-select -p` fails. When the tools are already present, `--install` can raise the system install dialog anyway.

`xcode-select -p` prints `/Library/Developer/CommandLineTools` or an Xcode.app path. The three `xcrun --find` lines print absolute paths.

### Rust, for a helper rebuild

`desktop/os-helper-macos/package-app.sh` runs cargo from `~/dev/bao-mac-toolchain/cargo` unless `CARGO_HOME` is already set. Skip the installer when `"$HOME/dev/bao-mac-toolchain/cargo/bin/cargo" --version` already prints `cargo 1.`. On a Mac that already has the helper grant, do not run this script. See Build.

```sh
mkdir -p "$HOME/dev/bao-mac-toolchain"
export RUSTUP_HOME="$HOME/dev/bao-mac-toolchain/rustup"
export CARGO_HOME="$HOME/dev/bao-mac-toolchain/cargo"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain stable
"$CARGO_HOME/bin/cargo" --version
```

`cargo --version` prints `cargo 1.` followed by a version. `--no-modify-path` does not edit the shell rc file.

### Signing identity `bao dev signing`

Both package scripts sign with `BAO_SIGN_IDENTITY`, which defaults to the login-keychain certificate `bao dev signing`. Keep that certificate. The grant follows it plus the bundle id. A new certificate is a different app, and the helper grant does not follow it.

```sh
security find-certificate -c 'bao dev signing' >/dev/null && echo 'certificate present'
security find-identity -v -p codesigning | grep -F 'bao dev signing' || true
```

If the certificate is present, skip the `openssl` block. `find-identity -p codesigning` can print nothing while that certificate is in the login keychain and `codesign --sign "bao dev signing"` still works. Do not create a second certificate with the same common name.

If the certificate is absent:

```sh
WORKDIR=$(mktemp -d)
openssl req -new -newkey rsa:2048 -x509 -days 3650 -nodes \
  -subj "/CN=bao dev signing" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem"
openssl pkcs12 -export -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
  -out "$WORKDIR/bao.p12" -name "bao dev signing" -passout pass:
security import "$WORKDIR/bao.p12" -P "" -T /usr/bin/codesign -f pkcs12
rm -rf "$WORKDIR"
```

`security find-certificate -c 'bao dev signing'` succeeds. `find-identity -p codesigning` may still print nothing. There is no notarization step.

### This checkout

Build from `v1/desktop`.

```sh
git clone https://github.com/aaalexliu/bao-browser.git
cd bao-browser
git fetch origin v1/desktop
git checkout v1/desktop
```

## Build

On this Mac the helper is already signed with `bao dev signing` (CDHash `e2ad7477d8f989484c3d0ef8a2598561844127bf`). Skip the helper script. Run only the desktop script, so the nested helper keeps that CDHash and the grant stays. Do not pass `--deep` to `codesign`.

```sh
npm install
export BAO_SIGN_IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
bash desktop/packaging/macos/package-app.sh
file desktop/packaging/macos/dist/Bao.app/Contents/MacOS/bao
```

`npm install` finishes before the desktop script runs `tsc`. The desktop script compiles `bao-main.c`, `bao-launch.c`, and `bao-notify.m` into `Bao.app` (`dev.bao.desktop`). It copies the helper that is already at `desktop/os-helper-macos/BaoOSHelper.app` to `Bao.app/Contents/Resources/BaoOSHelper.app`. It copies `src/mask.ts` to `Contents/Resources/bao/src/mask.ts` (without that file the window script fails and the sidebar never renders). It copies Playwright Chromium to `Contents/Resources/Chromium.app`, and writes `Bao.dmg` beside the app.

- `npm install` ends without `EBADENGINE`.
- The desktop script prints `BUNDLED_BROWSER` and then `WROTE` lines for `Bao.app` and `Bao.dmg`.
- `file` prints `Mach-O 64-bit executable arm64` for `Contents/MacOS/bao`.
- `codesign -dvvv` on the nested `BaoOSHelper.app` still shows CDHash `e2ad7477d8f989484c3d0ef8a2598561844127bf`.

Copy `Bao.app` to `/Applications/Bao.app`. A local build has no `com.apple.quarantine` attribute, so Finder Open does not show the Gatekeeper sheets. A downloaded copy does. Those sheets are macOS.

## Permissions

The product window does not need Accessibility. The nested helper does. On the first launch, macOS asks twice, naming **BaoOSHelper**:

1. Accessibility. The usage string is `BaoOSHelper reads accessibility elements in throwaway apps so a computer-use click can be replayed by role and name.`
2. Screen Recording. The usage string is `BaoOSHelper captures one throwaway window so the spike can show the control it pressed.`

Enable BaoOSHelper in System Settings → Privacy & Security → Accessibility, and again under Screen & System Audio Recording. Add `Bao.app/Contents/Resources/BaoOSHelper.app` with the + button if the row is missing. The grant is for bundle id `dev.bao.oshelper` signed by `bao dev signing`. A rebuild of the helper with a new certificate, or an ad-hoc signature, is a different app and the grant does not follow it.

Quit Bao from the Dock and open it from Finder again. No new privacy sheet. The footer reads **helper ok**.

An agent can check the local server. This is not a page to open:

```sh
curl -s "http://127.0.0.1:4787/api/state"
```

`helper.accessibility` and `helper.screenCapture` are true, and `helper.label` is `helper ok`. `curl -s "http://127.0.0.1:4787/api/pids"` prints JSON whose `helper` path ends in `Bao.app/Contents/Resources/BaoOSHelper.app`.

## Behavior a rebuild must keep

The Capture field defaults to `/fixture`. The owned browser opens that page on this server. The product window does not show the listen address. Stop saves the page URL at stop time. The fixture's Log in button moves to `/secure`, and this server serves the fixture there too.

A chooser and a Finder drop each add a `file` input. The secret string is absent. The absolute path of the file is absent. The trail says `Password values are not stored.` The drag has to be a real file drop. A scripted pointer move does not start an `NSDraggingSession`. Do not rebuild the helper to record one.

Replay sets a file input with `DOM.setFileInputFiles`, and a drop zone with a synthetic `DataTransfer`. Run again after moving the replay window. The next run reuses that window. Chrome for Testing is moved with CDP `Browser.setWindowBounds`. The helper is also tried with the replay pid. A size row can stay `n/a-harness` when `AXSize` is rejected (`-25200`). A step failure counts only after the requested bounds landed.

Each headed replay writes `videos/<runId>.webm`. On macOS the picture is that replay's window: a ScreenCaptureKit filter (`SCContentFilter`, desktop-independent window), not a display crop.

A `login` step waits. Replay does not type the password and does not press Log in. The bar says to sign in in the Bao window. `Bao.app` posts that sentence with `UNUserNotificationCenter` (category `bao.act`). The Dock badge is `!`. `osascript` is not used, and BaoOSHelper does not post the notification.

A confirm step uses the same bar. Replay does not press the site button. Place order and Reserve are that pause.

Settings → When a step misses defaults to **Auto self-heal**. With the Cursor CLI logged in, the footer reads **cursor account**. `BAO_HEAL_FIXTURE=1` is a local stand-in (`bao-heal-fixture`). Do not cause a miss while Model reads **cursor account**.

A date field is stored as a relative input. `+14d` replays as that day. A download step saves under the run directory. An `open` step can hand the file to Preview. A bot check pauses the run before any heal. The status is **needs you**. Model calls stay at 0.
