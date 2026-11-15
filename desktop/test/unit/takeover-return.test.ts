import assert from "node:assert/strict";
import test from "node:test";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { Takeover } from "../../src/cdp-live/takeover";
import type { Identity } from "../../src/v1/schema";
import { replay, type Driver } from "../../src/v1/replay";
import { targetFor, testWorkflow } from "../support/workflow";

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

test("a live owner-press handoff returns to working and continues", async () => {
  const fake = overlayFake();
  const save = { surface: "dom", role: "button", name: "Save", path: [] } as Identity;
  let handedBack = false;
  let asked = false;
  let clicks = 0;
  let overlay: Takeover | undefined;
  const driver: Driver = {
    tree: async () => {
      if (asked && !handedBack) {
        fake.emit({ type: "done" });
        const start = Date.now();
        while (!handedBack && Date.now() - start < 1000) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { nodes: [save], texts: [], values: [] };
    },
    snapshot: async () => ({}),
    click: async () => { clicks += 1; },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    showAsk: async () => {
      asked = true;
      overlay = new Takeover({ heartbeatMs: 0, finishHoldMs: 0, onAskDone: () => { handedBack = true; } });
      await overlay.attachShared(fake.cdp, "page-0");
      await overlay.showAsk("Confirm, then click Done");
    },
    ownerContinued: () => handedBack,
    handedBack: () => handedBack,
    askUnwatched: () => overlay?.noteAskReturned(),
  };
  const doc = testWorkflow({
    steps: [
      {
        id: "press",
        index: 0,
        timeoutMs: 2000,
        caption: { text: "you press Save" },
        action: "handoff",
        reason: "owner-press",
        target: targetFor(save),
        check: { kind: "text", match: "Applied", timeoutMs: 2000 },
      },
      {
        id: "save",
        index: 1,
        timeoutMs: 0,
        caption: { text: "Click Save" },
        action: "click",
        heal: "never",
        target: targetFor(save),
        check: { kind: "element", locators: targetFor(save).locators, timeoutMs: 0 },
      },
    ],
  });
  const result = await replay(doc, {}, driver, { settings: { heal: "never" } });
  const askAt = fake.views.findIndex((view) => view.phase === "control");
  const after = fake.views.slice(askAt + 1);
  assert.equal(result.status, "passed");
  assert.equal(clicks, 1);
  assert.equal(handedBack, true);
  assert.equal(after.some((view) => view.phase === "working" && view.activity === "Working…"), true);
  assert.equal(after.some((view) => view.phase === "finished" || view.phase === "releasing" || view.activity === "Resuming…"), false);
  assert.equal(fake.calls.includes("dispose"), false);
  await overlay?.dispose();
});

test("Done after an owner-press replay has returned ends the overlay without resuming", async () => {
  const fake = overlayFake();
  let handedBack = false;
  let overlay: Takeover | undefined;
  const driver: Driver = {
    tree: async () => ({ nodes: [], texts: [], values: [] }),
    snapshot: async () => ({}),
    click: async () => {},
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    showAsk: async () => {
      overlay = new Takeover({ heartbeatMs: 0, finishHoldMs: 0, onAskDone: () => { handedBack = true; } });
      await overlay.attachShared(fake.cdp, "page-0");
      await overlay.showAsk("Confirm, then click Done");
    },
    ownerContinued: () => handedBack,
    askUnwatched: () => overlay?.noteAskReturned(),
  };
  const save = { surface: "dom", role: "button", name: "Save", path: [] } as Identity;
  const doc = testWorkflow({
    steps: [{
      id: "press",
      index: 0,
      timeoutMs: 0,
      caption: { text: "you press Save" },
      action: "handoff",
      reason: "owner-press",
      target: targetFor(save),
      check: { kind: "text", match: "Applied", timeoutMs: 0 },
    }],
  });
  const result = await replay(doc, {}, driver, { settings: { heal: "never" } });
  assert.equal(result.status, "paused");
  assert.equal(handedBack, false);
  assert.equal(fake.calls.includes("dispose"), false);
  fake.emit({ type: "done" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const askAt = fake.views.findIndex((view) => view.phase === "control");
  const after = fake.views.slice(askAt + 1);
  assert.equal(handedBack, true);
  assert.equal(after.some((view) => view.phase === "releasing" || view.activity === "Resuming…" || view.phase === "working"), false);
  assert.equal(after.some((view) => view.phase === "finished"), true);
  assert.equal(fake.calls.includes("dispose"), true);
});

test("a wall pause that has returned ends on Done, and a live wall wait does not", async () => {
  const save = { surface: "dom", role: "button", name: "Save", path: [] } as Identity;
  const doc = testWorkflow({
    startUrl: "https://example.test/",
    steps: [{
      id: "open",
      index: 0,
      timeoutMs: 0,
      caption: { text: "Click Save" },
      action: "click",
      heal: "never",
      target: targetFor(save),
      check: { kind: "element", locators: targetFor(save).locators, timeoutMs: 0 },
    }],
  });
  const wall = { nodes: [], texts: ["hcaptcha"], values: [], url: "https://example.test/check" };
  const page = { nodes: [save], texts: [], values: [], url: "https://example.test/" };
  const returned = overlayFake();
  let returnedOverlay: Takeover | undefined;
  let returnedBack = false;
  const returnedDriver: Driver = {
    tree: async () => wall,
    snapshot: async () => ({}),
    click: async () => {},
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    showAsk: async () => {
      returnedOverlay = new Takeover({ heartbeatMs: 0, finishHoldMs: 0, onAskDone: () => { returnedBack = true; } });
      await returnedOverlay.attachShared(returned.cdp, "page-0");
      await returnedOverlay.showAsk("Sign in, then click Done");
    },
    loginContinued: () => returnedBack,
    askUnwatched: () => returnedOverlay?.noteAskReturned(),
  };
  const paused = await replay(doc, {}, returnedDriver, { settings: { heal: "never" } });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pausedKind, "wall");
  assert.equal(returned.calls.includes("dispose"), false);
  returned.emit({ type: "done" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const returnedAsk = returned.views.findIndex((view) => view.phase === "control");
  const returnedAfter = returned.views.slice(returnedAsk + 1);
  assert.equal(returnedAfter.some((view) => view.phase === "finished"), true);
  assert.equal(returnedAfter.some((view) => view.phase === "releasing" || view.activity === "Resuming…" || view.phase === "working"), false);
  assert.equal(returned.calls.includes("dispose"), true);

  const live = overlayFake();
  let liveOverlay: Takeover | undefined;
  let liveBack = false;
  let clicks = 0;
  const liveDriver: Driver = {
    tree: async () => liveBack ? page : wall,
    snapshot: async () => ({}),
    click: async () => { clicks += 1; },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {
      if (!liveOverlay || liveBack) return;
      live.emit({ type: "done" });
      const start = Date.now();
      while (!liveBack && Date.now() - start < 1000) await new Promise((resolve) => setTimeout(resolve, 10));
    },
    showAsk: async () => {
      liveOverlay = new Takeover({ heartbeatMs: 0, finishHoldMs: 0, onAskDone: () => { liveBack = true; } });
      await liveOverlay.attachShared(live.cdp, "page-0");
      await liveOverlay.showAsk("Sign in, then click Done");
    },
    loginContinued: () => liveBack,
    askUnwatched: () => liveOverlay?.noteAskReturned(),
  };
  const continued = await replay(doc, {}, liveDriver, { holdForPerson: true, settings: { heal: "never", actTimeoutMs: 2000 } });
  const liveAsk = live.views.findIndex((view) => view.phase === "control");
  const liveAfter = live.views.slice(liveAsk + 1);
  assert.equal(continued.status, "passed");
  assert.equal(clicks, 1);
  assert.equal(liveAfter.some((view) => view.phase === "working" && view.activity === "Working…"), true);
  assert.equal(liveAfter.some((view) => view.phase === "finished" || view.phase === "releasing" || view.activity === "Resuming…"), false);
  assert.equal(live.calls.includes("dispose"), false);
  await liveOverlay?.dispose();
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
