import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { artifactsRoot, testArtifacts, tryWriteEvidence } from "../artifacts";
import { ACCOUNT_CHROME_MAC, LINUX_CHROME, formatShutdown, ownedChromeLaunchArgs, resolveNormalChrome } from "../../src/launch";
import { classifyStatus, compiledTestPlan, cookieKeys, laneChildEnv, liveSkip, MAC_MOCK_KEYCHAIN_PASSWORD, ownApiOutage } from "../runtime";

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
  const env = laneChildEnv("hermetic", {
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
    BAO_INVITE_SECRET: "canary-invite",
    bao_browser: "canary-lower",
    BAO_BROWSER_EVIL: "canary-evil",
    CI: "true",
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
  assert.equal(env.BAO_ARTIFACTS, undefined);
  assert.equal(env.BAO_ARTIFACTS_DIR, undefined);
  assert.equal(env.BAO_INVITE_SECRET, undefined);
  assert.equal(env.bao_browser, undefined);
  assert.equal(env.BAO_BROWSER_EVIL, undefined);
  assert.equal(env.CI, undefined);
  assert.equal(ownedChromeLaunchArgs([], env, "linux").includes("--no-sandbox"), false);
  assert.equal(env.BAO_REPLAY_VIDEO, "0");
  assert.equal(env.BAO_RUN_VIDEO, undefined);
  assert.equal(env.BAO_HOME, undefined);
  assert.equal(env.BAO_HEAL_CURSOR_ACCOUNT, "0");
  assert.equal(env.BAO_LANE, "hermetic");
  assert.equal(env.BAO_TEST_MOCK_KEYCHAIN, undefined);
  assert.deepEqual(ownedChromeLaunchArgs([], env, "darwin").slice(-2), ["--use-mock-keychain", "--password-store=basic"]);
});

test("the live lane turns public demos on, stays headless, and launches the test browser, not installed Chrome", () => {
  const pin = path.join(mkdtempSync(path.join(tmpdir(), "bao-live-pin-")), "Google Chrome for Testing");
  writeFileSync(pin, "");
  chmodSync(pin, 0o755);
  const env = laneChildEnv("live", { BAO_BROWSER: "/tmp/bundle", BAO_LIVE_TESTS: "0", BAO_TEST_BROWSER: "/tmp/parent-pin" }, pin);
  assert.equal(env.BAO_LIVE_TESTS, "1");
  assert.equal(env.BAO_HEADED, "0");
  assert.equal(env.BAO_LANE, "live");
  assert.equal(env.BAO_BROWSER, undefined);
  assert.equal(env.BAO_TEST_BROWSER, pin);
  assert.deepEqual(ownedChromeLaunchArgs([], env, "darwin").slice(-2), ["--use-mock-keychain", "--password-store=basic"]);
  const installed = (file: string) => file === ACCOUNT_CHROME_MAC || file === LINUX_CHROME;
  assert.equal(resolveNormalChrome(installed, env, "darwin"), pin);
  assert.equal(resolveNormalChrome(installed, env, "linux"), pin);
});

