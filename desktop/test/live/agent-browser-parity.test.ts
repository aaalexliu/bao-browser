import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLiveHost } from "../../src/cdp-live/live-host";
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

test("old and agent-browser keep the same guarded Instacart cart and recorded replay", { skip: !enabled, timeout: 240_000 }, async () => {
  pinTestBrowser();
  const fixture = await startInstacartFixture();
  const browser = await launchFixtureBrowser(fixture);
  const savedEnv = { engine: process.env.BAO_PAGE_ENGINE, binary: process.env.BAO_AGENT_BROWSER };
  const comparisons: unknown[] = [];
  try {
    for (const engine of ["old", "agent-browser"] as const) {
      const home = await mkdtemp(path.join(tmpdir(), "bao-engine-parity-"));
      process.env.BAO_PAGE_ENGINE = engine;
      process.env.BAO_AGENT_BROWSER = process.env.AGENT_BROWSER_PARITY_BINARY;
      fixture.reset();
      const target = { kind: "throwaway" as const, portFile: browser.portFile };
      const host = createLiveHost({ home, lockFile: path.join(home, "lock"), target, idleMs: 0,
        selectRun: async () => ({ target, engineName: engine, ...(engine === "agent-browser" ? { artifactRoot: home } : {}) }),
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
        const typed = await call({ op: "live_type", ref: ref(started, "Search Costco"), text: "blueberries" });
        const found = await call({ op: "live_key", ref: ref(typed, "Search Costco"), key: "Enter" });
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
          assert.equal(captured.steps.length, workflow.steps.length);
          for (const step of captured.steps as { afterShot?: string }[]) {
            assert.ok(step.afterShot, "captured workflow step has a screenshot");
            assert.ok((await stat(path.join(home, "shots", "runs", captured.id, step.afterShot))).size > 1000);
          }
          assert.ok((await stat(path.join(home, "videos", captured.video))).size > 1000);
          if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) await copyFile(path.join(home, "videos", captured.video), path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, "agent-browser-recording.webm"));
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
        comparisons.push({ engine, cart: cartState.carts, writes: cartState.writes.map(({ op, productId, qty }) => ({ op, productId, qty })), steps: replayed.steps.map(({ status }) => status) });
        const image = await readFile(path.join(home, "live-session", "shots", shot.shot!));
        assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) await writeFile(path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, `${engine}-cart.png`), image);
      } finally { await host.close(); await rm(home, { recursive: true, force: true }); }
    }
    assert.deepEqual({ ...comparisons[0] as object, engine: "same" }, { ...comparisons[1] as object, engine: "same" });
    if (process.env.AGENT_BROWSER_PARITY_ARTIFACTS) await writeFile(path.join(process.env.AGENT_BROWSER_PARITY_ARTIFACTS, "parity.json"), JSON.stringify(comparisons, null, 2));
  } finally {
    if (savedEnv.engine === undefined) delete process.env.BAO_PAGE_ENGINE; else process.env.BAO_PAGE_ENGINE = savedEnv.engine;
    if (savedEnv.binary === undefined) delete process.env.BAO_AGENT_BROWSER; else process.env.BAO_AGENT_BROWSER = savedEnv.binary;
    await browser.close();
    await fixture.close();
  }
});
