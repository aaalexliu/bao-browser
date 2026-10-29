import assert from "node:assert/strict";
import test from "node:test";
import { helperStatusText, rail } from "../../src/app/views";
import {
  capabilityReport,
  forbidScreenRecording,
  liveChromeBlock,
  usesScreenRecording,
} from "../../src/helper-capabilities";

test("live Chrome starts when Screen Recording is already granted", () => {
  assert.equal(
    liveChromeBlock({ accessibility: true, screenCapture: true, prompted: false }),
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
  let captured = false;
  const helper = {
    shot: async (_bundle: string, _out: string) => {
      captured = true;
      return { ok: true };
    },
  };
  forbidScreenRecording(helper);
  await assert.rejects(
    () => helper.shot("com.google.Chrome", "/tmp/bao-live.png"),
    /live Chrome does not use screen recording/,
  );
  assert.equal(captured, false);
  assert.equal(usesScreenRecording([["permissions"], ["nodes", "--bundle", "com.google.Chrome"], ["press"]]), false);
  assert.equal(usesScreenRecording([["shot", "--bundle", "com.google.Chrome", "--out", "/tmp/bao-live.png"]]), true);
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
    "native automation ready",
    "window capture needs Screen Recording",
    "live Chrome ready",
    "extension replay ready",
  ]);

  const both = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: true,
  });
  assert.equal(both.label, "helper ok");
  assert.deepEqual(both.capabilities.map((row) => row.status), [
    "native automation ready",
    "window capture ready",
    "live Chrome ready",
    "extension replay ready",
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

test("the footer shows each job and still says helper ok", () => {
  const both = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: true,
  });
  const text = helperStatusText(both);
  assert.match(text, /helper ok/);
  assert.match(text, /live Chrome ready/);
  assert.match(text, /window capture ready/);
  const html = rail({ helper: both });
  assert.match(html, /id="helper-status"/);
  assert.match(html, /helper ok/);
  assert.match(html, /live Chrome ready/);
  assert.match(html, /window capture ready/);

  const axOnly = capabilityReport({
    platform: "darwin",
    helperPresent: true,
    accessibility: true,
    screenCapture: false,
  });
  const axHtml = rail({ helper: axOnly });
  assert.match(axHtml, /helper needs permission/);
  assert.match(axHtml, /live Chrome ready/);
  assert.doesNotMatch(axHtml, /BaoOSHelper screen recording is granted/);
});
