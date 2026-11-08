import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dist = path.resolve(__dirname, "../../..");
const root = path.resolve(dist, "../..");

async function serverInfo(cli: string, scratch: string, env: NodeJS.ProcessEnv = {}): Promise<{ name: string; version: string }> {
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const child = spawn(process.execPath, [cli, "mcp"], {
    cwd: scratch,
    env: { ...process.env, ...env, HOME: home, BAO_HOME: path.join(scratch, "library"), BAO_HEAL_CURSOR_ACCOUNT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { errors += bytes.toString(); });
  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const [code] = await once(child, "exit") as [number | null];
  assert.equal(code, 0, errors);
  return (JSON.parse(output.split("\n")[0]) as { result: { serverInfo: { name: string; version: string } } }).result.serverInfo;
}

test("a Bao.app reports the version package-app.sh stamped into its Info.plist", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-mcp-version-"));
  try {
    const contents = path.join(scratch, "Bao.app", "Contents");
    const resources = path.join(contents, "Resources");
    cpSync(path.join(dist, "desktop", "src"), path.join(resources, "bao", "src"), { recursive: true });
    for (const name of readdirSync(path.join(root, "desktop", "src")).filter((file) => file.endsWith(".cjs"))) {
      cpSync(path.join(root, "desktop", "src", name), path.join(resources, "bao", "src", name));
    }
    for (const name of ["shared", "extension", "web"]) cpSync(path.join(dist, name), path.join(resources, name), { recursive: true });
    const template = readFileSync(path.join(root, "desktop", "packaging", "macos", "Info.plist"), "utf8");
    const stamped = template.replace(/<key>CFBundleShortVersionString<\/key><string>[^<]+<\/string>/,
      "<key>CFBundleShortVersionString</key>\n\t<string>9.8.7</string>");
    assert.notEqual(stamped, template);
    writeFileSync(path.join(contents, "Info.plist"), stamped);

    const info = await serverInfo(path.join(resources, "bao", "src", "app", "cli.js"), scratch, { NODE_PATH: path.join(root, "node_modules") });
    assert.deepEqual(info, { name: "bao", version: "9.8.7" });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a checkout reports version dev", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-mcp-version-"));
  try {
    assert.deepEqual(await serverInfo(path.join(dist, "desktop", "src", "app", "cli.js"), scratch), { name: "bao", version: "dev" });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
