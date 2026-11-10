import assert from "node:assert/strict";
import test from "node:test";
import { focusOwnedHandoff, type OwnedChromeFocus } from "../../src/launch";
import { ownerPrompts, type WorkflowBrowser } from "../../src/engines/workflow-browser";

function recorder(): { focus: OwnedChromeFocus; order: string[] } {
  const order: string[] = [];
  return {
    order,
    focus: {
      async present() { order.push("present"); },
      async lock() { order.push("lock"); },
    },
  };
}

test("an owner handoff presents before the prompt and locks when it ends", async () => {
  const { focus, order } = recorder();
  const browser = {
    kind: "owned",
    choice: "owned",
    profile: "/tmp/bao-owned-focus",
    persistent: false,
    context: {},
    page: {},
    close: async () => {},
  } as WorkflowBrowser;
  const prompts = ownerPrompts(browser, {
    async showConfirm() { order.push("confirm"); },
    async showLoginWait() { order.push("login"); },
    async showAsk() { order.push("ask"); },
    async pauseCapture() { order.push("pause"); },
    async clearConfirm() { order.push("clear-confirm"); },
    async clearLoginWait() { order.push("clear-login"); },
    async resumeCapture() { order.push("resume"); },
  }, focus);
  await prompts!.showConfirm!("Apply");
  await prompts!.showLoginWait!("Sign in");
  await prompts!.showAsk!({} as never);
  await prompts!.pauseCapture!();
  await prompts!.clearConfirm!("run");
  await prompts!.clearLoginWait!("run");
  await prompts!.resumeCapture!();
  assert.deepEqual(order, [
    "present", "confirm",
    "present", "login",
    "present", "ask",
    "present", "pause",
    "lock", "clear-confirm",
    "lock", "clear-login",
    "lock", "resume",
  ]);
});

test("a running Chrome handoff does not present or lock the owned Chrome", async () => {
  const { focus, order } = recorder();
  let shown = false;
  const browser = {
    kind: "current",
    choice: "current",
    context: {},
    page: {},
    close: async () => {},
    show: async () => { shown = true; },
    settle: async () => {},
    bringToFront: async () => {},
    keepOpen: async () => {},
  } as WorkflowBrowser;
  const prompts = ownerPrompts(browser, {
    async showAsk() { order.push("ask"); },
    async clearLoginWait() { order.push("clear"); },
  }, focus);
  await prompts!.showAsk!({} as never);
  await prompts!.clearLoginWait!("run");
  assert.equal(shown, true);
  assert.deepEqual(order, ["ask", "clear"]);
});

test("focusOwnedHandoff presents while waiting and locks when the wait ends", async () => {
  const { focus, order } = recorder();
  await focusOwnedHandoff("/tmp/bao-owned-focus", true, focus);
  await focusOwnedHandoff("/tmp/bao-owned-focus", false, focus);
  assert.deepEqual(order, ["present", "lock"]);
});
