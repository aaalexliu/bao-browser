import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCaptureUrl } from "../../src/app/capture-url";
import { fixtureStartValue, productWindowTitle, teachHome } from "../../src/app/views";

function macCompileSkip(): string | false {
  const cc = spawnSync("cc", ["--version"], { encoding: "utf8" });
  if (cc.error || cc.status !== 0) return "mac launch compile needs cc on PATH";
  return false;
}

test("node discovery and the single-instance lock", { skip: macCompileSkip() }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-launch-"));
  const bin = path.join(dir, "bao-launch-test");
  try {
    execFileSync("cc", [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      path.join(process.cwd(), "desktop/packaging/macos/bao-launch.c"),
      path.join(process.cwd(), "desktop/packaging/macos/bao-launch-test.c"),
      "-o",
      bin,
    ], { stdio: "inherit", timeout: 60_000 });
    const out = execFileSync(bin, { encoding: "utf8", timeout: 20_000 });
    assert.match(out, /^ok \d+\n$/);
    const count = Number(out.match(/^ok (\d+)/)?.[1]);
    assert.ok(count >= 40, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function launcherSkip(): string | false {
  if (process.platform !== "darwin") return "bao-mcp is the Mac app's launcher";
  return macCompileSkip();
}

const MACOS = path.join(process.cwd(), "desktop/packaging/macos");

/** Env for a launcher child: an empty HOME, no node on PATH, and this test's Node named in BAO_NODE. */
function launcherEnv(user: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: user, PATH: "/usr/bin:/bin", BAO_NODE: process.execPath };
  for (const key of Object.keys(env)) {
    if (key.startsWith("BAO_") && key !== "BAO_NODE") delete env[key];
  }
  return env;
}

test("bao-mcp becomes node cli.js mcp inside the bundle, with the app's browser and helper", { skip: launcherSkip() }, () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-mcp-exec-")));
  try {
    const resources = path.join(root, "Bao.app/Contents/Resources");
    const launcher = path.join(root, "Bao.app/Contents/MacOS/bao-mcp");
    const cli = path.join(resources, "bao/src/app/cli.js");
    const browser = path.join(resources, "Chromium.app/Contents/MacOS/Chromium");
    mkdirSync(path.dirname(launcher), { recursive: true });
    mkdirSync(path.dirname(browser), { recursive: true });
    mkdirSync(path.join(resources, "BaoOSHelper.app"));
    writeFileSync(browser, "#!/bin/sh\n");
    chmodSync(browser, 0o755);
    execFileSync("cc", ["-Wall", "-Wextra", "-Werror", path.join(MACOS, "bao-mcp.c"), path.join(MACOS, "bao-launch.c"), "-o", launcher], { stdio: "inherit", timeout: 60_000 });

    const missing = spawnSync(launcher, [], { env: launcherEnv(root), encoding: "utf8", timeout: 10_000 });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, `bao-mcp: ${cli} is missing. Install Bao again.\n`);

    // A stand-in server: one JSON line about how it was started, then stdin echoed back.
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, [
      "const seen = { argv: process.argv.slice(1), cwd: process.cwd(), browser: process.env.BAO_BROWSER, helper: process.env.BAO_OS_HELPER };",
      "process.stdout.write(JSON.stringify(seen) + '\\n');",
      "process.stdin.pipe(process.stdout);",
    ].join("\n"));
    const agentDir = path.join(root, "agent");
    mkdirSync(agentDir);
    const ran = spawnSync(launcher, ["--home", "/srv/bao lib"], { cwd: agentDir, env: launcherEnv(root), input: "{\"jsonrpc\":\"2.0\"}\n", encoding: "utf8", timeout: 10_000 });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stderr, "");
    const [first, echoed] = ran.stdout.split("\n");
    assert.deepEqual(JSON.parse(first || "{}"), {
      argv: [cli, "mcp", "--home", "/srv/bao lib"],
      cwd: path.join(resources, "bao"),
      browser,
      helper: path.join(resources, "BaoOSHelper.app"),
    });
    assert.equal(echoed, "{\"jsonrpc\":\"2.0\"}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bao-mcp built into a Bao.app answers MCP from the app's library, not the agent's directory", { skip: launcherSkip() }, () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-mcp-app-")));
  try {
    // The staged layout: Contents/Resources/bao/src is the compiled desktop/src.
    const app = path.join(root, "Bao.app");
    mkdirSync(path.join(app, "Contents/Resources"), { recursive: true });
    symlinkSync(path.join(process.cwd(), "desktop/dist/desktop"), path.join(app, "Contents/Resources/bao"));
    // The build script runs node itself. The launcher it proves gets PATH without node.
    const env = { ...launcherEnv(root), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const out = execFileSync("bash", [path.join(MACOS, "build-mcp-launcher.sh"), app], { cwd: root, env, encoding: "utf8", timeout: 90_000 });
    assert.match(out, /^MCP_LAUNCHER ok .*Bao\.app\/Contents\/MacOS\/bao-mcp initialize \d+ ms, \d+ tools\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the product window title is Bao and the capture field hides the listen address", () => {
  assert.equal(productWindowTitle(), "Bao");
  assert.equal(fixtureStartValue(), "/fixture");
  assert.equal(fixtureStartValue().includes("127.0.0.1"), false);
  assert.equal(teachHome([]).includes("127.0.0.1"), false);
  assert.match(teachHome([]), /value="\/fixture"/);
  const client = readFileSync(path.join(process.cwd(), "desktop/src/app/client.ts"), "utf8");
  assert.match(client, /productWindowTitle\(\)/);
  assert.equal(client.includes("location.origin"), false);
  const html = readFileSync(path.join(process.cwd(), "desktop/src/app/public/index.html"), "utf8");
  assert.match(html, /<title>Bao<\/title>/);
});

test("a path capture target stays on this app", () => {
  assert.equal(resolveCaptureUrl("/fixture", 4787), "http://127.0.0.1:4787/fixture");
  assert.equal(resolveCaptureUrl("", 4787), "http://127.0.0.1:4787/fixture");
  assert.equal(resolveCaptureUrl("  /secure", 9), "http://127.0.0.1:9/secure");
  assert.equal(resolveCaptureUrl("https://example.com/in", 4787), "https://example.com/in");
  assert.equal(resolveCaptureUrl("//evil.example/fixture", 4787), "//evil.example/fixture");
});

test("the Mac test card does not send anyone to the listen address", () => {
  const card = readFileSync(path.join(process.cwd(), "docs/mac-test.md"), "utf8");
  const lines = card.split("\n");
  const count = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  assert.ok(count <= 40, `mac-test.md is ${count} lines`);
  assert.equal(card.includes("127.0.0.1"), false);
  assert.equal(card.includes("4787"), false);
  assert.equal(card.includes("BAO_NODE"), false);
  assert.equal(card.includes("SCContentFilter"), false);
  assert.equal(card.includes("AXSize"), false);
  assert.equal(card.includes("CDP"), false);
  assert.match(card, /mac-build\.md/);
  assert.match(card, /helper ok/);
  assert.match(card, /live Chrome ready/);
  assert.match(card, /window capture ready/);
  assert.equal(card.includes("allow Accessibility and Screen Recording"), false);
  const guide = readFileSync(path.join(process.cwd(), "docs/v1.md"), "utf8");
  assert.equal(guide.includes("Open `http://127.0.0.1:4787`"), false);
});
