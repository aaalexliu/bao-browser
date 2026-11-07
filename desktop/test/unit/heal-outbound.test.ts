import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import fc from "fast-check";
import { cursorAccountHeal, resetCursorAccountCache, type CursorAgentRun } from "../../src/v1/cursor-account";
import { cursorSessionHeal, llmHealFromEnv, type StepFailure } from "../../src/v1/heal";
import { replay, type Driver } from "../../src/v1/replay";
import type { WorkflowV2 } from "../../src/v1/schema";

const stripped = "[secret stripped]";
const reply = JSON.stringify({ identity: { surface: "dom", role: "button", testId: "fixed", path: [] } });

function fixture(secret: string) {
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2", version: 2, id: "heal-outbound", name: secret, createdAt: 1,
    startUrl: "https://example.test/", inputs: [{ name: "password", type: "secret", label: "Password", default: secret }],
    steps: [{
      id: "missing", index: 0, action: "type", label: secret, surface: "dom", timeoutMs: 0,
      input: "password", value: "{{password}}",
      identity: { surface: "dom", role: "textbox", testId: "missing", path: [] },
    }],
  };
  const dom = [
    { op: "type", value: secret, identity: { surface: "dom", role: "textbox", value: secret } },
    { op: "type", value: "sk-generatedOutboundToken" },
    { op: "type", value: "4111111111111111" },
    { op: "type", value: `prefix ${secret} suffix` },
    { op: "select", value: "4111111111111111" },
    { kind: "read-back", hash: "sealed-fixture", expected: secret, actual: secret },
    { note: secret },
  ];
  const failure: StepFailure = {
    stepId: "missing", index: 0, intent: secret, phase: "find", reason: secret,
    snapshot: { dom, screenshot: "AAAALOCALSCREENSHOT" },
  };
  return { workflow, step: workflow.steps[0]!, failure, context: { workflow, args: { password: secret } } };
}

function assertPrompt(prompt: string, secret: string): void {
  const dom = JSON.parse(prompt.split("\n").find((line) => line.startsWith("Snapshot: "))!.slice(10)).dom;
  assert.equal(dom[0].value, stripped);
  assert.equal(dom[0].identity.value, stripped);
  assert.equal(dom[1].value, stripped);
  assert.equal(dom[2].value, stripped);
  assert.equal(dom[3].value, `prefix ${secret} suffix`);
  assert.equal(dom[4].value, "4111111111111111");
  assert.equal(dom[5].actual, secret);
  assert.equal(dom[6].note, secret);
  assert.ok(prompt.includes(`Intent: ${secret}`));
  assert.ok(prompt.includes(`Reason: ${secret}`));
  assert.equal(prompt.includes("AAAALOCALSCREENSHOT"), false);
  const step = JSON.parse(prompt.split("\n").find((line) => line.startsWith("Step: "))!.slice(6));
  assert.equal(step.value, "{{password}}");
  assert.equal(step.label, secret);
}

for (const provider of ["openai", "anthropic", "cursor-session", "cursor-print"] as const) {
  test(`${provider} generated requests keep main's typed-value policy and leave local evidence raw`, async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1000000 }), async (seed) => {
      const secret = `outbound-password-${seed}`;
      const data = fixture(secret);
      const original = structuredClone(data);
      let sent = "";
      const fetchImpl: typeof fetch = async (_url, init) => {
        sent = JSON.parse(String(init?.body)).messages[0].content;
        return new Response(reply);
      };
      const agent: CursorAgentRun = {
        status: async () => ({ code: 0, stdout: JSON.stringify({ status: "authenticated", isAuthenticated: true }), stderr: "", args: [] }),
        print: async (_bin, prompt) => {
          sent = prompt;
          return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", result: reply }), stderr: "", args: [] };
        },
      };
      resetCursorAccountCache();
      const heal = provider === "cursor-print"
        ? await cursorAccountHeal({ BAO_CURSOR_AGENT: process.execPath }, [], agent)
        : provider === "cursor-session"
          ? cursorSessionHeal(() => reply)
          : llmHealFromEnv(provider === "openai" ? { OPENAI_API_KEY: "fixture" } : { ANTHROPIC_API_KEY: "fixture" }, fetchImpl);
      try {
        const proposal = await heal.propose(data.failure, data.step, data.context);
        assert.ok(proposal);
        assertPrompt(proposal.prompt, secret);
        if (provider !== "cursor-session") assert.equal(sent, proposal.prompt);
        assert.deepEqual(data, original);
      } finally {
        resetCursorAccountCache();
      }
    }), { numRuns: 12 });
  });
}

