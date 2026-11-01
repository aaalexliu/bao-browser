import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { startApp } from "../../src/app/server";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { LIVE_DISCONNECT } from "../../src/cdp-live/live-ops";
import { pinTestBrowser } from "../../src/launch";
import { Library } from "../../src/v1/store";
import { launchFixtureBrowser } from "../instacart/browser";
import { startInstacartFixture } from "../instacart/fixture";

type Reply = { outcome: { kind: string; reason?: string }; session?: string; view?: { controls: { ref: string; label: string }[] } };

const enabled = process.env.BAO_LIVE_TESTS === "1";

test("video encoding failure keeps saved captures and action status across all stop paths", { skip: !enabled, timeout: 180_000 }, async (t) => {
  pinTestBrowser();
  const fixture = await startInstacartFixture();
  const browser = await launchFixtureBrowser(fixture);
  const observer = await chromium.connectOverCDP(browser.cdpUrl);
  const processes = require("node:child_process") as typeof import("node:child_process");
  const spawn = processes.spawn;
  let encodes = 0;
  t.mock.method(processes, "spawn", ((_file: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => {
    if (args.includes("concat")) {
      encodes++;
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(_file, args, options);
  }) as typeof processes.spawn);
  const results: unknown[] = [];
  try {
    for (const mode of ["passed", "refused", "halted", "disconnect", "idle", "save-error"] as const) {
      const home = await mkdtemp(path.join(tmpdir(), "bao-video-stop-"));
      const target = { kind: "throwaway" as const, portFile: browser.portFile };
      const host = createLiveHost({ home, target, lockFile: path.join(home, "live.lock"), idleMs: mode === "idle" ? 150 : 0,
        selectRun: async () => ({ target, engineName: "old", artifactRoot: home }) });
      let restoreSave: (() => void) | undefined;
      try {
        const started = await host.call({ op: "live_session_start", intent: "Search the local fixture", client: "fixture-agent", url: fixture.url("/store/costco/storefront") }) as Reply;
        assert.equal(started.outcome.kind, "applied", JSON.stringify(started));
        const ref = started.view?.controls.find((item) => item.label === "Search Costco")?.ref;
        assert.ok(ref);
        const typed = await host.call({ op: "live_type", ref, text: "blueberries" }) as Reply;
        assert.equal(typed.outcome.kind, "applied", JSON.stringify(typed));
        if (mode === "refused") assert.equal(((await host.call({ op: "live_click", ref: "expired" })) as Reply).outcome.kind, "refused");
        if (mode === "halted") {
          await observer.contexts()[0]!.newPage().catch(() => undefined);
          assert.equal(((await host.call({ op: "live_snapshot" })) as Reply).outcome.kind, "halted");
        }
        if (mode === "save-error") {
          const save = t.mock.method(Library.prototype, "save", () => { throw new Error("fixture workflow save failed"); });
          restoreSave = () => save.mock.restore();
        }
        const beforeEncodes = encodes;
        let stopped: Reply;
        if (mode === "idle") {
          const deadline = Date.now() + 20_000;
          while (host.isOpen() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
          assert.equal(host.isOpen(), false);
          stopped = await host.call({ op: "live_stop" }) as Reply;
        } else {
          stopped = await host.call(mode === "disconnect" ? { op: LIVE_DISCONNECT, client: "fixture-agent" } : { op: "live_stop" }) as Reply;
        }
        assert.ok(encodes > beforeEncodes, "the actual final encoding boundary failed");
        const library = new Library(home);
        if (mode === "save-error") {
          assert.equal(stopped.outcome.kind, "rejected");
          assert.equal(stopped.outcome.reason, "fixture workflow save failed");
          assert.deepEqual(library.listRuns(), []);
          continue;
        }
        assert.equal(stopped.outcome.kind, "stopped");
        if (mode !== "idle") assert.match(stopped.outcome.reason || "", /Workflow saved; video unavailable: CDP video encoding failed/);
        const workflow = library.read(started.session!);
        assert.equal(workflow.steps.length, 1);
        const run = library.listRuns()[0]!;
        const expected = mode === "refused" ? "failed" : mode === "halted" ? "needs_human" : "passed";
        assert.equal(run.kind, "capture");
        assert.equal(run.status, expected);
        assert.equal(run.modelCalls, 0);
        assert.equal(run.video, undefined);
        assert.equal(run.traceUnavailable, "video unavailable: CDP video encoding failed");
        assert.equal((JSON.parse(await readFile(path.join(home, "live-session", "session.json"), "utf8")) as { status: string }).status, expected);
        assert.ok((run.steps[0] as { afterShot?: string }).afterShot);
        results.push({ mode, stopped, run });
        if (mode === "passed" && process.env.AGENT_BROWSER_PARITY_ARTIFACTS) {
          const app = await startApp({ home, port: 0, liveTarget: `throwaway:${browser.portFile}`, liveLockFile: path.join(home, "app.lock") });
          const ui = await chromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
          try {
            const page = await ui.newPage({ viewport: { width: 1400, height: 1000 } });
            await page.goto(`http://127.0.0.1:${app.port}/`);
            await page.locator('#rail [data-screen="runs"]').click();
            await page.locator(`[data-open-run="${run.id}"]`).click();
            assert.equal(await page.locator("#trace-unavailable").innerText(), run.traceUnavailable);
            await page.screenshot({ path: path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, "missing-video-after.png"), fullPage: true });
          } finally { await ui.close(); await app.close(); }
        }
        process.kill(browser.pid, 0);
      } finally {
        restoreSave?.();
        await host.close();
        await rm(home, { recursive: true, force: true });
      }
    }
    if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) await writeFile(path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, "capture-video-failure.json"), JSON.stringify(results, null, 2));
  } finally { await observer.close(); await browser.close(); await fixture.close(); }
});
