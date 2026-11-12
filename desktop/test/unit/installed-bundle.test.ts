import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scaledMs } from "../runtime";
const localRequire = createRequire(__filename);
const { acceptHelper, parseCodesign, helperCertHash, signingPlan, PINNED_CERT_HASH } = localRequire(path.join(process.cwd(), "desktop/packaging/helper-identity.js")) as {
  acceptHelper: (report: {
    exists: boolean;
    isBundle: boolean;
    adhoc: boolean;
    identifier: string;
    authorities: string[];
    designated: string;
  }, identity: string, certHash: string, teamId?: string) => { ok: boolean; reason: string };
  signingPlan: (subject: string, issuer: string, teamId: string) => { ok: boolean; pinHash: boolean; teamId: string; reason: string };
  parseCodesign: (verifyText: string, requirementText: string) => {
    identifier: string;
    authorities: string[];
    adhoc: boolean;
    cdhash: string;
    designated: string;
  };
  helperCertHash: (env?: Record<string, string | undefined>) => string;
  PINNED_CERT_HASH: string;
};

const identity = "bao dev signing";
const pinnedHash = "a522e15d431a2f36ace451dd575a02e9e877fbd1";
const recordedRequirement = `designated => identifier "dev.bao.oshelper" and certificate leaf = H"${pinnedHash}"`;

function fromCodesign(verifyText: string, requirementText: string) {
  return { exists: true, isBundle: true, ...parseCodesign(verifyText, requirementText) };
}

test("the recorded helper requirement passes and a different certificate hash fails", () => {
  const verify = "Identifier=dev.bao.oshelper\nAuthority=bao dev signing\n";
  const recorded = fromCodesign(
    `${verify}CDHash=bac5c56ac584bc325e0961999e028fdb87d74edd\n`,
    `${recordedRequirement}\n`,
  );
  const laterBinary = fromCodesign(
    `${verify}CDHash=14898d92021b268d5090437140e45e252d656e50\n`,
    `${recordedRequirement}\n`,
  );
  assert.equal(acceptHelper(recorded, identity, pinnedHash).ok, true, acceptHelper(recorded, identity, pinnedHash).reason);
  assert.equal(acceptHelper(laterBinary, identity, pinnedHash).ok, true);
  const otherHash = "0123456789abcdef0123456789abcdef01234567";
  const other = fromCodesign(verify, `designated => identifier "dev.bao.oshelper" and certificate leaf = H"${otherHash}"\n`);
  assert.equal(acceptHelper(other, identity, pinnedHash).ok, false);
  assert.equal(acceptHelper(recorded, identity, otherHash).ok, false);
  const subjectForm = fromCodesign(
    verify,
    'designated => identifier "dev.bao.oshelper" and certificate leaf[subject.CN] = "bao dev signing"\n',
  );
  assert.equal(acceptHelper(subjectForm, identity, pinnedHash).ok, false);
  assert.equal(acceptHelper({ ...recorded, exists: false }, identity, pinnedHash).reason, "helper is absent");
  assert.match(acceptHelper({ ...recorded, isBundle: false }, identity, pinnedHash).reason, /bundle/);
  assert.match(acceptHelper({ ...recorded, adhoc: true }, identity, pinnedHash).reason, /ad-hoc/);
  const adhocText = fromCodesign(`${verify}Signature=adhoc\n`, `${recordedRequirement}\n`);
  assert.match(acceptHelper(adhocText, identity, pinnedHash).reason, /ad-hoc/);
  assert.equal(pinnedHash, PINNED_CERT_HASH);
  assert.equal(helperCertHash({}), PINNED_CERT_HASH);
  assert.equal(helperCertHash({ BAO_HELPER_CERT_HASH: "A5:22:E1:5D:43:1A:2F:36:AC:E4:51:DD:57:5A:02:E9:E8:77:FB:D1" }), pinnedHash);
  assert.equal(helperCertHash({ BAO_HELPER_CERT_HASH: "not-a-hash" }), "");
  assert.equal(acceptHelper(other, identity, helperCertHash({ BAO_HELPER_CERT_HASH: otherHash })).ok, true);
});

