import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
