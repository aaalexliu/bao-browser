import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACCOUNT_CHROME_MAC, LINUX_CHROME, accountLaunchArgs, assessOwnedCommand, browserPidFromLauncher, discardRestoredTabs, ownedChromeLaunchArgs, readOwnedCommand, resolveAccountChrome, resolveNormalChrome, testLaneBrowser, testLaneKeychainArgs } from "../../src/launch";

const fixture = readFileSync(path.join(process.cwd(), "desktop/test/fixtures/ps-chrome-owned.txt"), "utf8");
const owned = "/tmp/bao-owned-profile";
/** No BAO_TEST_BROWSER: the product launch. The test lane sets it in process.env. */
const product: NodeJS.ProcessEnv = {};

test("the launcher pid is the descendant whose profile is ours", () => {
  const rows = [
    { pid: 100, ppid: 1, command: "node cli.js" },
    { pid: 200, ppid: 100, command: fixture.trim() },
    { pid: 201, ppid: 100, command: "ps -axww -o pid=,ppid=,command=" },
    { pid: 300, ppid: 1, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/alex/Library/Application Support/Google/Chrome" },
  ];
  assert.equal(browserPidFromLauncher(owned, 100, rows), 200);
  const cmd = readOwnedCommand(200, owned, "darwin", (pid) => {
    assert.equal(pid, 200);
    return fixture;
  });
  assert.equal(assessOwnedCommand(cmd, owned, product).ok, true);
});

test("mac ps output: the Google Chrome binary path is not the daily profile", () => {
  const cmd = readOwnedCommand(4242, owned, "darwin", () => fixture);
  const verdict = assessOwnedCommand(cmd, owned, product);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(cmd, /Google Chrome\.app/);
});

test("darwin refuses to read /proc when the launcher did not return a pid", () => {
  assert.throws(
    () => readOwnedCommand(undefined, owned, "darwin", () => fixture),
    /pid was not available/,
  );
});

test("a user-data-dir inside the daily profile is refused even when the binary is Chrome", () => {
  const daily = fixture.replace(
    "--user-data-dir=/tmp/bao-owned-profile",
    "--user-data-dir=/Users/alex/Library/Application Support/Google/Chrome",
  );
  const verdict = assessOwnedCommand(daily, "/Users/alex/Library/Application Support/Google/Chrome", product);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason || "", /daily profile/);
});

test("an account browser uses installed Chrome and skips Playwright automation switches", () => {
  const args = accountLaunchArgs(9333);
  assert.match(args.join(" "), /--remote-debugging-port=9333/);
  assert.equal(args.includes("--enable-automation"), false);
  assert.equal(args.includes("--disable-extensions"), false);
  assert.equal(args.includes("--use-mock-keychain"), false);
  assert.equal(args.includes("--password-store=basic"), false);
  assert.equal(args.includes("--no-sandbox"), false);
  assert.equal(args.includes("--restore-last-session"), false);
  assert.equal(ownedChromeLaunchArgs([], {}, "linux").includes("--no-sandbox"), false);
  assert.equal(ownedChromeLaunchArgs([], { BAO_CHROME_NO_SANDBOX: "1" }, "linux").includes("--no-sandbox"), true);
  assert.equal(ownedChromeLaunchArgs([], { BAO_CHROME_NO_SANDBOX: "1" }, "linux").includes("--disable-dev-shm-usage"), true);
  assert.equal(ownedChromeLaunchArgs([], { BAO_CHROME_NO_SANDBOX: "1" }, "darwin").includes("--no-sandbox"), false);
  assert.equal(ownedChromeLaunchArgs([], { CI: "true" }, "linux").includes("--no-sandbox"), true);
  assert.equal(ownedChromeLaunchArgs([], { CI: "true" }, "darwin").includes("--no-sandbox"), false);
  assert.equal(ownedChromeLaunchArgs(["--enable-automation", "--no-sandbox"], {}, "darwin").includes("--enable-automation"), false);
  assert.equal(ownedChromeLaunchArgs(["--no-sandbox"], {}, "darwin").includes("--no-sandbox"), false);
  assert.equal(ownedChromeLaunchArgs([], {}, "linux").includes("--restore-last-session"), false);
  assert.equal(ownedChromeLaunchArgs(["--restore-last-session"], {}, "darwin").includes("--restore-last-session"), false);
  assert.throws(() => accountLaunchArgs(9222), /9222/);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin") {
    assert.equal(resolveAccountChrome((file) => file === chrome, {}), chrome);
  }
  const accountExe = path.join(mkdtempSync(path.join(tmpdir(), "bao-account-bin-")), "chrome");
  writeFileSync(accountExe, "");
  chmodSync(accountExe, 0o755);
  assert.equal(resolveAccountChrome(() => false, { BAO_BROWSER: accountExe }, () => "/missing/playwright"), accountExe);
  assert.throws(() => resolveAccountChrome(() => false, {}, () => "/missing/playwright"), /Chrome was not found/);
});

