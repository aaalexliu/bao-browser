import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { helperJobList, htmlEsc, rail } from "../../src/app/views";
import type { AutomationReport } from "../../src/cdp-live/automation";
import { AUTOMATION_DENIED } from "../../src/cdp-live/remote-debugging";
import { chromeHelper } from "../../src/cdp-live/ax";
import {
  capabilityReport,
  liveChromeBlock,
  usesScreenRecording,
} from "../../src/helper-capabilities";
import { MacOsHelper } from "../../src/proxy/os-macos";

const LIVE_ENTRIES = ["session.ts", "instacart-run.ts", "login-diff.ts", "run.ts"];

function liveEntryProblem(src: string): string | undefined {
  if (src.includes("screen recording is granted; not starting")) return "old throw";
  if (src.includes("new MacOsHelper")) return "raw helper";
  if (!src.includes("chromeHelper(")) return "missing chromeHelper";
  if (!src.includes("liveChromeBlock(")) return "missing liveChromeBlock";
  return undefined;
}

test("live Chrome starts when Screen Recording is already granted", () => {
  assert.equal(
    liveChromeBlock({ accessibility: true, screenCapture: true, prompted: false }),
    undefined,
  );
  assert.equal(
    liveChromeBlock({ accessibility: true, screenCapture: false, prompted: false }),
    undefined,
  );
});

test("live Chrome still requires Accessibility and still refuses a permission prompt", () => {
  assert.equal(
    liveChromeBlock({ accessibility: false, screenCapture: true }),
    "BaoOSHelper accessibility is not granted",
  );
  assert.equal(
    liveChromeBlock({ accessibility: true, prompted: true, screenCapture: false }),
    "helper asked for a permission prompt",
  );
});

test("live Chrome rejects window capture without calling it", async () => {
  assert.equal(usesScreenRecording([["permissions"], ["nodes", "--bundle", "com.google.Chrome"], ["press"]]), false);
  assert.equal(usesScreenRecording([["shot", "--bundle", "com.google.Chrome", "--out", "/tmp/bao-live.png"]]), true);
  const live = chromeHelper();
  await assert.rejects(
    () => MacOsHelper.prototype.shot.call(live, "com.google.Chrome", "/tmp/bao-live.png"),
    /live Chrome does not use screen recording/,
  );
  await assert.rejects(
    () => live.exec(["shot", "--bundle", "com.google.Chrome", "--out", "/tmp/bao-live.png"]),
    /live Chrome does not use screen recording/,
  );
  const wiped = live as Omit<MacOsHelper, "shot"> & { shot?: MacOsHelper["shot"] };
  delete wiped.shot;
  await assert.rejects(
    () => live.shot("com.google.Chrome", "/tmp/bao-live.png"),
    /live Chrome does not use screen recording/,
  );
  assert.equal(live.calls.some((call) => call[0] === "shot"), false);
  const other = new MacOsHelper(live.bin);
  assert.equal(other.refuseWindowShot, false);
});

test("live Chrome helper refuses nodes outside stable Chrome before launching the helper", async () => {
  const live = chromeHelper();
  for (const bundle of [
    "com.apple.UserNotificationCenter", "", "com.google.Chrome.helper", "com.google.Chrome.evil",
    "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary", "com.google.chrome.for.testing",
  ]) {
    await assert.rejects(live.nodes(bundle), /target bundle must be com\.google\.Chrome/);
  }
  for (const args of [
    ["nodes"],
    ["nodes", "--pid", "123"],
    ["nodes", "--bundle"],
    ["nodes", "--bundle", "com.google.Chrome", "--bundle", "com.apple.UserNotificationCenter"],
    ["nodes", "--bundle", "com.google.Chrome", "--bundle", "com.google.Chrome"],
  ]) {
    await assert.rejects(live.exec(args), /target bundle must be com\.google\.Chrome/);
  }
  await assert.rejects(live.windows("com.google.Chrome"), /Screen Recording is not used/);
  await assert.rejects(live.permissions(true), /Screen Recording is not used/);
  assert.deepEqual(live.calls, []);
});

