import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactsRoot, tryWriteEvidence } from "../artifacts";
import { formatShutdown } from "../../src/launch";
import { classifyStatus, compiledTestPlan, cookieKeyPlan, hermeticChildEnv, laneEnv, liveSkip, mockKeychainArgs } from "../runtime";

test("the required files and dates demo stays on local fixtures", () => {
  const demo = readFileSync("desktop/test/unit/files-dates-demo.test.ts", "utf8");
  assert.equal(demo.includes("/opt/cursor"), false);
  assert.equal(demo.includes("automationintesting.online"), false);
  assert.equal(demo.includes("www.irs.gov"), false);
  assert.equal(demo.includes("the-internet.herokuapp.com"), false);
});

test("a failed evidence write does not replace the caller error", async () => {
  await tryWriteEvidence(() => {
    throw new Error("disk full");
  });
  await tryWriteEvidence(() => Promise.reject(new Error("disk full")));
});

test("artifact roots stay in the checkout unless an env dir is set", () => {
  const fallback = artifactsRoot({ BAO_TEST_RUN_ID: "run-a" });
  assert.equal(fallback.includes(`${path.sep}out${path.sep}test-artifacts${path.sep}run-a`), true);
  assert.equal(fallback.includes(`${path.sep}opt${path.sep}cursor`), false);
  assert.equal(artifactsRoot({ BAO_ARTIFACTS_DIR: "/tmp/bao-art", BAO_ARTIFACTS: "/tmp/other" }), path.resolve("/tmp/bao-art"));
  assert.equal(artifactsRoot({ BAO_ARTIFACTS: "/tmp/bao-alias" }), path.resolve("/tmp/bao-alias"));
  assert.equal(artifactsRoot({ BAO_ARTIFACTS_DIR: "   ", BAO_ARTIFACTS: "/tmp/bao-alias" }), path.resolve("/tmp/bao-alias"));
  assert.equal(artifactsRoot({ BAO_ARTIFACTS_DIR: " /tmp/spaced " }), path.resolve("/tmp/spaced"));
});

test("hermetic env drops inherited launch settings and pins the test browser", () => {
  const env = hermeticChildEnv({
    BAO_HEADED: "1",
    OPENAI_API_KEY: "sk-test",
    BAO_OS_HELPER: "/tmp/helper",
    BAO_BROWSER: "/tmp/bundle",
    BAO_TEST_BROWSER: "/tmp/parent-pin",
    BAO_CAPTURE_BAR: "1",
    BAO_CAPTURE_BAR_BIN: "/tmp/bar",
    BAO_CHROME_NO_SANDBOX: "1",
    BAO_CDP_PORT_FILE: "/tmp/port",
    BAO_LIVE_TESTS: "1",
    BAO_ARTIFACTS: "/tmp/art",
    BAO_ARTIFACTS_DIR: "/tmp/art-dir",
    BAO_RUN_VIDEO: "1",
    BAO_HOME: "/tmp/real-home",
    BAO_TEST_MOCK_KEYCHAIN: "1",
  }, "/tmp/playwright-chromium");
  assert.equal(env.BAO_HEADED, "0");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.BAO_OS_HELPER, undefined);
  assert.equal(env.BAO_BROWSER, undefined);
  assert.equal(env.BAO_TEST_BROWSER, "/tmp/playwright-chromium");
  assert.equal(env.BAO_CAPTURE_BAR, undefined);
  assert.equal(env.BAO_CAPTURE_BAR_BIN, undefined);
  assert.equal(env.BAO_CHROME_NO_SANDBOX, undefined);
  assert.equal(env.BAO_CDP_PORT_FILE, undefined);
  assert.equal(env.BAO_LIVE_TESTS, undefined);
  assert.equal(env.BAO_ARTIFACTS, "/tmp/art");
  assert.equal(env.BAO_ARTIFACTS_DIR, "/tmp/art-dir");
  assert.equal(env.BAO_REPLAY_VIDEO, "0");
  assert.equal(env.BAO_RUN_VIDEO, undefined);
  assert.equal(env.BAO_HOME, undefined);
  assert.equal(env.BAO_HEAL_CURSOR_ACCOUNT, "0");
  assert.equal(env.BAO_LANE, "hermetic");
  assert.equal(env.BAO_TEST_MOCK_KEYCHAIN, undefined);
});

