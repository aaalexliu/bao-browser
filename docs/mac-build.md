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

The product window uses the Chromium bundled at `Contents/Resources/Chromium.app`. Owned capture and replay choose their browser through `resolveNormalChrome` in `desktop/src/launch.ts`, as [Select the driver](extension.md#select-the-driver) describes. Daily live sessions attach instead. The Settings-selected [agent-browser trial](agent-browser-engine.md#pick-an-engine-and-profile) reads a chosen Chrome profile into a private copy; it is separate from site-login import.

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

`desktop/os-helper-macos/package-app.sh` runs cargo from `~/dev/bao-mac-toolchain/cargo` unless `CARGO_HOME` is already set. Skip the installer when `"$HOME/dev/bao-mac-toolchain/cargo/bin/cargo" --version` already prints `cargo 1.`. A Mac that already has the helper grant follows [Rebuild with an existing grant](#rebuild-with-an-existing-grant), which explains when the helper can be reused. A machine without that signed helper uses [Fresh setup](#fresh-setup).

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

Package the checkout you have. `v1/desktop` is the integration branch when that is the branch you mean to ship. Do not switch to it if you are already on the branch you are packaging.

```sh
git rev-parse --abbrev-ref HEAD
git status -sb
```

`git rev-parse` prints the branch name. `git status -sb` prints that branch and a clean or dirty worktree.

To clone for the first time, check out the branch you intend to package.

```sh
git clone https://github.com/aaalexliu/bao-browser.git
cd bao-browser
git checkout v1/desktop
```

Replace `v1/desktop` with the branch you are packaging.

## Fresh setup

Use this when `desktop/os-helper-macos/BaoOSHelper.app` is missing, or when `codesign -dvvv` does not show identifier `dev.bao.oshelper` signed by `bao dev signing`. The helper is gitignored. Packaging stops if it is missing.

The helper script signs bundle id `dev.bao.oshelper` with `BAO_SIGN_IDENTITY`. Do not pass `--deep` to `codesign`. Do not sign the helper ad-hoc, and do not drop a raw executable in place of the `.app`.

```sh
npm install
export BAO_SIGN_IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
bash desktop/os-helper-macos/package-app.sh
bash desktop/packaging/macos/package-app.sh
file desktop/packaging/macos/dist/Bao.app/Contents/MacOS/bao
```

`npm install` finishes before the desktop script runs `tsc`. The helper script prints a `codesign` verify. The desktop script then refuses to continue unless that helper is a bundle, identifier `dev.bao.oshelper`, not ad-hoc, and the first `Authority` line equals `BAO_SIGN_IDENTITY`. The designated requirement must be exactly `identifier "dev.bao.oshelper" and certificate leaf = H"a522e15d431a2f36ace451dd575a02e9e877fbd1"`. Set `BAO_HELPER_CERT_HASH` to the new certificate SHA-1 when the certificate changes. Use 40 hex digits. Colons are optional. The script does not accept a different hash on its own. It does not compare a binary CDHash. It copies the helper into `Bao.app` without signing it again.

The desktop script stages Playwright and `classic-level` by reading those two versions from `package-lock.json` and running `npm install`. That install resolves transitive versions from the registry. It is not `npm ci`. A version match on the day of the build is not a lockfile install of the transitive tree. The staged tree includes the native binary for this Mac. The script compiles `extension/src/host-grant.ts` to `Contents/Resources/extension/src/host-grant.js`. It builds the window script to `Contents/Resources/bao/src/app/app.js`, so launch does not need the TypeScript sources or esbuild. It copies `desktop/src/library-home.cjs` and `desktop/src/print-home.cjs` to `Contents/Resources/bao/src`, next to the compiled server. The launcher runs that `print-home.cjs` to pick the library, and staging fails unless it prints `ok`. It copies the unpacked extension to `Contents/Resources/extension/dist`. Before `codesign`, it copies `bao`, `extension`, `src`, and `web` to a temp directory outside the checkout, unsets `NODE_PATH` and `NODE_OPTIONS`, points `HOME` at an empty temp directory, and requires `./src/app/server.js`, `playwright`, and `classic-level`. Each resolved file must realpath inside that copy. A module that exists only in the repo, on `NODE_PATH`, in `$HOME/.node_modules`, or through a symlink to another directory does not pass. The same check runs at the end of staging, so a missing `classic-level` cannot load the repo copy. The `extension`, `src`, and `web` copies are there so the server require can see `host-grant` and the other relative modules. A module that a staged package lists under `optionalDependencies` and that the copy lacks fails to load during the check, as it does in the installed app, even when the repo or `NODE_PATH` has it. The check then prints `require-staged: optional <name> is not staged; the app loads without it`. On macOS that is Playwright's `fsevents`: the registry entry for `fsevents@2.3.2` runs `node-gyp rebuild`, the package ships no `binding.gyp`, and the staged `npm install` drops it. Playwright catches the failed require and falls back to `fs.watch`.

`stage-runtime.sh` also runs `desktop/packaging/stage-agent-browser.mjs`. The version, archive URL, archive checksum, and platform executable checksums come from [`agent-browser-pin.json`](../desktop/packaging/agent-browser-pin.json). Staging checks both hashes, sets the executable bit, and copies the native binary, license, skill data, upstream package metadata, and pin into `Contents/Resources/agent-browser`. It fails on a checksum mismatch or an unpinned platform. `BAO_AGENT_BROWSER_ARCHIVE` can name a local archive instead of downloading it; the same checks still apply. The Mac package signs and verifies the staged executable as `dev.bao.agent-browser` with `BAO_SIGN_IDENTITY`.

It copies Playwright Chromium to `Contents/Resources/Chromium.app` and signs that bundle. It compiles `bao-main.c`, `bao-launch.c`, and `bao-notify.m` into `Bao.app` (`dev.bao.desktop`). `build-mcp-launcher.sh` compiles `bao-mcp.c` and `bao-launch.c` into `Contents/MacOS/bao-mcp`, the agents' MCP entry ([Agent quickstart](agent-quickstart.md#mcp)). Before `bao-mcp` and `Bao.app` are signed, `prove-mcp-launcher.mjs` starts that launcher with no `node` on `PATH` and a temp `HOME` that holds only the test library the proof plants. It checks one MCP exchange: the `bao` server, its tools, a search that reads the app's library and not a `.bao-mcp` library in the caller's directory, and a live tool that says to open the app. The launcher is then signed on its own as `dev.bao.mcp`, then `Bao.app` is signed. The script writes `Bao.dmg` beside the app.

- `npm install` ends without `EBADENGINE`.
- The desktop script prints `BUNDLED_BROWSER`, `MCP_LAUNCHER ok`, and then `WROTE` lines for `Bao.app` and `Bao.dmg`.
- `file` prints `Mach-O 64-bit executable arm64` for `Contents/MacOS/bao`.
- `codesign -dvvv` on the nested helper prints `Identifier=dev.bao.oshelper` and `Authority=bao dev signing`.

## Rebuild with an existing grant

Use this when this Mac already has the helper grant. Reuse the signed helper only when its commands match this Bao. If its source has changed, rebuild it with `desktop/os-helper-macos/package-app.sh` and the existing `bao dev signing` identity before packaging. That script includes the Automation entitlement from `desktop/os-helper-macos/entitlements.plist`. Do not pass `--deep` to `codesign` or replace the helper with an ad-hoc signature or a raw binary. A new certificate is a different app, and the grant does not follow it. An old helper answers `unknown command`; Bao then says `BaoOSHelper is older than this Bao; rebuild it`.

```sh
npm install
export BAO_SIGN_IDENTITY="${BAO_SIGN_IDENTITY:-bao dev signing}"
bash desktop/packaging/macos/package-app.sh
file desktop/packaging/macos/dist/Bao.app/Contents/MacOS/bao
```

The desktop script reads `desktop/os-helper-macos/BaoOSHelper.app` and exits before it compiles or signs if any of these are true.

- The path is missing.
- The path is not an app bundle with `Contents/MacOS/BaoOSHelper`.
- `codesign --verify --strict` fails.
- The identifier is not `dev.bao.oshelper`.
- The signature is ad-hoc.
- The first `Authority` line is not `$BAO_SIGN_IDENTITY`.
- The designated requirement is not exactly `identifier "dev.bao.oshelper" and certificate leaf = H"a522e15d431a2f36ace451dd575a02e9e877fbd1"`. A new certificate passes only when `BAO_HELPER_CERT_HASH` is set to that certificate's SHA-1.

`codesign -dvvv` prints a CDHash. Rebuilding the helper changes it. The CDHash is not the acceptance check.

Inspect the helper you are about to nest:

```sh
codesign --verify --strict --verbose=2 desktop/os-helper-macos/BaoOSHelper.app
codesign -dvvv desktop/os-helper-macos/BaoOSHelper.app
codesign -d -r- desktop/os-helper-macos/BaoOSHelper.app
```

`Identifier=dev.bao.oshelper`. The first `Authority=` line is `bao dev signing` unless you set `BAO_SIGN_IDENTITY`. The designated requirement line is `identifier "dev.bao.oshelper" and certificate leaf = H"a522e15d431a2f36ace451dd575a02e9e877fbd1"` unless you set `BAO_HELPER_CERT_HASH`.

## Install or update

Quit Bao from the Dock. Replacing the app does not remove the library.

```sh
rm -rf /Applications/Bao.app
cp -a desktop/packaging/macos/dist/Bao.app /Applications/Bao.app
codesign --verify --strict --verbose=2 /Applications/Bao.app
codesign --verify --strict --verbose=2 /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
codesign -dvvv /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
open /Applications/Bao.app
```

Do not delete `~/Library/Application Support/bao`. Do not run `codesign --deep` on `Bao.app`. A local build has no `com.apple.quarantine` attribute, so Finder Open does not show the Gatekeeper sheets. A downloaded copy does. Those sheets are macOS.

Quit Bao from the Dock and open `/Applications/Bao.app` again. A second open focuses the window. It does not start a second server. With Accessibility on and Automation for Google Chrome granted (or Chrome closed), the footer reads **helper ok**, even with Screen Recording off.

## Logs

Bao does not write a launch log. Finder does not keep the server stdout. The server prints one line, `bao <port> home <home>`, when a terminal is attached.

An import appends a line to `~/Library/Application Support/bao/audit/import-login.jsonl`. That directory is the library. Do not delete it to clear a log.

## Roll back

Keep the previous `Bao.app` or `Bao.dmg`. Quit Bao from the Dock. Replace `/Applications/Bao.app` with that copy. Leave `~/Library/Application Support/bao` in place. Open the restored app from Finder.

```sh
rm -rf /Applications/Bao.app
cp -a /path/to/previous/Bao.app /Applications/Bao.app
codesign --verify --strict --verbose=2 /Applications/Bao.app/Contents/Resources/BaoOSHelper.app
open /Applications/Bao.app
```

The nested helper in the restored app must still be the signed `dev.bao.oshelper` bundle. Do not copy an ad-hoc helper or a raw executable into it.

## Permissions

The product window does not need these grants. The nested helper does. Bao's status checks read Accessibility and Automation for Google Chrome without prompting or checking Screen Recording. See [What Bao asks permission for](permissions.md) for grant requirements, Automation prompt timing, and live Chrome readiness. The helper's prompt text is defined in [`Info.plist`](../desktop/os-helper-macos/Info.plist), not in the product window.

Enable BaoOSHelper in System Settings → Privacy & Security → Accessibility. Add `Bao.app/Contents/Resources/BaoOSHelper.app` with the + button if the Accessibility row is missing. Keep the helper identity described in [Rebuild with an existing grant](#rebuild-with-an-existing-grant).

Quit Bao from the Dock and open it from Finder again. No new privacy sheet. With Accessibility on and Automation for Google Chrome granted (or Chrome closed), the footer shows **helper ok**, **AX press ready**, and **live Chrome ready**. Screen Recording on or off makes no difference. A quiet note says native-app capture is optional and not needed for Chrome. See [Which grant each job needs](permissions.md#which-grant-each-job-needs) for API capability rows.

An agent can check the local server. This is not a page to open:

```sh
curl -s "http://127.0.0.1:4787/api/state"
```

`helper.accessibility` is true. The `live-chrome` row in `helper.capabilities` and `helper.label` follow [Which grant each job needs](permissions.md#which-grant-each-job-needs). `helper.screenCapture` stays false because app status does not check Screen Recording. `curl -s "http://127.0.0.1:4787/api/pids"` prints JSON whose `helper` path ends in `Bao.app/Contents/Resources/BaoOSHelper.app`.

## Behavior a rebuild must keep

The Capture field defaults to `/fixture`. The owned browser opens that page on this server. The product window does not show the listen address. Stop saves the page URL at stop time. The fixture's Log in button moves to `/secure`, and this server serves the fixture there too.

A chooser and a Finder drop each add a `file` input. The secret string is absent. The absolute path of the file is absent. The trail says `Password values are not stored.` The drag has to be a real file drop. A scripted pointer move does not start an `NSDraggingSession`. Do not rebuild the helper to record one.

Replay sets a file input with `DOM.setFileInputFiles`, and a drop zone with a synthetic `DataTransfer`. Run again after moving the replay window. The next run reuses that window. Chrome for Testing is moved with CDP `Browser.setWindowBounds`. The helper is also tried with the replay pid. A size row can stay `n/a-harness` when `AXSize` is rejected (`-25200`). A step failure counts only after the requested bounds landed.

Each headed ordinary browser replay writes `videos/<runId>.webm`. On macOS the picture is that replay's window: a ScreenCaptureKit filter (`SCContentFilter`, desktop-independent window), not a display crop. Copied-profile live capture and replay use the separate [CDP evidence path](agent-browser-engine.md#evidence).

A `login` step waits. Replay does not type the password and does not press Log in. The bar says to sign in in the Bao window. `Bao.app` posts that sentence with `UNUserNotificationCenter` (category `bao.act`). The Dock badge is `!`. `osascript` is not used, and BaoOSHelper does not post the notification.

A confirm step uses the same bar. Replay does not press the site button. Place order and Reserve are that pause.

Settings → When a step misses defaults to **Auto self-heal**. With the Cursor CLI logged in, the footer reads **cursor account**. `BAO_HEAL_FIXTURE=1` is a local stand-in (`bao-heal-fixture`). Do not cause a miss while Model reads **cursor account**.

A date field is stored as a relative input. `+14d` replays as that day. A download step saves under the run directory. An `open` step can hand the file to Preview. A bot check pauses the run before any heal. The status is **needs you**. Model calls stay at 0.