test("live Chrome helper accepts stable Chrome nodes and skips ScreenCapture preflight", async (t) => {
  const sent: string[][] = [];
  t.mock.method(MacOsHelper.prototype, "exec", async (args: string[]) => {
    sent.push(args);
    return { ok: true };
  });
  const live = chromeHelper();
  await live.nodes("com.google.Chrome", 42);
  await live.nodes("com.google.Chrome");
  await live.permissions(false);
  assert.deepEqual(sent, [
    ["nodes", "--bundle", "com.google.Chrome", "--pid", "42"],
    ["nodes", "--bundle", "com.google.Chrome"],
    ["permissions-ax"],
  ]);
});

test("live Chrome helper leaves other commands' bundle handling to the native helper", async (t) => {
  const sent: string[][] = [];
  t.mock.method(MacOsHelper.prototype, "exec", async (args: string[]) => {
    sent.push(args);
    return { ok: true };
  });
  const live = chromeHelper();
  for (const bundle of ["com.google.Chrome", "com.google.chrome.for.testing", "com.example.test", ""]) {
    await live.press({ platform: "macos", app: bundle, role: "AXButton", name: "Allow", path: [] }, 42);
    await live.hit(10, 20, bundle);
    await live.focused(bundle);
    assert.deepEqual(sent.slice(-3), [
      ["press", "--bundle", bundle, "--role", "AXButton", "--name", "Allow", "--pid", "42"],
      ["hit", "--x", "10", "--y", "20", "--allow-bundle", bundle],
      ["focus", "--allow-bundle", bundle],
    ]);
  }
  for (const command of [
    "read", "set-value", "focus-role", "move-window", "key", "type-keys", "cg-key", "cg-type",
    "fixture", "windows-brief", "close-window", "raise-window", "set-window-text", "confirm-text",
  ]) {
    const args = [command, "--bundle", "com.example.test"];
    await live.exec(args);
    assert.deepEqual(sent.at(-1), args);
  }
  await live.moveWindow("", { x: 50, y: 50, w: 550, h: 500 }, { pid: 42, frontmost: true });
  assert.deepEqual(sent.at(-1), ["move-window", "--pid", "42", "--frontmost", "--x", "50", "--y", "50", "--w", "550", "--h", "500"]);
});

test("live entries keep the shared gate", () => {
  for (const name of LIVE_ENTRIES) {
    const src = readFileSync(path.join(process.cwd(), "desktop/src/cdp-live", name), "utf8");
    assert.equal(liveEntryProblem(src), undefined, name);
    const thrown = `${src}\nthrow new Error("BaoOSHelper screen recording is granted; not starting");\n`;
    assert.equal(liveEntryProblem(thrown), "old throw", name);
    const raw = `${src}\nconst other = new MacOsHelper(bin);\n`;
    assert.equal(liveEntryProblem(raw), "raw helper", name);
  }
});

test("helper status requires Accessibility and Automation, not Screen Recording", () => {
  const axOnly = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: false,
    automation: { state: "granted", message: "allowed" },
  });
  assert.equal(axOnly.label, "helper ok");
  assert.equal(axOnly.accessibility, true);
  assert.equal(axOnly.screenCapture, false);
  const axStatus = axOnly.capabilities.map((row) => row.status);
  assert.deepEqual(axStatus, [
    "AX press ready",
    "optional window capture needs Screen Recording (not needed for Chrome)",
    "live Chrome ready",
    "optional native-app MCP driver needs Accessibility and Screen Recording (not needed for Chrome)",
  ]);
  assert.deepEqual(axOnly.capabilities.filter((row) => row.optional).map((row) => row.id), ["window-capture", "mcp-ax"]);

  const both = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: true,
    automation: { state: "granted", message: "allowed" },
  });
  assert.equal(both.label, "helper ok");
  assert.deepEqual(both.capabilities.map((row) => row.status), [
    "AX press ready",
    "window capture ready",
    "live Chrome ready",
    "MCP driver ready",
  ]);

  const screenOnly = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: false,
    screenCapture: true,
  });
  assert.equal(screenOnly.label, "helper needs permission");
  assert.ok(screenOnly.capabilities.some((row) => row.status === "window capture ready"));
  assert.ok(screenOnly.capabilities.some((row) => row.status === "live Chrome needs Accessibility"));

  const linux = capabilityReport({
    platform: "linux",
    helperPresent: false,
    accessibility: true,
    screenCapture: true,
  });
  assert.equal(linux.label, "helper off");
  assert.equal(linux.accessibility, false);
  assert.equal(linux.screenCapture, false);
  assert.deepEqual(linux.capabilities, []);

  const noBundle = capabilityReport({
    platform: "darwin",
    helperPresent: false,
    accessibility: true,
    screenCapture: true,
  });
  assert.equal(noBundle.label, "helper off");
  assert.deepEqual(noBundle.capabilities, []);
});