for (const mode of ["logged-out", "print-fails"] as const) {
  test(`Cursor ${mode} file fallback keeps context and scrubs only typed values`, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "bao-heal-outbound-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    t.after(() => resetCursorAccountCache());
    const secret = "fallback-password";
    const data = fixture(secret);
    const original = structuredClone(data);
    const agent: CursorAgentRun = {
      status: async () => ({ code: 0, stdout: JSON.stringify({ status: mode === "logged-out" ? "unauthenticated" : "authenticated", isAuthenticated: mode !== "logged-out" }), stderr: "", args: [] }),
      print: async () => ({ code: 1, stdout: "", stderr: "fixture print failure", args: [] }),
    };
    resetCursorAccountCache();
    const heal = await cursorAccountHeal({ BAO_CURSOR_AGENT: process.execPath, BAO_HEAL_CURSOR: "1", BAO_HEAL_DIR: dir, BAO_HEAL_WAIT_MS: "0" }, [], agent);
    assert.equal(await heal.propose(data.failure, data.step, data.context), null);
    const request = JSON.parse(readFileSync(path.join(dir, "heal-request.json"), "utf8"));
    assertPrompt(request.prompt, secret);
    assert.equal(request.dom[0].value, stripped);
    assert.equal(request.dom[0].identity.value, stripped);
    assert.equal(request.intent, secret);
    assert.equal(request.reason, secret);
    assert.equal(request.step.value, "{{password}}");
    assert.equal(readFileSync(path.join(dir, "heal-shot.png"), "base64"), Buffer.from(data.failure.snapshot.screenshot!, "base64").toString("base64"));
    assert.deepEqual(data, original);
  });
}

test("replay threads default and runtime secrets to the model while returning raw failure evidence", async () => {
  for (const supplied of [false, true]) {
    const data = fixture("default-password");
    const secret = supplied ? "runtime-password" : "default-password";
    const snapshot = fixture(secret).failure.snapshot;
    let sent = "";
    const heal = llmHealFromEnv({ OPENAI_API_KEY: "fixture" }, async (_url, init) => {
      sent = JSON.parse(String(init?.body)).messages[0].content;
      return new Response(reply);
    });
    const driver: Driver = {
      tree: async () => ({ nodes: [], texts: [], values: [] }),
      snapshot: async () => snapshot,
      click: async () => {}, fill: async () => {}, key: async () => {}, upload: async () => {},
      drop: async () => {}, digits: async () => {}, check: async () => {}, notify: async () => {}, sleep: async () => {},
    };
    data.workflow.heal = "approve";
    const result = await replay(data.workflow, supplied ? { password: secret } : {}, driver, { heal });
    assert.equal(result.status, "paused");
    const dom = JSON.parse(sent.split("\n").find((line) => line.startsWith("Snapshot: "))!.slice(10)).dom;
    assert.equal(dom[0].value, stripped);
    assert.deepEqual(result.heals[0]?.snapshot, snapshot);
    assert.equal((result.heals[0]?.snapshot.dom as { value: string }[])[0]?.value, secret);
    assert.equal(data.workflow.inputs[0]?.default, "default-password");
  }
});