test("both lanes stop when the test browser is missing", () => {
  for (const lane of ["hermetic", "live"] as const) {
    assert.throws(() => laneChildEnv(lane, {}, undefined), /npx playwright install chromium/);
    assert.throws(() => laneChildEnv(lane, {}, ""), /npx playwright install chromium/);
  }
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

test("a reachable page keeps product failures and skips a network error only off origin", () => {
  const page = { status: 200, url: "https://example.com/reservation/1" };
  assert.equal(liveSkip(page, { phase: "expect", reason: "Order 403 confirmed" }), undefined);
  assert.equal(liveSkip(page, { phase: "action", reason: "5xx 500" }), undefined);
  assert.equal(liveSkip(page, { phase: "find", reason: "net::ERR_FAILED" }), undefined);
  assert.equal(liveSkip(page, { phase: "action", reason: "status 404" }), undefined);
  assert.deepEqual(liveSkip({ status: 503 }), { result: "unavailable", status: 503 });
  assert.deepEqual(liveSkip({ status: 403 }), { result: "bot-blocked", status: 403 });
  assert.deepEqual(liveSkip({ status: 404 }), { result: "unavailable", status: 404 });
  assert.deepEqual(liveSkip({ status: 0 }), { result: "unavailable", status: 0 });
  assert.equal(liveSkip(page, { phase: "action", reason: "net::ERR_CONNECTION_REFUSED" }), undefined);
  assert.equal(liveSkip(page, { phase: "action", reason: "net::ERR_CONNECTION_REFUSED", url: "https://example.com/api/room/1" }), undefined);
  assert.equal(liveSkip(page, { phase: "action", reason: "fetch failed", url: "https://example.com/api/room/1" }), undefined);
  assert.deepEqual(
    liveSkip(page, { phase: "action", reason: "net::ERR_CONNECTION_REFUSED", url: "https://cdn.example.net/app.js" }),
    { result: "unavailable", status: 0 },
  );
});

test("a 5xx from the page's own API is an environment skip", () => {
  const page = "https://automationintesting.online/reservation/1?checkin=2027-06-01";
  const failure = { phase: "action", reason: "5xx 500" };
  const api = { url: "https://automationintesting.online/api/room/1", status: 500 };
  assert.deepEqual(ownApiOutage(page, failure, [api]), { result: "unavailable", status: 500 });
  assert.deepEqual(
    ownApiOutage(page, { phase: "action", reason: "5xx 502" }, [{ url: "https://automationintesting.online/api/room/1", status: 502 }]),
    { result: "unavailable", status: 502 },
  );
  assert.equal(ownApiOutage(page, failure, []), undefined);
  assert.equal(ownApiOutage(page, failure, undefined), undefined);
  assert.equal(ownApiOutage(page, failure, [{ url: "https://cdn.example.net/room.js", status: 500 }]), undefined);
  assert.equal(ownApiOutage(page, failure, [{ url: "https://automationintesting.online/reservation/1", status: 500 }]), undefined);
  assert.equal(ownApiOutage(page, failure, [{ url: "https://automationintesting.online/api/room/1", status: 404 }]), undefined);
  assert.equal(ownApiOutage(page, { phase: "expect", reason: "5xx 500" }, [api]), undefined);
  assert.equal(ownApiOutage(page, { phase: "find", reason: "5xx 500" }, [api]), undefined);
  assert.equal(ownApiOutage(page, { phase: "action", reason: "calendar missing" }, [api]), undefined);
  assert.equal(liveSkip({ status: 200 }, failure), undefined);
});

test("an artifact leaf cannot leave its run directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-art-"));
  const env = { BAO_ARTIFACTS_DIR: root };
  assert.throws(() => testArtifacts("..", env), /leaf/);
  assert.throws(() => testArtifacts("a/b", env), /leaf/);
  assert.throws(() => testArtifacts("a\\b", env), /leaf/);
  assert.throws(() => testArtifacts("", env), /leaf/);
  assert.throws(() => testArtifacts("   ", env), /leaf/);
  assert.throws(() => testArtifacts("foo/../bar", env), /leaf/);
  assert.equal(testArtifacts("files-dates-public", env), path.join(root, "files-dates-public"));
});

