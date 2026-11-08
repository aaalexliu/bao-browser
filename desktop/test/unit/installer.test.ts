import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const INSTALLER = path.join(process.cwd(), "installer/bin/bao-browser.mjs");
const skip = process.platform !== "darwin" ? "the installer places a signed Mac app" : false;

interface Lab {
  root: string;
  home: string;
  apps: string;
  release: string;
}

/** A Bao.app whose bao-cli records its arguments in $HOME/bao-cli.log, signed ad-hoc like a release without a signing secret. */
function fakeApp(dir: string, version: string): string {
  const app = path.join(dir, "Bao.app");
  const macos = path.join(app, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>bao</string>
<key>CFBundleIdentifier</key><string>dev.bao.installer-test</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`);
  const scripts: Record<string, string> = {
    bao: "exit 0",
    "bao-mcp": "exit 0",
    "bao-cli": 'printf "%s\\n" "$*" >> "$HOME/bao-cli.log"',
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(macos, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(macos, name), 0o755);
  }
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", path.join(macos, "bao-cli"), path.join(macos, "bao-mcp")], { stdio: "ignore" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
  return app;
}

/** Zips a fake app the way make-release-asset.sh does and writes release.json beside it. */
function publish(lab: Lab, version: string): void {
  const build = mkdtempSync(path.join(lab.root, "build-"));
  const app = fakeApp(build, version);
  const name = `Bao-${version}-darwin-arm64.zip`;
  const zip = path.join(path.dirname(lab.release), name);
  rmSync(zip, { force: true });
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
  const release = { version, platforms: { "darwin-arm64": { url: name, size: statSync(zip).size, sha256 } } };
  writeFileSync(lab.release, `${JSON.stringify(release, null, 2)}\n`);
}

function lab(t: TestContext, version = "9.9.1"): Lab {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-installer-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out: Lab = { root, home: path.join(root, "home"), apps: path.join(root, "Applications"), release: path.join(root, "release", "release.json") };
  mkdirSync(out.home);
  mkdirSync(path.dirname(out.release));
  publish(out, version);
  return out;
}

function install(lab: Lab, ...args: string[]) {
  return installWith(lab, {}, ...args);
}

function installWith(lab: Lab, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [INSTALLER, "--dir", lab.apps, "--release", lab.release, ...args], {
    env: { HOME: lab.home, PATH: "/usr/bin:/bin", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

function version(app: string): string {
  return execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
}

test("the installer places the pinned app, links bao, and hands the picker flags to the app's setup", { skip }, (t) => {
  const box = lab(t);
  const run = install(box, "--agents", "codex");
  assert.equal(run.status, 0, run.stderr);
  const app = path.join(box.apps, "Bao.app");
  assert.equal(version(app), "9.9.1");
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", app]);
  assert.equal(readlinkSync(path.join(box.home, ".local", "bin", "bao")), path.join(app, "Contents", "MacOS", "bao-cli"));
  assert.equal(readFileSync(path.join(box.home, "bao-cli.log"), "utf8"), `setup --app ${app} --agents codex\n`);
  assert.ok(existsSync(path.join(box.home, "Library", "Caches", "bao", "downloads", "Bao-9.9.1-darwin-arm64.zip")));
  assert.match(run.stdout, /Checked size and SHA-256/);
  assert.match(run.stdout, /npx bao-browser doctor .* npx bao-browser setup/);
});

test("a download that does not match release.json installs nothing", { skip }, (t) => {
  const box = lab(t);
  const release = JSON.parse(readFileSync(box.release, "utf8")) as { platforms: Record<string, { sha256: string }> };
  release.platforms["darwin-arm64"]!.sha256 = "0".repeat(64);
  writeFileSync(box.release, JSON.stringify(release));
  const run = install(box, "--none");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /does not match this release/);
  assert.equal(existsSync(path.join(box.apps, "Bao.app")), false);
  assert.deepEqual(readdirSync(path.join(box.home, "Library", "Caches", "bao", "downloads")), []);
  assert.equal(existsSync(path.join(box.home, "bao-cli.log")), false);
});

test("a rerun reuses the checked download, and a new release replaces the app in place", { skip }, (t) => {
  const box = lab(t);
  assert.equal(install(box, "--none").status, 0);
  const again = install(box, "--none");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Using the copy downloaded earlier/);
  const cache = path.join(box.home, "Library", "Caches", "bao", "downloads");
  writeFileSync(path.join(cache, "Bao-9.9.0-darwin-arm64.zip.part"), "cut short");
  writeFileSync(path.join(cache, "notes.txt"), "not Bao's");
  publish(box, "9.9.2");
  const update = install(box, "--none");
  assert.equal(update.status, 0, update.stderr);
  assert.equal(version(path.join(box.apps, "Bao.app")), "9.9.2");
  assert.deepEqual(readdirSync(box.apps), ["Bao.app"]);
  assert.deepEqual(readdirSync(cache).sort(), ["Bao-9.9.2-darwin-arm64.zip", "notes.txt"]);
});

test("a missing release.json stops before any download", { skip }, (t) => {
  const box = lab(t);
  rmSync(box.release);
  const run = install(box, "--none");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /release\.json is missing/);
  assert.equal(existsSync(box.apps), false);
});

/**
 * A codesign that reports a self-signed "bao dev signing" certificate, with leaf hash $OLD_CERT for the app at $SIGNED_APP
 * and $NEW_CERT for the staged copy, and passes every other call, such as --verify, to /usr/bin/codesign.
 */
function certificateCodesign(lab: Lab): string {
  const file = path.join(lab.root, "codesign");
  writeFileSync(file, `#!/bin/sh
for last; do :; done
cert=""
case "$last" in
  "$SIGNED_APP") cert="$OLD_CERT" ;;
  */.bao-install-*/Bao.app) cert="$NEW_CERT" ;;
