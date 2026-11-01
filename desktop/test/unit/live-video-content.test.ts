import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { startApp } from "../../src/app/server";
import { ffmpegBin } from "../../src/v1/replay-video";
import type { RunResult } from "../../src/v1/replay";
import type { WorkflowV2 } from "../../src/v1/schema";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { selfSignedCert } from "../instacart/cert";

const ffmpeg = ffmpegBin();

for (const evalVideoNoBlur of [true, undefined] as const) {
  it(`${evalVideoNoBlur ? "eval" : "ordinary"} short replay video contains the rendered result, not just startup frames`, { skip: !ffmpeg, timeout: 60_000 }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-video-content-"));
    const cert = selfSignedCert(["www.instacart.com"]);
    let typed = "";
    const site = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      if (req.method === "POST") {
        req.on("data", (chunk: Buffer) => { typed += chunk.toString(); });
        req.on("end", () => res.end("ok"));
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><html><body style="background:white">
        <div role="dialog" aria-label="Registration">
          <h1>Contact details</h1><button onclick="this.parentNode.remove()">Close</button>
          <label for="phone">Contact phone</label><input id="phone" type="tel"
            oninput="document.body.style.background='#008000';fetch('/typed',{method:'POST',body:this.value})">
        </div></body></html>`);
    });
    let browser: FixtureBrowser | undefined;
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    const before = process.env.BAO_RUN_VIDEO;
    process.env.BAO_RUN_VIDEO = "1";
    try {
      await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
      const address = site.address();
      assert.ok(address && typeof address !== "string");
      browser = await launchFixtureBrowser({ port: address.port, spki: cert.spki });
      app = await startApp({ home, port: 0, extensionHost: false, liveTarget: `throwaway:${browser.portFile}`, liveLockFile: path.join(home, "lock"), evalVideoNoBlur });
      const workflow: WorkflowV2 = {
        schema: "bao.workflow/v2", version: 2, id: "phone-video", name: "Enter a contact number", createdAt: 0,
        driver: "cdp-live", startUrl: "https://www.instacart.com/store/costco/storefront", inputs: [],
        steps: [{ id: "phone", index: 0, surface: "dom", action: "type", label: "Contact phone", value: "415", timeoutMs: 2000,
          identity: { surface: "dom", role: "textbox", id: "phone", name: "Contact phone", path: [{ role: "dialog", name: "Registration" }] } }],
      };
      const response = await fetch(`http://127.0.0.1:${app.port}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "live_replay", workflow }) });
      assert.equal(response.status, 200);
      const { run } = await response.json() as { run: RunResult };
      assert.equal(run.status, "passed", JSON.stringify(run.failure));
      assert.equal(run.modelCalls, 0);
      assert.equal(typed, "415");
      assert.ok(run.video, run.traceUnavailable);
      const decoded = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", path.join(home, "videos", run.video), "-vf", "scale=16:16", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { maxBuffer: 16 * 1024 * 1024 });
      assert.equal(decoded.status, 0, decoded.stderr.toString());
      const frameSize = 16 * 16 * 3;
      assert.ok(decoded.stdout.length >= frameSize);
      const lastFrame = decoded.stdout.subarray(-frameSize);
      const pixel = 15 * 16 * 3;
      const r = lastFrame[pixel]!;
      const g = lastFrame[pixel + 1]!;
      const b = lastFrame[pixel + 2]!;
      const contrast = evalVideoNoBlur ? 50 : 12;
      assert.ok(g > r + contrast && g > b + contrast, `last frame must show the green post-input page, got RGB ${r},${g},${b}`);
      if (!evalVideoNoBlur) assert.ok(r >= 190 && b >= 190, "ordinary replay keeps its privacy veil");
    } finally {
      await app?.close();
      await browser?.close();
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
      if (before === undefined) delete process.env.BAO_RUN_VIDEO; else process.env.BAO_RUN_VIDEO = before;
    }
  });
}
