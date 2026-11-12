import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scaledMs } from "../runtime";

const REPO = process.cwd();
const INSTALL_SH = path.join(REPO, "installer/install.sh");
const skip = process.platform !== "darwin" ? "the installer places a signed Mac app" : false;

function fakeApp(dir: string, version: string): void {
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
  for (const [name, body] of Object.entries({ bao: "exit 0", "bao-mcp": "exit 0", "bao-cli": "exit 0" })) {
    writeFileSync(path.join(macos, name), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(macos, name), 0o755);
  }
  spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", path.join(macos, "bao-cli"), path.join(macos, "bao-mcp")], { stdio: "ignore" });
  spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
}

function versionOf(app: string): string {
  return spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" }).stdout.trim();
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(cmd, args, { env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), scaledMs(60_000));
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("docs and the installer name the same newest-release command", () => {
  const script = readFileSync(INSTALL_SH, "utf8");
  const bin = readFileSync(path.join(REPO, "installer/bin/bao-browser.mjs"), "utf8");
  const releaseJson = "https://github.com/aaalexliu/bao-browser/releases/latest/download/release.json";
  const installSh = "https://raw.githubusercontent.com/aaalexliu/bao-browser/main/installer/install.sh";
  assert.ok(script.includes(releaseJson));
  assert.ok(bin.includes(releaseJson));
  assert.ok(bin.includes(installSh));
  for (const file of ["README.md", "installer/README.md", "docs/release.md"]) {
    assert.ok(readFileSync(path.join(REPO, file), "utf8").includes(installSh), file);
  }
});

test("the latest tarball URL reinstalls the cached release, and install.sh installs the release the redirect now names", { skip, timeout: scaledMs(120_000) }, async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-installer-latest-")));
  const home = path.join(root, "home");
  const apps = path.join(root, "Applications");
  const cache = path.join(root, "npm-cache");
  const packs = path.join(root, "packs");
  mkdirSync(home);
  mkdirSync(apps);
  mkdirSync(cache);
  mkdirSync(packs);
  const files = new Map<string, Buffer>();
  let latest = "0.2.1";
  const hits: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    hits.push(url.pathname);
    if (url.pathname === "/releases/latest/download/bao-browser.tgz" || url.pathname === "/releases/latest/download/release.json") {
      res.writeHead(302, { Location: `/releases/download/v${latest}/${path.basename(url.pathname)}` });
      res.end();
      return;
    }
    const body = files.get(url.pathname);
    if (!body) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    res.writeHead(200, { "Content-Length": body.length });
    res.end(body);
  });
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const origin = `http://127.0.0.1:${address.port}`;

  for (const version of ["0.2.1", "0.3.0"]) {
    const build = path.join(root, `build-${version}`);
    fakeApp(build, version);
    const name = `Bao-${version}-darwin-arm64.zip`;
    const zip = path.join(packs, name);
    const packed = spawnSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(build, "Bao.app"), zip], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const release = {
      version,
      platforms: {
        "darwin-arm64": {
          url: `${origin}/releases/download/v${version}/${name}`,
          size: statSync(zip).size,
          sha256: createHash("sha256").update(readFileSync(zip)).digest("hex"),
        },
      },
    };
    const releasePath = path.join(packs, `release-${version}.json`);
    writeFileSync(releasePath, `${JSON.stringify(release)}\n`);
    const out = path.join(packs, "out");
    mkdirSync(out, { recursive: true });
    const tarball = spawnSync("bash", [path.join(REPO, "desktop/packaging/macos/pack-installer.sh"), releasePath, out], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, npm_config_cache: cache, npm_config_update_notifier: "false" },
    });
    assert.equal(tarball.status, 0, tarball.stderr || tarball.stdout);
    const wrote = /WROTE (.+)$/m.exec(tarball.stdout)?.[1];
    assert.ok(wrote, tarball.stdout);
    files.set(`/releases/download/v${version}/bao-browser.tgz`, readFileSync(wrote));
    files.set(`/releases/download/v${version}/${name}`, readFileSync(zip));
    files.set(`/releases/download/v${version}/release.json`, readFileSync(releasePath));
  }

  const app = path.join(apps, "Bao.app");
  const nodeBin = path.dirname(process.execPath);
  const baseEnv: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${nodeBin}:/opt/homebrew/bin:/usr/bin:/bin`,
    npm_config_cache: cache,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    BAO_INSTALLER_LATEST: `${origin}/releases/download/v0.2.1/release.json`,
  };
  const latestUrl = `${origin}/releases/latest/download/bao-browser.tgz`;
  const first = await run("npx", ["--yes", latestUrl, "--dir", apps, "--none"], baseEnv);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(versionOf(app), "0.2.1");
  latest = "0.3.0";
  const again = await run("npx", ["--yes", latestUrl, "--dir", apps, "--none"], baseEnv);
  assert.equal(again.status, 0, `${again.stderr}\n${hits.join(" ")}`);
  assert.match(again.stdout, /Installing Bao 0\.2\.1 over 0\.2\.1 at /);
  assert.equal(versionOf(app), "0.2.1");
  const updated = await run("sh", [INSTALL_SH, "--dir", apps, "--none"], {
    ...baseEnv,
    BAO_INSTALLER_LATEST: `${origin}/releases/latest/download/release.json`,
  });
  assert.equal(updated.status, 0, `${updated.stderr}\n${updated.stdout}\n${hits.join(" ")}`);
  assert.equal(versionOf(app), "0.3.0");
  assert.match(updated.stdout, /Installing Bao 0\.3\.0 over 0\.2\.1 at /);
});
