import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import type { CdpSocket } from "../../src/cdp-live/socket";
import * as cdpVideo from "../../src/engines/cdp-video";

for (const recording of [false, true]) {
  for (const fails of [false, true]) {
    test(`redacted capture ${fails ? "failure" : "success"} ${recording ? "waits for recording" : "needs no recording delay"}`, { timeout: 2000 }, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const calls: string[] = [];
      const image = Buffer.from("screenshot");
      const cdp = {
        async send(method: string) {
          calls.push(method);
          if (method === "Page.captureScreenshot") {
            if (fails) throw new Error("shot failed");
            return { data: image.toString("base64") };
          }
          return { result: {} };
        },
      } as unknown as CdpSocket;
      const video: cdpVideo.CdpVideo = {
        pause() { calls.push("pause"); },
        resume() { calls.push("resume"); },
        async endCapture() {},
        async stop() { return { wrote: false, frames: 0, truncated: false }; },
      };
      t.mock.method(cdpVideo, "startCdpVideo", async () => video);
      const driver = new CdpLiveDriver(cdp, "session", "tab");
      if (recording) await driver.startVideo("unused.webm");
      let settled = false;
      const capture = driver.captureRedacted("evidence").then(
        (png) => { settled = true; return { png, error: "" }; },
        (error: Error) => { settled = true; return { png: undefined, error: error.message }; },
      );
      await setImmediate();
      assert.equal(calls.at(-1), "Runtime.evaluate", "remove the veil before waiting or resuming");
      assert.equal(settled, !recording);
      if (recording) {
        assert.equal(calls[0], "pause");
        t.mock.timers.tick(99);
        await setImmediate();
        assert.equal(settled, false);
        assert.equal(calls.includes("resume"), false);
        t.mock.timers.tick(1);
      }
      const result = await capture;
      if (fails) assert.equal(result.error, "shot failed");
      else assert.deepEqual(result.png, image);
      assert.equal(calls.filter((call) => call === "resume").length, recording ? 1 : 0);
    });
  }
}
