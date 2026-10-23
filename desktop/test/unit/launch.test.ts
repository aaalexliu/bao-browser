import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { accountLaunchArgs, assessOwnedCommand, browserPidFromLauncher, ownedChromeLaunchArgs, readOwnedCommand, resolveAccountChrome } from "../../src/launch";

const fixture = readFileSync(path.join(process.cwd(), "desktop/test/fixtures/ps-chrome-owned.txt"), "utf8");
const owned = "/tmp/bao-owned-profile";

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
  assert.equal(assessOwnedCommand(cmd, owned).ok, true);
});

test("mac ps output: the Google Chrome binary path is not the daily profile", () => {
  const cmd = readOwnedCommand(4242, owned, "darwin", () => fixture);
  const verdict = assessOwnedCommand(cmd, owned);
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
  const verdict = assessOwnedCommand(daily, "/Users/alex/Library/Application Support/Google/Chrome");
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
  assert.throws(() => accountLaunchArgs(9222), /9222/);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const bundled = "/tmp/Bao.app/Chromium";
  if (process.platform === "darwin") {
    assert.equal(resolveAccountChrome((file) => file === chrome, {}), chrome);
  }
  assert.equal(resolveAccountChrome((file) => file === bundled, { BAO_BROWSER: bundled }), bundled);
  assert.throws(() => resolveAccountChrome(() => false, {}), /Chrome was not found/);
});

test("remote debugging port 9222 is refused", () => {
  const cmd = `${fixture.trim()} --remote-debugging-port=9222`;
  const verdict = assessOwnedCommand(cmd, owned);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason || "", /9222/);
});

test("a mismatched user-data-dir is refused", () => {
  const verdict = assessOwnedCommand(fixture, "/tmp/someone-else");
  assert.equal(verdict.ok, false);
});

test("Bao.app is a compiled entry plus bundled Chromium, not Google Chrome", () => {
  const script = readFileSync(path.join(process.cwd(), "desktop/packaging/macos/package-app.sh"), "utf8");
  const main = readFileSync(path.join(process.cwd(), "desktop/packaging/macos/bao-main.c"), "utf8");
  assert.equal(script.includes("/Applications/Google Chrome.app"), false);
  assert.match(script, /bao-main\.c/);
  assert.match(script, /Chromium\.app/);
  assert.equal(main.includes("/Applications/Google Chrome.app"), false);
  assert.match(main, /Google Chrome for Testing/);
  assert.match(main, /Chromium\.app/);
  assert.match(main, /--app=/);
  assert.match(main, /--disable-infobars/);
});
