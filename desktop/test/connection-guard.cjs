// Preloaded with --require into every test process by laneChildEnv in runtime.ts.
// The owner's Chrome listens for remote debugging on 127.0.0.1:9222, and every connection
// there raises Chrome's "Allow remote debugging?" sheet on his screen. A test that reaches
// it, reads the daily Chrome's DevToolsActivePort to find it, or hands its address to a
// child such as the native agent-browser, fails here instead.
const { ChildProcess } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const OWNER_CHROME_PORT = 9222;
const OWNER_CHROME_URL = /(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]):9222(?!\d)/;

const home = os.userInfo().homedir;
const chromeRoots = [
  path.join(home, "Library", "Application Support", "Google"),
  path.join(home, "Library", "Application Support", "Chromium"),
  path.join(home, ".config", "google-chrome"),
  path.join(home, ".config", "chromium"),
];

function loopback(host) {
  if (!host) return true;
  const name = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "::1" || name === "::" || name === "0.0.0.0" || /^127\./.test(name);
}

function ownerChromeFile(file) {
  const name = file instanceof URL ? decodeURIComponent(file.pathname) : file;
  if (typeof name !== "string" || path.basename(name) !== "DevToolsActivePort") return false;
  const resolved = path.resolve(name);
  return chromeRoots.some((root) => resolved.startsWith(root));
}

function refuse(what) {
  const error = new Error(`connection-guard: a test tried to ${what}, which belongs to the owner's Chrome`);
  error.code = "EOWNERCHROME";
  process.exitCode = 1;
  process.stderr.write(`${error.stack}\n`);
  return error;
}

function target(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") return { port: first.port, host: first.host, path: first.path };
  return { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const to = target(args);
  if (!to.path && Number(to.port) === OWNER_CHROME_PORT && loopback(to.host)) {
    const error = refuse(`connect to ${to.host || "localhost"}:${OWNER_CHROME_PORT}`);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return connect.apply(this, args);
};

const readFileSync = fs.readFileSync;
fs.readFileSync = function guardedReadFileSync(file, ...rest) {
  if (ownerChromeFile(file)) throw refuse(`read ${file}`);
  return readFileSync.call(this, file, ...rest);
};

const readFile = fs.readFile;
fs.readFile = function guardedReadFile(file, ...rest) {
  if (ownerChromeFile(file)) {
    const error = refuse(`read ${file}`);
    const callback = rest[rest.length - 1];
    process.nextTick(() => callback(error));
    return;
  }
  return readFile.call(this, file, ...rest);
};

const readFilePromise = fs.promises.readFile;
fs.promises.readFile = function guardedReadFilePromise(file, ...rest) {
  if (ownerChromeFile(file)) return Promise.reject(refuse(`read ${file}`));
  return readFilePromise.call(this, file, ...rest);
};

const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function guardedSpawn(options) {
  const arg = options?.args?.find((value) => OWNER_CHROME_URL.test(String(value)));
  if (arg) throw refuse(`start ${options.file} with ${arg}`);
  return spawn.call(this, options);
};