test("installed Chrome wins, and a missing BAO_BROWSER falls through", () => {
  const bundled = "/tmp/Bao.app/Chromium";
  const both = (file: string) => file === ACCOUNT_CHROME_MAC || file === LINUX_CHROME || file === bundled;
  assert.equal(resolveNormalChrome(both, { BAO_BROWSER: bundled }, "darwin"), ACCOUNT_CHROME_MAC);
  assert.equal(resolveNormalChrome(both, { BAO_BROWSER: bundled }, "linux"), LINUX_CHROME);
  assert.equal(resolveNormalChrome(both, { BAO_BROWSER: "/missing/chrome" }, "linux"), LINUX_CHROME);
  const exe = path.join(mkdtempSync(path.join(tmpdir(), "bao-bundled-")), "chrome");
  writeFileSync(exe, "");
  chmodSync(exe, 0o755);
  assert.equal(resolveNormalChrome(() => false, { BAO_BROWSER: exe }, "linux", () => "/missing/playwright"), exe);
  assert.throws(() => resolveNormalChrome(() => false, { BAO_BROWSER: "/missing/chrome" }, "linux", () => "/missing/playwright"), /Chrome was not found/);
});

test("product launch arguments are unchanged and drop the mock keychain", () => {
  assert.deepEqual(ownedChromeLaunchArgs([], product, "darwin"), [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--force-renderer-accessibility",
  ]);
  assert.deepEqual(ownedChromeLaunchArgs([], product, "linux"), [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
  ]);
  assert.deepEqual(
    ownedChromeLaunchArgs(["--use-mock-keychain", "--password-store=basic", "--lang=en"], { BAO_TEST_MOCK_KEYCHAIN: "1" }, "darwin"),
    ["--no-first-run", "--no-default-browser-check", "--disable-sync", "--force-renderer-accessibility", "--lang=en"],
  );
  assert.equal(ownedChromeLaunchArgs([], { BAO_TEST_BROWSER: "   " }, "darwin").includes("--use-mock-keychain"), false);
  assert.deepEqual(accountLaunchArgs(9333), [
    "--remote-debugging-port=9333",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    ...(process.platform === "darwin" ? ["--force-renderer-accessibility"] : []),
  ]);
  assert.equal(resolveNormalChrome((file) => file === ACCOUNT_CHROME_MAC, product, "darwin"), ACCOUNT_CHROME_MAC);
  assert.equal(resolveNormalChrome((file) => file === LINUX_CHROME, product, "linux"), LINUX_CHROME);
});

test("the test lane launches BAO_TEST_BROWSER with a mock keychain", () => {
  const pin = path.join(mkdtempSync(path.join(tmpdir(), "bao-test-browser-")), "Google Chrome for Testing");
  writeFileSync(pin, "");
  chmodSync(pin, 0o755);
  const lane: NodeJS.ProcessEnv = { BAO_TEST_BROWSER: pin };
  const installed = (file: string) => file === ACCOUNT_CHROME_MAC || file === LINUX_CHROME;
  assert.equal(testLaneBrowser(lane), pin);
  assert.equal(testLaneBrowser(product), undefined);
  assert.equal(resolveNormalChrome(installed, lane, "darwin"), pin);
  assert.equal(resolveNormalChrome(installed, lane, "linux"), pin);
  assert.throws(
    () => resolveNormalChrome(installed, { BAO_TEST_BROWSER: "/missing/chrome-for-testing" }, "darwin"),
    /BAO_TEST_BROWSER is not an executable file/,
  );
  assert.deepEqual(testLaneKeychainArgs(lane), ["--use-mock-keychain", "--password-store=basic"]);
  assert.deepEqual(testLaneKeychainArgs(product), []);
  assert.deepEqual(ownedChromeLaunchArgs(["--use-mock-keychain=0", "--password-store=gnome"], lane, "darwin"), [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--force-renderer-accessibility",
    "--use-mock-keychain",
    "--password-store=basic",
  ]);
  const laneCmd = `${pin} --user-data-dir=${owned} --no-first-run --use-mock-keychain --password-store=basic`;
  assert.equal(assessOwnedCommand(laneCmd, owned, lane).ok, true);
  assert.equal(assessOwnedCommand(laneCmd, owned, product).ok, false);
  const bare = assessOwnedCommand(fixture, owned, lane);
  assert.equal(bare.ok, false);
  assert.match(bare.reason || "", /without a mock keychain/);
});

