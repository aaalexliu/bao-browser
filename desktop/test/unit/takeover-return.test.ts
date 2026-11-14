import assert from "node:assert/strict";
import test from "node:test";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { Takeover } from "../../src/cdp-live/takeover";

interface OverlayView { phase?: string; activity?: string; lastTab?: boolean }

function overlayFake(pages = 3): {
  cdp: CdpSocket;
  views: OverlayView[];
  calls: string[];
  heartbeats: { n: number };
  emit: (event: { type: string }) => void;
} {
  const views: OverlayView[] = [];
  const calls: string[] = [];
  const heartbeats = { n: 0 };
  const queued: { type: string }[] = [];
  let wait: ((event: { type: string }) => void) | undefined;
  const emit = (event: { type: string }) => {
    if (wait) {
      const resolve = wait;
      wait = undefined;
      resolve(event);
      return;
    }
    queued.push(event);
  };
  const send = async (method: string, params?: Record<string, unknown>) => {
    if (method === "Target.getTargets") {
      return { targetInfos: Array.from({ length: pages }, (_, index) => ({ targetId: `page-${index}`, type: "page" })) };
    }
    if (method === "Target.attachToTarget") return { sessionId: "page" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script" };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate") return { result: { objectId: "overlay" } };
    if (method === "Runtime.callFunctionOn") {
      const declared = String(params?.functionDeclaration);
      const name = declared.match(/this\.(\w+)/)?.[1] ?? "";
      calls.push(name);
      if (name === "poll") {
        const next = queued.shift();
        if (next) return { result: { value: next } };
        return { result: { value: await new Promise<{ type: string }>((resolve) => { wait = resolve; }) } };
      }
      if (name === "apply") {
        const view = (params?.arguments as { value?: OverlayView }[] | undefined)?.[0]?.value;
        if (view) views.push(view);
        if (views.length > 1 && params?.failApply) throw new Error("execution context destroyed");
        return { result: {} };
      }
      if (name === "heartbeat") heartbeats.n += 1;
      return { result: {} };
    }
    return {};
  };
  return {
    cdp: { send, on: () => () => undefined } as unknown as CdpSocket,
    views,
    calls,
    heartbeats,
    emit,
  };
}

test("one owned tab keeps the stop-Bao question while Chrome has other pages", async () => {
  const fake = overlayFake(3);
  const takeover = new Takeover({ quiet: true, heartbeatMs: 0 });
  await takeover.noteOwned(1);
  await takeover.attachShared(fake.cdp);
  assert.equal(fake.views.at(-1)?.lastTab, true);
  await takeover.dispose();
});

test("a heartbeat does not count the owner's other pages, and more than one owned tab does", async () => {
  const fake = overlayFake(3);
  const takeover = new Takeover({ heartbeatMs: 20 });
  await takeover.attachShared(fake.cdp, "page-0");
  await takeover.noteOwned(1);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(fake.heartbeats.n > 0);
  assert.equal(fake.views.at(-1)?.lastTab, true);
  await takeover.noteOwned(3);
  assert.equal(fake.views.at(-1)?.lastTab, false);
  await takeover.dispose();
});

test("Done on an ask whose replay already returned ends the overlay without resuming", async () => {
  const fake = overlayFake();
  let asked = false;
  const takeover = new Takeover({ heartbeatMs: 0, finishHoldMs: 0, endAsk: true, onAskDone: () => { asked = true; } });
  await takeover.attachShared(fake.cdp, "page-0");
  await takeover.showAsk("Sign in, then click Done");
  fake.emit({ type: "done" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const askAt = fake.views.findIndex((view) => view.phase === "control");
  const after = fake.views.slice(askAt + 1);
  assert.equal(asked, true);
  assert.equal(after.some((view) => view.phase === "releasing" || view.activity === "Resuming…" || view.phase === "working"), false);
  assert.equal(after.some((view) => view.phase === "finished"), true);
  assert.equal(fake.calls.includes("dispose"), true);
});

test("a lost execution context still hands the tab back and still reports the take", async () => {
  const views: OverlayView[] = [];
  const queued: { type: string }[] = [];
  let wait: ((event: { type: string }) => void) | undefined;
  let applies = 0;
  const emit = (event: { type: string }) => {
    if (wait) {
      const resolve = wait;
      wait = undefined;
      resolve(event);
      return;
    }
    queued.push(event);
  };
  const send = async (method: string, params?: Record<string, unknown>) => {
    if (method === "Target.attachToTarget") return { sessionId: "page" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script" };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate") return { result: { objectId: "overlay" } };
    if (method === "Runtime.callFunctionOn") {
      const declared = String(params?.functionDeclaration);
      if (declared.includes("this.poll")) {
        const next = queued.shift();
        if (next) return { result: { value: next } };
        return { result: { value: await new Promise<{ type: string }>((resolve) => { wait = resolve; }) } };
      }
      if (declared.includes("this.apply")) {
        applies += 1;
        const view = (params?.arguments as { value?: OverlayView }[] | undefined)?.[0]?.value;
        if (view) views.push(view);
        if (applies > 1) throw new Error("execution context destroyed");
        return { result: {} };
      }
      return { result: {} };
    }
    return {};
  };
  const held: boolean[] = [];
  const takeover = new Takeover({ heartbeatMs: 0, onHeld: (value) => held.push(value) });
  await takeover.attachShared({ send, on: () => () => undefined } as unknown as CdpSocket, "page-0");
  emit({ type: "takeControl" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(held, [true]);
  const outcome = takeover.waitHandback(AbortSignal.timeout(1000), 800);
  emit({ type: "done" });
  assert.equal(await outcome, "done");
  assert.deepEqual(held, [true, false]);
  await takeover.dispose();
});
