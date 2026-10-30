import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { helperJobList, rail } from "../../src/app/views";
import { chromeHelper } from "../../src/cdp-live/ax";
import {
  capabilityReport,
  liveChromeBlock,
  usesScreenRecording,
} from "../../src/helper-capabilities";
import { MacOsHelper } from "../../src/proxy/os-macos";

const LIVE_ENTRIES = ["session.ts", "instacart-run.ts", "login-diff.ts", "run.ts", "live-target.ts"];

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

test("helper status names each job and keeps the old label", () => {
  const axOnly = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: false,
  });
  assert.equal(axOnly.label, "helper needs permission");
  assert.equal(axOnly.accessibility, true);
  assert.equal(axOnly.screenCapture, false);
  const axStatus = axOnly.capabilities.map((row) => row.status);
  assert.deepEqual(axStatus, [
    "AX press ready",
    "window capture needs Screen Recording",
    "live Chrome ready",
    "MCP driver needs Accessibility and Screen Recording",
  ]);

  const both = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: true,
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

function helperLine(html: string): string | undefined {
  return html.match(/<div class="channel" id="helper-status">([^<]*)<\/div>/)?.[1];
}

function jobRows(html: string): string[] {
  const list = html.match(/<ul class="helper-jobs">(.*?)<\/ul>/)?.[1] ?? "";
  return [...list.matchAll(/<li>([^<]*)<\/li>/g)].map((row) => row[1]);
}

test("the footer shows each job on its own line and still says helper ok", () => {
  const both = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: true,
  });
  assert.deepEqual(jobRows(helperJobList(both)), [
    "AX press ready",
    "window capture ready",
    "live Chrome ready",
    "MCP driver ready",
  ]);
  const html = rail({ helper: both });
  assert.equal(helperLine(html), "helper ok");
  assert.deepEqual(jobRows(html), both.capabilities.map((row) => row.status));

  const axOnly = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: false,
  });
  const axHtml = rail({ helper: axOnly });
  assert.equal(helperLine(axHtml), "helper needs permission");
  assert.deepEqual(jobRows(axHtml), [
    "AX press ready",
    "window capture needs Screen Recording",
    "live Chrome ready",
    "MCP driver needs Accessibility and Screen Recording",
  ]);
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
