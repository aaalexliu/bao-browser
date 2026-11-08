import { testWorkflow,  } from "../support/workflow";
// Guide Me highlights the next target and waits. It does not click or type.

import assert from "node:assert/strict";
import test from "node:test";
import { guideMe } from "../../src/v1/guide-me";
import type { Driver, GuideAct } from "../../src/v1/replay";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "textbox", path: [], ...partial };
}

test("guide me advances when the person acts and the action counter stays 0", async () => {
  const user = ident({ id: "username", nameAttr: "username", role: "textbox" });
  const login = ident({ id: "login-btn", role: "button", name: "Log in", testId: "login" });
  const doc: WorkflowV2 = testWorkflow({
    schema: "bao.workflow/v4",
    id: "wf-guide",
    name: "Guide the fixture",
    startUrl: "http://127.0.0.1/fixture",
    inputs: [],
    createdAt: 1,
    steps: [
      { id: "note", index: 0, timeoutMs: 8000, caption: { text: "Note: wait" }, action: "note", text: "Note: wait" },
      {
        id: "focus-user",
        index: 1,
        timeoutMs: 8000,
        caption: { text: "Click Username" },
        action: "click",
        target: {
          locators: [{ kind: "css", value: "#username" }, { kind: "xpath", value: "//*[@id=\"username\"]" }],
          hint: { nameAttr: "username", role: "textbox", surface: "dom", id: "username" },
        },
      },
      {
        id: "type-user",
        index: 2,
        timeoutMs: 8000,
        caption: { text: "Type demo" },
        action: "type",
        target: {
          locators: [{ kind: "css", value: "#username" }, { kind: "xpath", value: "//*[@id=\"username\"]" }],
          hint: { nameAttr: "username", role: "textbox", surface: "dom", id: "username" },
        },
        text: { literal: "demo" },
      },
      {
        id: "login",
        index: 3,
        timeoutMs: 8000,
        caption: { text: "Click Log in", citation: { text: "Log in", source: "name" } },
        action: "click",
        target: {
          locators: [
            { kind: "role", role: "button", name: "Log in" },
            { kind: "text", value: "Log in" },
            { kind: "testid", value: "login" },
            { kind: "css", value: "#login-btn" },
            { kind: "xpath", value: "//*[@id=\"login-btn\"]" },
          ],
          hint: { role: "button", surface: "dom", id: "login-btn" },
        },
      },
    ],
  });
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
  const doc: WorkflowV2 = testWorkflow({
    schema: "bao.workflow/v4",
    id: "wf-ring",
    name: "Ring",
    startUrl: "http://127.0.0.1/fixture",
    inputs: [],
    createdAt: 1,
    steps: [
      {
        id: "focus-user",
        index: 0,
        timeoutMs: 8000,
        caption: { text: "Click Username" },
        action: "click",
        target: {
          locators: [{ kind: "css", value: "#username" }, { kind: "xpath", value: "//*[@id=\"username\"]" }],
          hint: { role: "textbox", surface: "dom", id: "username" },
        },
      },
    ],
  });
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
