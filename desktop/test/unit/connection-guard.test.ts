import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CONNECTION_GUARD, laneChildEnv } from "../runtime";

// Loaded before the guard, so the guard wraps it. It stands in for the network and the disk:
// a 9222 connection or a read under the real Chrome folder that gets past the guard is recorded, never made.
const FLOOR = `
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const home = os.userInfo().homedir;
const roots = [
  path.join(home, "Library", "Application Support", "Google"),
  path.join(home, "Library", "Application Support", "Chromium"),
  path.join(home, ".config", "google-chrome"),
  path.join(home, ".config", "chromium"),
];
function owner(file) {
  const resolved = path.resolve(String(file));
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = Number(first && typeof first === "object" ? first.port : first);
  if (port === 9200 + 22) {
    process.stdout.write("REACHED 9222\\n");
    process.nextTick(() => this.destroy(Object.assign(new Error("floor"), { code: "ECONNREFUSED" })));
    return this;
  }
  return connect.apply(this, args);
};
for (const [ownerFs, name] of [[fs, "readFileSync"], [fs, "readFile"], [fs.promises, "readFile"], [fs, "readdirSync"], [fs, "readdir"], [fs.promises, "readdir"]]) {
  const read = ownerFs[name];
  ownerFs[name] = function (file, ...rest) {
    if (!owner(file)) return read.call(this, file, ...rest);
    process.stdout.write("REACHED " + file + "\\n");
    const error = Object.assign(new Error("floor"), { code: "ENOENT" });
    const callback = rest[rest.length - 1];
    if (typeof callback === "function") {
      process.nextTick(() => callback(error));
      return;
    }
    throw error;
  };
}
`;

const PROBE = `
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const settle = (promise) => promise.then(() => "ok", (error) => error.code || error.cause?.code || error.message);
const home = os.userInfo().homedir;
const daily = path.join(home, "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort");
const linux = path.join(home, ".config", "google-chrome", "DevToolsActivePort");
(async () => {
  const own = http.createServer((req, res) => res.end("own")).listen(0, "127.0.0.1");
  await new Promise((resolve) => own.once("listening", resolve));
  const port = own.address().port;
  const rows = {
    netHost: await settle(new Promise((resolve, reject) => net.connect(9222, "127.0.0.1").once("connect", resolve).once("error", reject))),
    netOptions: await settle(new Promise((resolve, reject) => net.connect({ port: 9222 }).once("connect", resolve).once("error", reject))),
    fetch: await settle(fetch("http://localhost:9222/json/version")),
    http: await settle(new Promise((resolve, reject) => http.get("http://[::1]:9222/json", resolve).once("error", reject))),
    webSocket: await settle(new Promise((resolve, reject) => {
      const socket = new WebSocket("ws://127.0.0.1:9222/devtools/browser/x");
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("websocket refused"));
    })),
    readPromise: await settle(fs.promises.readFile(daily, "utf8")),
    readCallback: await settle(new Promise((resolve, reject) => fs.readFile(linux, (error) => error ? reject(error) : resolve()))),
    readSync: await settle(Promise.resolve().then(() => fs.readFileSync(daily))),
    spawn: await settle(Promise.resolve().then(() => require("node:child_process").execFile(process.execPath, ["-e", "", "--cdp", "ws://127.0.0.1:9222/devtools/browser/x"]))),
    spawnSync: await settle(Promise.resolve().then(() => require("node:child_process").spawnSync("/bin/echo", ["--remote-debugging-port=9222"]))),
    execFileSync: await settle(Promise.resolve().then(() => require("node:child_process").execFileSync("/bin/echo", ["9222"]))),
    execSync: await settle(Promise.resolve().then(() => require("node:child_process").execSync("/bin/echo :9222"))),
    readFolder: await settle(Promise.resolve().then(() => fs.readdirSync(path.dirname(daily)))),
    readState: await settle(Promise.resolve().then(() => fs.readFileSync(path.join(path.dirname(daily), "Local State")))),
    own: await settle(fetch("http://127.0.0.1:" + port + "/").then((response) => response.text())),
  };
  own.close();
  process.stdout.write("ROWS " + JSON.stringify(rows) + "\\n");
})();
`;

