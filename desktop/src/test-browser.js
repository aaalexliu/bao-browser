// @ts-check
const { chromium } = require("playwright");

// Deny in Chrome, and never open real capture devices. Fake UI would auto-accept.
// Test profiles only, never live CDP or copies of real profiles.
const TEST_MEDIA_ARGS = Object.freeze([
  "--deny-permission-prompts",
  "--use-fake-device-for-media-stream",
]);

/** @param {import("playwright").LaunchOptions} [options] */
function launchTestBrowser(options = {}) {
  return chromium.launch({ ...options, args: [...(options.args ?? []), ...TEST_MEDIA_ARGS] });
}

/**
 * @param {string} userDataDir
 * @param {Parameters<typeof chromium.launchPersistentContext>[1]} [options]
 */
function launchTestContext(userDataDir, options = {}) {
  return chromium.launchPersistentContext(userDataDir, {
    ...options,
    args: [...(options.args ?? []), ...TEST_MEDIA_ARGS],
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
