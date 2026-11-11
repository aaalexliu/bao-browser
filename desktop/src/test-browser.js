// @ts-check
const os = require("os");
const { swapTestHome } = require("./playwright-cache.js");

// A test child can load this file after HOME was swapped. Pin before Playwright reads it.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.HOME && process.env.HOME !== os.userInfo().homedir) {
  swapTestHome(process.env);
}
const { chromium } = require("playwright");

// Deny in Chrome, and never open real capture devices. Fake UI would auto-accept.
const TEST_MEDIA_ARGS = Object.freeze([
  "--deny-permission-prompts",
  "--use-fake-device-for-media-stream",
]);

// Chromium 149's new surface path copies immediately, retries five times with
// no delay, and then returns the empty image behind "Unable to capture screenshot".
// The feature is off unless this switch turns it on. The legacy path waits for the redraw.
const SURFACE_SWITCH = "--enable-features=CDPScreenshotNewSurface";

/** @param {import("playwright").LaunchOptions} options */
function launchOptions(options) {
  const args = [...(options.args ?? []), ...TEST_MEDIA_ARGS];
  if (options.ignoreDefaultArgs === true) return { ...options, args };
  const ignored = Array.isArray(options.ignoreDefaultArgs) ? options.ignoreDefaultArgs : [];
  return {
    ...options,
    args,
    ignoreDefaultArgs: [...ignored, SURFACE_SWITCH],
  };
}

/** @param {import("playwright").LaunchOptions} [options] */
function launchTestBrowser(options = {}) {
  swapTestHome(process.env);
  return chromium.launch({ headless: true, ...launchOptions(options) });
}

/**
 * @param {string} userDataDir
 * @param {Parameters<typeof chromium.launchPersistentContext>[1]} [options]
 */
function launchTestContext(userDataDir, options = {}) {
  swapTestHome(process.env);
  return chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...launchOptions(options),
  });
}

exports.TEST_MEDIA_ARGS = TEST_MEDIA_ARGS;
exports.launchTestBrowser = launchTestBrowser;
exports.launchTestContext = launchTestContext;
exports.testChromium = {
  launch: launchTestBrowser,
  launchPersistentContext: launchTestContext,
  connectOverCDP: chromium.connectOverCDP.bind(chromium),
  executablePath: chromium.executablePath.bind(chromium),
};