test("an ad-hoc build accepts only an ad-hoc dev.bao.oshelper helper", () => {
  const verify = "Identifier=dev.bao.oshelper\nSignature=adhoc\n";
  const adhoc = fromCodesign(verify, 'designated => cdhash H"bac5c56ac584bc325e0961999e028fdb87d74edd"\n');
  assert.equal(adhoc.adhoc, true);
  assert.equal(acceptHelper(adhoc, "-", pinnedHash).ok, true, acceptHelper(adhoc, "-", pinnedHash).reason);
  assert.equal(acceptHelper({ ...adhoc, identifier: "other" }, "-", pinnedHash).ok, false);
  assert.equal(acceptHelper({ ...adhoc, exists: false }, "-", pinnedHash).reason, "helper is absent");
  const signed = fromCodesign("Identifier=dev.bao.oshelper\nAuthority=bao dev signing\n", recordedRequirement);
  assert.match(acceptHelper(signed, "-", pinnedHash).reason, /needs an ad-hoc helper/);
  assert.match(acceptHelper(adhoc, identity, pinnedHash).reason, /ad-hoc/);
});

const TEAM = "ABCDE12345";
const appleRequirement = `designated => identifier "dev.bao.oshelper" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${TEAM}`;

test("a Developer ID helper is accepted by team id, not by the leaf SHA-1", () => {
  const verify = "Identifier=dev.bao.oshelper\nAuthority=Developer ID Application: Example (ABCDE12345)\n";
  const report = fromCodesign(verify, `${appleRequirement}\n`);
  const named = "Developer ID Application: Example (ABCDE12345)";
  assert.equal(acceptHelper(report, named, pinnedHash, TEAM).ok, true, acceptHelper(report, named, pinnedHash, TEAM).reason);
  assert.equal(acceptHelper(report, pinnedHash, pinnedHash, TEAM).ok, true);
  const quoted = fromCodesign(verify, appleRequirement.replace(`= ${TEAM}`, `= "${TEAM}"`));
  assert.equal(acceptHelper(quoted, named, pinnedHash, TEAM).ok, true);
  assert.equal(acceptHelper(report, named, pinnedHash, "OTHERTEAM1").ok, false);
  assert.match(acceptHelper(report, named, pinnedHash, "nope").reason, /10 letters or digits/);
  const leaf = fromCodesign(verify, recordedRequirement);
  assert.match(acceptHelper(leaf, named, pinnedHash, TEAM).reason, /Developer ID form/);
  assert.equal(acceptHelper(report, named, pinnedHash).ok, false);
  assert.match(acceptHelper(report, "-", pinnedHash, TEAM).reason, /not an ad-hoc build/);
  assert.match(acceptHelper(report, "other name", pinnedHash, TEAM).reason, /not other name/);
});

test("a Developer ID certificate is not pinned to its leaf SHA-1", () => {
  const subject = "CN=Developer ID Application: Example (ABCDE12345),OU=ABCDE12345,O=Example,C=US";
  const issuer = "CN=Developer ID Certification Authority,OU=Apple Certification Authority,O=Apple Inc.,C=US";
  assert.deepEqual(signingPlan(subject, issuer, TEAM), { ok: true, pinHash: false, teamId: TEAM, reason: "" });
  assert.equal(signingPlan(subject, issuer, "").ok, false);
  assert.match(signingPlan(subject, issuer, "OTHERTEAM1").reason, /does not match/);
  assert.deepEqual(signingPlan("CN=bao dev signing", "CN=bao dev signing", ""), { ok: true, pinHash: true, teamId: "", reason: "" });
  assert.match(signingPlan("CN=bao dev signing", "CN=bao dev signing", TEAM).reason, /not Developer ID/);
});

test("a hash signing selector still requires the pinned helper certificate", () => {
  const report = fromCodesign("Identifier=dev.bao.oshelper\nAuthority=bao dev signing\n", recordedRequirement);
  assert.equal(acceptHelper(report, pinnedHash.toUpperCase(), pinnedHash).ok, true);
  assert.equal(acceptHelper(report, "0123456789abcdef0123456789abcdef01234567", pinnedHash).ok, false);
  assert.equal(acceptHelper({ ...report, designated: "" }, pinnedHash, pinnedHash).ok, false);
  assert.equal(acceptHelper({ ...report, adhoc: true }, pinnedHash, pinnedHash).ok, false);
  assert.equal(acceptHelper({ ...report, identifier: "other" }, pinnedHash, pinnedHash).ok, false);
});

function signingEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, GITHUB_ENV: path.join(dir, "github-env"), RUNNER_TEMP: dir, PATH: extra.PATH || process.env.PATH || "" };
  for (const key of ["BAO_SIGNING_P12", "BAO_SIGNING_P12_PASSWORD", "BAO_APPLE_TEAM_ID", "BAO_NOTARY_KEY_P8", "BAO_NOTARY_KEY_ID", "BAO_NOTARY_ISSUER_ID", "BAO_SIGN_IDENTITY"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

test("Chromium's entitlements add library validation off, and bao's do not", {
  skip: process.platform !== "darwin" ? "entitlement validation uses macOS plutil" : false,
}, () => {
  const parse = (name: string): unknown => {
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", `desktop/packaging/macos/${name}.plist`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(parse("entitlements-jit"), {
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
  });
  assert.deepEqual(parse("entitlements-chromium"), {
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
    "com.apple.security.cs.disable-library-validation": true,
  });
});

test("inside-out signing covers native dependencies without signing the node_modules directory", {
  skip: process.platform !== "darwin" ? "native dependency fixtures use macOS Mach-O binaries" : false,
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-native-sign-"));
  const modules = path.join(dir, "node_modules");
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "codesign.jsonl");
  const addon = path.join(modules, "classic-level", "prebuilds", "darwin-x64+arm64", "classic-level.node");
  const dylib = path.join(modules, "@img", "sharp-libvips-darwin-arm64", "lib", "libvips-cpp.dylib");
  try {
    mkdirSync(bin);
    for (const file of [addon, dylib]) {
      mkdirSync(path.dirname(file), { recursive: true });
      copyFileSync("/usr/bin/true", file);
    }
    writeFileSync(path.join(modules, "package.json"), "{}");
    writeFileSync(path.join(bin, "codesign"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
    chmodSync(path.join(bin, "codesign"), 0o755);
    const result = spawnSync("bash", ["desktop/packaging/macos/sign-runtime.sh", "--inside-out", modules], {
      encoding: "utf8",
      env: signingEnv(dir, { PATH: `${bin}:${process.env.PATH}`, BAO_SIGN_IDENTITY: "test signing identity", BAO_APPLE_TEAM_ID: TEAM }),
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls.map((args) => args.at(-1)).sort(), [addon, dylib].sort());
    for (const args of calls) {
      assert.deepEqual(args.slice(0, -1), ["--force", "--options", "runtime", "--sign", "test signing identity", "--timestamp"]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release with no signing secret stays ad-hoc and does not pin a helper hash", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-ci-sign-"));
  try {
    const run = spawnSync("bash", ["desktop/packaging/macos/ci-signing.sh", "import"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: signingEnv(dir),
    });
    assert.equal(run.status, 0, run.stderr);
    const written = readFileSync(path.join(dir, "github-env"), "utf8");
    assert.match(written, /^BAO_SIGN_IDENTITY=-$/m);
    assert.doesNotMatch(written, /BAO_HELPER_CERT_HASH|BAO_APPLE_TEAM_ID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notarize and staple run only when the notary secrets are set", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-notarize-"));
  const bin = path.join(dir, "bin");
  const app = path.join(dir, "Bao.app");
  const log = path.join(dir, "xcrun.log");
  mkdirSync(bin);
  mkdirSync(app);
  writeFileSync(path.join(bin, "xcrun"), `#!/bin/sh
printf '%s\n' "$*" >> "${log}"
exit 0
`);
  chmodSync(path.join(bin, "xcrun"), 0o755);
  const key = Buffer.from("not-a-real-key").toString("base64");
  try {
    const skipped = spawnSync("bash", ["desktop/packaging/macos/notarize-app.sh", app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: signingEnv(dir, { PATH: `${bin}:${process.env.PATH}` }),
    });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.match(skipped.stdout, /skipping notarization/);
    assert.equal(existsSync(log), false);

    const ran = spawnSync("bash", ["desktop/packaging/macos/notarize-app.sh", app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: signingEnv(dir, {
        PATH: `${bin}:${process.env.PATH}`,
        BAO_NOTARY_KEY_P8: key,
        BAO_NOTARY_KEY_ID: "KEYID",
        BAO_NOTARY_ISSUER_ID: "ISSUER",
        BAO_APPLE_TEAM_ID: TEAM,
        BAO_SIGN_IDENTITY: "D5F25A1C70D8842E87F88852772EE74E51F303AF",
      }),
    });
    assert.equal(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /notarytool submit .* --wait --key /);
    assert.match(calls, /stapler staple /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a staged require fails when the module is found outside the copy", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "bao-staged-"));
  const walked = mkdtempSync(path.join(process.cwd(), ".probe-staged-"));
  const bare = mkdtempSync(path.join(tmpdir(), "bao-bare-"));
  try {
    for (const dir of [outside, walked, bare]) {
      mkdirSync(path.join(dir, "src/app"), { recursive: true });
      writeFileSync(path.join(dir, "src/app/server.js"), "module.exports = {};\n");
    }
    for (const name of ["playwright", "classic-level"]) {
      const pkg = path.join(outside, "node_modules", name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, main: "index.js" }));
      writeFileSync(path.join(pkg, "index.js"), "module.exports = {};\n");
    }
    const env = { ...process.env, NODE_PATH: path.join(process.cwd(), "node_modules") };
    const good = spawnSync(process.execPath, ["desktop/packaging/require-staged.js", outside], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
    assert.equal(good.status, 0, good.stderr);
    const fromParent = spawnSync(process.execPath, ["desktop/packaging/require-staged.js", walked], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    });
    assert.notEqual(fromParent.status, 0);
    assert.match(fromParent.stderr, /outside the staged copy/);
    const fromNodePath = spawnSync(process.execPath, ["desktop/packaging/require-staged.js", bare], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
    assert.notEqual(fromNodePath.status, 0);
    assert.match(fromNodePath.stderr, /outside the staged copy/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(walked, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

function stubServer(dir: string) {
  mkdirSync(path.join(dir, "src/app"), { recursive: true });
  writeFileSync(path.join(dir, "src/app/server.js"), "module.exports = {};\n");
}

function stubPackage(dir: string, name: string, body = "module.exports = {};\n", manifest: Record<string, unknown> = {}) {
  const pkg = path.join(dir, "node_modules", name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, main: "index.js", ...manifest }));
  writeFileSync(path.join(pkg, "index.js"), body);
}

test("an unstaged optional module fails to load even when the checkout or NODE_PATH has it", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "bao-optional-"));
  const walked = path.join(parent, "checkout", "dist", "bao");
  const bare = path.join(parent, "bare");
  const lib = path.join(parent, "lib");
  const declared = { optionalDependencies: { "opt-watch": "1.0.0" } };
  const tolerant = "try { require('opt-watch'); } catch {}\n";
  const stage = (dir: string, body: string, manifest: Record<string, unknown>) => {
    rmSync(dir, { recursive: true, force: true });
    stubServer(dir);
    stubPackage(dir, "classic-level");
    stubPackage(dir, "playwright", body, manifest);
  };
  const run = (dir: string, nodePath: string) => spawnSync(process.execPath, ["desktop/packaging/require-staged.js", dir], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: nodePath, NODE_OPTIONS: "", HOME: parent },
  });
  try {
    stubPackage(path.join(parent, "checkout"), "opt-watch");
    stubPackage(lib, "opt-watch");
    for (const [dir, nodePath] of [[walked, ""], [bare, path.join(lib, "node_modules")]] as const) {
      stage(dir, tolerant, declared);
      const skipped = run(dir, nodePath);
      assert.equal(skipped.status, 0, skipped.stderr);
      assert.match(skipped.stdout, /optional opt-watch is not staged/);

      stage(dir, "require('opt-watch');\n", declared);
      const needed = run(dir, nodePath);
      assert.notEqual(needed.status, 0);
      assert.match(needed.stderr, /'opt-watch': it is optional and not in the staged copy/);

      stage(dir, tolerant, {});
      const undeclared = run(dir, nodePath);
      assert.notEqual(undeclared.status, 0);
      assert.match(undeclared.stderr, /outside the staged copy/);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a correct staged tree behind a directory symlink is accepted", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "bao-var-"));
  const privateVar = path.join(parent, "private-var");
  mkdirSync(privateVar);
  symlinkSync(privateVar, path.join(parent, "var"));
  const staged = path.join(parent, "var", "folders");
  mkdirSync(staged);
  try {
    stubServer(staged);
    stubPackage(staged, "playwright");
    stubPackage(staged, "classic-level");
    const result = spawnSync(process.execPath, ["desktop/packaging/require-staged.js", staged], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a staged package that loads from HOME or a symlink is rejected", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "bao-escape-"));
  const staged = path.join(parent, "staged");
  const home = path.join(parent, "home");
  const outside = path.join(parent, "outside", "playwright");
  try {
    stubServer(staged);
    stubPackage(staged, "classic-level");
    stubPackage(staged, "playwright", "require('playwright-core');\n");
    const core = path.join(home, ".node_modules", "playwright-core");
    mkdirSync(core, { recursive: true });
    writeFileSync(path.join(core, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
    writeFileSync(path.join(core, "index.js"), "module.exports = {};\n");
    const fromHome = spawnSync(process.execPath, ["desktop/packaging/require-staged.js", staged], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", HOME: home },
    });
    assert.notEqual(fromHome.status, 0);
    assert.match(fromHome.stderr, /outside the staged copy/);

    rmSync(path.join(staged, "node_modules", "playwright"), { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "playwright", main: "index.js" }));
    writeFileSync(path.join(outside, "index.js"), "module.exports = {};\n");
    symlinkSync(outside, path.join(staged, "node_modules", "playwright"));
    const fromLink = spawnSync(process.execPath, ["desktop/packaging/require-staged.js", staged], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "--preserve-symlinks", HOME: home },
    });
    assert.notEqual(fromLink.status, 0);
    assert.match(fromLink.stderr, /outside the staged copy/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an installed bundle serves extension settings and imports synthetic localStorage", { timeout: scaledMs(180_000) }, async () => {
  const destParent = mkdtempSync(path.join(tmpdir(), "bao-installed-"));
  const dest = path.join(destParent, "Resources");
  mkdirSync(dest);
  const staged = spawnSync("bash", ["desktop/packaging/stage-runtime.sh", dest], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
  });
  assert.equal(staged.status, 0, staged.stderr || staged.stdout);
  assert.equal(existsSync(path.join(dest, "extension/src/host-grant.js")), true);
  assert.equal(existsSync(path.join(dest, "extension/dist/manifest.json")), true);
  assert.equal(existsSync(path.join(dest, "extension/dist/background.js")), true);
  assert.equal(existsSync(path.join(dest, "bao/src/app/app.js")), true);
  assert.equal(existsSync(path.join(dest, "bao/node_modules/classic-level/prebuilds/linux-x64/classic-level.node")), true);
  assert.equal(existsSync(path.join(dest, "bao/node_modules/classic-level/prebuilds/darwin-x64+arm64/classic-level.node")), true);
  const bao = path.join(dest, "bao");
  const bin = path.join(bao, "node_modules/.bin");
  assert.equal(existsSync(bin), true);
  for (const name of readdirSync(bin)) {
    const link = path.join(bin, name);
    const target = readlinkSync(link);
    assert.equal(existsSync(path.resolve(path.dirname(link), target)), true, `${name} -> ${target}`);
  }
  const isolated = spawnSync(process.execPath, [path.join(process.cwd(), "desktop/packaging/require-staged.js"), bao], {
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: path.join(process.cwd(), "node_modules") },
  });
  assert.equal(isolated.status, 0, isolated.stderr);
  const ext = path.join(bao, "src/extension");
  const homeForHost = mkdtempSync(path.join(tmpdir(), "bao-host-home-"));
  const wrapped = spawnSync(process.execPath, ["-e", `
    const { installNativeHost } = require("./install-host.js");
    const path = require("path");
    const home = process.env.BAO_FAKE_HOME;
    const result = installNativeHost({
      home,
      socketPath: path.join(home, "extension-host", "bridge.sock"),
      tokenPath: path.join(home, "extension-host", "token"),
      hostScript: "/checkout/desktop/dist/desktop/src/extension/native-host.js",
    });
    process.stdout.write(require("fs").readFileSync(result.wrapper, "utf8"));
  `], {
    cwd: ext,
    encoding: "utf8",
    env: { PATH: process.env.PATH, BAO_FAKE_HOME: homeForHost },
  });
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.match(wrapped.stdout, /Resources\/bao\/src\/extension\/native-host\.js/);
  assert.equal(wrapped.stdout.includes("/checkout/desktop"), false);
  const shared = spawnSync(process.execPath, ["-e", `
    const assert = require('node:assert/strict');
    const { STRIPPED_SECRET, stepNeedsSecretValue } = require('../shared/saved-secrets.js');
    const { stripUnsafe } = require('../web/src/lib/guard.js');
    const { Library } = require('./src/v1/store.js');
    const library = new Library(process.env.BAO_FAKE_HOME);
    for (const value of ['short-password', 'sk-stagedFixtureToken', '4111111111111111']) {
      const metadata = { label: value, source: { agent: value }, locators: [{ kind: 'text', value }], ax: value };
      const record = { op: 'type', value, metadata, sealed: { kind: 'read-back', expected: value, actual: value, hash: 'signed' } };
      const original = structuredClone(record);
      assert.deepEqual(stripUnsafe(record), { ...record, value: value === 'short-password' ? value : STRIPPED_SECRET });
      library.saveTrail('staged-input', [record]);
      assert.deepEqual(library.readTrail('staged-input'), [record]);
      assert.equal(stepNeedsSecretValue({ action: 'type', text: { literal: STRIPPED_SECRET } }, { inputs: [], steps: [] }, {}), true);
      assert.deepEqual(record, original);
    }
    const owners = Object.keys(require.cache).filter(file => file.endsWith('/saved-secrets.js'));
    assert.deepEqual(owners, [require.resolve('../shared/saved-secrets.js')]);
    console.log('shared saved-secret owner loaded by desktop and web');
  `], {
    cwd: bao,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: homeForHost, BAO_FAKE_HOME: path.join(homeForHost, "library"), BAO_HEAL_CURSOR_ACCOUNT: "0" },
  });
  assert.equal(shared.status, 0, shared.stderr);
  assert.match(shared.stdout, /shared saved-secret owner loaded by desktop and web/);
  const loaded = spawnSync(process.execPath, ["-e", "require('./src/app/server.js')"], {
    cwd: bao,
    encoding: "utf8",
  });
  assert.equal(loaded.status, 0, loaded.stderr);

  const profile = mkdtempSync(path.join(tmpdir(), "bao-ls-"));
  const unrelated = mkdtempSync(path.join(tmpdir(), "bao-cwd-"));
  const imported = spawnSync(process.execPath, ["-e", `
    const path = require("path");
    const { ClassicLevel } = require(process.env.BAO_CLASSIC);
    const storage = require(process.env.BAO_STORAGE);
    const origin = "https://fixture.test";
    const key = "bao-smoke";
    const value = "synthetic-token";
    const levelDir = path.join(process.env.BAO_PROFILE, "Local Storage", "leveldb");
    (async () => {
      const db = new ClassicLevel(levelDir, { keyEncoding: "buffer", valueEncoding: "buffer" });
      await db.put(storage.localStorageKey(origin, key), storage.encodeStorageBytes(value));
      await db.close();
      const items = await storage.readLocalStorage(process.env.BAO_PROFILE, [origin]);
      const hit = items.find((item) => item.origin === origin && item.key === key && item.value === value);
      if (!hit) {
        console.error(JSON.stringify(items));
        process.exit(1);
      }
      console.log("imported " + hit.value);
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `], {
    cwd: unrelated,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      BAO_CLASSIC: path.join(bao, "node_modules/classic-level"),
      BAO_STORAGE: path.join(bao, "src/login-import/storage.js"),
      BAO_PROFILE: profile,
    },
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /imported synthetic-token/);

  const fakeHome = mkdtempSync(path.join(tmpdir(), "bao-fake-home-"));
  const dataHome = path.join(fakeHome, "library");
  const server = spawn(process.execPath, [
    path.join(bao, "src/app/cli.js"),
    "serve",
    "--home", dataHome,
    "--port", "0",
  ], {
    cwd: unrelated,
    env: {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
      HOME: fakeHome,
      BAO_HEAL_CURSOR_ACCOUNT: "0",
      BAO_HOME: dataHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout?.on("data", (chunk) => { logs += chunk.toString(); });
  server.stderr?.on("data", (chunk) => { logs += chunk.toString(); });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs || "server did not listen")), 30_000);
    const watch = () => {
      const match = logs.match(/bao (\d+) home /);
      if (!match?.[1]) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    server.stdout?.on("data", watch);
    server.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(logs || "server exited"));
    });
    watch();
  });
  try {
    const js = await fetch(`http://127.0.0.1:${port}/app.js`).then((res) => res.text());
    assert.match(js, /Chrome sites/);
    assert.match(js, /Site access:/);
    assert.match(js, /id="host-access"/);
    assert.match(js, /all sites/);
    assert.match(js, /per site/);
  } finally {
    server.kill("SIGTERM");
    rmSync(destParent, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
    rmSync(unrelated, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(homeForHost, { recursive: true, force: true });
  }
});
