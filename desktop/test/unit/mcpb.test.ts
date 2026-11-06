import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "../../../../..");
const source = path.join(root, "desktop/packaging/mcpb/server.cjs");

test("official MCPB tooling validates and packs the install artifact", { timeout: 30_000 }, () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-mcpb-test-")));
  try {
    const output = path.join(home, "bao.mcpb");
    const built = spawnSync(process.execPath, [path.join(root, "desktop/packaging/build-mcpb.mjs"), output], {
      cwd: home, env: { ...process.env, HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" }, encoding: "utf8", timeout: 25_000,
    });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    assert.match(built.stdout, /Manifest schema validation passes/);
    const manifestResult = spawnSync("/usr/bin/unzip", ["-p", output, "manifest.json"], { encoding: "utf8" });
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifest = JSON.parse(manifestResult.stdout) as {
      server: { type: string; entry_point: string; mcp_config: { command: string; args: string[] } };
      compatibility: { platforms: string[]; runtimes?: unknown };
      user_config?: Record<string, unknown>;
    };
    assert.equal(manifest.server.type, "node");
    assert.deepEqual(manifest.compatibility.platforms, ["darwin"]);
    assert.equal(manifest.compatibility.runtimes, undefined);
    assert.deepEqual(manifest.server.mcp_config, { command: "node", args: ["${__dirname}/server.cjs"] });
    const entry = spawnSync("/usr/bin/unzip", ["-p", output, manifest.server.entry_point], { encoding: "utf8" });
    assert.equal(entry.status, 0, entry.stderr);
    assert.equal(entry.stdout, readFileSync(source, "utf8"));
    const allowedKeys = new Set(["manifest_version", "name", "display_name", "version", "description", "author", "server", "tools_generated", "compatibility"]);
    for (const key of Object.keys(manifest)) assert.ok(allowedKeys.has(key), key);
    assert.equal(manifest.user_config, undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("MCPB forwards stdio, hints the relay runtime and reports missing apps", () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-mcpb-relay-")));
  try {
    const app = path.join(home, "Bao fixture.app");
    const launcher = path.join(app, "Contents/MacOS/bao-mcp");
    mkdirSync(path.dirname(launcher), { recursive: true });
    writeFileSync(launcher, `#!${process.execPath}\nif (process.env.BAO_NODE !== process.execPath) process.exit(9);\nprocess.stdin.pipe(process.stdout);\nprocess.stderr.write("launcher fixture\\n");\n`);
    chmodSync(launcher, 0o700);
    const input = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
    const env = { ...process.env, HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" };
    const preload = path.join(home, "spawn.cjs");
    writeFileSync(preload, `const cp = require("node:child_process");
const assert = require("node:assert/strict");
const spawn = cp.spawn;
cp.spawn = (command, args, options) => {
  assert.equal(command, "/Applications/Bao.app/Contents/MacOS/bao-mcp");
  return spawn(${JSON.stringify(launcher)}, args, options);
};\n`);
    const relayed = spawnSync(process.execPath, ["--require", preload, source], { cwd: home, env, input, encoding: "utf8", timeout: 10_000 });
    assert.equal(relayed.status, 0, relayed.stderr);
    assert.equal(relayed.stdout, input);
    assert.equal(relayed.stderr, 'launcher fixture\n');
    rmSync(launcher);
    const missing = spawnSync(process.execPath, ["--require", preload, source], { cwd: home, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "Cannot start Bao. Install Bao.app.\n");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