test("live Chrome readiness counts Automation or an existing listener without counting Screen Recording", () => {
  const reports: (AutomationReport | undefined)[] = [
    { state: "granted", message: "allowed" },
    { state: "closed", message: "Chrome is not open" },
    { state: "not-asked", message: "not yet asked" },
    { state: "denied", message: AUTOMATION_DENIED },
    { state: "unavailable", message: "BaoOSHelper is older than this Bao; rebuild it" },
    undefined,
  ];
  for (const report of reports) {
    for (const remoteDebugging of [false, true]) {
      for (const accessibility of [false, true]) {
        for (const screenCapture of [false, true]) {
          const automation = report ? { ...report, remoteDebugging } : undefined;
          const helper = capabilityReport({ platform: "darwin", helperPresent: true, accessibility, screenCapture, automation });
          const live = helper.capabilities.find((row) => row.id === "live-chrome")?.status;
          const ready = accessibility && !!automation && (automation.state === "granted" || automation.state === "closed" || remoteDebugging);
          const context = JSON.stringify({ automation, accessibility, screenCapture });
          assert.equal(live === "live Chrome ready", ready, context);
          if (!accessibility) {
            assert.equal(live, "live Chrome needs Accessibility", context);
          } else if (!ready && automation?.state === "not-asked") {
            assert.equal(live, "live Chrome needs one more permission: use Allow beside Automation: Google Chrome", context);
          } else if (!ready && automation?.state === "denied") {
            assert.equal(live, `live Chrome needs one more permission: ${AUTOMATION_DENIED}`, context);
          } else if (!ready) {
            assert.ok(live?.startsWith("live Chrome Automation status unavailable:"), context);
            if (automation) assert.ok(live?.includes(automation.message), context);
          }
          assert.ok(helperJobList(helper).includes(htmlEsc(live)), context);
          assert.ok(rail({ helper }).includes(htmlEsc(live)), context);
          const labelReady = accessibility && (automation?.state === "granted" || automation?.state === "closed");
          assert.equal(helper.label, labelReady ? "helper ok" : "helper needs permission", context);
          assert.equal(helper.capabilities.find((row) => row.id === "window-capture")?.status, screenCapture ? "window capture ready" : "optional window capture needs Screen Recording (not needed for Chrome)");
        }
      }
    }
  }
});

function helperLine(html: string): string | undefined {
  return html.match(/<div class="channel" id="helper-status">([^<]*)<\/div>/)?.[1];
}

function jobRows(html: string): string[] {
  const list = html.match(/<ul class="helper-jobs">(.*?)<\/ul>/)?.[1] ?? "";
  return [...list.matchAll(/<li>([^<]*)<\/li>/g)].map((row) => row[1]);
}

test("the footer shows Chrome readiness and one quiet line for optional native capture", () => {
  const both = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: true,
    automation: { state: "granted", message: "allowed" },
  });
  assert.deepEqual(jobRows(helperJobList(both)), [
    "AX press ready",
    "live Chrome ready",
  ]);
  const html = rail({ helper: both });
  assert.equal(helperLine(html), "helper ok");
  assert.deepEqual(jobRows(html), both.capabilities.filter((row) => !row.optional).map((row) => row.status));

  const axOnly = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: false,
    automation: { state: "granted", message: "allowed" },
  });
  const axHtml = rail({ helper: axOnly });
  assert.equal(helperLine(axHtml), "helper ok");
  assert.deepEqual(jobRows(axHtml), [
    "AX press ready",
    "live Chrome ready",
  ]);
  assert.match(axHtml, /<p class="quiet">Native-app capture is optional and not needed for Chrome\.<\/p>/);
  assert.doesNotMatch(axHtml, /Screen Recording|MCP driver needs|window capture needs/);
  assert.doesNotMatch(axHtml, /helper needs permission AX press ready/);
  assert.doesNotMatch(axHtml, /BaoOSHelper screen recording is granted/);

  const off = capabilityReport({
    platform: "linux",
    helperPresent: false,
  });
  assert.equal(helperJobList(off), "");
  assert.equal(helperLine(rail({ helper: off })), "helper off");
  assert.equal(helperLine(rail({})), "helper off");
});
