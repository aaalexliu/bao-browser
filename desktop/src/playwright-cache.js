// @ts-check
const os = require("os");
const path = require("path");

// Playwright reads this path once, at load. Pin the real cache before HOME changes.

/** @param {NodeJS.ProcessEnv} env */
function explicitBrowsersPath(env) {
  const value = env.PLAYWRIGHT_BROWSERS_PATH;
  if (value === undefined || value === "") return undefined;
  return value;
}

/**
 * @param {string | undefined} dir
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function outsideSwappedHome(dir, env, home) {
  if (!dir) return undefined;
  if (!env.HOME || path.resolve(env.HOME) === path.resolve(home)) return dir;
  const swapped = path.resolve(env.HOME);
  const target = path.resolve(dir);
  if (target === swapped || target.startsWith(swapped + path.sep)) return undefined;
  return dir;
}

/** @param {NodeJS.ProcessEnv} env */
function playwrightCacheRoot(env) {
  const home = os.userInfo().homedir;
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") {
    const local = outsideSwappedHome(env.LOCALAPPDATA, env, home) || path.join(home, "AppData", "Local");
    return path.join(local, "ms-playwright");
  }
  const cache = outsideSwappedHome(env.XDG_CACHE_HOME, env, home) || path.join(home, ".cache");
  return path.join(cache, "ms-playwright");
}

/** @param {NodeJS.ProcessEnv} env */
function pinPlaywrightBrowsers(env) {
  const explicit = explicitBrowsersPath(env);
  if (explicit !== undefined) return explicit;
  env.PLAYWRIGHT_BROWSERS_PATH = playwrightCacheRoot(env);
  return env.PLAYWRIGHT_BROWSERS_PATH;
}

/**
 * Pin the real Playwright cache, then set HOME.
 * An explicit PLAYWRIGHT_BROWSERS_PATH is kept, including "0".
 * Omit home to pin the cache without changing HOME.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [home]
 */
function swapTestHome(env, home) {
  pinPlaywrightBrowsers(env);
  if (home !== undefined) env.HOME = home;
  return env;
}

exports.pinPlaywrightBrowsers = pinPlaywrightBrowsers;
exports.swapTestHome = swapTestHome;
