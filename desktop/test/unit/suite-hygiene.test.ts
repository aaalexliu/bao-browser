import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactsRoot, tryWriteEvidence } from "../artifacts";
import { formatShutdown } from "../../src/launch";
import { classifyStatus, compiledTestPlan, cookieKeyPlan, hermeticChildEnv, laneEnv, outageFromReason } from "../runtime";

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
});

test("hermetic env is headless and keeps an explicit browser", () => {
  const env = hermeticChildEnv({
    BAO_HEADED: "1",
    OPENAI_API_KEY: "sk-test",
    BAO_OS_HELPER: "/tmp/helper",
    BAO_BROWSER: "/tmp/pinned-chrome",
    BAO_RUN_VIDEO: "1",
    BAO_HOME: "/tmp/real-home",
    BAO_TEST_MOCK_KEYCHAIN: "1",
  }, "/tmp/playwright-chromium");
  assert.equal(env.BAO_HEADED, "0");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.BAO_OS_HELPER, undefined);
  assert.equal(env.BAO_BROWSER, "/tmp/pinned-chrome");
  assert.equal(env.BAO_REPLAY_VIDEO, "0");
  assert.equal(env.BAO_RUN_VIDEO, undefined);
  assert.equal(env.BAO_HOME, undefined);
  assert.equal(env.BAO_HEAL_CURSOR_ACCOUNT, "0");
  assert.equal(env.BAO_LANE, "hermetic");
  assert.equal(env.BAO_TEST_MOCK_KEYCHAIN, undefined);
});

test("the installed Chrome lane does not pin a browser or force headless", () => {
  const env = laneEnv("installed-chrome", { BAO_BROWSER: "/tmp/pin", BAO_HEADED: "0" });
  assert.equal(env.BAO_BROWSER, undefined);
  assert.equal("BAO_HEADED" in env, false);
  assert.equal(env.BAO_LANE, "installed-chrome");
});

test("the live lane turns public demos on and stays headless", () => {
  const env = laneEnv("live", {}, "/tmp/pin");
  assert.equal(env.BAO_LIVE_TESTS, "1");
  assert.equal(env.BAO_HEADED, "0");
  assert.equal(env.BAO_BROWSER, "/tmp/pin");
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

test("a 5xx during replay is infrastructure and a tie is a product failure", () => {
  assert.deepEqual(outageFromReason("5xx 500"), { result: "unavailable", status: 500 });
  assert.deepEqual(outageFromReason("5xx"), { result: "unavailable", status: 500 });
  assert.deepEqual(outageFromReason("blocked 403"), { result: "bot-blocked", status: 403 });
  assert.equal(outageFromReason("tie"), undefined);
  assert.equal(outageFromReason(undefined), undefined);
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
