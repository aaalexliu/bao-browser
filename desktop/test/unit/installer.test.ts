import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scaledMs } from "../runtime";

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

/** A tccutil that logs each call to $HOME/tccutil.log and exits $TCC_EXIT, so no test touches the Mac's real grants. */
function fakeTccutil(lab: Lab): string {
  const file = path.join(lab.root, "tccutil");
  writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/tccutil.log"\nexit "${TCC_EXIT:-0}"\n');
  chmodSync(file, 0o755);
  return file;
}

function installWith(lab: Lab, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [INSTALLER, "--dir", lab.apps, "--release", lab.release, ...args], {
    env: { HOME: lab.home, PATH: "/usr/bin:/bin", BAO_INSTALLER_LATEST: lab.release, BAO_INSTALLER_TCCUTIL: fakeTccutil(lab), ...env },
    encoding: "utf8",
    timeout: scaledMs(60_000),
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
  assert.match(run.stdout, /Installing Bao 9\.9\.1\. No Bao\.app is installed yet\./);
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", app]);
  assert.equal(readlinkSync(path.join(box.home, ".local", "bin", "bao")), path.join(app, "Contents", "MacOS", "bao-cli"));
  assert.equal(readFileSync(path.join(box.home, "bao-cli.log"), "utf8"), `setup --app ${app} --agents codex\n`);
  assert.ok(existsSync(path.join(box.home, "Library", "Caches", "bao", "downloads", "Bao-9.9.1-darwin-arm64.zip")));
  assert.match(run.stdout, /Checked size and SHA-256/);
  const bao = path.join(box.home, ".local", "bin", "bao");
  assert.ok(run.stdout.endsWith(`Check this install any time: ${bao} doctor   ·   change agents: ${bao} setup\nTo run plain bao, add ~/.local/bin to your PATH.\n`), run.stdout);
  const onPath = installWith(box, { PATH: `${path.dirname(bao)}:/usr/bin:/bin` }, "--none");
  assert.ok(onPath.stdout.endsWith(`Check this install any time: ${bao} doctor   ·   change agents: ${bao} setup\n`), onPath.stdout);
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
  assert.match(again.stdout, /Installing Bao 9\.9\.1 over 9\.9\.1 at /);
  assert.match(again.stdout, /Using the copy downloaded earlier/);
  const cache = path.join(box.home, "Library", "Caches", "bao", "downloads");
  writeFileSync(path.join(cache, "Bao-9.9.0-darwin-arm64.zip.part"), "cut short");
  writeFileSync(path.join(cache, "notes.txt"), "not Bao's");
  publish(box, "9.9.2");
  const update = install(box, "--none");
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /Installing Bao 9\.9\.2 over 9\.9\.1 at /);
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

function tccCalls(lab: Lab): string {
  const log = path.join(lab.home, "tccutil.log");
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

test("replacing a Bao signed another way clears its stale macOS grants before setup, and the same signature keeps them", { skip }, (t) => {
  const box = lab(t);
  assert.equal(install(box, "--none").status, 0);
  assert.equal(install(box, "--none").status, 0);
  assert.equal(tccCalls(box), "", "a first install and a reinstall of the same build keep every grant");
  publish(box, "9.9.2");
  const adhoc = install(box, "--none");
  assert.equal(adhoc.status, 0, adhoc.stderr);
  assert.equal(tccCalls(box), "reset All dev.bao.installer-test\n");
  assert.match(adhoc.stdout, /Cleared the macOS grants of the Bao it replaced \(dev\.bao\.installer-test\)\. That Bao was signed ad-hoc, so they no longer matched\./);
  // The clear comes before setup, which opens the permission window.
  assert.ok(adhoc.stdout.indexOf("Cleared the macOS grants") < adhoc.stdout.indexOf("Now pick the agents"), adhoc.stdout);
  rmSync(path.join(box.home, "tccutil.log"));
  publish(box, "9.9.3");
  const app = path.join(box.apps, "Bao.app");
  const same = installWith(box, { BAO_INSTALLER_CODESIGN: certificateCodesign(box), SIGNED_APP: app, OLD_CERT: "a".repeat(40), NEW_CERT: "a".repeat(40) }, "--none");
  assert.equal(same.status, 0, same.stderr);
  assert.equal(version(app), "9.9.3");
  assert.equal(tccCalls(box), "", "the same certificate keeps the grants");
  assert.doesNotMatch(same.stdout, /Cleared the macOS grants/);
});

test("a stale grant tccutil cannot clear is named with the command to clear it", { skip }, (t) => {
  const box = lab(t);
  assert.equal(install(box, "--none").status, 0);
  publish(box, "9.9.2");
  const run = installWith(box, { TCC_EXIT: "64" }, "--none");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(version(path.join(box.apps, "Bao.app")), "9.9.2");
  assert.doesNotMatch(run.stdout, /Cleared the macOS grants/);
  assert.match(run.stdout, /Could not clear the old grants for dev\.bao\.installer-test\. If a Bao switch in System Settings is on but Bao is still refused, run: tccutil reset All dev\.bao\.installer-test/);
});

test("a downgrade is refused and leaves the installed app", { skip }, (t) => {
  const box = lab(t, "9.9.2");
  assert.equal(install(box, "--none").status, 0);
  publish(box, "9.9.1");
  const run = install(box, "--none");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Refusing to install Bao 9\.9\.1 over 9\.9\.2 at .* That would downgrade/);
  assert.equal(version(path.join(box.apps, "Bao.app")), "9.9.2");
  assert.equal(existsSync(path.join(box.home, "bao-cli.log")), true);
  const log = readFileSync(path.join(box.home, "bao-cli.log"), "utf8");
  assert.equal(log.split("\n").filter(Boolean).length, 1);
});

test("a same-version reinstall is refused when a newer release exists", { skip }, (t) => {
  const box = lab(t);
  assert.equal(install(box, "--none").status, 0);
  rmSync(path.join(box.home, "bao-cli.log"));
  const newer = path.join(box.root, "newer.json");
  writeFileSync(newer, `${JSON.stringify({ version: "9.9.2", platforms: { "darwin-arm64": { url: "file:///missing", size: 1, sha256: "ab" } } })}\n`);
  const run = installWith(box, { BAO_INSTALLER_LATEST: newer }, "--none");
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Installing Bao 9\.9\.1 over 9\.9\.1 at /);
  assert.match(run.stderr, /Refusing to install Bao 9\.9\.1 over 9\.9\.1 at .* The newest release is 9\.9\.2/);
  assert.equal(version(path.join(box.apps, "Bao.app")), "9.9.1");
  assert.equal(existsSync(path.join(box.home, "bao-cli.log")), false);
});

test("a same-version reinstall stops when the newest release cannot be read", { skip }, (t) => {
  const box = lab(t);
  assert.equal(install(box, "--none").status, 0);
  rmSync(path.join(box.home, "bao-cli.log"));
  const missing = path.join(box.root, "missing-latest.json");
  const run = installWith(box, { BAO_INSTALLER_LATEST: missing }, "--none");
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Cannot read the newest release/);
  assert.match(run.stderr, /Nothing was installed/);
  assert.equal(version(path.join(box.apps, "Bao.app")), "9.9.1");
  assert.equal(existsSync(path.join(box.home, "bao-cli.log")), false);
});
