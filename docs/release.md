# Release Bao

Users install Bao with the one `npx` command in the [README](../README.md#install). This page covers how that release is built, signed, and checked. [Build Bao on a Mac](mac-build.md) stays the contributor path.

## Pieces

| Piece | File | Job |
| --- | --- | --- |
| Release build | `.github/workflows/mac-release.yml` | Runs on a published GitHub release or a manual run, never on a pull request. Apple silicon only (`macos-15`). It installs a minimal Rust toolchain for the helper and sets `BAO_SKIP_DMG=1`, so `package-app.sh` skips `Bao.dmg`. |
| Bundled Node | `desktop/packaging/macos/fetch-node.sh`, `node-pin.json` | Downloads the pinned nodejs.org Node and checks its SHA-256. `package-app.sh` copies it to `Contents/Resources/node/bin/node` when `BAO_BUNDLE_NODE` names it. It keeps the Node.js Foundation Developer ID signature. |
| Node lookup | `bao_pick_node` in `desktop/packaging/macos/bao-launch.c` | `BAO_NODE`, then the bundled Node, then the lookup in [Build Bao on a Mac](mac-build.md#launch). A process that answers to macOS as Bao skips `BAO_NODE`, and `bao --run-node` runs only the bundle's own `src/app/cli.js` with `NODE_OPTIONS` and `NODE_PATH` cleared. |
| `bao-cli` | `bao-mcp.c` built with `-DBAO_CLI` | Runs `node src/app/cli.js [args]` from inside the app, through `Contents/MacOS/bao --run-node --own` so macOS asks about Bao for Chrome's folder ([`bao-run-node.h`](../desktop/packaging/macos/bao-run-node.h)). The installer links `~/.local/bin/bao` to it. |
| `bao setup` | `desktop/src/app/setup.ts` | Finds agents and desktop apps, shows the picker, and writes each pick through `agentMain` and `DesktopMcpInstaller`. Ends with the optional [Files & Folders > Google Chrome](permissions.md#files--folders--google-chrome) step. |
| `bao doctor` | `desktop/src/app/doctor.ts` | Checks the app, its signatures, the quarantine mark, Node, Chrome, whether Bao can read Chrome's folder, each agent entry, and one MCP handshake. |
| Release asset | `desktop/packaging/macos/make-release-asset.sh` | Zips `Bao.app` with `ditto` and writes `release.json` with the zip's URL, size, and SHA-256. |
| Installer | `installer/`, packed by `desktop/packaging/macos/pack-installer.sh` | The `bao-browser` package: no dependencies and no install script. It reads the `release.json` packed inside it. |

## Build a release

Bao's version is `version` in the root `package.json`. `desktop/packaging/macos/stamp-version.sh` writes it into the app's `Info.plist`, and `desktop/packaging/build-mcpb.mjs` writes it into the `bao.mcpb` manifest. Every build, local or release, reports it in the About panel, `bao --version`, `bao doctor`, and the MCP `initialize` reply. To release, bump that version on `main` first, then publish a release tagged `v` plus that version from that commit, such as `v1.2.3`.

Publishing a GitHub release runs `mac-release.yml`. When the tag is not `v` plus the `package.json` version, the run still builds and attaches the files, using the tag's version, and posts a warning that names both versions. That warning means `main` missed the bump: set `package.json` to the tag's version on `main`. The run attaches `Bao-<version>-darwin-arm64.zip`, `release.json`, and the installer packed with that `release.json` as `bao-browser.tgz`. That `release.json` names the zip by its full release URL. `installer/install.sh` reads `release.json` from `releases/latest`, then runs the versioned `bao-browser.tgz`, so the latest release installs with:

```sh
curl -fsSL https://raw.githubusercontent.com/aaalexliu/bao-browser/main/installer/install.sh | sh
```

`npx` on the `releases/latest` tarball URL is the wrong command. npx caches that URL and keeps the first release it fetched. The installer prints the version it is about to install and the version already in `/Applications/Bao.app`, or in `~/Applications/Bao.app` when that is the only copy. It refuses a downgrade, and it refuses a same-version reinstall when a newer release exists or cannot be read.

A rerun never replaces those files: a published `bao-browser` pins the zip's size and SHA-256, and a rebuilt zip never matches. When the release already has any of them, the run stops; publish a new release instead.

A manual run (**Actions → Mac release → Run workflow**) builds the same files and uploads them as the `bao-mac-<sha>` artifact. Its `release.json` names the zip by file name, so the latest release's installer installs it from a download folder:

```sh
curl -fsSL https://raw.githubusercontent.com/aaalexliu/bao-browser/main/installer/install.sh | sh -s -- --release ~/Downloads/bao-mac-<sha>/release.json
```

The installer package is not on npm yet. The owner decides the npm account, signing, and license first. Publishing would be:

```sh
bash desktop/packaging/macos/pack-installer.sh path/to/release.json /tmp/bao-installer
npm publish /tmp/bao-installer/bao-browser-<version>.tgz
```

`pack-installer.sh` refuses a `release.json` whose URL is a bare file name.

## Signing

Without a signing secret, the release build signs every part ad-hoc (`BAO_SIGN_IDENTITY=-`). `desktop/packaging/helper-identity.js` then accepts only an ad-hoc `dev.bao.oshelper` helper.

- `npx` and `curl` downloads carry no quarantine mark, so Gatekeeper does not stop an ad-hoc app. A copy downloaded in a browser needs System Settings → Privacy & Security → Open Anyway.
- macOS keys an ad-hoc helper's Accessibility grant to one build, so the grant does not survive an update. The same holds for Bao's Files & Folders > Google Chrome switch, so an ad-hoc build leaves agents with their own app's switch; a certificate build makes `bao-mcp` answer as Bao ([Files & Folders](permissions.md#files--folders--google-chrome)). A copied profile needs no grant. Running Chrome, the default, uses the helper's Accessibility grant.
- The app still runs `BaoOSHelper permissions-ax` for the Settings label. That reads Accessibility without a prompt.

To sign with one project certificate, add two repository secrets: `BAO_SIGNING_P12`, a base64 `.p12` of the certificate and key, and `BAO_SIGNING_P12_PASSWORD`. `desktop/packaging/macos/ci-signing.sh` imports it into a temporary keychain and sets `BAO_SIGN_IDENTITY` and `BAO_HELPER_CERT_HASH` to its SHA-1. A self-signed certificate like `bao dev signing` works as is. Every update signed by it keeps the helper grant. Gatekeeper treats it like an ad-hoc signature.

Apple Developer ID also opens from a browser download and keeps the grant across certificate renewal. It needs three more changes:

1. `helper-identity.js` must accept Apple's requirement form, which names the team id instead of a certificate hash.
2. Every executable needs the hardened runtime: `bao`, `bao-mcp`, `bao-cli`, `bao-front`, BaoCaptureBar, BaoWindowVideo, agent-browser, and Chromium. The helper and Node already have it.
3. A `notarytool submit --wait` step, then `stapler staple`, before `make-release-asset.sh`.

## Build the release locally

This builds what `mac-release.yml` builds, with an ad-hoc signature. Copy the helper and sign the copy ad-hoc, so the signed helper and its grant stay as they are:

```sh
cp -a desktop/os-helper-macos/BaoOSHelper.app /tmp/BaoOSHelper.app
codesign --force --options runtime --entitlements desktop/os-helper-macos/entitlements.plist \
  --identifier dev.bao.oshelper -s - /tmp/BaoOSHelper.app
BAO_SIGN_IDENTITY=- BAO_HELPER_APP=/tmp/BaoOSHelper.app BAO_DIST=/tmp/bao-dist \
  BAO_BUNDLE_NODE="$(bash desktop/packaging/macos/fetch-node.sh /tmp/bao-node)" \
  bash desktop/packaging/macos/package-app.sh
bash desktop/packaging/macos/make-release-asset.sh /tmp/bao-dist/Bao.app /tmp/bao-release
```

Install it into a temp HOME and a temp Applications folder, never `/Applications`:

```sh
mkdir -p /tmp/bao-home /tmp/bao-apps
env -u CODEX_HOME -u CLAUDE_CONFIG_DIR HOME=/tmp/bao-home \
  node installer/bin/bao-browser.mjs --dir /tmp/bao-apps --release /tmp/bao-release/release.json
```
