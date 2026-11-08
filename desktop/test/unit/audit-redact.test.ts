import { fixtureDoc, fixtureInput, fixtureStep } from "../support/fixture-step";
// Audit redaction. No database.

import assert from "node:assert/strict";
import test from "node:test";
import { redactAudit } from "../../../web/src/lib/audit-redact";
import { argsForJob, splitResult } from "../../../web/src/lib/relay-job";
import { stepNeedsSecretValue } from "../../../shared/saved-secrets";
import type { ReplayArgs, WorkflowV2 } from "../../src/v1/schema";

const shot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("relay routing numbers reach replay inputs and results unchanged", () => {
  const job = argsForJob({ id: "routing", inputs: { routing: "021000021", zip: "941031234", order: "123456789" } });
  assert.ok("args" in job);
  const inputs = job.args.inputs as ReplayArgs;
  assert.deepEqual(inputs, { routing: "021000021", zip: "941031234", order: "123456789" });
  const workflow = fixtureDoc({ inputs: [fixtureInput({ name: "routing", type: "text" })], steps: [fixtureStep({ id: "route", action: "type", input: "routing", value: "{{routing}}" })] }) as WorkflowV2;
  assert.equal(stepNeedsSecretValue(workflow.steps[0]!, workflow, inputs), false);
  const result = splitResult({ outcome: "ok", outputs: inputs, readBack: "021000021" });
  assert.deepEqual(result.stored.outputs, inputs);
  assert.equal(result.callerText.readBack, "021000021");
});

test("an audit row retains owner data and evidence but drops credentials", () => {
  const cleaned = redactAudit({
    outcome: "ok",
    workflowId: "hello-bao",
    password: "fixture-pass-value",
    cookie: "session=super-secret-cookie",
    authorization: "Bearer bao_at_secret",
    inputs: { note: "hello", password: "fixture-pass-value", Cookie: "session=super-secret-cookie" },
    resume: "resume-secret",
    resume_token: "resume-secret",
    screenshot: shot,
    nested: `prefix ${shot}`,
    email: "ada@fixture.test",
    path: "/Users/ada/note.txt",
    query: "sk-fixtureTokenValue",
  }) as Record<string, unknown>;
  const text = JSON.stringify(cleaned);
  assert.equal(text.includes("fixture-pass-value"), false);
  assert.equal(text.includes("super-secret-cookie"), false);
  assert.equal(text.includes("bao_at_secret"), false);
  assert.equal(text.includes("resume-secret"), true);
  assert.equal(text.includes("iVBORw0KGgo"), true);
  assert.equal(text.includes("sk-fixtureTokenValue"), true);
  assert.equal(cleaned.email, "ada@fixture.test");
  assert.equal(cleaned.path, "/Users/ada/note.txt");
  assert.equal(cleaned.outcome, "ok");
  assert.equal(cleaned.workflowId, "hello-bao");
  assert.equal((cleaned.inputs as { note?: string }).note, "hello");
  assert.equal(cleaned.nested, `prefix ${shot}`);
  assert.equal(cleaned.screenshot, shot);
  assert.equal(cleaned.resume, "resume-secret");

  const forCaller = redactAudit({ resume: "abc", screenshot: shot }) as {
    resume: string;
    screenshot: string;
  };
  assert.equal(forCaller.resume, "abc");
  assert.equal(forCaller.screenshot, shot);
});