test("a product command line rejects mock keychain flags in every form", () => {
  const flags = [
    "--use-mock-keychain",
    "--use-mock-keychain=1",
    "--use-mock-keychain ",
    "--password-store=basic",
    "--password-store=gnome",
    "--password-store ",
  ];
  for (const flag of flags) {
    const verdict = assessOwnedCommand(`${fixture.trim()} ${flag}`, owned, product);
    assert.equal(verdict.ok, false, flag);
    assert.match(verdict.reason || "", /mock keychain/);
  }
  const cleaned = ownedChromeLaunchArgs([
    "--use-mock-keychain",
    "--use-mock-keychain=1",
    "--use-mock-keychain ",
    "--password-store=basic",
    "--password-store=gnome",
    "--password-store ",
  ], product, "darwin");
  assert.equal(cleaned.some((arg) => /use-mock-keychain|password-store/.test(arg)), false);
});

test("BAO_BROWSER and the Playwright path must be executable files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-chrome-bin-"));
  const dir = path.join(root, "dir");
  mkdirSync(dir);
  const plain = path.join(root, "plain");
  writeFileSync(plain, "");
  const exe = path.join(root, "chrome");
  writeFileSync(exe, "");
  chmodSync(exe, 0o755);
  const system = (file: string) => file === LINUX_CHROME || file === ACCOUNT_CHROME_MAC ? false : existsSync(file);
  assert.throws(() => resolveNormalChrome(system, { BAO_BROWSER: dir }, "linux", () => plain), /Chrome was not found/);
  assert.throws(() => resolveNormalChrome(system, { BAO_BROWSER: plain }, "linux", () => dir), /Chrome was not found/);
  assert.equal(resolveNormalChrome(system, { BAO_BROWSER: exe }, "linux", () => plain), exe);
  assert.throws(() => resolveNormalChrome(system, {}, "linux", () => dir), /Chrome was not found/);
  assert.equal(resolveNormalChrome(system, {}, "linux", () => exe), exe);
});

test("remote debugging port 9222 is refused", () => {
  const cmd = `${fixture.trim()} --remote-debugging-port=9222`;
  const verdict = assessOwnedCommand(cmd, owned, product);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason || "", /9222/);
});

test("a mismatched user-data-dir is refused", () => {
  const verdict = assessOwnedCommand(fixture, "/tmp/someone-else", product);
  assert.equal(verdict.ok, false);
});

test("saved tabs are removed and the cookie store is left in place", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-tabs-"));
  const base = path.join(dir, "Default");
  mkdirSync(path.join(base, "Sessions"), { recursive: true });
  mkdirSync(path.join(base, "Network"), { recursive: true });
  writeFileSync(path.join(base, "Sessions", "Tabs_1"), "restored");
  writeFileSync(path.join(base, "Current Session"), "restored");
  writeFileSync(path.join(base, "Last Tabs"), "restored");
  writeFileSync(path.join(base, "Network", "Cookies"), "keep");
  discardRestoredTabs(dir);
  assert.equal(existsSync(path.join(base, "Sessions")), false);
  assert.equal(existsSync(path.join(base, "Current Session")), false);
  assert.equal(existsSync(path.join(base, "Last Tabs")), false);
  assert.equal(readFileSync(path.join(base, "Network", "Cookies"), "utf8"), "keep");
});

