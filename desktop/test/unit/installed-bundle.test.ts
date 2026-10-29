import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appHostScript, installNativeHost } from "../../src/extension/install-host";

const localRequire = createRequire(__filename);
const { acceptHelper, parseCodesign } = localRequire(path.join(process.cwd(), "desktop/packaging/helper-identity.js")) as {
  acceptHelper: (report: {
    exists: boolean;
    isBundle: boolean;
    adhoc: boolean;
    identifier: string;
    authorities: string[];
    designated: string;
  }, identity: string, certHash: string) => { ok: boolean; reason: string };
  parseCodesign: (verifyText: string, requirementText: string) => {
    identifier: string;
    authorities: string[];
    adhoc: boolean;
    cdhash: string;
    designated: string;
  };
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
});

test("the native host wrapper points at the script inside Resources", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-resources-"));
  const ext = path.join(root, "Resources", "bao", "src", "extension");
  mkdirSync(ext, { recursive: true });
  const script = path.join(ext, "native-host.js");
  writeFileSync(script, "/* host */\n");
  assert.equal(appHostScript(ext), script);
  assert.equal(appHostScript(root), undefined);
  const home = mkdtempSync(path.join(tmpdir(), "bao-host-home-"));
  const installed = installNativeHost({
    home,
    socketPath: path.join(home, "extension-host", "bridge.sock"),
    tokenPath: path.join(home, "extension-host", "token"),
    hostScript: script,
  });
  const wrapper = readFileSync(installed.wrapper, "utf8");
  assert.match(wrapper, new RegExp(script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(wrapper.includes("/checkout/desktop"), false);
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("an installed bundle serves extension settings and imports synthetic localStorage", { timeout: 180_000 }, async () => {
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
