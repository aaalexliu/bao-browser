import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { LIVE_DISCONNECT } from "../../src/cdp-live/live-ops";
import { AgentBrowserPage } from "../../src/engines/agent-browser";
import { pinTestBrowser } from "../../src/launch";
import { Library } from "../../src/v1/store";
import { launchFixtureBrowser } from "../instacart/browser";
import { startInstacartFixture } from "../instacart/fixture";

type Reply = { outcome: { kind: string; reason?: string }; shot: string; view?: { controls: { ref: string; label: string }[] } };
const enabled = process.env.BAO_LIVE_TESTS === "1";
const proof = process.env.AGENT_BROWSER_PARITY_ARTIFACTS;
const stage = process.env.BAO_REVIEW_PROOF_STAGE || "after";

test("transient screenshot veil blocks hit testing and exposes its caption in AX", { skip: !enabled || !process.env.AGENT_BROWSER_PARITY_BINARY, timeout: 120_000 }, async (t) => {
  pinTestBrowser();
  if (proof) await mkdir(proof, { recursive: true });
  const fixture = await startInstacartFixture();
  const browser = await launchFixtureBrowser(fixture);
  const observer = await chromium.connectOverCDP(browser.cdpUrl);
  const previous = process.env.BAO_AGENT_BROWSER;
  process.env.BAO_AGENT_BROWSER = process.env.AGENT_BROWSER_PARITY_BINARY;
  try {
    for (const engine of ["old", "agent-browser"] as const) await t.test(engine, async (t) => {
      const home = await mkdtemp(path.join(tmpdir(), "bao-transient-veil-"));
      const target = { kind: "throwaway" as const, portFile: browser.portFile };
      const host = createLiveHost({ home, target, lockFile: path.join(home, "live.lock"), idleMs: 0,
        selectRun: async () => ({ target, engineName: engine }) });
      const observed: { hitBlocked: boolean; captionAccessible: boolean; ariaHidden: string | null; caption: string }[] = [];
      const screenshot = CdpLiveDriver.prototype.screenshotPng;
      t.mock.method(CdpLiveDriver.prototype, "screenshotPng", async function(this: CdpLiveDriver) {
        const page = observer.contexts().flatMap((context) => context.pages()).find((page) => page.url() === fixture.url("/store/costco/storefront"));
        assert.ok(page);
        const box = await page.getByLabel("Search Costco", { exact: true }).boundingBox();
        assert.ok(box);
        const hitBlocked = await page.evaluate(({ x, y }) => document.getElementById("bao-redact")!.contains(document.elementFromPoint(x, y)), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        const veil = page.locator("#bao-redact");
        const caption = await veil.innerText();
        const session = await page.context().newCDPSession(page);
        try {
          const ax = await session.send("Accessibility.getFullAXTree");
          observed.push({ hitBlocked, captionAccessible: ax.nodes.some((node) => !node.ignored && node.name?.value === caption), ariaHidden: await veil.getAttribute("aria-hidden"), caption });
        } finally { await session.detach(); }
        return screenshot.call(this);
      });
      try {
        const started = await host.call({ op: "live_session_start", intent: "Read-only veil proof", url: fixture.url("/store/costco/storefront") }) as Reply;
        assert.equal(started.outcome.kind, "applied", JSON.stringify(started));
        const page = observer.contexts().flatMap((context) => context.pages()).find((page) => page.url() === fixture.url("/store/costco/storefront"));
        assert.ok(page);
        assert.equal(await page.locator("#bao-redact").count(), 0);
        const shot = await host.call({ op: "live_screenshot" }) as Reply;
        assert.ok(shot.shot);
        const png = await readFile(path.join(home, "live-session", "shots", shot.shot));
        assert.equal(await page.locator("#bao-redact").count(), 0);
        assert.ok((await page.locator("body").innerText()).includes("Costco"));
        if (proof) {
          await writeFile(path.join(proof, `veil-${stage}-${engine}-step.png`), png);
          await page.screenshot({ path: path.join(proof, `veil-${stage}-${engine}-live.png`) });
        }
        if (engine === "agent-browser") {
          t.mock.method(AgentBrowserPage.prototype, "screenshot", async function(this: AgentBrowserPage) {
            await this.close();
            throw new Error("fixture screenshot transport stopped");
          });
          const failed = await host.call({ op: "live_screenshot" }) as Reply;
          assert.equal(failed.shot, "");
          assert.equal(await page.locator("#bao-redact").count(), 0, "exact-session cleanup survives native transport failure");
        }
        await page.goto(fixture.url("/store/costco/s?k=blueberries"));
        assert.equal(await page.locator("#bao-redact").count(), 0);
        assert.ok((await page.locator("body").innerText()).includes("Results for"));
        if (proof) {
          await page.screenshot({ path: path.join(proof, `veil-${stage}-${engine}-navigation.png`) });
          await writeFile(path.join(proof, `veil-${stage}-${engine}.json`), JSON.stringify(observed, null, 2));
        }
        assert.ok(observed.length >= 2);
        for (const item of observed) {
          assert.equal(item.hitBlocked, true, "the transient veil blocks targeting the input underneath");
          assert.equal(item.captionAccessible, true, "the veil caption retains base AX visibility");
          assert.equal(item.ariaHidden, null);
        }
        process.kill(browser.pid, 0);
      } finally { await host.close(); await rm(home, { recursive: true, force: true }); }
    });
  } finally {
    if (previous === undefined) delete process.env.BAO_AGENT_BROWSER; else process.env.BAO_AGENT_BROWSER = previous;
    await observer.close(); await browser.close(); await fixture.close();
  }
});

test("capture clips have an adopter or are removed after encoding ends", { skip: !enabled, timeout: 180_000 }, async (t) => {
  pinTestBrowser();
  if (proof) await mkdir(proof, { recursive: true });
  const fixture = await startInstacartFixture();
  const browser = await launchFixtureBrowser(fixture);
  const observer = await chromium.connectOverCDP(browser.cdpUrl);
  try {
    for (const mode of ["read-only", "workflow-save-error", "run-save-error", "startup-error", "passed", "refused", "halted", "disconnect-empty", "idle-empty", "close-empty"] as const) await t.test(mode, async (t) => {
      const home = await mkdtemp(path.join(tmpdir(), "bao-capture-owner-"));
      const library = new Library(home);
      const videos = path.join(home, "videos");
      await mkdir(videos, { recursive: true });
      const sentinel = Buffer.from("another run owns this file");
      await writeFile(path.join(videos, "run-sentinel.webm"), sentinel);
      await writeFile(path.join(home, "caller-owned.txt"), sentinel);
      library.saveRun({ id: "run-sentinel", workflowId: "wf-sentinel", kind: "capture", status: "passed", at: 0, steps: [], heals: [], modelCalls: 0, video: "run-sentinel.webm" });
      const target = { kind: "throwaway" as const, portFile: browser.portFile };
      const host = createLiveHost({ home, target, lockFile: path.join(home, "live.lock"), idleMs: mode === "idle-empty" ? 100 : 0,
        selectRun: async () => ({ target, engineName: "old", artifactRoot: home }) });
      let destination = "";
      let created = false;
      let frameSaved: () => void = () => {};
      const firstFrame = new Promise<void>((resolve) => { frameSaved = resolve; });
      const fs = require("node:fs/promises") as typeof import("node:fs/promises");
      const write = fs.writeFile;
      t.mock.method(fs, "writeFile", async (...args: Parameters<typeof writeFile>) => {
        await write(...args);
        if (String(args[0]).includes("/bao-cdp-video-") && path.basename(String(args[0])).startsWith("frame-")) frameSaved();
      });
      const startVideo = CdpLiveDriver.prototype.startVideo;
      t.mock.method(CdpLiveDriver.prototype, "startVideo", async function(this: CdpLiveDriver, file: string) {
        destination = file;
        await startVideo.call(this, file);
      });
      const finishVideo = CdpLiveDriver.prototype.finishVideo;
      t.mock.method(CdpLiveDriver.prototype, "finishVideo", async function(this: CdpLiveDriver) {
        const result = await finishVideo.call(this);
        assert.equal(result.wrote, true, "successful encoding is required to reproduce the orphan");
        assert.ok((await stat(destination)).size > 1000, "the owned clip exists before cleanup");
        created = true;
        if (proof) await writeFile(path.join(proof, `clip-${stage}-${mode}.webm`), await readFile(destination));
        return result;
      });
      if (mode === "startup-error") {
        const goto = CdpLiveDriver.prototype.goto;
        t.mock.method(CdpLiveDriver.prototype, "goto", async function(this: CdpLiveDriver, url: string) {
          await goto.call(this, url);
          await this.captureRedacted("startup failure proof");
          await firstFrame;
          throw new Error("fixture startup failed after video started");
        });
      }
      try {
        const started = await host.call({ op: "live_session_start", intent: "Search the local fixture", client: "owner-test", url: fixture.url("/store/costco/storefront") }) as Reply;
        if (mode === "startup-error") {
          assert.equal(started.outcome.kind, "rejected");
          assert.equal(started.outcome.reason, "fixture startup failed after video started");
        } else {
          assert.equal(started.outcome.kind, "applied", JSON.stringify(started));
          if (["passed", "refused", "halted", "workflow-save-error", "run-save-error"].includes(mode)) {
            const ref = started.view?.controls.find((item) => item.label === "Search Costco")?.ref;
            assert.ok(ref);
            assert.equal(((await host.call({ op: "live_type", ref, text: "blueberries" })) as Reply).outcome.kind, "applied");
          } else assert.equal(((await host.call({ op: "live_snapshot" })) as Reply).outcome.kind, "applied");
          if (mode === "refused") assert.equal(((await host.call({ op: "live_click", ref: "expired" })) as Reply).outcome.kind, "refused");
          if (mode === "halted") {
            await observer.contexts()[0]!.newPage().catch(() => undefined);
            assert.equal(((await host.call({ op: "live_snapshot" })) as Reply).outcome.kind, "halted");
          }
          if (mode === "workflow-save-error") t.mock.method(Library.prototype, "save", () => { throw new Error("fixture workflow save failed"); });
          if (mode === "run-save-error") t.mock.method(Library.prototype, "saveRun", () => { throw new Error("fixture run save failed"); });
          await firstFrame;
          if (mode === "idle-empty") {
            const deadline = Date.now() + 20_000;
            while (host.isOpen() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
            assert.equal(host.isOpen(), false);
          }
          if (mode === "close-empty") await host.close();
          else {
            const stopped = await host.call(mode === "disconnect-empty" ? { op: LIVE_DISCONNECT, client: "owner-test" } : { op: "live_stop" }) as Reply;
            assert.equal(stopped.outcome.kind, mode.endsWith("save-error") ? "rejected" : "stopped", JSON.stringify(stopped));
          }
        }
        assert.equal(created, true);
        const runs = library.listRuns().filter((run) => run.id !== "run-sentinel");
        const kept = ["passed", "refused", "halted"].includes(mode);
        const files = await readdir(videos);
        if (proof) await writeFile(path.join(proof, `ownership-${stage}-${mode}.json`), JSON.stringify({ created, clip: path.basename(destination), files, runs }, null, 2));
        assert.deepEqual(await readFile(path.join(videos, "run-sentinel.webm")), sentinel);
        assert.deepEqual(await readFile(path.join(home, "caller-owned.txt")), sentinel);
        if (kept) {
          assert.equal(runs.length, 1);
          assert.equal(runs[0]!.video, path.basename(destination));
          assert.equal(runs[0]!.kind, "capture");
          assert.equal(runs[0]!.status, mode === "refused" ? "failed" : mode === "halted" ? "needs_human" : "passed");
          assert.equal(runs[0]!.modelCalls, 0);
          assert.equal(runs[0]!.traceUnavailable, undefined);
          assert.ok((await stat(destination)).size > 1000);
        } else {
          assert.deepEqual(runs, []);
          assert.deepEqual(files, ["run-sentinel.webm"], "no unadopted current capture clip remains");
        }
        assert.equal(host.isOpen(), false);
        process.kill(browser.pid, 0);
      } finally { await host.close(); await rm(home, { recursive: true, force: true }); }
    });
  } finally { await observer.close(); await browser.close(); await fixture.close(); }
});
