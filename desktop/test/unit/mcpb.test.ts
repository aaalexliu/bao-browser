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
      compatibility: { platforms: string[]; runtimes: { node: string } };
    };
    assert.equal(manifest.server.type, "node");
    assert.deepEqual(manifest.compatibility.platforms, ["darwin"]);
    assert.equal(manifest.compatibility.runtimes.node, ">=24");
    assert.deepEqual(manifest.server.mcp_config, { command: "node", args: ["${__dirname}/server.cjs", "${user_config.bao_app}"] });
    const entry = spawnSync("/usr/bin/unzip", ["-p", output, manifest.server.entry_point], { encoding: "utf8" });
    assert.equal(entry.status, 0, entry.stderr);
    assert.equal(entry.stdout, readFileSync(source, "utf8"));
    assert.doesNotMatch(manifestResult.stdout, /alwaysAllow|auto.?approv|default_tools_approval_mode/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("MCPB forwards stdio, passes Node 24 to the app launcher and reports missing apps", () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-mcpb-relay-")));
  try {
    const app = path.join(home, "Bao fixture.app");
    const launcher = path.join(app, "Contents/MacOS/bao-mcp");
    mkdirSync(path.dirname(launcher), { recursive: true });
    writeFileSync(launcher, `#!${process.execPath}\nif (process.env.BAO_NODE !== process.execPath) process.exit(9);\nprocess.stdin.pipe(process.stdout);\nprocess.stderr.write("launcher fixture\\n");\n`);
    chmodSync(launcher, 0o700);
    const input = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
    const env = { ...process.env, HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" };
    const relayed = spawnSync(process.execPath, [source, app], { cwd: home, env, input, encoding: "utf8", timeout: 10_000 });
    assert.equal(relayed.status, 0, relayed.stderr);
    assert.equal(relayed.stdout, input);
    assert.equal(relayed.stderr, 'launcher fixture\n');
    const missing = spawnSync(process.execPath, [source, path.join(home, "Missing.app")], { cwd: home, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /Install Bao.app.*choose its directory/);
    const invalid = spawnSync(process.execPath, [source, "relative.app"], { cwd: home, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Choose the installed Bao.app/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