esac
if [ -n "$cert" ] && [ "$1" = "-dvv" ]; then
  echo "Authority=bao dev signing" >&2
  exit 0
fi
if [ -n "$cert" ] && [ "$1" = "-d" ]; then
  echo "designated => identifier \\"dev.bao.installer-test\\" and certificate leaf = H\\"$cert\\""
  exit 0
fi
exec /usr/bin/codesign "$@"
`);
  chmodSync(file, 0o755);
  return file;
}

test("with --yes or no terminal, an ad-hoc release keeps a certificate-signed Bao.app and says how to replace it", { skip }, (t) => {
  const box = lab(t);
  assert.equal(install(box, "--none").status, 0);
  rmSync(path.join(box.home, "bao-cli.log"));
  publish(box, "9.9.2");
  const app = path.join(box.apps, "Bao.app");
  const env = { BAO_INSTALLER_CODESIGN: certificateCodesign(box), SIGNED_APP: app, OLD_CERT: "a".repeat(40) };
  for (const flag of ["--yes", "--none"]) {
    const run = installWith(box, env, flag);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /signed by bao dev signing\. This release is signed ad-hoc/);
    assert.match(run.stdout, /Kept .*Bao\.app\. Nothing was installed\. To replace it: quit Bao, remove /);
    assert.equal(version(app), "9.9.1");
    assert.equal(existsSync(path.join(box.home, "bao-cli.log")), false);
  }
  assert.equal(install(box, "--none").status, 0);
  assert.equal(version(app), "9.9.2");
});

test("a release signed by another certificate with the same name keeps the installed app, and the same certificate replaces it", { skip }, (t) => {
  const box = lab(t);
  assert.equal(install(box, "--none").status, 0);
  publish(box, "9.9.2");
  const app = path.join(box.apps, "Bao.app");
  const env = { BAO_INSTALLER_CODESIGN: certificateCodesign(box), SIGNED_APP: app, OLD_CERT: "a".repeat(40) };
  const other = installWith(box, { ...env, NEW_CERT: "b".repeat(40) }, "--yes");
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /This release is signed by bao dev signing with a different certificate/);
  assert.match(other.stdout, /Kept .*Bao\.app\. Nothing was installed\./);
  assert.equal(version(app), "9.9.1");
  const same = installWith(box, { ...env, NEW_CERT: "a".repeat(40) }, "--none");
  assert.equal(same.status, 0, same.stderr);
  assert.doesNotMatch(same.stdout, /Kept /);
  assert.equal(version(app), "9.9.2");
});
