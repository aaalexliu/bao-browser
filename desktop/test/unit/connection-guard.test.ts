import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CONNECTION_GUARD, laneChildEnv } from "../runtime";

// Loaded before the guard, so the guard wraps it. It stands in for the network and the disk:
// a 9222 connection or a DevToolsActivePort read that gets past the guard is recorded, never made.
const FLOOR = `
const fs = require("node:fs");
const net = require("node:net");
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = Number(first && typeof first === "object" ? first.port : first);
  if (port === 9222) {
    process.stdout.write("REACHED 9222\\n");
    process.nextTick(() => this.destroy(Object.assign(new Error("floor"), { code: "ECONNREFUSED" })));
    return this;
  }
  return connect.apply(this, args);
};
for (const [owner, name] of [[fs, "readFileSync"], [fs, "readFile"], [fs.promises, "readFile"]]) {
  const read = owner[name];
  owner[name] = function (file, ...rest) {
    if (!String(file).endsWith("DevToolsActivePort")) return read.call(this, file, ...rest);
    process.stdout.write("REACHED " + file + "\\n");
    throw Object.assign(new Error("floor"), { code: "ENOENT" });
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
    own: await settle(fetch("http://127.0.0.1:" + port + "/").then((response) => response.text())),
  };
  own.close();
  process.stdout.write("ROWS " + JSON.stringify(rows) + "\\n");
})();
`;

function runGuarded() {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-connection-guard-"));
  const floor = path.join(dir, "floor.cjs");
  writeFileSync(floor, FLOOR);
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(floor)} --require ${JSON.stringify(CONNECTION_GUARD)}` };
  return spawnSync(process.execPath, ["-e", PROBE], { env, encoding: "utf8", timeout: 30_000 });
}

test("the guard refuses every route to the owner's Chrome port and its DevToolsActivePort, and fails the process", () => {
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
    own: "ok",
  });
  assert.match(result.stderr, /connection-guard: a test tried to connect to 127\.0\.0\.1:9222/);
  assert.match(result.stderr, /connection-guard: a test tried to read .*DevToolsActivePort/);
  assert.match(result.stderr, /connection-guard: a test tried to start .* with ws:\/\/127\.0\.0\.1:9222\/devtools\/browser\/x/);
  assert.equal(result.status, 1, "a refusal fails the test process even when the caller swallows the error");
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
