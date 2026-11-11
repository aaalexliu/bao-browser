import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dist = path.resolve(__dirname, "../../..");
const root = path.resolve(dist, "../..");

function scratchEnv(scratch: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = path.join(scratch, "home");
  mkdirSync(home, { recursive: true });
  return { ...process.env, ...env, HOME: home, BAO_HOME: path.join(scratch, "library"), BAO_HEAL_CURSOR_ACCOUNT: "0" };
}

async function serverInfo(cli: string, scratch: string, env: NodeJS.ProcessEnv = {}): Promise<{ name: string; version: string }> {
  const child = spawn(process.execPath, [cli, "mcp"], { cwd: scratch, env: scratchEnv(scratch, env), stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { errors += bytes.toString(); });
  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const [code] = await once(child, "exit") as [number | null];
  assert.equal(code, 0, errors);
  return (JSON.parse(output.split("\n")[0]) as { result: { serverInfo: { name: string; version: string } } }).result.serverInfo;
}

function cliVersion(cli: string, scratch: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [cli, "--version"], { cwd: scratch, env: scratchEnv(scratch, env), encoding: "utf8" }).trim();
}

function appPlist(scratch: string): string {
  return path.join(scratch, "Bao.app", "Contents", "Info.plist");
}

function insertVersion(plist: string, version: string): void {
  if (process.platform === "darwin") {
    execFileSync("/usr/bin/plutil", ["-replace", "CFBundleShortVersionString", "-string", version, plist]);
    return;
  }
  const key = `  <key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n`;
  const text = readFileSync(plist, "utf8").replace(/\s*<key>CFBundleShortVersionString<\/key>\s*<string>[^<]*<\/string>/, "");
  const end = text.lastIndexOf("</dict>");
  if (end < 0) throw new Error("plist has no root dict");
  writeFileSync(plist, `${text.slice(0, end)}${key}${text.slice(end)}`);
}

function removeVersion(plist: string): void {
  if (process.platform === "darwin") {
    execFileSync("/usr/bin/plutil", ["-replace", "CFBundleShortVersionString", "-string", "0.0.0", plist]);
    execFileSync("/usr/bin/plutil", ["-remove", "CFBundleShortVersionString", plist]);
    return;
  }
  writeFileSync(plist, readFileSync(plist, "utf8").replace(/\s*<key>CFBundleShortVersionString<\/key>\s*<string>[^<]*<\/string>/, ""));
}

async function liveServerInfo(cli: string, scratch: string, env: NodeJS.ProcessEnv = {}): Promise<{ name: string; version: string }> {
  const { testChromium } = await import("../../src/test-browser.js");
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>fixture</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const child = spawn(process.execPath, [cli, "mcp"], {
    cwd: scratch,
    env: {
      ...scratchEnv(scratch, env),
      BAO_MCP_LIVE: "1",
      BAO_HEADED: "0",
      BAO_FIXTURE_URL: `http://127.0.0.1:${address.port}/`,
      BAO_TEST_BROWSER: testChromium.executablePath(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { errors += bytes.toString(); });
  const exited = once(child, "exit");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  try {
    const line = await firstLine(child, () => output, () => errors);
    child.stdin.end();
    const [code] = await exited as [number | null];
    assert.equal(code, 0, errors);
    return (JSON.parse(line) as { result: { serverInfo: { name: string; version: string } } }).result.serverInfo;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function firstLine(child: ChildProcess, output: () => string, errors: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`live MCP initialize timed out\n${errors()}`)), 45_000);
    const onData = (): void => {
      const line = output().split("\n")[0];
      if (!line) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolve(line);
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`live MCP exited ${code} before initialize\n${errors()}\n${output()}`));
    });
  });
}

function stageApp(scratch: string, plist?: string): string {
  const contents = path.join(scratch, "Bao.app", "Contents");
  const resources = path.join(contents, "Resources");
  cpSync(path.join(dist, "desktop", "src"), path.join(resources, "bao", "src"), { recursive: true });
  for (const name of readdirSync(path.join(root, "desktop", "src")).filter((file) => file.endsWith(".cjs"))) {
    cpSync(path.join(root, "desktop", "src", name), path.join(resources, "bao", "src", name));
  }
  for (const name of ["shared", "extension", "web"]) cpSync(path.join(dist, name), path.join(resources, name), { recursive: true });
  if (plist !== undefined) writeFileSync(path.join(contents, "Info.plist"), plist);
  return path.join(resources, "bao", "src", "app", "cli.js");
}

const template = readFileSync(path.join(root, "desktop", "packaging", "macos", "Info.plist"), "utf8");
const appEnv = { NODE_PATH: path.join(root, "node_modules") };

test("a Bao.app stamped by package-app.sh reports the package.json version in Info.plist, bao --version, and MCP initialize", {
  skip: process.platform !== "darwin" ? "stamp-version.sh uses macOS plutil" : false,
}, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-mcp-version-"));
  try {
    const cli = stageApp(scratch, template);
    const plist = path.join(scratch, "Bao.app", "Contents", "Info.plist");
    execFileSync("bash", [path.join(root, "desktop", "packaging", "macos", "stamp-version.sh"), plist]);
    const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
    for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
      assert.equal(execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8" }).trim(), version);
    }
    assert.equal(cliVersion(cli, scratch, appEnv), version);
    assert.deepEqual(await serverInfo(cli, scratch, appEnv), { name: "bao", version });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a Bao.app reports the version in its Info.plist", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-mcp-version-"));
  try {
    const cli = stageApp(scratch, template);
    const plist = appPlist(scratch);
    insertVersion(plist, "9.8.7");
    assert.equal(cliVersion(cli, scratch, appEnv), "9.8.7");
    assert.deepEqual(await serverInfo(cli, scratch, appEnv), { name: "bao", version: "9.8.7" });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("the eval live MCP server reports the Info.plist version", { timeout: 60_000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-mcp-version-"));
  try {
    const cli = stageApp(scratch, template);
    insertVersion(appPlist(scratch), "9.8.7");
    assert.deepEqual(await liveServerInfo(cli, scratch, appEnv), { name: "bao", version: "9.8.7" });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a Bao.app whose Info.plist lacks the version still answers with version unknown", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-mcp-version-"));
  try {
    const cli = stageApp(scratch, template);
    removeVersion(appPlist(scratch));
    assert.equal(cliVersion(cli, scratch, appEnv), "unknown");
    assert.deepEqual(await serverInfo(cli, scratch, appEnv), { name: "bao", version: "unknown" });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a Bao.app with no Info.plist still answers initialize with version unknown", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-mcp-version-"));
  try {
    assert.deepEqual(await serverInfo(stageApp(scratch), scratch, appEnv), { name: "bao", version: "unknown" });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("a checkout reports version dev", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-mcp-version-"));
  try {
    const cli = path.join(dist, "desktop", "src", "app", "cli.js");
    assert.equal(cliVersion(cli, scratch), "dev");
    assert.deepEqual(await serverInfo(cli, scratch), { name: "bao", version: "dev" });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
