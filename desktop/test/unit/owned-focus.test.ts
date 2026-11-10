import assert from "node:assert/strict";
import test from "node:test";
import { focusOwnedHandoff, forgetDisclaimedChrome, lockOwnedProfile, presentOwnedProfile, releaseKeptWindow, rememberDisclaimedChrome, type OwnedChromeFocus } from "../../src/launch";
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

function owned(profile: string): WorkflowBrowser {
  return {
    kind: "owned",
    choice: "owned",
    profile,
    persistent: false,
    context: {},
    page: {},
    close: async () => {},
  } as WorkflowBrowser;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("an owner handoff calls the prompt first, then focus work, in call order", async () => {
  const profile = "/tmp/bao-owned-focus-order";
  rememberDisclaimedChrome(profile, 4501, true);
  try {
    const order: string[] = [];
    let finishPresent!: () => void;
    const presentGate = new Promise<void>((resolve) => { finishPresent = resolve; });
    const focus: OwnedChromeFocus = {
      async present() {
        order.push("present-start");
        await presentGate;
        order.push("present-end");
      },
      async lock() { order.push("lock"); },
    };
    const prompts = ownerPrompts(owned(profile), {
      showConfirm() { order.push("confirm"); },
      clearConfirm() { order.push("clear"); },
    }, focus);
    prompts!.showConfirm!("Apply");
    prompts!.clearConfirm!("run");
    assert.deepEqual(order, ["confirm", "clear"]);
    await flush();
    assert.deepEqual(order, ["confirm", "clear", "present-start"]);
    finishPresent();
    await flush();
    assert.deepEqual(order, ["confirm", "clear", "present-start", "present-end", "lock"]);
  } finally {
    forgetDisclaimedChrome(profile);
  }
});

test("a throwing prompt does not reject, and the handoff still runs", async (t) => {
  const profile = "/tmp/bao-owned-focus-throw";
  rememberDisclaimedChrome(profile, 4502, true);
  const rejections: unknown[] = [];
  const onReject = (error: unknown) => { rejections.push(error); };
  process.on("unhandledRejection", onReject);
  t.after(() => {
    process.off("unhandledRejection", onReject);
    forgetDisclaimedChrome(profile);
  });
  const { focus, order } = recorder();
  const prompts = ownerPrompts(owned(profile), {
    showConfirm() { throw new Error("prompt failed"); },
    async showLoginWait() { throw new Error("prompt rejected"); },
  }, focus);
  assert.doesNotThrow(() => prompts!.showConfirm!("Apply"));
  assert.doesNotThrow(() => prompts!.showLoginWait!("Sign in"));
  await flush();
  assert.deepEqual(order, ["present", "present"]);
  assert.deepEqual(rejections, []);
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

test("a handoff locks again only a Chrome Bao launched behind", async () => {
  const behind = "/tmp/bao-owned-focus-behind";
  const foreground = "/tmp/bao-owned-focus-foreground";
  rememberDisclaimedChrome(behind, 4503, true);
  rememberDisclaimedChrome(foreground, 4504, false);
  try {
    const behindFocus = recorder();
    await focusOwnedHandoff(behind, true, behindFocus.focus);
    await focusOwnedHandoff(behind, false, behindFocus.focus);
    assert.deepEqual(behindFocus.order, ["present", "lock"]);
    const foregroundFocus = recorder();
    await focusOwnedHandoff(foreground, true, foregroundFocus.focus);
    await focusOwnedHandoff(foreground, false, foregroundFocus.focus);
    assert.deepEqual(foregroundFocus.order, ["present"]);
  } finally {
    forgetDisclaimedChrome(behind);
    forgetDisclaimedChrome(foreground);
  }
});

test("a handoff does not touch a Chrome bao-spawn did not start", async () => {
  const profile = "/tmp/bao-playwright-chrome";
  const { focus, order } = recorder();
  await focusOwnedHandoff(profile, true, focus);
  await focusOwnedHandoff(profile, false, focus);
  await presentOwnedProfile(profile);
  await lockOwnedProfile(profile);
  assert.deepEqual(order, []);
});

test("letting a kept window go allows that pid and does not present it", async () => {
  const { order } = recorder();
  const allowed: number[] = [];
  await releaseKeptWindow({ kind: "gui", pid: 5150, userDataDir: "/tmp/bao-kept" }, async (pid) => {
    allowed.push(pid);
    order.push("allow");
    return true;
  });
  assert.deepEqual(allowed, [5150]);
  assert.deepEqual(order, ["allow"]);
});