function runGuarded() {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-connection-guard-"));
  const floor = path.join(dir, "floor.cjs");
  const probe = path.join(dir, "probe.cjs");
  writeFileSync(floor, FLOOR);
  writeFileSync(probe, PROBE);
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(floor)} --require ${JSON.stringify(CONNECTION_GUARD)}` };
  return spawnSync(process.execPath, [probe], { env, encoding: "utf8", timeout: 30_000 });
}

test("the guard refuses every route to the owner's Chrome port and folder, and fails the process", () => {
  const result = runGuarded();
  assert.doesNotMatch(result.stdout, /REACHED/);
  const rows = JSON.parse(/^ROWS (.*)$/m.exec(result.stdout)?.[1] ?? "null") as Record<string, string>;
  assert.deepEqual(rows, {
    netHost: "EOWNERCHROME",
    netOptions: "EOWNERCHROME",
    fetch: "EOWNERCHROME",
    http: "EOWNERCHROME",
    webSocket: "websocket refused",
    readPromise: "EOWNERCHROME",
    readCallback: "EOWNERCHROME",
    readSync: "EOWNERCHROME",
    spawn: "EOWNERCHROME",
    spawnSync: "EOWNERCHROME",
    execFileSync: "EOWNERCHROME",
    execSync: "EOWNERCHROME",
    readFolder: "EOWNERCHROME",
    readState: "EOWNERCHROME",
    own: "ok",
  });
  assert.match(result.stderr, /connection-guard: a test tried to connect to 127\.0\.0\.1:9222/);
  assert.match(result.stderr, /connection-guard: a test tried to read .*DevToolsActivePort/);
  assert.match(result.stderr, /connection-guard: a test tried to start .* with ws:\/\/127\.0\.0\.1:9222\/devtools\/browser\/x/);
  assert.match(result.stderr, /connection-guard: a test tried to start \/bin\/echo with --remote-debugging-port=9222/);
  assert.match(result.stderr, /connection-guard: a test tried to start \/bin\/echo with 9222/);
  assert.match(result.stderr, /connection-guard: a test tried to start a command with \/bin\/echo :9222/);
  assert.equal(result.status, 1, "a refusal fails the test process even when the caller swallows the error");
});

test("a node child with NODE_OPTIONS cleared still refuses the owner's Chrome port", () => {
  const script = [
    'const net = require("node:net");',
    'if (!globalThis[Symbol.for("bao.connection-guard")]) { process.stdout.write("NO GUARD\\n"); process.exit(0); }',
    "const port = 9200 + 22;",
    "const socket = net.connect(port, \"127.0.0.1\");",
    "socket.once(\"error\", (error) => { process.stdout.write((error.code || \"\") + \"\\n\"); process.exit(0); });",
    "setTimeout(() => process.exit(2), 2000);",
  ].join("\n");
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.stdout.trim(), "EOWNERCHROME", result.stderr);
});

test("a headed browser fails outside the live lane and is allowed in it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-headed-guard-"));
  const chrome = path.join(dir, "chrome");
  writeFileSync(chrome, "#!/bin/sh\nexit 0\n");
  chmodSync(chrome, 0o755);
  const probe = [
    'const { spawnSync } = require("node:child_process");',
    "const chrome = process.env.CHROME;",
    "function once(args) {",
    "  try {",
    "    const result = spawnSync(chrome, args, { encoding: \"utf8\" });",
    "    return String(result.status);",
    "  } catch (error) {",
    "    return error.code || error.message;",
    "  }",
    "}",
    'process.stdout.write("headed " + once(["about:blank"]) + "\\n");',
    'process.stdout.write("quiet " + once(["--headless=new", "about:blank"]) + "\\n");',
  ].join("\n");
  const base = { ...process.env, CHROME: chrome, NODE_OPTIONS: `--require ${JSON.stringify(CONNECTION_GUARD)}` };
  const hermetic = spawnSync(process.execPath, ["-e", probe], { env: { ...base, BAO_LANE: "hermetic" }, encoding: "utf8", timeout: 15_000 });
  assert.match(hermetic.stdout, /headed EOWNERCHROME/);
  assert.match(hermetic.stdout, /quiet 0/, hermetic.stderr);
  const live = spawnSync(process.execPath, ["-e", probe], { env: { ...base, BAO_LANE: "live" }, encoding: "utf8", timeout: 15_000 });
  assert.match(live.stdout, /headed 0/, live.stderr);
  assert.match(live.stdout, /quiet 0/, live.stderr);
});

test("both lanes preload the guard once and keep the caller's NODE_OPTIONS", () => {
  const pin = process.execPath;
  for (const lane of ["hermetic", "live"] as const) {
    const env = laneChildEnv(lane, { NODE_OPTIONS: "--max-old-space-size=512" }, () => pin);
    const preload = `--require ${JSON.stringify(CONNECTION_GUARD)}`;
    assert.equal(env.NODE_OPTIONS, `--max-old-space-size=512 ${preload}`);
    assert.equal(laneChildEnv(lane, env, () => pin).NODE_OPTIONS, env.NODE_OPTIONS);
  }
});
