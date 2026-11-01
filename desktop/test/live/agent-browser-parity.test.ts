import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { pageEngineName } from "../../src/engines/agent-browser";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { AgentBrowserPage } from "../../src/engines/agent-browser";
import { pinTestBrowser } from "../../src/launch";
import { Library } from "../../src/v1/store";
import { launchFixtureBrowser } from "../instacart/browser";
import { startInstacartFixture, TARGET } from "../instacart/fixture";

type Reply = {
  outcome: { kind: string; reason?: string };
  view?: { controls: { ref: string; label: string; kind: string }[]; stopBeforeConfirm: { label: string }[] };
  shot?: string;
  session?: string;
};

const enabled = process.env.BAO_LIVE_TESTS === "1" && !!process.env.AGENT_BROWSER_PARITY_BINARY;

test("old and agent-browser keep the same guarded Instacart cart and recorded replay", { skip: !enabled, timeout: 240_000 }, async (t) => {
  pinTestBrowser();
  const fixture = await startInstacartFixture();
  const browser = await launchFixtureBrowser(fixture);
  const observer = await chromium.connectOverCDP(browser.cdpUrl);
  const savedBinary = process.env.BAO_AGENT_BROWSER;
  const comparisons: unknown[] = [];
  try {
    for (const engine of ["old", "agent-browser"] as const) {
      const home = await mkdtemp(path.join(tmpdir(), "bao-engine-parity-"));
      process.env.BAO_AGENT_BROWSER = process.env.AGENT_BROWSER_PARITY_BINARY;
      fixture.reset();
      const target = { kind: "throwaway" as const, portFile: browser.portFile };
      const profiles = path.join(home, "synthetic-profiles");
      await mkdir(path.join(profiles, "Default"), { recursive: true });
      await writeFile(path.join(profiles, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture" } } } }));
      const app = await startApp({ home, port: 0, chromeProfilesRoot: profiles, liveTarget: `throwaway:${browser.portFile}`, liveLockFile: path.join(home, "app.lock") });
      const setting = await fetch(`http://127.0.0.1:${app.port}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageEngine: engine, chromeProfile: "Default" }) });
      assert.equal(setting.status, 200);
      const host = createLiveHost({ home, lockFile: path.join(home, "lock"), target, idleMs: 0,
        selectRun: async () => ({ target, engineName: pageEngineName(app.library.settings().pageEngine), artifactRoot: home }),
      });
      const call = async (body: Record<string, unknown>, expected = "applied") => {
        const reply = await host.call(body) as Reply;
        assert.equal(reply.outcome.kind, expected, `${engine}: ${JSON.stringify(reply.outcome)}`);
        return reply;
      };
      const ref = (reply: Reply, label: string) => {
        const hits = reply.view?.controls.filter((item) => item.label === label) || [];
        assert.equal(hits.length, 1, `${engine}: unique ${label}`);
        return hits[0]!.ref;
      };
      try {
        const started = await call({ op: "live_session_start", intent: "put costco blueberries into the cart at instacart", url: fixture.url("/store/costco/storefront") });
        const livePage = observer.contexts().flatMap((context) => context.pages()).find((page) => page.url() === fixture.url("/store/costco/storefront"));
        assert.ok(livePage);
        assert.equal(await livePage.locator("#bao-redact").count(), 0, "the live window stays readable after the initial shot");
        const partial = await call({ op: "live_type", ref: ref(started, "Search Costco"), text: "blue" });
        const typed = await call({ op: "live_type", ref: ref(partial, "Search Costco"), text: "berries" });
        assert.equal(await livePage.locator("#bao-redact").count(), 0, "step shots remove the veil in finally");
        assert.ok((await livePage.locator("body").innerText()).includes("Costco"));
        if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) await livePage.screenshot({ path: path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, `${engine}-live-page.png`) });
        const found = await call({ op: "live_key", ref: ref(typed, "Search Costco"), key: "Enter" });
        assert.equal(await livePage.locator("#bao-redact").count(), 0, "navigation does not install a persistent veil");
        assert.ok((await livePage.locator("body").innerText()).includes("blueberries"));
        if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) await livePage.screenshot({ path: path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, `${engine}-live-after-navigation.png`) });
        await call({ op: "live_click", ref: ref(started, "Search Costco") }, "refused");
        assert.ok(found.view?.stopBeforeConfirm.some((item) => item.label === "Checkout"));
        const product = found.view!.controls.filter((item) => item.kind === "link" && item.label.includes(TARGET.name) && item.label !== TARGET.name);
        assert.equal(product.length, 1, JSON.stringify(found.view!.controls));
        const opened = await call({ op: "live_click", ref: product[0]!.ref });
        const added = await call({ op: "live_click", ref: ref(opened, "Add to cart") });
        const cart = await call({ op: "live_click", ref: ref(added, "View Cart. Items in cart: 1") });
        const shot = await call({ op: "live_screenshot" });
        assert.ok(shot.shot, "run evidence screenshot path");
        const cartState = fixture.state();
        assert.deepEqual(cartState.carts.costco.map((item) => [item.productId, item.qty]), [[TARGET.id, 1]]);
        assert.equal(cartState.writes.length, 1);
        assert.deepEqual(cartState.traps, []);
        if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) {
          // live_screenshot returns Bao's artifact reference, not an upstream file path.
          await writeFile(path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, `${engine}-cart.json`), JSON.stringify({ cart, shot, state: cartState }, null, 2));
        }
        await call({ op: "live_stop" }, "stopped");
        process.kill(browser.pid, 0); // External Chrome survived engine disconnect.
        const library = new Library(home);
        const workflow = library.read(started.session!);
        if (engine === "agent-browser") {
          const captured = library.listRuns().find((run) => run.workflowId === workflow.id);
          assert.ok(captured?.video, "captured live run has page video");
          assert.equal(captured.pageEngine, engine);
          assert.equal(captured.kind, "capture");
          assert.equal(workflow.steps[0]?.value, "blueberries");
          const merged = captured.steps[0] as { afterShot: string };
          assert.deepEqual(await readFile(path.join(home, "shots", "runs", captured.id, merged.afterShot)), await readFile(path.join(home, "live-session", "shots", typed.shot!)));
          assert.notDeepEqual(await readFile(path.join(home, "live-session", "shots", partial.shot!)), await readFile(path.join(home, "live-session", "shots", typed.shot!)));
          assert.equal(captured.steps.length, workflow.steps.length);
          for (const step of captured.steps as { afterShot?: string }[]) {
            assert.ok(step.afterShot, "captured workflow step has a screenshot");
            assert.ok((await stat(path.join(home, "shots", "runs", captured.id, step.afterShot))).size > 1000);
          }
          assert.ok((await stat(path.join(home, "videos", captured.video))).size > 1000);
          if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) {
            const artifacts = process.env.AGENT_BROWSER_PARITY_ARTIFACTS;
            await copyFile(path.join(home, "videos", captured.video), path.join(artifacts, "agent-browser-recording.webm"));
            const ui = await chromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
            try {
              const page = await ui.newPage({ viewport: { width: 1400, height: 1000 } });
              library.saveRun({ ...captured, kind: undefined });
              await page.goto(`http://127.0.0.1:${app.port}/`);
              await page.locator('#rail [data-screen="runs"]').click();
              assert.ok((await page.locator("#runs").innerText()).includes(captured.id));
              await page.screenshot({ path: path.join(artifacts, "library-recording-before.png"), fullPage: true });
              library.saveRun(captured);
              await page.reload();
              await page.locator('#rail [data-screen="runs"]').click();
              assert.ok((await page.locator("#runs").innerText()).includes("recording"));
              await page.screenshot({ path: path.join(artifacts, "library-recording-after.png"), fullPage: true });
            } finally { library.saveRun(captured); await ui.close(); }
          }
        }
        fixture.reset();
        const replayed = await host.replay(workflow);
        assert.equal(replayed.status, "passed", `${engine}: ${JSON.stringify(replayed.failure)}`);
        assert.equal(replayed.modelCalls, 0);
        if (engine === "agent-browser") {
          assert.ok(replayed.video, "guarded replay has page video");
          assert.ok(replayed.traceUnavailable, "unsupported trace is explicit, not an empty success");
          assert.ok(replayed.steps.every((step) => step.status === "skipped" || (step.beforeShot && step.afterShot)), "replay keeps per-step screenshots");
          if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) await copyFile(path.join(home, "videos", replayed.video), path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, "agent-browser-replay.webm"));
        }
        assert.deepEqual(fixture.state().carts.costco.map((item) => [item.productId, item.qty]), [[TARGET.id, 1]]);
        assert.equal(fixture.state().writes.length, 1);
        assert.deepEqual(fixture.state().traps, []);
        const evidence = replayed.steps.map((step) => ({
          identity: "identity" in step,
          dom: !!step.snapshot?.dom?.length,
          ax: !!step.snapshot?.ax,
          before: !!step.beforeShot,
          after: !!step.afterShot,
        }));
        assert.ok(evidence.every((step) => !step.identity && !step.dom && !step.ax), "guarded old/native replay does not record successful-step identity, DOM, or AX evidence");
        assert.ok(evidence.every((step) => step.before && step.after), "both engines retain step screenshots at the same fixture viewport");
        library.saveRun({ id: replayed.runId, workflowId: workflow.id, pageEngine: engine, at: Date.now(),
          status: replayed.status, steps: replayed.steps, heals: replayed.heals, modelCalls: replayed.modelCalls,
          video: replayed.video, videoStartedAt: replayed.videoStartedAt, traceUnavailable: replayed.traceUnavailable });
        comparisons.push({ engine, cart: cartState.carts, writes: cartState.writes.map(({ op, productId, qty }) => ({ op, productId, qty })), steps: replayed.steps.map(({ status }) => status), evidence });
        if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) {
          await cp(home, path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, `${engine}-library`), { recursive: true });
        }
        const image = await readFile(path.join(home, "live-session", "shots", shot.shot!));
        assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) await writeFile(path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, `${engine}-cart.png`), image);
        if (engine === "agent-browser") {
          const restarted = await call({ op: "live_session_start", intent: "Failed screenshot cleanup", url: fixture.url("/store/costco/storefront") });
          assert.equal(restarted.outcome.kind, "applied");
          const page = observer.contexts().flatMap((context) => context.pages()).find((page) => page.url() === fixture.url("/store/costco/storefront"));
          assert.ok(page);
          const screenshot = t.mock.method(AgentBrowserPage.prototype, "screenshot", async function(this: AgentBrowserPage) {
            await this.close();
            throw new Error("fixture screenshot transport failed");
          });
          try {
            const failed = await call({ op: "live_screenshot" });
            assert.equal(failed.shot, "");
            assert.equal(screenshot.mock.calls.length, 1);
            assert.equal(await page.locator("#bao-redact").count(), 0, "cleanup survives a stopped native transport");
          } finally { screenshot.mock.restore(); }
          assert.equal(((await host.call({ op: "live_stop" })) as Reply).outcome.kind, "stopped");
        }
        process.kill(browser.pid, 0);
        assert.equal((await fetch(`${browser.cdpUrl}/json/version`)).status, 200);
      } finally { await host.close(); await app.close(); await rm(home, { recursive: true, force: true }); }
    }
    assert.deepEqual({ ...comparisons[0] as object, engine: "same" }, { ...comparisons[1] as object, engine: "same" });
    if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) await writeFile(path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, "parity.json"), JSON.stringify(comparisons, null, 2));
  } finally {
    if (savedBinary === undefined) delete process.env.BAO_AGENT_BROWSER; else process.env.BAO_AGENT_BROWSER = savedBinary;
    await observer.close();
    await browser.close();
    await fixture.close();
  }
});