test("the live lane turns public demos on and stays headless", () => {
  const env = laneEnv("live", { BAO_BROWSER: "/tmp/bundle", BAO_LIVE_TESTS: "0" }, "/tmp/pin");
  assert.equal(env.BAO_LIVE_TESTS, "1");
  assert.equal(env.BAO_HEADED, "0");
  assert.equal(env.BAO_BROWSER, undefined);
  assert.equal(env.BAO_TEST_BROWSER, "/tmp/pin");
});

test("the test adds the mock keychain flags and the product builder does not", () => {
  assert.deepEqual(mockKeychainArgs({}), []);
  assert.deepEqual(mockKeychainArgs({ BAO_TEST_MOCK_KEYCHAIN: "1" }), ["--use-mock-keychain", "--password-store=basic"]);
});

test("a deleted source is stale and a missing compile is reported", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-suite-"));
  const source = path.join(root, "src");
  const dist = path.join(root, "dist");
  mkdirSync(source);
  mkdirSync(dist);
  writeFileSync(path.join(source, "keep.test.ts"), "");
  writeFileSync(path.join(dist, "keep.test.js"), "");
  writeFileSync(path.join(dist, "gone.test.js"), "");
  writeFileSync(path.join(source, "fresh.test.ts"), "");
  const plan = compiledTestPlan(source, dist);
  assert.deepEqual(plan.run, ["keep.test.js"]);
  assert.deepEqual(plan.stale, ["gone.test.js"]);
  assert.deepEqual(plan.missing, ["fresh.test.js"]);
});

test("site status splits infrastructure from a reachable page", () => {
  assert.equal(classifyStatus(200), "reachable");
  assert.equal(classifyStatus(302), "reachable");
  assert.equal(classifyStatus(403), "bot-blocked");
  assert.equal(classifyStatus(429), "bot-blocked");
  assert.equal(classifyStatus(500), "unavailable");
  assert.equal(classifyStatus(0), "unavailable");
});

test("a product failure on a reachable page is not an infrastructure skip", () => {
  const page = { status: 200 };
  assert.equal(liveSkip(page, { phase: "expect", reason: "Order 403 confirmed" }), undefined);
  assert.equal(liveSkip(page, { phase: "action", reason: "5xx 500" }), undefined);
  assert.equal(liveSkip(page, { phase: "find", reason: "net::ERR_FAILED" }), undefined);
  assert.equal(liveSkip(page, { phase: "action", reason: "status 404" }), undefined);
  assert.deepEqual(liveSkip({ status: 503 }), { result: "unavailable", status: 503 });
  assert.deepEqual(liveSkip({ status: 403 }), { result: "bot-blocked", status: 403 });
  assert.deepEqual(liveSkip({ status: 404 }), { result: "unavailable", status: 404 });
  assert.deepEqual(liveSkip(page, { phase: "action", reason: "net::ERR_CONNECTION_REFUSED" }), { result: "unavailable", status: 0 });
});

test("browser cookies do not take an injected linux key", () => {
  assert.deepEqual(cookieKeyPlan("browser", "darwin"), { platform: "darwin", injected: false });
  assert.deepEqual(cookieKeyPlan("browser", "linux"), { platform: "linux", injected: false });
  assert.equal(cookieKeyPlan("synthetic-linux", "darwin").injected, true);
  assert.equal(cookieKeyPlan("synthetic-linux", "darwin").platform, "linux");
});

test("shutdown trace names close and profile release", () => {
  const line = formatShutdown({
    browserClose: "sent",
    openPages: 1,
    childExit: 0,
    signal: null,
    killedPids: [],
    profile: "/tmp/bao-profile",
  });
  assert.match(line, /browserClose=sent/);
  assert.match(line, /openPages=1/);
  assert.match(line, /childExit=0/);
  assert.match(line, /killedPids=none/);
  assert.match(line, /profile=\/tmp\/bao-profile/);
});
