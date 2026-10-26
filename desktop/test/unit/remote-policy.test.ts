// Remote policy and the audit redaction. No database.

import assert from "node:assert/strict";
import test from "node:test";
import { redactAudit } from "../../../web/src/lib/audit-redact";
import { policyAllowsRemoteRun, REMOTE_POLICY } from "../../../web/src/lib/remote-policy";

const shot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("the remote policy requires a local approval and refuses a remote confirm", () => {
  assert.equal(policyAllowsRemoteRun(REMOTE_POLICY), true);
  assert.equal(REMOTE_POLICY.requireLocalApproval, true);
  assert.equal(REMOTE_POLICY.confirmLocalOnly, true);
  assert.equal(REMOTE_POLICY.remoteMayApproveConfirm, false);
  assert.equal(policyAllowsRemoteRun({ ...REMOTE_POLICY, remoteMayApproveConfirm: true }), false);
  assert.equal(policyAllowsRemoteRun({ ...REMOTE_POLICY, requireLocalApproval: false }), false);
  assert.equal(policyAllowsRemoteRun({ ...REMOTE_POLICY, confirmLocalOnly: false }), false);
  assert.equal(policyAllowsRemoteRun({ ...REMOTE_POLICY, version: 2 }), false);
  assert.equal(policyAllowsRemoteRun(null), false);
  assert.equal(policyAllowsRemoteRun("allow"), false);
});

test("an audit row drops cookies, secrets, resume tokens, and screenshot bytes", () => {
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
  }) as Record<string, unknown>;
  const text = JSON.stringify(cleaned);
  assert.equal(text.includes("fixture-pass-value"), false);
  assert.equal(text.includes("super-secret-cookie"), false);
  assert.equal(text.includes("bao_at_secret"), false);
  assert.equal(text.includes("resume-secret"), false);
  assert.equal(text.includes("iVBORw0KGgo"), false);
  assert.equal(cleaned.outcome, "ok");
  assert.equal(cleaned.workflowId, "hello-bao");
  assert.equal((cleaned.inputs as { note?: string }).note, "hello");
  assert.equal(cleaned.nested, "redacted");
  assert.equal("screenshot" in cleaned, false);
  assert.equal("resume" in cleaned, false);

  const forCaller = redactAudit({ resume: "abc", screenshot: shot }, { keepResume: true, keepScreenshot: true }) as {
    resume: string;
    screenshot: string;
  };
  assert.equal(forCaller.resume, "abc");
  assert.equal(forCaller.screenshot, "redacted");
});
