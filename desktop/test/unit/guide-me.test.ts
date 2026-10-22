// Guide Me highlights the next target and waits. It does not click or type.

import assert from "node:assert/strict";
import test from "node:test";
import { guideMe } from "../../src/v1/guide-me";
import type { Driver, GuideAct } from "../../src/v1/replay";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "textbox", path: [], ...partial };
}

function step(partial: Omit<WorkflowV2["steps"][number], "index" | "surface" | "timeoutMs">, index: number): WorkflowV2["steps"][number] {
  return { surface: "dom", timeoutMs: 8000, ...partial, index };
}

test("guide me advances when the person acts and the action counter stays 0", async () => {
  const user = ident({ id: "username", nameAttr: "username", role: "textbox" });
  const login = ident({ id: "login-btn", role: "button", name: "Log in", testId: "login" });
  const doc: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf-guide",
    name: "Guide the fixture",
    startUrl: "http://127.0.0.1/fixture",
    inputs: [],
    createdAt: 1,
    steps: [
      step({ id: "note", action: "note", label: "Note: wait", intent: "wait" }, 0),
      step({ id: "focus-user", action: "click", label: "Click Username", intent: "Focus the username field", identity: user }, 1),
      step({ id: "type-user", action: "type", label: "Type demo", intent: "Type the demo username", value: "demo", identity: user }, 2),
      step({ id: "login", action: "click", label: "Click Log in", intent: "Log in", identity: login }, 3),
    ],
  };
  const outlined: string[] = [];
  const acts: GuideAct[] = [];
  let actions = 0;
  const bump = async () => {
    actions += 1;
    throw new Error("automated");
  };
  const driver: Driver = {
    async tree() {
      return { nodes: [user, login], texts: [], values: [{ identity: user, value: "" }] };
    },
    async snapshot() { throw new Error("snapshot"); },
    click: bump,
    fill: async () => bump(),
    key: async () => bump(),
    upload: async () => bump(),
    drop: async () => bump(),
    digits: async () => bump(),
    check: async () => bump(),
    async notify() { throw new Error("notify"); },
    async outline(node) { outlined.push(node.id || ""); },
    async performed() { return acts.shift() ?? null; },
  };
  const pending = guideMe(doc, {}, driver, { pollMs: 5, timeoutMs: 2000 });
  const wait = async (pred: () => boolean) => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > 1500) throw new Error(`timed out with outlines ${outlined.join(",")}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await wait(() => outlined[0] === "username");
  acts.push({ op: "click", id: "username", ts: Date.now() });
  await wait(() => outlined.length >= 2);
  acts.push({ op: "type", id: "username", value: "demo", ts: Date.now() });
  await wait(() => outlined.includes("login-btn"));
  acts.push({ op: "click", id: "login-btn", ts: Date.now() });
  const result = await pending;
  assert.equal(result.status, "passed");
  assert.equal(result.actions, 0);
  assert.equal(actions, 0);
  assert.deepEqual(result.steps.map((item) => item.status), ["passed", "passed", "passed", "passed"]);
  assert.deepEqual(outlined, ["username", "username", "login-btn"]);
});

test("guide me rings the control itself when the driver can", async () => {
  const user = ident({ id: "username", role: "textbox" });
  const doc: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf-ring",
    name: "Ring",
    startUrl: "http://127.0.0.1/fixture",
    inputs: [],
    createdAt: 1,
    steps: [
      step({ id: "focus-user", action: "click", label: "Click Username", intent: "Focus the username field", identity: user }, 0),
    ],
  };
  const outlined: string[] = [];
  const rings: string[] = [];
  const acts: GuideAct[] = [];
  const driver: Driver = {
    async tree() { return { nodes: [user], texts: [], values: [] }; },
    async snapshot() { throw new Error("snapshot"); },
    async click() { throw new Error("automated"); },
    async fill() { throw new Error("automated"); },
    async key() { throw new Error("automated"); },
    async upload() { throw new Error("automated"); },
    async drop() { throw new Error("automated"); },
    async digits() { throw new Error("automated"); },
    async check() { throw new Error("automated"); },
    async notify() { throw new Error("notify"); },
    async outline(node) { outlined.push(node.id || ""); },
    async highlightTarget(node) { rings.push(node.id || ""); },
    async performed() { return acts.shift() ?? null; },
  };
  const pending = guideMe(doc, {}, driver, { pollMs: 5, timeoutMs: 1500 });
  const start = Date.now();
  while (!rings.includes("username")) {
    if (Date.now() - start > 1000) throw new Error("ring missing");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  acts.push({ op: "click", id: "username", ts: Date.now() });
  const result = await pending;
  assert.equal(result.status, "passed");
  assert.equal(result.actions, 0);
  assert.deepEqual(rings, ["username"]);
  assert.deepEqual(outlined, []);
});