test("inherited BAO names and CI do not reach the launched Chrome", { timeout: 20_000 }, () => {
  const canaries: Record<string, string> = {
    BAO_INVITE_SECRET: "canary-invite-secret",
    BAO_PUBLIC: "canary-public",
    BAO_HEAL_DIR: "canary-heal-dir",
    BAO_REPLAY_HOLD_MS: "canary-hold",
    BAO_SECRET_SHOT: "canary-secret-shot",
    BAO_FIXTURE_URL: "canary-fixture-url",
    BAO_SYNC_SERVER: "canary-sync",
    BAO_SECRETS: "canary-secrets",
    BAO_MCP_SOCK: "canary-mcp-sock",
    BAO_ARTIFACTS_DIR: "canary-artifacts",
    BAO_PROOF_CHROME: "canary-proof-chrome",
    BAO_REMOTE_MCP: "canary-remote-mcp",
    bao_browser: "canary-lower-browser",
    BAO_BROWSER_EVIL: "canary-browser-evil",
    BAO_TEST_RUN_ID: "parent-run-canary",
    CI: "true",
  };
  const pin = "/tmp/bao-lane-pin";
  const env = laneChildEnv("hermetic", { ...process.env, ...canaries, LANG: "C" }, pin);
  const names = Object.keys(env).filter((key) => /^bao/i.test(key)).sort();
  assert.deepEqual(names, [
    "BAO_HEADED",
    "BAO_HEAL_CURSOR_ACCOUNT",
    "BAO_LANE",
    "BAO_REPLAY_VIDEO",
    "BAO_TEST_BROWSER",
    "BAO_TEST_RUN_ID",
  ]);
  assert.equal(env.BAO_HEADED, "0");
  assert.equal(env.BAO_HEAL_CURSOR_ACCOUNT, "0");
  assert.equal(env.BAO_REPLAY_VIDEO, "0");
  assert.equal(env.BAO_LANE, "hermetic");
  assert.equal(env.BAO_TEST_BROWSER, pin);
  assert.notEqual(env.BAO_TEST_RUN_ID, "parent-run-canary");
  assert.equal(env.BAO_LIVE_TESTS, undefined);
  assert.equal(env.CI, undefined);
  assert.equal(ownedChromeLaunchArgs([], env, "linux").includes("--no-sandbox"), false);
  for (const value of Object.values(canaries)) {
    if (value === "true") continue;
    assert.equal(JSON.stringify(env).includes(value), false, value);
  }
  if (process.platform !== "linux") return;

  const dir = mkdtempSync(path.join(tmpdir(), "bao-lane-chrome-"));
  const child = spawn(LINUX_CHROME, [
    "--headless=new",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--disable-gpu",
    "about:blank",
  ], { env, stdio: "ignore", detached: true });
  const pid = child.pid;
  try {
    if (!pid) throw new Error("Chrome pid was missing");
    let raw = "";
    const started = Date.now();
    let last = "missing";
    while (Date.now() - started < 2000) {
      try {
        raw = readFileSync(`/proc/${pid}/environ`).toString("utf8");
        break;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
    }
    if (!raw) throw new Error(`Chrome environ was not readable: ${last}`);
    const got = raw.split("\0").filter(Boolean).map((row) => row.slice(0, row.indexOf("="))).filter((key) => /^bao/i.test(key)).sort();
    assert.deepEqual(got, [
      "BAO_HEADED",
      "BAO_HEAL_CURSOR_ACCOUNT",
      "BAO_LANE",
      "BAO_REPLAY_VIDEO",
      "BAO_TEST_BROWSER",
      "BAO_TEST_RUN_ID",
    ]);
    assert.equal(raw.includes("canary-invite-secret"), false);
    assert.equal(raw.includes("canary-lower-browser"), false);
    assert.equal(raw.includes("canary-browser-evil"), false);
    assert.equal(raw.includes("parent-run-canary"), false);
    assert.equal(raw.includes(`${pin}`), true);
    assert.equal(/(^|\0)CI=/.test(raw), false);
    assert.equal(raw.includes("LANG=C"), true);
  } finally {
    if (pid) {
      try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login-import cookies use the test browser's fixed key, never the login keychain", () => {
  assert.deepEqual(cookieKeys("browser", "darwin"), { platform: "darwin", secret: MAC_MOCK_KEYCHAIN_PASSWORD });
  assert.deepEqual(cookieKeys("browser", "linux"), { platform: "linux" });
  assert.deepEqual(cookieKeys("synthetic-linux", "darwin"), { platform: "linux" });
  assert.deepEqual(cookieKeys("synthetic-linux", "linux"), { platform: "linux" });
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
