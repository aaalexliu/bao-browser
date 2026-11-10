// Preloaded with --require into every test process by laneChildEnv in runtime.ts.
// The owner's Chrome listens for remote debugging on 127.0.0.1:9222, and every connection
// there raises Chrome's "Allow remote debugging?" sheet on the owner's screen. A test that reaches
// it, reads his Chrome folder, or hands its address to a child fails here instead.
// A headed browser is refused unless BAO_LANE=live or BAO_LIVE_TESTS=1, so a unit run
// cannot draw a window. spawnSync and execFileSync take the same checks as spawn.
// A node child whose caller cleared NODE_OPTIONS still loads this file: the spawn hook
// adds --require, and does not put the preload back into NODE_OPTIONS.
const { ChildProcess } = require("node:child_process");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const MARK = Symbol.for("bao.connection-guard");
if (globalThis[MARK]) return;
globalThis[MARK] = true;

const GUARD = __filename;
const OWNER_CHROME_PORT = 9222;

const home = os.userInfo().homedir;
const chromeRoots = [
  path.join(home, "Library", "Application Support", "Google"),
  path.join(home, "Library", "Application Support", "Chromium"),
  path.join(home, ".config", "google-chrome"),
  path.join(home, ".config", "chromium"),
];

function liveLane() {
  return process.env.BAO_LANE === "live" || process.env.BAO_LIVE_TESTS === "1";
}

function loopback(host) {
  if (!host) return true;
  const name = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "::1" || name === "::" || name === "0.0.0.0" || /^127\./.test(name);
}

function ownerChromeFile(file) {
  const name = file instanceof URL ? decodeURIComponent(file.pathname) : file;
  if (typeof name !== "string" || name.length === 0) return false;
  let resolved;
  try { resolved = path.resolve(name); }
  catch { return false; }
  return chromeRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
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

function is9222(arg) {
  const text = String(arg);
  return text === "9222" || /:9222(?!\d)/.test(text) || /=9222(?!\d)/.test(text);
}

function ownerChromeArg(arg) {
  const text = String(arg);
  const value = text.startsWith("--user-data-dir=") ? text.slice("--user-data-dir=".length) : text;
  if (!value || value.startsWith("-")) return false;
  return ownerChromeFile(value);
}

function browserFile(file) {
  const text = String(file);
  if (/headless[-_]shell/i.test(text)) return false;
  const base = path.basename(text);
  if (/^(chrome|chromium|google chrome|google chrome for testing)$/i.test(base)) return true;
  return /Google Chrome\.app|Chromium\.app|Chrome for Testing/i.test(text);
}

function openChrome(file, args) {
  if (path.basename(String(file)) !== "open") return false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-a" && /chrome|chromium/i.test(args[i + 1] || "")) return true;
  }
  return false;
}

function hasHeadless(args) {
  return args.some((arg) => arg === "--headless" || String(arg).startsWith("--headless="));
}

function headedBrowser(file, args) {
  if (!browserFile(file) && !openChrome(file, args)) return false;
  return !hasHeadless(args);
}

function checkSpawn(file, args) {
  const list = args.map(String);
  const address = list.find((arg, index) => is9222(arg) || (arg === "--remote-debugging-port" && list[index + 1] === "9222"));
  if (address) throw refuse(`start ${file} with ${address}`);
  const folder = list.find((arg) => ownerChromeArg(arg));
  if (folder) throw refuse(`start ${file} with ${folder}`);
  if (!liveLane() && headedBrowser(file, list)) throw refuse(`start a headed browser ${file}`);
}

function checkExec(command) {
  const text = String(command);
  if (/:9222(?!\d)/.test(text) || /=9222(?!\d)/.test(text) || /(?:^|\s)9222(?:\s|$)/.test(text)) {
    throw refuse(`start a command with ${text}`);
  }
  const parts = text.split(/\s+/).filter(Boolean);
  checkSpawn(parts[0] || "", parts.slice(1));
}

function isNode(file) {
  const text = String(file);
  const base = path.basename(text);
  return text === process.execPath || base === "node" || base === "node.exe";
}

function alreadyGuarded(args) {
  return args.some((arg) => {
    const text = String(arg);
    return text === GUARD || text.includes("connection-guard.cjs");
  });
}

function injectNodeArgs(file, args) {
  if (!isNode(file) || alreadyGuarded(args)) return args;
  return ["--require", GUARD, ...args];
}

function commandOf(file, args) {
  if (args && !Array.isArray(args) && typeof args === "object") return { file: String(file), args: [], options: args };
  return { file: String(file), args: Array.isArray(args) ? args.map(String) : [], options: undefined };
}

function guardSync(original) {
  return function guardedSync(file, args, options) {
    const command = commandOf(file, args);
    checkSpawn(command.file, command.args);
    const next = injectNodeArgs(command.file, command.args);
    if (command.options) {
      if (next.length === 0) return original.call(this, file, command.options);
      return original.call(this, file, next, command.options);
    }
    return original.call(this, file, next, options);
  };
}

function denyPath(file, rest, async) {
  if (!ownerChromeFile(file)) return undefined;
  const error = refuse(`read ${file}`);
  const callback = rest[rest.length - 1];
  if (typeof callback === "function") {
    process.nextTick(() => callback(error));
    return null;
  }
  if (async) return Promise.reject(error);
  throw error;
}

function wrap(owner, name, async) {
  const original = owner[name];
  if (typeof original !== "function") return;
  owner[name] = function guarded(file, ...rest) {
    const denied = denyPath(file, rest, async);
    if (denied !== undefined) return denied;
    return original.call(this, file, ...rest);
  };
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

for (const name of ["readFile", "open", "readdir", "stat", "lstat", "access", "copyFile", "cp"]) wrap(fs, name, false);
for (const name of ["readFileSync", "openSync", "readdirSync", "statSync", "lstatSync", "accessSync", "copyFileSync", "cpSync", "existsSync"]) wrap(fs, name, false);
for (const name of ["readFile", "open", "readdir", "stat", "lstat", "access", "copyFile", "cp"]) wrap(fs.promises, name, true);

const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function guardedSpawn(options) {
  const args = (options?.args || []).map(String);
  checkSpawn(options?.file, args);
  if (options && isNode(options.file) && !alreadyGuarded(args)) {
    const argv0 = args.length ? args[0] : path.basename(String(options.file));
    const rest = args.length ? args.slice(1) : [];
    options.args = [argv0, "--require", GUARD, ...rest];
  }
  return spawn.call(this, options);
};

childProcess.spawnSync = guardSync(childProcess.spawnSync);
childProcess.execFileSync = guardSync(childProcess.execFileSync);
const execSync = childProcess.execSync;
childProcess.execSync = function guardedExecSync(command, options) {
  checkExec(command);
  return execSync.call(this, command, options);
};
