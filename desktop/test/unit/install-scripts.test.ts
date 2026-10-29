import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "desktop"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const root = repoRoot();

function writeFixture(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
}

const legacyManifest = `{
  "manifest_version": 3,
  "name": "Bao",
  "icons": { "16": "icons/icon-16.png" },
  "side_panel": { "default_path": "sidepanel.html" },
  "options_page": "dashboard.html",
  "background": { "service_worker": "dist/background.js" }
}
`;

function legacyFiles(icon = "png"): Record<string, string> {
  const files: Record<string, string> = {
    "manifest.json": legacyManifest,
    "sidepanel.html": "<script src=\"dist/sidepanel.js\"></script>\n",
    "dashboard.html": "<script src=\"dist/dashboard.js\"></script>\n",
    "dist/background.js": "background",
    "dist/sidepanel.js": "sidepanel",
    "dist/dashboard.js": "dashboard",
  };
  if (icon) files["icons/icon-16.png"] = icon;
  return files;
}

test("legacy installer copies every manifest file into the stage", () => {
  const source = mkdtempSync(path.join(tmpdir(), "bao-legacy-src-"));
  const stage = mkdtempSync(path.join(tmpdir(), "bao-legacy-stage-"));
  writeFixture(source, legacyFiles());
  const result = spawnSync("bash", [path.join(root, "install-dev-legacy.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BAO_SKIP_BUILD: "1",
      BAO_LEGACY_SOURCE: source,
      BAO_EXT_DIR: stage,
      BAO_CHROME_PROFILE: "missing-profile-for-test",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const rel of ["manifest.json", "icons/icon-16.png", "dashboard.html", "sidepanel.html", "dist/background.js", "dist/dashboard.js", "dist/sidepanel.js"]) {
    assert.equal(readFileSync(path.join(stage, rel), "utf8").length > 0, true, rel);
  }
});

test("legacy installer exits non-zero when a manifest file is absent", () => {
  const source = mkdtempSync(path.join(tmpdir(), "bao-legacy-bad-"));
  const stage = path.join(tmpdir(), `bao-legacy-bad-stage-${process.pid}`);
  writeFixture(source, legacyFiles(""));
  const result = spawnSync("bash", [path.join(root, "install-dev-legacy.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BAO_SKIP_BUILD: "1",
      BAO_LEGACY_SOURCE: source,
      BAO_EXT_DIR: stage,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}`, /icons\/icon-16\.png/);
});

test("install-dev.sh names the legacy and current installers and does not stage", () => {
  const stage = path.join(tmpdir(), `bao-shim-stage-${process.pid}`);
  const result = spawnSync("bash", [path.join(root, "install-dev.sh")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BAO_EXT_DIR: stage, BAO_SKIP_BUILD: "1" },
    timeout: 15000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2, output);
  assert.match(output, /install-dev-legacy\.sh/);
  assert.match(output, /install-extension\.sh/);
  assert.equal(existsSync(stage), false);
});

test("extension installer stages the unpacked directory and rejects a missing manifest file", () => {
  const source = mkdtempSync(path.join(tmpdir(), "bao-ext-src-"));
  const stage = mkdtempSync(path.join(tmpdir(), "bao-ext-stage-"));
  writeFixture(source, {
    "manifest.json": `{
      "manifest_version": 3,
      "name": "Bao",
      "background": { "service_worker": "background.js" },
      "action": { "default_popup": "popup.html" }
    }\n`,
    "popup.html": "<script src=\"popup.js\"></script>\n",
    "background.js": "bg",
    "popup.js": "pop",
    "dialogs.js": "dialogs",
  });
  const ok = spawnSync("bash", [path.join(root, "install-extension.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BAO_SKIP_BUILD: "1",
      BAO_EXTENSION_SOURCE: source,
      BAO_EXTENSION_DIR: stage,
    },
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(path.join(stage, "dialogs.js"), "utf8"), "dialogs");
  assert.match(ok.stdout, /jcjcpblcjaakcmbgljdjkfgmmdfdbnfj/);

  const broken = mkdtempSync(path.join(tmpdir(), "bao-ext-broken-"));
  const brokenStage = mkdtempSync(path.join(tmpdir(), "bao-ext-broken-stage-"));
  writeFixture(broken, {
    "manifest.json": `{ "background": { "service_worker": "background.js" }, "icons": { "16": "icons/icon-16.png" } }\n`,
    "background.js": "bg",
  });
  const bad = spawnSync("bash", [path.join(root, "install-extension.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BAO_SKIP_BUILD: "1",
      BAO_EXTENSION_SOURCE: broken,
      BAO_EXTENSION_DIR: brokenStage,
    },
  });
  assert.notEqual(bad.status, 0);
  assert.match(`${bad.stderr}`, /icons\/icon-16\.png/);
});

test("legacy installer stages dist/forceopen.js from the real build", () => {
  const built = path.join(root, "dist/forceopen.js");
  assert.equal(existsSync(built), true, built);
  const stage = mkdtempSync(path.join(tmpdir(), "bao-forceopen-"));
  const result = spawnSync("bash", [path.join(root, "install-dev-legacy.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BAO_SKIP_BUILD: "1",
      BAO_LEGACY_SOURCE: root,
      BAO_EXT_DIR: stage,
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.equal(readFileSync(path.join(stage, "dist/forceopen.js"), "utf8"), readFileSync(built, "utf8"));
  assert.match(output, /Stage succeeded/);
  assert.match(output, /macOS-only/);
  assert.doesNotMatch(output, /Could not find a Chrome profile/);
});

function stageCopy(source: string, stage: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, "scripts/stage-unpacked.mjs"), "copy", source, stage], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extra },
  });
}

function tinySource(): string {
  const source = mkdtempSync(path.join(tmpdir(), "bao-stage-src-"));
  writeFixture(source, { "manifest.json": "{ \"name\": \"Bao\" }\n" });
  return source;
}

test("stager refuses a populated directory that is not a previous stage", () => {
  const source = tinySource();
  const stage = mkdtempSync(path.join(tmpdir(), "bao-foreign-"));
  writeFileSync(path.join(stage, "canary.txt"), "keep");
  const refused = stageCopy(source, stage);
  assert.notEqual(refused.status, 0, refused.stderr);
  assert.match(`${refused.stderr}`, /refusing to replace/);
  assert.equal(readFileSync(path.join(stage, "canary.txt"), "utf8"), "keep");

  const forced = stageCopy(source, stage, { BAO_STAGE_FORCE: "1" });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(`${forced.stderr}`, /Replacing /);
  assert.equal(existsSync(path.join(stage, "canary.txt")), false);
  assert.equal(existsSync(path.join(stage, "manifest.json")), true);
  assert.equal(existsSync(path.join(stage, ".bao-stage")), true);

  writeFileSync(path.join(stage, "again.txt"), "x");
  const again = stageCopy(source, stage);
  assert.equal(again.status, 0, again.stderr);
  assert.match(`${again.stderr}`, /Replacing /);
  assert.equal(existsSync(path.join(stage, "again.txt")), false);
  assert.equal(existsSync(path.join(stage, ".bao-stage")), true);
});

test("stager refuses the home directory even when force is set", () => {
  const source = tinySource();
  const home = mkdtempSync(path.join(tmpdir(), "bao-fake-home-"));
  writeFileSync(path.join(home, "canary.txt"), "keep");
  const result = stageCopy(source, home, { HOME: home, BAO_STAGE_FORCE: "1" });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(`${result.stderr}`, /refusing to replace/);
  assert.equal(readFileSync(path.join(home, "canary.txt"), "utf8"), "keep");
});

test("stager refuses the source tree and a parent of the source", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "bao-parent-"));
  const source = path.join(parent, "src");
  mkdirSync(source);
  writeFixture(source, { "manifest.json": "{ \"name\": \"Bao\" }\n", "keep.txt": "src" });
  writeFileSync(path.join(parent, "keep.txt"), "parent");
  const self = stageCopy(source, source);
  assert.notEqual(self.status, 0, self.stderr);
  assert.equal(readFileSync(path.join(source, "keep.txt"), "utf8"), "src");
  const up = stageCopy(source, parent);
  assert.notEqual(up.status, 0, up.stderr);
  assert.equal(readFileSync(path.join(parent, "keep.txt"), "utf8"), "parent");
  assert.equal(readFileSync(path.join(source, "manifest.json"), "utf8").includes("Bao"), true);
});

test("stager resolves a symlink and refuses a foreign target", () => {
  const source = tinySource();
  const target = mkdtempSync(path.join(tmpdir(), "bao-link-target-"));
  writeFileSync(path.join(target, "canary.txt"), "keep");
  const linkDir = mkdtempSync(path.join(tmpdir(), "bao-link-dir-"));
  const link = path.join(linkDir, "stage");
  symlinkSync(target, link);
  const result = stageCopy(source, link);
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(`${result.stderr}`, /refusing to replace/);
  assert.equal(readFileSync(path.join(target, "canary.txt"), "utf8"), "keep");
});

test("bao runs the compiled cli and the aggregate scripts exist", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const web = JSON.parse(readFileSync(path.join(root, "web/package.json"), "utf8")) as { scripts: Record<string, string>; engines: { node: string } };
  assert.equal(pkg.scripts.bao, "node desktop/dist/desktop/src/app/cli.js");
  assert.equal(pkg.scripts["build:desktop"], "tsc -p tsconfig.desktop.json");
  assert.match(pkg.scripts["typecheck:desktop"], /tsc -p tsconfig\.desktop\.json --noEmit/);
  assert.match(pkg.scripts["typecheck:extension"], /extension\/tsconfig\.json/);
  assert.match(pkg.scripts["test:desktop:unit"], /run-v1\.mjs/);
  assert.match(pkg.scripts["test:desktop:integration"], /run-v1\.mjs live/);
  assert.match(pkg.scripts["package:mac"], /package-app\.sh/);
  assert.match(pkg.scripts.typecheck, /typecheck:desktop/);
  assert.match(pkg.scripts.check, /test:desktop:unit/);
  assert.equal(typeof pkg.scripts.test, "string");
  assert.equal(typeof web.scripts.test, "string");
  assert.equal(web.engines.node, ">=24");
  const cli = path.join(root, "desktop/dist/desktop/src/app/cli.js");
  assert.equal(existsSync(cli), true, cli);
  const result = spawnSync("npm", ["run", "bao", "--", "nope"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /usage: bao/);
  assert.doesNotMatch(output, /tsconfig\.desktop\.json/);
});

test("stager refuses the repo and the filesystem root", () => {
  const source = tinySource();
  const repo = stageCopy(source, root, { BAO_STAGE_FORCE: "1" });
  assert.notEqual(repo.status, 0, repo.stderr);
  assert.match(`${repo.stderr}`, /is the repo/);
  assert.equal(existsSync(path.join(root, "package.json")), true);
  const slash = stageCopy(source, "/", { BAO_STAGE_FORCE: "1" });
  assert.notEqual(slash.status, 0, slash.stderr);
  assert.match(`${slash.stderr}`, /filesystem root/);
});

test("sync refuses a foreign stage", () => {
  const source = tinySource();
  const stage = mkdtempSync(path.join(tmpdir(), "bao-sync-foreign-"));
  writeFileSync(path.join(stage, "canary.txt"), "keep");
  const result = spawnSync(process.execPath, [path.join(root, "scripts/stage-unpacked.mjs"), "sync", source, stage], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(stage, "canary.txt"), "utf8"), "keep");
});

test("stager --force replaces a foreign stage and prints the path", () => {
  const source = tinySource();
  const stage = mkdtempSync(path.join(tmpdir(), "bao-flag-force-"));
  writeFileSync(path.join(stage, "canary.txt"), "keep");
  const result = spawnSync(process.execPath, [path.join(root, "scripts/stage-unpacked.mjs"), "copy", source, stage, "--force"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(`${result.stderr}`, /Replacing /);
  assert.equal(existsSync(path.join(stage, "canary.txt")), false);
  assert.equal(existsSync(path.join(stage, ".bao-stage")), true);
});

test("quickstart installs packages before Playwright browsers", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const guide = readFileSync(path.join(root, "docs/agent-quickstart.md"), "utf8");
  for (const text of [readme, guide]) {
    const packages = text.indexOf("npm install");
    const browsers = text.indexOf("npx playwright install chromium");
    const tests = text.indexOf("npm test");
    assert.ok(packages >= 0 && browsers > packages && tests > browsers, text);
  }
});

test("stager refuses a forged stage marker and keeps the canary", () => {
  const source = tinySource();
  const stage = mkdtempSync(path.join(tmpdir(), "bao-forged-"));
  writeFileSync(path.join(stage, ".bao-stage"), "not-a-real-stage");
  writeFileSync(path.join(stage, "canary.txt"), "keep");
  const result = stageCopy(source, stage);
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(`${result.stderr}`, /refusing to replace/);
  assert.equal(readFileSync(path.join(stage, "canary.txt"), "utf8"), "keep");
  assert.equal(readFileSync(path.join(stage, ".bao-stage"), "utf8"), "not-a-real-stage");
});

test("stager refuses an extra file in a previous stage", () => {
  const source = tinySource();
  const stage = mkdtempSync(path.join(tmpdir(), "bao-extra-"));
  const first = stageCopy(source, stage);
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(path.join(stage, "canary.txt"), "keep");
  const again = stageCopy(source, stage);
  assert.notEqual(again.status, 0, again.stderr);
  assert.equal(readFileSync(path.join(stage, "canary.txt"), "utf8"), "keep");
});

test("stager refuses an empty directory inside the checkout", () => {
  const source = tinySource();
  const stage = path.join(root, `.stage-probe-${process.pid}`);
  mkdirSync(stage);
  try {
    const result = stageCopy(source, stage, { BAO_STAGE_FORCE: "1" });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(`${result.stderr}`, /inside the repo/);
    assert.equal(readdirSync(stage).length, 0);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

function unameStub(system: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-uname-"));
  const file = path.join(dir, "uname");
  writeFileSync(file, `#!/bin/sh\necho ${system}\n`);
  chmodSync(file, 0o755);
  return dir;
}

test("legacy installer splits the profile hint by uname and does not launch", () => {
  const source = tinySource();
  function run(system: string) {
    const home = mkdtempSync(path.join(tmpdir(), "bao-uname-home-"));
    const local = path.join(home, "Library/Application Support/Google/Chrome");
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(local, "Local State"), JSON.stringify({
      profile: { info_cache: { "Profile 1": { name: "dev" } } },
    }));
    const stage = mkdtempSync(path.join(tmpdir(), "bao-uname-stage-"));
    return spawnSync("bash", [path.join(root, "install-dev-legacy.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${unameStub(system)}:${process.env.PATH}`,
        BAO_SKIP_BUILD: "1",
        BAO_LEGACY_SOURCE: source,
        BAO_EXT_DIR: stage,
      },
    });
  }
  const linux = run("Linux");
  const linuxOut = `${linux.stdout}${linux.stderr}`;
  assert.equal(linux.status, 0, linuxOut);
  assert.match(linuxOut, /macOS-only/);
  assert.match(linuxOut, /Stage succeeded/);
  assert.doesNotMatch(linuxOut, /Profile 1/);
  const mac = run("Darwin");
  const macOut = `${mac.stdout}${mac.stderr}`;
  assert.equal(mac.status, 0, macOut);
  assert.match(macOut, /Reload it at chrome:\/\/extensions/);
  assert.doesNotMatch(macOut, /macOS-only/);
  assert.doesNotMatch(macOut, /Profile 1/);
  assert.doesNotMatch(macOut, /Could not find a Chrome profile/);
});

test("bao-mcp.sh exits before creating .bao-mcp when BAO_HOME is unset", () => {
  const env = { ...process.env };
  delete env.BAO_HOME;
  const result = spawnSync("sh", [path.join(root, "scripts/bao-mcp.sh")], {
    cwd: "/",
    encoding: "utf8",
    env,
    timeout: 5000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /BAO_HOME/);
  assert.doesNotMatch(output, /EACCES/);
});

test("quickstart points MCP at the checkout serve home and names dist/forceopen.js", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const quick = readFileSync(path.join(root, "docs/agent-quickstart.md"), "utf8");
  const extensionDoc = readFileSync(path.join(root, "docs/extension.md"), "utf8");
  const mcpRow = readme.split("\n").find((line) => line.startsWith("| MCP |"));
  assert.equal(typeof mcpRow, "string");
  assert.match(mcpRow || "", /BAO_HOME="\$HOME\/\.local\/share\/bao"/);
  assert.match(quick, /"BAO_HOME": "\/ABS\/to\/the\/serve\/home"/);
  assert.match(quick, /defaultHome/);
  assert.match(quick, /\.bao-mcp/);
  assert.match(quick, /dist\/forceopen\.js/);
  assert.doesNotMatch(quick, /pull request 133/);
  assert.doesNotMatch(quick, /Library\/Application Support\/bao/);
  assert.doesNotMatch(extensionDoc, /pull request 133/);
  assert.match(extensionDoc, /~\/\.local\/share\/bao\/extension-host/);
});
