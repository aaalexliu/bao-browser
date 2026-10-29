// One library directory for the CLI, MCP, the Mac launcher, and the Claude observer.
// Those entry points load this file. A second copy of the rules drifts and hides data.

const { existsSync, readdirSync, realpathSync, statSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

const warned = new Set();
const DATA_FILES = ["server.json", "settings.json", "sync.json", "relay.json", "login-sites.json"];
const DATA_DIRS = ["workflows", "runs", "trails", "reports", "inputs", "bounds", "promotions"];

function isArgList(value) {
  return Array.isArray(value);
}

function nonempty(value) {
  return value ? value : undefined;
}

function HomeError(message) {
  const err = new Error(message);
  err.name = "HomeError";
  return err;
}

function normalize(argsOrOptions, env) {
  const options = isArgList(argsOrOptions) ? { args: argsOrOptions, env } : (argsOrOptions || {});
  const environment = options.env ?? env ?? process.env;
  const platform = options.platform ?? process.platform;
  const userHome = options.userHome || userHomeFrom(environment, platform);
  if (!path.isAbsolute(userHome)) throw HomeError("bao: HOME must be an absolute path");
  return {
    args: options.args ?? [],
    env: environment,
    platform,
    cwd: options.cwd ?? process.cwd(),
    userHome,
    warn: options.warn ?? warnOnStderr,
  };
}

function userHomeFrom(env, platform) {
  const named = namedHome(env, platform);
  if (named === undefined) {
    const fallback = homedir();
    if (!fallback || !path.isAbsolute(fallback)) throw HomeError("bao: HOME must be an absolute path");
    return fallback;
  }
  if (!path.isAbsolute(named)) throw HomeError("bao: HOME must be an absolute path");
  return named;
}

function namedHome(env, platform) {
  if (platform === "win32") {
    if (typeof env.USERPROFILE === "string" && env.USERPROFILE !== "") return env.USERPROFILE;
    if (typeof env.HOME === "string" && env.HOME !== "") return env.HOME;
    return undefined;
  }
  if (typeof env.HOME !== "string") return undefined;
  if (env.HOME === "") throw HomeError("bao: HOME must be an absolute path");
  return env.HOME;
}

function resolveLibraryHome(argsOrOptions, env) {
  return chooseHome(normalize(argsOrOptions, env));
}

function otherLibraries(root, argsOrOptions, env) {
  const settings = normalize(argsOrOptions || {}, env);
  return legacyDirs(settings).filter((dir) => !samePath(dir, root) && libraryHasData(dir));
}

function serverHomes(args, env) {
  const settings = normalize(args || [], env);
  const home = chooseHome(settings);
  const homes = [home];
  for (const extra of legacyDirs(settings)) {
    if (!homes.some((item) => samePath(item, extra))) homes.push(extra);
  }
  const platform = platformHome(settings.userHome, settings.platform);
  if (!homes.some((item) => samePath(item, platform))) homes.push(platform);
  return homes;
}

function librarySplitLine(other, root) {
  return `library data is at ${other}; using ${root}`;
}

function tildePath(file, userHome) {
  const root = path.resolve(userHome);
  const abs = path.resolve(file);
  if (abs === root) return "~";
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!abs.startsWith(prefix)) return abs;
  return `~/${abs.slice(prefix.length)}`;
}

function baoUserHome(env, platform) {
  return userHomeFrom(env ?? process.env, platform ?? process.platform);
}

function chooseHome(settings) {
  const flagged = readHomeFlag(settings.args);
  const fromEnv = nonempty(settings.env.BAO_HOME);
  const requested = flagged ?? fromEnv ?? platformHome(settings.userHome, settings.platform);
  const resolved = flagged !== undefined
    ? absoluteHome(requested, settings.userHome, "--home")
    : fromEnv !== undefined
      ? absoluteHome(requested, settings.userHome, "BAO_HOME")
      : requested;
  const legacies = legacyDirs(settings).filter((dir) => !samePath(dir, resolved));
  const workflowHits = legacies.filter((dir) => hasWorkflows(dir));
  const dataHits = legacies.filter((dir) => libraryHasData(dir));

  if (hasWorkflows(resolved)) {
    warnOthers(settings, resolved, workflowHits, dataHits);
    return resolved;
  }
  if (workflowHits.length > 0) {
    const root = workflowHits[0];
    emit(settings, `bao: no workflows in ${resolved}; using ${root}`);
    warnOthers(settings, root, workflowHits.slice(1), dataHits);
    return root;
  }
  if (libraryHasData(resolved)) {
    warnOthers(settings, resolved, [], dataHits);
    return resolved;
  }
  if (dataHits.length > 0) {
    const root = dataHits[0];
    emit(settings, `bao: no library data in ${resolved}; using ${root}`);
    warnOthers(settings, root, [], dataHits.slice(1));
    return root;
  }
  return resolved;
}

function warnOthers(settings, root, workflowHits, dataHits) {
  for (const other of workflowHits) {
    if (samePath(other, root)) continue;
    emit(settings, `bao: ${librarySplitLine(other, root)}`);
  }
  for (const other of dataHits) {
    if (samePath(other, root) || workflowHits.some((dir) => samePath(dir, other))) continue;
    emit(settings, `bao: ${librarySplitLine(other, root)}`);
  }
}

function readHomeFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--home") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw HomeError("bao: --home needs a directory");
      return value;
    }
    if (arg.startsWith("--home=")) {
      const value = arg.slice("--home=".length);
      if (!value || value.startsWith("--")) throw HomeError("bao: --home needs a directory");
      return value;
    }
  }
  return undefined;
}

function absoluteHome(value, userHome, label) {
  if (value.includes("\0")) throw HomeError("bao: home path contains a null byte");
  let expanded = value;
  if (value === "~") expanded = userHome;
  else if (value.startsWith("~/")) expanded = path.join(userHome, value.slice(2));
  if (!path.isAbsolute(expanded)) throw HomeError(`bao: ${label} must be an absolute path`);
  return path.resolve(expanded);
}

function platformHome(userHome, platform) {
  if (platform === "darwin") return path.join(userHome, "Library", "Application Support", "bao");
  return path.join(userHome, ".local", "share", "bao");
}

function legacyDirs(settings) {
  return [
    path.resolve(settings.userHome, ".local", "share", "bao"),
    path.resolve(settings.cwd, ".bao-mcp"),
  ];
}

function emit(settings, line) {
  if (warned.has(line)) return;
  warned.add(line);
  settings.warn(line);
}

function warnOnStderr(line) {
  console.error(line);
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function hasJsonFile(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => name.endsWith(".json") && isFile(path.join(dir, name)));
}

function hasWorkflows(dir) {
  return hasJsonFile(path.join(dir, "workflows"));
}

function libraryHasData(dir) {
  if (DATA_FILES.some((name) => isFile(path.join(dir, name)))) return true;
  if (isFile(path.join(dir, "observer", "trail.jsonl"))) return true;
  if (isFile(path.join(dir, "live-session", "session.json"))) return true;
  return DATA_DIRS.some((name) => hasJsonFile(path.join(dir, name)));
}

function samePath(left, right) {
  return canonical(left) === canonical(right);
}

function canonical(file) {
  try {
    if (existsSync(file)) return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
  return path.resolve(file);
}

module.exports = {
  resolveLibraryHome,
  otherLibraries,
  serverHomes,
  librarySplitLine,
  tildePath,
  baoUserHome,
};