test("Bao.app is a compiled entry plus bundled Chromium, not Google Chrome", () => {
  const script = readFileSync(path.join(process.cwd(), "desktop/packaging/macos/package-app.sh"), "utf8");
  const main = readFileSync(path.join(process.cwd(), "desktop/packaging/macos/bao-main.c"), "utf8");
  const launch = readFileSync(path.join(process.cwd(), "desktop/packaging/macos/bao-launch.c"), "utf8");
  assert.equal(script.includes("/Applications/Google Chrome.app"), false);
  assert.match(script, /bao-main\.c/);
  assert.match(script, /Chromium\.app/);
  assert.equal(main.includes("/Applications/Google Chrome.app"), false);
  assert.equal(launch.includes("/Applications/Google Chrome.app"), false);
  assert.match(main, /bao_find_browser\(browser, sizeof browser, resources\)/);
  assert.match(launch, /Google Chrome for Testing/);
  assert.match(launch, /Chromium\.app/);
  assert.match(main, /--app=/);
  assert.match(main, /--disable-infobars/);
  assert.match(script, /bao-launch\.c/);
  assert.equal(/codesign[^\n]*--deep/.test(script), false);
  assert.equal(main.includes("execlp"), false);
  assert.match(main, /bao_discover_node/);
  assert.match(main, /bao_instance_acquire/);
  assert.match(main, /bao_show_alert/);
  assert.match(main, /bao_focus_pid/);
  assert.match(main, /bao_wait_for_port/);
  const messages = [...main.matchAll(/static const char k\w+\[\] =\s*((?:"[^"]*"\s*)+);/g)].map((match) => match[1]);
  assert.ok(messages.length >= 4);
  for (const message of messages) {
    assert.equal(message.includes("127.0.0.1"), false, message);
    assert.equal(message.includes("4787"), false, message);
  }
});

test("package-app.sh stops before it builds an app when the helper is absent", () => {
  const dist = mkdtempSync(path.join(tmpdir(), "bao-dist-"));
  const helper = path.join(dist, "fixture", "BaoOSHelper.app");
  try {
    const result = spawnSync("bash", ["desktop/packaging/macos/package-app.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        BAO_DIST: dist,
        BAO_HELPER_APP: helper,
        BAO_SIGN_IDENTITY: "bao dev signing",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /helper is absent/);
    assert.match(result.stderr, /fixture\/BaoOSHelper\.app/);
    assert.equal((result.stderr || "").includes("desktop/os-helper-macos/BaoOSHelper.app"), false);
    assert.equal((result.stderr || "").includes("codesign"), false);
    assert.equal(existsSync(path.join(dist, "Bao.app")), false);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("stage-runtime compiles into a temp dir and leaves extension/dist alone", { timeout: 180_000 }, () => {
  const parent = mkdtempSync(path.join(tmpdir(), "bao-stage-"));
  const dest = path.join(parent, "Resources");
  mkdirSync(dest);
  const manifest = path.join(process.cwd(), "extension/dist/manifest.json");
  const compiled = path.join(process.cwd(), "desktop/dist/desktop/src/app/server.js");
  const manifestBefore = existsSync(manifest) ? statSync(manifest).mtimeMs : null;
  const compiledBefore = existsSync(compiled) ? statSync(compiled).mtimeMs : null;
  try {
    const result = spawnSync("bash", ["desktop/packaging/stage-runtime.sh", dest], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = (result.stdout || "").split("\n").find((row) => row.startsWith("STAGED_TSC "));
    assert.ok(line);
    const out = line.slice("STAGED_TSC ".length).trim();
    assert.equal(out.includes(`${path.sep}bao-tsc`), true, out);
    assert.equal(out.startsWith(process.cwd() + path.sep), false, out);
    assert.equal(existsSync(path.join(dest, "extension/src/host-grant.js")), true);
    assert.equal(existsSync(path.join(dest, "extension/dist/manifest.json")), true);
    const user = path.join(parent, "user");
    mkdirSync(user);
    const printed = spawnSync(process.execPath, [path.join(dest, "bao/src/print-home.cjs")], {
      cwd: user,
      encoding: "utf8",
      env: { PATH: process.env.PATH || "", HOME: user },
    });
    assert.equal(printed.status, 0, printed.stderr || printed.stdout);
    const library = process.platform === "darwin"
      ? path.join(user, "Library", "Application Support", "bao")
      : path.join(user, ".local", "share", "bao");
    assert.equal(printed.stdout, `ok\n${library}\n`);
    if (manifestBefore == null) assert.equal(existsSync(manifest), false);
    else assert.equal(statSync(manifest).mtimeMs, manifestBefore);
    if (compiledBefore == null) assert.equal(existsSync(compiled), false);
    else assert.equal(statSync(compiled).mtimeMs, compiledBefore);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
